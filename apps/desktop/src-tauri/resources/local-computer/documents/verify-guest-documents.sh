#!/bin/bash
set -euo pipefail

output="${1:-/tmp/fable-document-verification}"
source_dir="$output/source"
render_dir="$output/rendered"
recalculated_dir="$output/recalculated"
rm -rf -- "$output"
mkdir -p "$source_dir" "$render_dir" "$recalculated_dir"

python3 - "$source_dir" <<'PY'
import sys
from pathlib import Path

from docx import Document
from openpyxl import Workbook
from reportlab.pdfgen import canvas

output = Path(sys.argv[1])

document = Document()
document.add_heading("Fable document verification", level=1)
document.add_paragraph("Generated inside the isolated computer.")
document.save(output / "document.docx")

workbook = Workbook()
sheet = workbook.active
sheet["A1"] = 2
sheet["A2"] = 3
sheet["A3"] = "=SUM(A1:A2)"
workbook.calculation.fullCalcOnLoad = True
workbook.calculation.forceFullCalc = True
workbook.save(output / "workbook.xlsx")

pdf = canvas.Canvas(str(output / "report.pdf"))
pdf.drawString(72, 760, "Fable PDF verification")
pdf.save()
PY

node - "$source_dir" <<'JS'
const path = require("node:path");
const pptxgen = require("pptxgenjs");

const output = process.argv[2];
async function main() {
  const presentation = new pptxgen();
  presentation.layout = "LAYOUT_WIDE";
  const slide = presentation.addSlide();
  slide.addText("Fable presentation verification", { x: 1, y: 1, w: 8, h: 1 });
  await presentation.writeFile({ fileName: path.join(output, "presentation.pptx") });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
JS

libreoffice --headless --convert-to pdf --outdir "$render_dir" \
    "$source_dir/document.docx" "$source_dir/presentation.pptx" >/tmp/fable-lo-render.log
libreoffice --headless --convert-to 'xlsx:Calc MS Excel 2007 XML' \
    --outdir "$recalculated_dir" "$source_dir/workbook.xlsx" >/tmp/fable-lo-calc.log

python3 - "$recalculated_dir/workbook.xlsx" <<'PY'
import sys
from openpyxl import load_workbook

workbook = load_workbook(sys.argv[1], data_only=True)
assert workbook.active["A3"].value == 5, "LibreOffice did not cache the recalculated formula"
PY

for pdf in "$source_dir/report.pdf" "$render_dir/document.pdf" "$render_dir/presentation.pdf"; do
    pdfinfo "$pdf" >/dev/null
    pdftoppm -f 1 -singlefile -png "$pdf" "${pdf%.pdf}" >/dev/null 2>&1
    test -s "${pdf%.pdf}.png"
done

test -s "$source_dir/document.docx"
test -s "$source_dir/workbook.xlsx"
test -s "$source_dir/presentation.pptx"
test -s "$source_dir/report.pdf"
