//! Fixed embedded fonts, measured wrapping and lossless Unicode text mapping.
use lopdf::{dictionary, Document, Object, ObjectId, Stream, StringFormat};
use std::collections::BTreeMap;

pub(super) struct Font {
    face: ttf_parser::Face<'static>,
    bytes: &'static [u8],
    name: &'static str,
    characters: BTreeMap<char, u16>,
}

impl Font {
    pub(super) fn new(bold: bool) -> Result<Self, String> {
        let bytes: &[u8] = if bold {
            include_bytes!("../../resources/pdf-fonts/LiberationSans-Bold.ttf")
        } else {
            include_bytes!("../../resources/pdf-fonts/LiberationSans-Regular.ttf")
        };
        let face = ttf_parser::Face::parse(bytes, 0)
            .map_err(|_| "The bundled PDF report font is unavailable.")?;
        if !face.is_outline_embedding_allowed() {
            return Err("The bundled PDF report font does not allow embedding.".into());
        }
        Ok(Self {
            face,
            bytes,
            name: if bold {
                "LiberationSans-Bold"
            } else {
                "LiberationSans"
            },
            characters: BTreeMap::new(),
        })
    }

    fn advance(&self, character: char) -> Result<f32, String> {
        // This bounded renderer does not pretend to perform shaping or bidi.
        if matches!(character as u32, 0x300..=0x36f | 0x483..=0x489 | 0x590..=0x109f | 0x1780..=0x17ff | 0x1ab0..=0x1aff | 0x1dc0..=0x1dff | 0x200b..=0x200f | 0x202a..=0x202e | 0x2066..=0x2069 | 0x20d0..=0x20ff | 0xfb1d..=0xfdff | 0xfe20..=0xfe2f | 0xfe70..=0xfeff)
        {
            return Err("PDF reports support precomposed left-to-right text; complex scripts and combining marks need another document renderer.".into());
        }
        let glyph = self.face.glyph_index(character)
            .ok_or("This text needs a glyph unavailable in the bundled PDF report font. Use a DOCX or another renderer.")?;
        if glyph.0 == 0 {
            return Err("This PDF report character has no usable font glyph.".into());
        }
        Ok(f32::from(
            self.face
                .glyph_hor_advance(glyph)
                .ok_or("PDF font metrics are unavailable.")?,
        ) / f32::from(self.face.units_per_em()))
    }

    pub(super) fn width(&self, text: &str, size: f32) -> Result<f32, String> {
        text.chars().try_fold(0.0, |width, character| {
            Ok(width + self.advance(character)? * size)
        })
    }

    pub(super) fn encode(&mut self, text: &str) -> Result<Object, String> {
        let mut bytes = Vec::with_capacity(text.len() * 2);
        for character in text.chars() {
            self.advance(character)?;
            let next = u16::try_from(self.characters.len() + 1)
                .map_err(|_| "PDF font character limit exceeded.")?;
            if next > 4096 && !self.characters.contains_key(&character) {
                return Err("A PDF report supports at most 4096 distinct characters.".into());
            }
            bytes.extend_from_slice(
                &self
                    .characters
                    .entry(character)
                    .or_insert(next)
                    .to_be_bytes(),
            );
        }
        Ok(Object::String(bytes, StringFormat::Hexadecimal))
    }

    pub(super) fn embed(&self, document: &mut Document) -> Result<ObjectId, String> {
        let font_file = document.add_object(Stream::new(
            dictionary! {"Length1"=>self.bytes.len() as i64},
            self.bytes.to_vec(),
        ));
        let units = f32::from(self.face.units_per_em());
        let metric = |value: i16| f32::from(value) * 1000.0 / units;
        let bbox = self.face.global_bounding_box();
        let descriptor = document.add_object(dictionary! {
            "Type"=>"FontDescriptor", "FontName"=>self.name, "Flags"=>4,
            "FontBBox"=>vec![metric(bbox.x_min).into(),metric(bbox.y_min).into(),metric(bbox.x_max).into(),metric(bbox.y_max).into()],
            "ItalicAngle"=>0, "Ascent"=>metric(self.face.ascender()), "Descent"=>metric(self.face.descender()),
            "CapHeight"=>metric(self.face.capital_height().unwrap_or(self.face.ascender())), "StemV"=>80, "FontFile2"=>font_file,
        });
        let mut widths = vec![Object::Integer(0); self.characters.len()];
        let mut glyphs = vec![0; (self.characters.len() + 1) * 2];
        let mut unicode = String::from("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /MivletReportUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n");
        let characters = self.characters.iter().collect::<Vec<_>>();
        for group in characters.chunks(100) {
            unicode.push_str(&format!("{} beginbfchar\n", group.len()));
            for (character, cid) in group {
                let glyph = self
                    .face
                    .glyph_index(**character)
                    .ok_or("PDF font glyph is unavailable.")?;
                let cid_index = usize::from(**cid);
                glyphs[cid_index * 2..cid_index * 2 + 2].copy_from_slice(&glyph.0.to_be_bytes());
                widths[cid_index - 1] = (self.advance(**character)? * 1000.0).into();
                let mut buffer = [0u16; 2];
                let encoded = character
                    .encode_utf16(&mut buffer)
                    .iter()
                    .map(|unit| format!("{unit:04X}"))
                    .collect::<String>();
                unicode.push_str(&format!("<{cid:04X}> <{encoded}>\n"));
            }
            unicode.push_str("endbfchar\n");
        }
        unicode.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
        let mapping = document.add_object(Stream::new(dictionary! {}, glyphs));
        let unicode = document.add_object(Stream::new(dictionary! {}, unicode.into_bytes()));
        let descendant = document.add_object(dictionary! {
            "Type"=>"Font", "Subtype"=>"CIDFontType2", "BaseFont"=>self.name, "FontDescriptor"=>descriptor,
            "CIDSystemInfo"=>dictionary! {"Registry"=>Object::string_literal("Adobe"),"Ordering"=>Object::string_literal("Identity"),"Supplement"=>0},
            "CIDToGIDMap"=>mapping, "DW"=>1000, "W"=>vec![1.into(),Object::Array(widths)],
        });
        Ok(document.add_object(dictionary! {
            "Type"=>"Font", "Subtype"=>"Type0", "BaseFont"=>self.name, "Encoding"=>"Identity-H",
            "DescendantFonts"=>vec![descendant.into()], "ToUnicode"=>unicode,
        }))
    }
}

pub(super) fn wrap(font: &Font, text: &str, size: f32, width: f32) -> Result<Vec<String>, String> {
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        let mut line = String::new();
        for word in paragraph.split_whitespace() {
            let candidate = if line.is_empty() {
                word.into()
            } else {
                format!("{line} {word}")
            };
            if font.width(&candidate, size)? <= width {
                line = candidate;
                continue;
            }
            if !line.is_empty() {
                lines.push(std::mem::take(&mut line));
            }
            for character in word.chars() {
                let candidate = format!("{line}{character}");
                if font.width(&candidate, size)? > width {
                    if line.is_empty() {
                        return Err("This PDF column is too narrow for its text.".into());
                    }
                    lines.push(std::mem::take(&mut line));
                }
                line.push(character);
            }
        }
        lines.push(line);
    }
    Ok(lines)
}
