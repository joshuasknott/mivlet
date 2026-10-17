//! Explicit, one-shot native file imports. Only sanitized measurements are retained.
//! No home-directory discovery, auth-file reads, transcript persistence or background scans.
use super::history::Receipt;
use super::*;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::{BufRead, BufReader, Read},
    path::Path,
    time::Instant,
};

const KEY: &str = "provider-usage-imported-measurements";
const MAX_RECORDS: usize = 20000;
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_LINE_BYTES: u64 = 1024 * 1024;

#[derive(Default, Deserialize, Serialize)]
pub(super) struct History {
    pub records: BTreeMap<String, Receipt>,
    skipped: u64,
    imported_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    records: usize,
    skipped: u64,
    imported_at: Option<String>,
    providers: BTreeSet<String>,
}

impl History {
    pub(super) fn summary(&self) -> Summary {
        Summary {
            records: self.records.len(),
            skipped: self.skipped,
            imported_at: self.imported_at.clone(),
            providers: self
                .records
                .values()
                .map(|r| r.provider_id.clone())
                .collect(),
        }
    }
    fn merge(&mut self, record: Receipt) {
        // Message snapshots replace each other; repeated files/imports never add another copy.
        if self.records.contains_key(&record.id) || self.records.len() < MAX_RECORDS {
            let replace = self.records.get(&record.id).is_none_or(|old| {
                record
                    .usage
                    .input_tokens
                    .saturating_add(record.usage.output_tokens)
                    >= old
                        .usage
                        .input_tokens
                        .saturating_add(old.usage.output_tokens)
            });
            if replace {
                self.records.insert(record.id.clone(), record);
            }
        } else {
            self.skipped += 1;
        }
    }
}

pub(super) fn load(
    conn: &Connection,
    store: &Store,
    scope: &AuthorizedCommandScope,
) -> Result<History> {
    preferences::get_scoped(conn, store, &scope.data, KEY)?
        .map(serde_json::from_value)
        .transpose()
        .map(|v| v.unwrap_or_default())
        .map_err(|_| invalid("Imported usage measurements are invalid."))
}

fn text(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 200 && !s.chars().any(char::is_control))
}
fn count(value: &Value) -> Option<u64> {
    value.as_u64().filter(|n| *n <= 1_000_000_000)
}
fn observed(value: &Value) -> Option<String> {
    iso(&value["timestamp"])
}
fn model(value: &Value) -> Option<String> {
    text(value)
        .filter(|s| !crate::secret_redaction::looks_secret(s))
        .map(str::to_owned)
}

#[derive(Default)]
struct CodexState {
    session: String,
    model: String,
    excluded_fork: bool,
    fast: bool,
}

fn codex_record(value: &Value, state: &mut CodexState) -> Option<Receipt> {
    let payload = &value["payload"];
    match value["type"].as_str()? {
        "session_meta" => {
            if state.session.is_empty() {
                state.session = text(&payload["id"])
                    .or_else(|| text(&payload["session_id"]))?
                    .into();
                // Forked files contain copied parent history. Exclude them rather than guess ownership.
                state.excluded_fork = payload.get("forked_from_id").is_some()
                    || payload
                        .pointer("/source/subagent/thread_spawn/parent_thread_id")
                        .is_some();
            }
            return None;
        }
        "turn_context" => {
            state.model = model(&payload["model"]).unwrap_or_default();
            return None;
        }
        "event_msg" => {}
        _ => return None,
    }
    if payload["type"] == "thread_settings_applied" {
        state.fast = matches!(
            payload
                .pointer("/thread_settings/service_tier")
                .and_then(Value::as_str),
            Some("priority" | "fast" | "ultrafast")
        );
        return None;
    }
    if payload["type"] != "token_count"
        || state.excluded_fork
        || state.session.is_empty()
        || state.model.is_empty()
    {
        return None;
    }
    let info = &payload["info"];
    let last = &info["last_token_usage"];
    let total = &info["total_token_usage"];
    // Cumulative counters provide a stable call boundary even when a snapshot is re-emitted.
    count(&total["input_tokens"])?;
    count(&total["output_tokens"])?;
    let input = count(&last["input_tokens"])?;
    let output = count(&last["output_tokens"])?;
    let cached = last
        .get("cached_input_tokens")
        .map(count)
        .transpose_option()?;
    let writes = last
        .get("cache_write_input_tokens")
        .map(count)
        .transpose_option()?;
    // Codex transcript input includes any reported write portion; internal input excludes it.
    let input = input.checked_sub(writes.unwrap_or(0))?;
    if cached.is_some_and(|n| n > input) {
        return None;
    }
    let reasoning = last
        .get("reasoning_output_tokens")
        .map(count)
        .transpose_option()?;
    if reasoning.is_some_and(|n| n > output) {
        return None;
    }
    Some(Receipt {
        id: hash(&format!("codex:{}:{}", state.session, total)),
        provider_id: "codex".into(),
        model: state.model.clone(),
        observed_at: observed(value)?,
        standard_pricing: !state.fast,
        usage: crate::models::ExecutionAttemptUsage {
            input_tokens: input,
            output_tokens: output,
            cached_input_tokens: cached,
            cache_write_tokens: writes,
            reasoning_tokens: reasoning,
            cost_usd: 0.0,
            cost_estimated: false,
            cost_unknown: Some(true),
            observed_at: observed(value),
            pricing_tier: Some(if state.fast { "fast" } else { "standard" }.into()),
        },
    })
}

/// Keep absent categories absent while rejecting malformed present categories.
trait TransposeOption {
    fn transpose_option(self) -> Option<Option<u64>>;
}
impl TransposeOption for Option<Option<u64>> {
    fn transpose_option(self) -> Option<Option<u64>> {
        match self {
            None => Some(None),
            Some(Some(n)) => Some(Some(n)),
            Some(None) => None,
        }
    }
}

fn claude_record(value: &Value) -> Option<Receipt> {
    if value["type"] != "assistant" {
        return None;
    }
    let message = &value["message"];
    let usage = &message["usage"];
    let id = text(&message["id"]).or_else(|| text(&value["requestId"]))?;
    let session = text(&value["sessionId"])?;
    let input = count(&usage["input_tokens"])?;
    let cached = usage
        .get("cache_read_input_tokens")
        .map(count)
        .transpose_option()?;
    let write = usage
        .get("cache_creation_input_tokens")
        .map(count)
        .transpose_option()?;
    let output = count(&usage["output_tokens"])?;
    let sdk_cost = value["costUSD"]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0);
    Some(Receipt {
        id: hash(&format!("claude:{session}:{id}")),
        provider_id: "claude".into(),
        model: model(&message["model"])?,
        observed_at: observed(value)?,
        standard_pricing: usage["speed"] != "fast",
        usage: crate::models::ExecutionAttemptUsage {
            input_tokens: input.checked_add(cached.unwrap_or(0))?,
            output_tokens: output,
            cached_input_tokens: cached,
            cache_write_tokens: write,
            reasoning_tokens: None,
            cost_usd: sdk_cost.unwrap_or(0.0),
            cost_estimated: true,
            cost_unknown: Some(sdk_cost.is_none()),
            observed_at: observed(value),
            pricing_tier: Some(
                if usage["speed"] == "fast" {
                    "fast"
                } else {
                    "standard"
                }
                .into(),
            ),
        },
    })
}

fn read_file(
    path: &Path,
    provider: &str,
    history: &mut History,
    at: &str,
    started: Instant,
) -> std::result::Result<(), ()> {
    let file = File::open(path).map_err(|_| ())?;
    if file.metadata().map_err(|_| ())?.len() > MAX_FILE_BYTES {
        return Err(());
    }
    let mut reader = BufReader::new(file);
    let mut state = CodexState::default();
    let mut line = Vec::new();
    let cutoff = (DateTime::parse_from_rfc3339(at).map_err(|_| ())? - Duration::days(91))
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    loop {
        if started.elapsed() > std::time::Duration::from_secs(20) {
            return Err(());
        }
        line.clear();
        if reader
            .by_ref()
            .take(MAX_LINE_BYTES + 1)
            .read_until(b'\n', &mut line)
            .map_err(|_| ())?
            == 0
        {
            break;
        }
        if line.len() as u64 > MAX_LINE_BYTES {
            return Err(());
        }
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            history.skipped += 1;
            continue;
        };
        let record = if provider == "codex" {
            codex_record(&value, &mut state)
        } else {
            claude_record(&value)
        };
        if let Some(record) = record {
            if record.observed_at >= cutoff && record.observed_at.as_str() <= at {
                history.merge(record);
            }
        } else if value.pointer("/payload/type").and_then(Value::as_str) == Some("token_count")
            || (value["type"] == "assistant" && value.pointer("/message/usage").is_some())
        {
            history.skipped += 1;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn import_provider_usage_history(
    app: tauri::AppHandle,
    provider_id: String,
) -> std::result::Result<Summary, String> {
    if !matches!(provider_id.as_str(), "codex" | "claude") {
        return Err("Choose Codex or Claude session history.".into());
    }
    let store = crate::store::try_global().ok_or("Encrypted storage is unavailable.")?;
    let scope = store
        .with_conn(|conn| authorized_scope::resolve(conn, None, None, ScopeAccess::Read))
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let paths = rfd::FileDialog::new()
            .set_title("Choose external session history (measurements only)")
            .add_filter("Session history", &["jsonl"])
            .pick_files();
        store
            .with_conn(|conn| {
                let current = authorized_scope::resolve(conn, None, None, ScopeAccess::Read)?;
                if current.internal_user_id != scope.internal_user_id
                    || current.data.workspace_id() != scope.data.workspace_id()
                {
                    return Err(invalid("The account or workspace changed during import."));
                }
                Ok(())
            })
            .map_err(|e| e.to_string())?;
        let Some(paths) = paths else {
            return store
                .with_conn(|conn| Ok(load(conn, store, &scope)?.summary()))
                .map_err(|e| e.to_string());
        };
        if paths.len() > 64 {
            return Err("Choose at most 64 session files per import.".into());
        }
        let app_data = crate::paths::app_data_dir(&app)?
            .canonicalize()
            .map_err(|_| "Mivlet data directory is unavailable.")?;
        let at = time();
        let mut imported = History::default();
        let started = Instant::now();
        let mut bytes = 0_u64;
        for path in paths {
            let Ok(path) = path.canonicalize() else {
                imported.skipped += 1;
                continue;
            };
            let size = path
                .metadata()
                .map(|m| m.len())
                .unwrap_or(MAX_FILE_BYTES + 1);
            bytes = bytes.saturating_add(size);
            if path.starts_with(&app_data)
                || path.extension().is_none_or(|ext| ext != "jsonl")
                || bytes > 128 * 1024 * 1024
                || read_file(&path, &provider_id, &mut imported, &at, started).is_err()
            {
                imported.skipped += 1;
            }
        }
        store
            .transaction(|conn| {
                let current = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
                if current.internal_user_id != scope.internal_user_id
                    || current.data.workspace_id() != scope.data.workspace_id()
                {
                    return Err(invalid("The account or workspace changed during import."));
                }
                let mut saved = load(conn, store, &scope)?;
                let cutoff =
                    (Utc::now() - Duration::days(91)).to_rfc3339_opts(SecondsFormat::Millis, true);
                saved.records.retain(|_, r| r.observed_at >= cutoff);
                for record in imported.records.into_values() {
                    saved.merge(record);
                }
                saved.skipped = imported.skipped;
                saved.imported_at = Some(at.clone());
                preferences::upsert_scoped(conn, store, &scope.data, KEY, &json!(saved), &at)?;
                Ok(saved.summary())
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "Usage import stopped unexpectedly.")?
}

#[tauri::command]
pub(crate) fn clear_imported_provider_usage() -> std::result::Result<(), String> {
    let store = crate::store::try_global().ok_or("Encrypted storage is unavailable.")?;
    store
        .transaction(|conn| {
            let scope = authorized_scope::resolve(conn, None, None, ScopeAccess::Write)?;
            preferences::upsert_scoped(
                conn,
                store,
                &scope.data,
                KEY,
                &json!(History::default()),
                &time(),
            )
        })
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn claude_snapshots_and_reimports_count_once_and_keep_only_measurements() {
        let value = json!({"type":"assistant","sessionId":"session","timestamp":"2026-10-17T12:00:00Z","message":{"id":"message","model":"exact","content":"private text","usage":{"input_tokens":100,"cache_read_input_tokens":40,"cache_creation_input_tokens":10,"output_tokens":20}}});
        let mut history = History::default();
        history.merge(claude_record(&value).unwrap());
        history.merge(claude_record(&value).unwrap());
        let record = history.records.values().next().unwrap();
        assert_eq!(history.records.len(), 1);
        assert_eq!(record.usage.input_tokens, 140);
        assert_eq!(record.usage.cache_write_tokens, Some(10));
        assert_eq!(record.usage.reasoning_tokens, None);
        let encoded = serde_json::to_string(&history).unwrap();
        assert!(!encoded.contains("private text"));
        assert!(!encoded.contains("session"));
        assert!(!encoded.contains("message"));
    }
    #[test]
    fn codex_cumulative_keys_deduplicate_copies_and_exclude_fork_history() {
        let mut state = CodexState {
            session: "session".into(),
            model: "exact".into(),
            ..Default::default()
        };
        let event = json!({"type":"event_msg","timestamp":"2026-10-17T12:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":150,"output_tokens":20},"last_token_usage":{"input_tokens":150,"cached_input_tokens":40,"cache_write_input_tokens":10,"output_tokens":20,"reasoning_output_tokens":5}}}});
        let mut history = History::default();
        history.merge(codex_record(&event, &mut state).unwrap());
        history.merge(codex_record(&event, &mut state).unwrap());
        assert_eq!(history.records.len(), 1);
        let usage = &history.records.values().next().unwrap().usage;
        assert_eq!(
            usage.input_tokens + usage.cache_write_tokens.unwrap() + usage.output_tokens,
            170
        );
        state.excluded_fork = true;
        assert!(codex_record(&event, &mut state).is_none());
        let mut malformed = event;
        malformed["payload"]["info"]["last_token_usage"]["cached_input_tokens"] = json!(999);
        state.excluded_fork = false;
        assert!(codex_record(&malformed, &mut state).is_none());
    }
}
