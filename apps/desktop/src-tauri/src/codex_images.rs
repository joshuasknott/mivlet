//! Import Codex's subscription image results, never its host-file paths or tokens.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

use crate::local_computer::{artifacts, LocalComputerState};

const MAX_IMAGE_BYTES: usize = 24 * 1024 * 1024;
const MAX_IMAGES: usize = 16;
const TOOL: &str = "codex-image-generation";

pub(crate) fn instructions(enabled: bool) -> &'static str {
    if enabled {
        "For image generation use Codex's built-in imagegen tool through the ChatGPT subscription. Mivlet imports successful image results and displays an openable image artifact in this conversation. Do not use a separately billed OpenAI API image tool or claim success without a successful image-tool result. Subscription limits still apply; report missing capability or quota plainly."
    } else {
        "Image generation and delivery are unavailable for this request. Explain that Computer Use, its workspace and write access must be enabled before generating an image. Do not claim to have generated an image or use an API fallback."
    }
}

pub(crate) struct ImageScope {
    workspace: String,
    agent: String,
    generation: u64,
}

impl ImageScope {
    pub(crate) fn capture(
        computers: &LocalComputerState,
        workspace: &str,
        agent: &str,
    ) -> Result<Self, String> {
        computers.validate_target(workspace, agent)?;
        computers.tool_workspace_root(workspace, agent)?;
        let generation = computers
            .authority_for(workspace, agent)?
            .snapshot()?
            .generation;
        computers
            .begin_agent_operation(workspace, agent, generation)?
            .check()?;
        Ok(Self {
            workspace: workspace.into(),
            agent: agent.into(),
            generation,
        })
    }

    pub(crate) fn publish(
        &self,
        computers: &LocalComputerState,
        bytes: &[u8],
    ) -> Result<String, String> {
        crate::execution_control::ensure_active_execution_allowed()?;
        let artifact = artifacts::publish_generated_png(
            computers,
            &self.workspace,
            &self.agent,
            self.generation,
            "Generated image",
            bytes,
        )?;
        serde_json::to_string(&artifact)
            .map_err(|_| "Mivlet could not prepare the generated image receipt.".into())
    }
}

/// Per-request state. The stop lock linearizes import/delivery against interruption.
/// Provider thread/turn ids and item ids prevent cross-turn or duplicate imports.
pub(crate) struct ImageDelivery {
    pub(crate) stopped: Arc<Mutex<bool>>,
    thread: Option<String>,
    turn: Option<String>,
    started: HashSet<String>,
    completed: HashSet<String>,
    enabled: bool,
}

impl ImageDelivery {
    pub(crate) fn new(enabled: bool) -> Self {
        Self {
            stopped: Arc::new(Mutex::new(false)),
            thread: None,
            turn: None,
            started: HashSet::new(),
            completed: HashSet::new(),
            enabled,
        }
    }

    pub(crate) fn bind_thread(&mut self, thread: &str) {
        self.thread = Some(thread.into());
    }

    pub(crate) fn observe(
        &mut self,
        value: &Value,
        mut publish: impl FnMut(&[u8]) -> Result<String, String>,
        mut emit: impl FnMut(Value),
    ) {
        let Ok(mut stopped) = self.stopped.lock() else {
            return;
        };
        if *stopped {
            return;
        }
        let method = value["method"].as_str().unwrap_or("");
        let params = &value["params"];
        // The adapter treats provider errors as terminal, even when the provider
        // omits a thread id. Do not import queued results after that terminal.
        if method == "error" {
            *stopped = true;
            return;
        }
        if params["threadId"].as_str() != self.thread.as_deref() || self.thread.is_none() {
            return;
        }
        if method == "turn/started" {
            if self.turn.is_none() {
                self.turn = params
                    .pointer("/turn/id")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            return;
        }
        if method == "turn/completed" {
            if params.pointer("/turn/id").and_then(Value::as_str) == self.turn.as_deref()
                && self.turn.is_some()
            {
                for id in self.started.difference(&self.completed) {
                    emit(event(
                        id,
                        "failed",
                        Some("Codex ended the turn without delivering this image.".into()),
                    ));
                }
                *stopped = true;
            }
            return;
        }
        if !matches!(method, "item/started" | "item/completed")
            || params["turnId"].as_str() != self.turn.as_deref()
            || self.turn.is_none()
            || params.pointer("/item/type").and_then(Value::as_str) != Some("imageGeneration")
        {
            return;
        }
        let item = &params["item"];
        let Some(id) = item["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control))
        else {
            return;
        };
        if self.completed.contains(id) {
            return;
        }
        if !self.started.contains(id) {
            if self.started.len() >= MAX_IMAGES {
                emit(
                    json!({"type":"error", "message":"Codex exceeded Mivlet's limit of 16 image results per turn. Remaining images were not imported."}),
                );
                *stopped = true;
                return;
            }
            self.started.insert(id.into());
            emit(event(id, "running", None));
        }
        if method != "item/completed" {
            return;
        }
        self.completed.insert(id.into());
        let result = if !self.enabled {
            Err("Image delivery is unavailable. Enable Computer Use for this agent and start a new request with write access.".into())
        } else {
            decode_result(item).and_then(|bytes| publish(&bytes))
        };
        match result {
            Ok(receipt) => emit(event(id, "succeeded", Some(receipt))),
            Err(message) => emit(event(id, "failed", Some(message))),
        }
    }
}

fn event(id: &str, status: &str, output: Option<String>) -> Value {
    json!({"type":"provider-tool", "callId":format!("codex-image:{id}"),
        "tool":TOOL, "arguments":"{}", "status":status, "output":output})
}

fn decode_result(item: &Value) -> Result<Vec<u8>, String> {
    if item["status"].as_str() != Some("completed") || !item["failure"].is_null() {
        return Err(if item.pointer("/failure/type").and_then(Value::as_str) == Some("usageLimitExceeded") {
            "Codex image generation reached your subscription usage limit. Wait for it to reset or check your Codex plan. No OpenAI API fallback was used."
        } else {
            "Codex did not generate an image. Check image-generation availability for your ChatGPT sign-in and try again. No OpenAI API fallback was used."
        }.into());
    }
    // The protocol's result is base64 PNG. savedPath and revisedPrompt are
    // untrusted and deliberately ignored: no arbitrary host reads or raw payload
    // is allowed into the renderer, audit log, or durable conversation.
    let encoded = item["result"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or("Codex reported completion without image data. Update Codex and try again.")?;
    if encoded.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
        return Err("The Codex image exceeds Mivlet's 24 MB image limit.".into());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "Codex returned invalid image data.")?;
    crate::media_images::validate_generated_png(&bytes)?;
    Ok(bytes)
}

#[cfg(test)]
#[path = "codex_images_tests.rs"]
mod tests;
