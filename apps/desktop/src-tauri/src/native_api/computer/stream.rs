//! Bounded native reconstruction of provider-emitted function calls. Renderer
//! messages cannot create the pending call needed to capture or act on pixels.
use serde_json::Value;
use std::collections::BTreeMap;

const INVALID: &str = "The provider returned an incomplete or invalid computer tool stream.";
const MAX_ARGUMENTS: usize = 64_000;
const MAX_CALLS: usize = 80;

pub(super) struct Call {
    pub call_id: String,
    pub tool: String,
    pub arguments: Value,
}

#[derive(Default)]
struct Buffer {
    id: String,
    name: String,
    arguments: String,
    initial: Option<Value>,
}

impl Buffer {
    fn finish(self) -> Result<Call, String> {
        if self.id.is_empty()
            || self.id.len() > 160
            || !self
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_".contains(c))
            || self.name.is_empty()
            || self.name.len() > 200
        {
            return Err(INVALID.into());
        }
        let arguments = if self.arguments.is_empty() {
            self.initial.unwrap_or_else(|| serde_json::json!({}))
        } else {
            if self
                .initial
                .as_ref()
                .is_some_and(|v| v.as_object().is_none_or(|v| !v.is_empty()))
            {
                return Err(INVALID.into());
            }
            serde_json::from_str(&self.arguments).map_err(|_| INVALID)?
        };
        if !arguments.is_object() || arguments.to_string().len() > MAX_ARGUMENTS {
            return Err(INVALID.into());
        }
        Ok(Call {
            call_id: self.id,
            tool: self.name,
            arguments,
        })
    }
}

pub(super) struct ToolCalls {
    anthropic: bool,
    pending: BTreeMap<u64, Buffer>,
    finish_reason: Option<String>,
    stopped: bool,
    emitted: usize,
}

impl ToolCalls {
    pub fn new(provider: &str) -> Self {
        Self {
            anthropic: provider == "anthropic",
            pending: BTreeMap::new(),
            finish_reason: None,
            stopped: false,
            emitted: 0,
        }
    }

    pub fn complete(&self) -> bool {
        self.pending.is_empty()
            && self.stopped
            && self.finish_reason.as_ref().is_some_and(|reason| {
                matches!(
                    reason.as_str(),
                    "stop" | "length" | "end_turn" | "max_tokens" | "stop_sequence"
                ) && self.emitted == 0
                    || matches!(reason.as_str(), "tool_calls" | "tool_use") && self.emitted > 0
            })
    }

    pub fn observe(&mut self, payload: &str) -> Result<Vec<Call>, String> {
        let value: Value = serde_json::from_str(payload).map_err(|_| INVALID)?;
        if value.get("error").is_some() {
            return Err(INVALID.into());
        }
        let calls = if self.anthropic {
            self.anthropic(&value)?
        } else {
            self.openai(&value)?
        };
        self.emitted += calls.len();
        if self.emitted > MAX_CALLS || self.pending.len() > MAX_CALLS {
            return Err(INVALID.into());
        }
        Ok(calls)
    }

    fn openai(&mut self, value: &Value) -> Result<Vec<Call>, String> {
        if value["choices"].as_array().is_some_and(|v| v.len() > 1) {
            return Err(INVALID.into());
        }
        let choice = &value["choices"][0];
        if let Some(fragments) = choice["delta"]["tool_calls"].as_array() {
            if self.stopped {
                return Err(INVALID.into());
            }
            for fragment in fragments {
                let index = fragment["index"]
                    .as_u64()
                    .filter(|i| *i < MAX_CALLS as u64)
                    .ok_or(INVALID)?;
                let buffered = self.pending.entry(index).or_default();
                if let Some(id) = fragment["id"].as_str() {
                    if !buffered.id.is_empty() && buffered.id != id {
                        return Err(INVALID.into());
                    }
                    buffered.id = id.into();
                }
                append(
                    &mut buffered.name,
                    fragment["function"]["name"].as_str(),
                    200,
                )?;
                append(
                    &mut buffered.arguments,
                    fragment["function"]["arguments"].as_str(),
                    MAX_ARGUMENTS,
                )?;
            }
        }
        if let Some(reason) = choice["finish_reason"].as_str() {
            if self.stopped {
                return Err(INVALID.into());
            }
            self.stopped = true;
            self.finish_reason = Some(reason.into());
            if reason == "tool_calls" {
                return std::mem::take(&mut self.pending)
                    .into_values()
                    .map(Buffer::finish)
                    .collect();
            }
        }
        Ok(Vec::new())
    }

    fn anthropic(&mut self, value: &Value) -> Result<Vec<Call>, String> {
        let kind = value["type"].as_str().ok_or(INVALID)?;
        if self.stopped && kind != "ping" {
            return Err(INVALID.into());
        }
        match kind {
            "content_block_start" if value["content_block"]["type"] == "tool_use" => {
                if self.finish_reason.is_some() {
                    return Err(INVALID.into());
                }
                let index = value["index"].as_u64().ok_or(INVALID)?;
                let block = &value["content_block"];
                if self
                    .pending
                    .insert(
                        index,
                        Buffer {
                            id: block["id"].as_str().ok_or(INVALID)?.into(),
                            name: block["name"].as_str().ok_or(INVALID)?.into(),
                            initial: block.get("input").cloned(),
                            arguments: String::new(),
                        },
                    )
                    .is_some()
                {
                    return Err(INVALID.into());
                }
            }
            "content_block_delta" if value["delta"]["type"] == "input_json_delta" => {
                let index = value["index"].as_u64().ok_or(INVALID)?;
                let buffer = self.pending.get_mut(&index).ok_or(INVALID)?;
                append(
                    &mut buffer.arguments,
                    value["delta"]["partial_json"].as_str(),
                    MAX_ARGUMENTS,
                )?;
            }
            "content_block_stop" => {
                let index = value["index"].as_u64().ok_or(INVALID)?;
                if let Some(buffer) = self.pending.remove(&index) {
                    return Ok(vec![buffer.finish()?]);
                }
            }
            "message_delta" => {
                if let Some(reason) = value["delta"]["stop_reason"].as_str() {
                    if self.finish_reason.replace(reason.into()).is_some() {
                        return Err(INVALID.into());
                    }
                }
            }
            "message_stop" => {
                self.stopped = true;
            }
            _ => {}
        }
        Ok(Vec::new())
    }
}

fn append(target: &mut String, fragment: Option<&str>, limit: usize) -> Result<(), String> {
    if let Some(fragment) = fragment {
        if target.len().saturating_add(fragment.len()) > limit {
            return Err(INVALID.into());
        }
        target.push_str(fragment);
    }
    Ok(())
}
