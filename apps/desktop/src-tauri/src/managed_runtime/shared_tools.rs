//! Turn-scoped Mivlet tools, shared by provider transports. This module only
//! negotiates and dispatches calls; the existing executor owns all effects.
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const MAX_FRAME: usize = 1024 * 1024;
const MAX_CALLS: usize = 64;

#[derive(Clone, Debug, Deserialize)]
pub(super) struct ToolSpec {
    name: String,
    description: String,
    parameters: String,
}

#[derive(Default)]
pub(super) struct ToolBridge {
    tools: Vec<Value>,
    pending: HashMap<String, Value>,
    delivering: HashSet<String>,
    seen: HashSet<String>,
    calls: usize,
    stopped: bool,
}

pub(super) enum Dispatch {
    Reply(Value),
    Call(Value),
}

fn rpc_error(id: Value, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":message}})
}

impl ToolBridge {
    pub fn new(specs: &[ToolSpec]) -> Result<Self, String> {
        if specs.len() > 128 {
            return Err("Too many Mivlet tools for this turn.".into());
        }
        let mut tools = Vec::new();
        for spec in specs {
            // Images need native egress custody, not a text-only MCP result.
            // Transport validation is separate from the one shared registry.
            // Every call is checked against that registry by the dispatcher,
            // then its owning native executor validates exact authority.
            if spec.name.is_empty()
                || spec.name.len() > 128
                || !spec
                    .name
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                || spec.name.starts_with("local-desktop-")
                || spec.name == "run-shell"
                || spec.description.len() > 16_384
                || spec.parameters.len() > 65_536
                || tools.iter().any(|v: &Value| v["name"] == spec.name)
            {
                return Err("This turn requested an unsupported or duplicate Mivlet tool.".into());
            }
            let schema: Value = serde_json::from_str(&spec.parameters)
                .map_err(|_| "The Mivlet tool schema is invalid.")?;
            if schema["type"] != "object" {
                return Err("Mivlet tools require object input schemas.".into());
            }
            tools.push(
                json!({"name":spec.name,"description":spec.description,"inputSchema":schema}),
            );
        }
        Ok(Self {
            tools,
            ..Default::default()
        })
    }

    pub fn owns(&self, provider_name: &str) -> bool {
        !self.stopped
            && provider_name
                .strip_prefix("mcp__mivlet__")
                .is_some_and(|name| self.tools.iter().any(|tool| tool["name"] == name))
    }

    pub fn dispatch(&mut self, control_id: &str, message: &Value) -> Result<Dispatch, String> {
        if self.stopped
            || control_id.is_empty()
            || control_id.len() > 256
            || message.to_string().len() > MAX_FRAME
            || message["jsonrpc"] != "2.0"
        {
            return Err("The provider sent an invalid Mivlet tool frame.".into());
        }
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        if !matches!(id, Value::Null | Value::String(_) | Value::Number(_)) {
            return Err("The provider sent an invalid tool request id.".into());
        }
        let result = match message["method"].as_str() {
            Some("initialize") => {
                let requested = message["params"]["protocolVersion"].as_str().unwrap_or("");
                let version = match requested {
                    "2025-11-25" | "2025-06-18" | "2025-03-26" | "2024-11-05" => requested,
                    _ => "2025-11-25",
                };
                json!({"protocolVersion":version,"capabilities":{"tools":{}},
                    "serverInfo":{"name":"mivlet","version":"1"}})
            }
            Some("notifications/initialized" | "ping") => json!({}),
            Some("tools/list") => json!({"tools":self.tools}),
            Some("tools/call") => {
                let name = message["params"]["name"].as_str().unwrap_or("");
                let args = message["params"]
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                if id.is_null()
                    || !args.is_object()
                    || !self.tools.iter().any(|tool| tool["name"] == name)
                {
                    return Ok(Dispatch::Reply(rpc_error(
                        id,
                        "This tool is unavailable for this turn.",
                    )));
                }
                if self.calls >= MAX_CALLS || self.seen.contains(control_id) {
                    return Ok(Dispatch::Reply(rpc_error(
                        id,
                        "This turn reached its tool limit or reused a pending request.",
                    )));
                }
                let opaque = crate::local_computer::desktop_tools::opaque_id()?;
                let approval_id = format!("mivlet-shared-{opaque}");
                let event = json!({"type":"tool-request","requestId":control_id,
                    "callId":approval_id,"approvalId":approval_id,"tool":name,"arguments":args.to_string()});
                self.pending.insert(
                    control_id.to_string(),
                    json!({"id":id,"callId":approval_id,"tool":name,"arguments":args}),
                );
                self.seen.insert(control_id.to_string());
                self.calls += 1;
                return Ok(Dispatch::Call(event));
            }
            _ => {
                return Ok(Dispatch::Reply(rpc_error(
                    id,
                    "This MCP method is unavailable.",
                )))
            }
        };
        Ok(Dispatch::Reply(
            json!({"jsonrpc":"2.0","id":id,"result":result}),
        ))
    }

    pub fn respond(
        &mut self,
        request_id: &str,
        call_id: &str,
        ok: bool,
        output: &str,
    ) -> Result<Value, String> {
        if output.len() > MAX_FRAME {
            return Err("The Mivlet tool result exceeds the response limit.".into());
        }
        let pending = self
            .pending
            .get(request_id)
            .ok_or("This Mivlet tool call is no longer pending.")?;
        if pending["callId"] != call_id {
            return Err("The Mivlet tool response belongs to a different call.".into());
        }
        let id = pending["id"].clone();
        self.pending.remove(request_id);
        self.delivering.insert(request_id.into());
        Ok(json!({"jsonrpc":"2.0","id":id,"result":{
            "content":[{"type":"text","text":output}],"isError":!ok}}))
    }

    pub fn cancel(&mut self, request_id: &str) {
        self.pending.remove(request_id);
        self.delivering.remove(request_id);
    }

    pub fn delivering(&self, request_id: &str) -> bool {
        !self.stopped && self.delivering.contains(request_id)
    }

    pub fn finish_response(&mut self, request_id: &str) {
        self.delivering.remove(request_id);
    }

    pub fn stop(&mut self) {
        self.stopped = true;
        self.pending.clear();
        self.delivering.clear();
    }

    pub fn current(&self, approval_id: &str, tool: &str, arguments: &Value) -> bool {
        !self.stopped
            && self.pending.values().any(|call| {
                call["callId"] == approval_id
                    && call["tool"] == tool
                    && &call["arguments"] == arguments
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bridge() -> ToolBridge {
        ToolBridge::new(&[ToolSpec {
            name: "read-file".into(),
            description: "Read scoped file".into(),
            parameters: r#"{"type":"object"}"#.into(),
        }])
        .unwrap()
    }
    fn call(name: &str) -> Value {
        json!({"jsonrpc":"2.0","id":"rpc-1","method":"tools/call",
            "params":{"name":name,"arguments":{"path":"report.md"}}})
    }
    #[test]
    fn only_admitted_registered_tools_are_listed_and_dispatched() {
        let mut bridge = bridge();
        assert!(bridge.owns("mcp__mivlet__read-file"));
        assert!(!bridge.owns("mcp__other__read-file"));
        assert!(matches!(
            bridge.dispatch("unknown", &call("write-file")).unwrap(),
            Dispatch::Reply(_)
        ));
        let Dispatch::Call(event) = bridge.dispatch("control-1", &call("read-file")).unwrap()
        else {
            panic!()
        };
        assert_eq!(event["tool"], "read-file");
        assert_eq!(event["arguments"], r#"{"path":"report.md"}"#);
        assert!(bridge.current(
            event["callId"].as_str().unwrap(),
            "read-file",
            &json!({"path":"report.md"})
        ));
        assert!(!bridge.current(
            event["callId"].as_str().unwrap(),
            "write-file",
            &json!({"path":"report.md"})
        ));
        assert!(matches!(
            bridge.dispatch("control-1", &call("read-file")).unwrap(),
            Dispatch::Reply(_)
        ));
        assert!(bridge.respond("control-1", "wrong", true, "ok").is_err());
        let result = bridge
            .respond(
                "control-1",
                event["callId"].as_str().unwrap(),
                false,
                "denied",
            )
            .unwrap();
        assert_eq!(result["id"], "rpc-1");
        assert_eq!(result["result"]["isError"], true);
        assert!(bridge
            .respond(
                "control-1",
                event["callId"].as_str().unwrap(),
                true,
                "replay"
            )
            .is_err());
        assert!(matches!(
            bridge.dispatch("control-1", &call("read-file")).unwrap(),
            Dispatch::Reply(_)
        ));
    }
    #[test]
    fn cancellation_and_call_budget_prevent_late_or_unbounded_execution() {
        let mut bridge = bridge();
        let Dispatch::Call(event) = bridge.dispatch("cancel", &call("read-file")).unwrap() else {
            panic!()
        };
        bridge.cancel("cancel");
        assert!(!bridge.current(
            event["callId"].as_str().unwrap(),
            "read-file",
            &json!({"path":"report.md"})
        ));
        assert!(bridge
            .respond("cancel", event["callId"].as_str().unwrap(), true, "late")
            .is_err());
        for index in 1..MAX_CALLS {
            assert!(matches!(
                bridge
                    .dispatch(&index.to_string(), &call("read-file"))
                    .unwrap(),
                Dispatch::Call(_)
            ));
        }
        assert!(matches!(
            bridge.dispatch("over-limit", &call("read-file")).unwrap(),
            Dispatch::Reply(_)
        ));
        bridge.stop();
        assert!(bridge.pending.is_empty());
        assert!(bridge.dispatch("new", &call("read-file")).is_err());
    }
    #[test]
    fn rejects_host_shell_images_invalid_names_and_malformed_schemas() {
        for name in ["run-shell", "local-desktop-observe", "invalid tool"] {
            assert!(ToolBridge::new(&[ToolSpec {
                name: name.into(),
                description: "".into(),
                parameters: r#"{"type":"object"}"#.into()
            }])
            .is_err());
        }
        assert!(ToolBridge::new(&[ToolSpec {
            name: "read-file".into(),
            description: "".into(),
            parameters: "[]".into()
        }])
        .is_err());
        assert!(bridge()
            .dispatch(
                "bad",
                &json!({"jsonrpc":"2.0","id":{},"method":"tools/list"})
            )
            .is_err());
    }

    #[test]
    fn transports_shared_connector_and_collaboration_specs_without_a_second_registry() {
        for name in [
            "connector-call",
            "connector-action",
            "workspace-agents",
            "teammate-assign",
        ] {
            let spec = ToolSpec {
                name: name.into(),
                description: "".into(),
                parameters: r#"{"type":"object"}"#.into(),
            };
            let mut bridge = ToolBridge::new(&[spec]).unwrap();
            assert!(matches!(
                bridge.dispatch("request", &call(name)).unwrap(),
                Dispatch::Call(_)
            ));
        }
    }
}
