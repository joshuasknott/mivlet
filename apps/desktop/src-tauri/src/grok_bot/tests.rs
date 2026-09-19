use super::*;

#[test]
fn only_pinned_paired_healthy_companions_connect() {
    let status = json!({"state":"connected","mode":"paired_relay","gateway_healthy":true,"server_version":VERSION,"companion_version":VERSION,"capabilities":["status","list_bots","read_bot","send_message"]});
    assert!(validate_status(&status).is_ok());
    for (key, value) in [
        ("mode", json!("legacy_direct")),
        ("state", json!("not_paired")),
        ("gateway_healthy", json!(false)),
        ("server_version", json!("0.2.0")),
        ("companion_version", json!("next")),
        ("capabilities", json!(["status"])),
    ] {
        let mut invalid = status.clone();
        invalid[key] = value;
        assert!(validate_status(&invalid).is_err());
    }
}

#[test]
fn roster_rejects_duplicate_or_unsafe_targets() {
    assert!(validate_roster(&json!({"bots":[{"id":"a","name":"A"}]})).is_ok());
    for value in [
        json!({"bots":[{"id":"a","name":"A"},{"id":"a","name":"B"}]}),
        json!({"bots":[{"id":"a\n","name":"A"}]}),
        json!({"bots":false}),
    ] {
        assert!(validate_roster(&value).is_err());
    }
}

#[test]
fn launcher_has_only_the_pinned_bridge_and_scoped_provider_home() {
    let script = launch_script(&"a".repeat(64));
    assert!(script.contains("/usr/bin/env -i"));
    assert!(script.contains("0.2.0-beta.8/node_modules/codex-grok-mcp/dist/index.js"));
    assert!(script.contains("XDG_CONFIG_HOME="));
    for forbidden in ["grok_ask", "api.x.ai", "grok --", "npx", "RELAY_TOKEN"] {
        assert!(!script.contains(forbidden));
    }
}

#[tokio::test]
async fn wire_uses_structured_content_and_never_retries_errors() {
    // Real stdio subprocess fixture: no account, relay or provider request.
    let script = r#"let count=0; require('node:readline').createInterface({input:process.stdin}).on('line', line=>{ const r=JSON.parse(line); count++; console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:count===1?{content:[{type:'text',text:'DO-NOT-EXPOSE'}],structuredContent:{accepted:true}}:{isError:true,content:[{type:'text',text:'SECRET-CANARY'}]}})); });"#;
    let mut child = Command::new("node")
        .args(["-e", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let input = child.stdin.take().unwrap();
    let output = BufReader::new(child.stdout.take().unwrap());
    let mut wire = Wire {
        child,
        input,
        output,
        sequence: 0,
    };
    assert_eq!(
        wire.tool("grok_send_bot_message", json!({})).await.unwrap(),
        json!({"accepted":true})
    );
    let error = wire
        .tool("grok_send_bot_message", json!({}))
        .await
        .unwrap_err();
    assert!(!error.contains("SECRET-CANARY"));
    assert_eq!(wire.sequence, 2);
    let original = Scope {
        namespace: "account-a-workspace-a".into(),
        selection: Some("first".into()),
    };
    let (stop, _) = watch::channel(false);
    let session = Session {
        scope: original.clone(),
        stop,
        wire: tokio::sync::Mutex::new(wire),
        bots: HashSet::new(),
        sent: Mutex::new(HashSet::new()),
    };
    assert!(current(&session, &original).is_ok());
    assert!(current(
        &session,
        &Scope {
            namespace: "account-b-workspace-a".into(),
            selection: Some("first".into())
        }
    )
    .is_err());
    assert!(current(
        &session,
        &Scope {
            namespace: "account-a-workspace-b".into(),
            selection: Some("first".into())
        }
    )
    .is_err());
    assert!(current(
        &session,
        &Scope {
            namespace: original.namespace.clone(),
            selection: Some("returned-to-a".into())
        }
    )
    .is_err());
    assert!(reserve_send(&session.sent, "one-attempt".into()).is_ok());
    assert!(reserve_send(&session.sent, "one-attempt".into()).is_err());
    session.stop.send_replace(true);
    assert!(current(&session, &original).is_err());
    let mut wire = session.wire.lock().await;
    wire.child.kill().await.unwrap();
}
