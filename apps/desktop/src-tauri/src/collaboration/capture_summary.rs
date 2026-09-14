//! Local incremental compaction of the exact transcript prefix omitted from a
//! Work snapshot. Only raw terminal text is folded; injected Memory never is.
use super::*;
use crate::store::repos::{message::MessageRow, preferences};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fold {
    through_sequence: i64,
    fingerprint: String,
    text: String,
}

fn fingerprint(rows: &[&MessageRow]) -> String {
    let mut hash = Sha256::new();
    for row in rows {
        hash.update(row.id.as_bytes());
        hash.update([0]);
        hash.update(row.current_revision_id.as_bytes());
        hash.update([0]);
    }
    hex::encode(hash.finalize())
}

pub(super) fn capture(
    ctx: &Context<'_>,
    room: &Conversation,
    rows: &[MessageRow],
    before: i64,
) -> Result<serde_json::Value> {
    let omitted: Vec<_> = rows
        .iter()
        .filter(|row| {
            row.sequence < before
                && row.current_revision_state == "terminal"
                && matches!(row.kind.as_str(), "user" | "assistant")
        })
        .collect();
    if omitted.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    let path = format!(
        "chat-fold-{}.json",
        hex::encode(Sha256::digest(room.id.as_bytes()))
    );
    let (scope, key) =
        crate::store::private_document_location(std::path::Path::new(&path), &ctx.scope.private)
            .map_err(StoreError::Invalid)?;
    let saved: Fold = preferences::get_scoped(ctx.conn, ctx.store, &scope, &key)?
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    // A changed/deleted revision invalidates the entire derived prefix. Rebuild
    // from authoritative raw text; never keep a stale cached conclusion.
    let prefix: Vec<_> = omitted
        .iter()
        .copied()
        .filter(|row| row.sequence <= saved.through_sequence)
        .collect();
    let reusable = saved.through_sequence <= omitted.last().unwrap().sequence
        && fingerprint(&prefix) == saved.fingerprint;
    let mut fold = if reusable { saved } else { Fold::default() };
    for row in omitted
        .iter()
        .filter(|row| row.sequence > fold.through_sequence)
        .copied()
        .collect::<Vec<_>>()
    {
        let text: String = row.content["text"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(500)
            .collect();
        fold.text.push_str(&format!("\n{}: {}", row.kind, text));
        if fold.text.chars().count() > 8_000 {
            // Preserve the early brief and the newest progress within a fixed
            // budget. This is a labelled extract, not a claimed semantic model.
            let head: String = fold.text.chars().take(3_500).collect();
            let tail: String = fold
                .text
                .chars()
                .rev()
                .take(4_000)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            fold.text = format!("{head}\n[Earlier detail omitted]\n{tail}");
        }
    }
    fold.through_sequence = omitted.last().unwrap().sequence;
    fold.fingerprint = fingerprint(&omitted);
    preferences::upsert_scoped(
        ctx.conn,
        ctx.store,
        &scope,
        &key,
        &serde_json::to_value(&fold).map_err(|_| invalid("Cannot encode Chat compaction."))?,
        ctx.time,
    )?;
    Ok(
        serde_json::json!({"kind":"local-transcript-extract","threadId":room.id,"fromSequence":omitted[0].sequence,"throughSequence":fold.through_sequence,"text":fold.text,"sourceFingerprint":fold.fingerprint,"derivedMemoryIds":[],"instructionAuthority":"none"}),
    )
}
