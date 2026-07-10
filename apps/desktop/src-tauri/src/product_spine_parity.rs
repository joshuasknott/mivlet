//! Build-time parity guard for the portable product-spine vocabulary.
//!
//! This deliberately validates the TypeScript source vocabulary, not Rust
//! runtime models. Wave 0B defines portable names and limits; Wave 0C adapters
//! will map storage/runtime structures to them. The digest is the Rust mirror
//! of the complete canonical payload, so changing the shared manifest requires
//! an intentional Rust review as well.

use serde::Serialize;
use sha2::{Digest, Sha256};

const MANIFEST: &str = include_str!("../../../../packages/protocol/spine-parity-manifest.json");
const IDENTITY: &str = include_str!("../../../../packages/protocol/src/spine/identity.ts");
const CONNECTIONS: &str = include_str!("../../../../packages/protocol/src/spine/connections.ts");
const MISSIONS: &str = include_str!("../../../../packages/protocol/src/spine/missions.ts");
const ARTIFACTS_AND_ROUTINES: &str =
    include_str!("../../../../packages/protocol/src/spine/artifacts-routines.ts");

/// Rust's reviewed mirror of the canonical TypeScript vocabulary payload.
const RUST_CANONICAL_SHA256: &str =
    "85ab781774fe66bfb8140e7a4365883f51febeebf3b2c7ad97bd43787af69fba";

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    contract_version: String,
    schema_version: u64,
    limits: std::collections::BTreeMap<String, u64>,
    families: Vec<ManifestFamily>,
    expected_canonical_sha256: String,
}

#[derive(serde::Deserialize)]
struct ManifestFamily {
    name: String,
    source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalPayload {
    contract_version: String,
    schema_version: u64,
    limits: Vec<(String, u64)>,
    families: Vec<CanonicalFamily>,
}

#[derive(Serialize)]
struct CanonicalFamily {
    name: String,
    vocabulary: Vec<CanonicalVocabulary>,
}

#[derive(Serialize)]
struct CanonicalVocabulary {
    name: String,
    values: Vec<String>,
}

fn extract_vocabulary(source: &str) -> Result<Vec<CanonicalVocabulary>, String> {
    let mut result = Vec::new();
    let mut remaining = source;
    while let Some(offset) = remaining.find("export const ") {
        remaining = &remaining[offset + "export const ".len()..];
        let name_end = remaining
            .find(|character: char| !character.is_ascii_alphanumeric() && character != '_')
            .ok_or("unterminated exported constant name")?;
        let name = &remaining[..name_end];
        let Some(equals_offset) = remaining[name_end..].find('=') else {
            return Err(format!("{name} is missing an initializer"));
        };
        let initializer = remaining[name_end + equals_offset + 1..].trim_start();
        if !initializer.starts_with('[') {
            remaining = initializer;
            continue;
        }

        let mut depth = 0usize;
        let mut end = None;
        for (index, character) in initializer.char_indices() {
            match character {
                '[' => depth += 1,
                ']' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(index + 1);
                        break;
                    }
                }
                _ => {}
            }
        }
        let end = end.ok_or_else(|| format!("{name} has an unclosed array"))?;
        // TypeScript permits a trailing comma; JSON does not.
        let mut json = initializer[..end].to_owned();
        if let Some(comma) = json.rfind(',') {
            if json[comma + 1..json.len() - 1].trim().is_empty() {
                json.remove(comma);
            }
        }
        let values: Vec<String> = serde_json::from_str(&json)
            .map_err(|error| format!("{name} is not a string vocabulary: {error}"))?;
        if values.is_empty() || values.iter().any(|value| value.is_empty()) {
            return Err(format!("{name} has an empty vocabulary value"));
        }
        let unique: std::collections::BTreeSet<_> = values.iter().collect();
        if unique.len() != values.len() {
            return Err(format!("{name} contains duplicate vocabulary values"));
        }
        result.push(CanonicalVocabulary {
            name: name.to_owned(),
            values,
        });
        remaining = &initializer[end..];
    }
    result.sort_by(|left, right| left.name.cmp(&right.name));
    if result.is_empty() {
        return Err("family has no exported vocabularies".into());
    }
    Ok(result)
}

#[test]
fn product_spine_typescript_and_rust_parity_hold() {
    let manifest: Manifest =
        serde_json::from_str(MANIFEST).expect("valid product-spine parity manifest");
    assert!(
        manifest.contract_version.split('.').count() == 3
            && manifest
                .contract_version
                .split('.')
                .all(|part| !part.is_empty() && part.parse::<u64>().is_ok()),
        "contract version must be x.y.z"
    );
    assert!(
        manifest.schema_version > 0,
        "schema version must be positive"
    );
    assert_eq!(
        manifest.limits.get("ARTIFACT_MAX_INLINE_CONTENT_BYTES"),
        Some(&65_536)
    );

    let expected = [
        ("Identity", "identity.ts", IDENTITY),
        ("Connections", "connections.ts", CONNECTIONS),
        ("Missions", "missions.ts", MISSIONS),
        (
            "ArtifactsAndRoutines",
            "artifacts-routines.ts",
            ARTIFACTS_AND_ROUTINES,
        ),
    ];
    assert_eq!(
        manifest.families.len(),
        expected.len(),
        "missing required family"
    );

    let mut families = Vec::new();
    for (name, source_name, source) in expected {
        assert!(
            manifest
                .families
                .iter()
                .any(|family| family.name == name && family.source == source_name),
            "missing required family {name}"
        );
        families.push(CanonicalFamily {
            name: name.to_owned(),
            vocabulary: extract_vocabulary(source).expect("valid TypeScript vocabulary"),
        });
    }
    families.sort_by(|left, right| left.name.cmp(&right.name));
    let limits = manifest
        .limits
        .iter()
        .map(|(name, value)| (name.clone(), *value))
        .collect();
    let payload = CanonicalPayload {
        contract_version: manifest.contract_version,
        schema_version: manifest.schema_version,
        limits,
        families,
    };
    let encoded = serde_json::to_vec(&payload).expect("serializable canonical payload");
    let actual = format!("{:x}", Sha256::digest(encoded));
    assert_eq!(
        actual, manifest.expected_canonical_sha256,
        "TypeScript vocabulary drifted from the manifest"
    );
    assert_eq!(
        actual, RUST_CANONICAL_SHA256,
        "Rust parity mirror drifted from the manifest"
    );
}
