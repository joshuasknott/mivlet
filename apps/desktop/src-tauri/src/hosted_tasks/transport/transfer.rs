//! Native-only <=120s immutable-manifest transfer lease. Tokens are never
//! serialized, persisted, returned to the renderer, or included in model data.
use super::*;
use crate::account_session::AccountDispatchFence;

pub(crate) struct Transfer {
    capability: Capability,
    base: Url,
    scope: directory::HostedComputerScope,
    account: AccountDispatchFence,
    identity: u64,
    binding: Binding,
    authorization: Value,
    direction: String,
    client: reqwest::Client,
}
impl Transfer {
    pub(crate) async fn open(
        ticket: &OperationTicket,
        scope: &directory::HostedComputerScope,
        binding: &Binding,
        authorization: Value,
        direction: &str,
        runner: &str,
    ) -> Result<Self, String> {
        if binding.version != 3
            || !["input", "output"].contains(&direction)
            || binding.workspace_id != scope.workspace_id
        {
            return Err("Invalid coding transfer scope.".into());
        }
        ticket.check()?;
        unchanged(scope)?;
        super::super::dispatch::with_current(binding, || Ok(()))?;
        let identity = crate::clerk_identity::native_identity_generation_snapshot()?;
        let envelope=crate::clerk_identity::call_convex_http_route("/native/task-capability",json!({"workspaceId":scope.workspace_id,"deviceId":scope.device_id,"agentId":binding.agent_id,"scope":format!("task:{direction}"),"resourceId":binding.task_id,"requestSha256":digest_value(&authorization)?})).await?;
        if crate::clerk_identity::native_identity_generation_snapshot()? != identity {
            return Err("The account changed during coding transfer authorization.".into());
        }
        let capability: Capability = serde_json::from_value(
            envelope
                .get("value")
                .cloned()
                .filter(|_| envelope.get("status").and_then(Value::as_str) == Some("success"))
                .ok_or("Coding transfer authorization unavailable.")?,
        )
        .map_err(|_| "Invalid coding transfer capability.")?;
        let base = validate_capability(&capability, Some(runner))?;
        unchanged(scope)?;
        let account = AccountDispatchFence::capture()?;
        super::super::dispatch::with_current(binding, || {
            ticket.with_current(|| account.with_current(|| Ok(())))
        })?;
        crate::ensure_rustls_provider();
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Coding transfer connection unavailable.")?;
        Ok(Self {
            capability,
            base,
            scope: scope.clone(),
            account,
            identity,
            binding: binding.clone(),
            authorization,
            direction: direction.into(),
            client,
        })
    }
    fn check(&self, ticket: &OperationTicket) -> Result<(), String> {
        ticket.check()?;
        if self.capability.expires_at <= chrono::Utc::now().timestamp_millis()
            || crate::clerk_identity::native_identity_generation_snapshot()? != self.identity
        {
            return Err("Coding transfer authorization expired or the account changed. Refresh its immutable result; no task was replayed.".into());
        }
        unchanged(&self.scope)?;
        super::super::dispatch::with_current(&self.binding, || {
            ticket.with_current(|| self.account.with_current(|| Ok(())))
        })
    }
    pub(crate) async fn call(
        &self,
        ticket: &OperationTicket,
        operation: &str,
        body: Value,
    ) -> Result<Value, String> {
        self.check(ticket)?;
        if !(self.direction == "input" && matches!(operation, "chunk" | "seal")
            || self.direction == "output" && operation == "output")
            || body.get("authorization") != Some(&self.authorization)
        {
            return Err("Coding transfer expanded its exact manifest scope.".into());
        }
        let mut url = self.base.clone();
        url.path_segments_mut()
            .map_err(|_| "Invalid coding transfer URL.")?
            .clear()
            .extend(["v1", "tasks", self.binding.task_id.as_str(), operation]);
        let request = self.account.with_current(|| {
            self.client
                .post(url)
                .header(
                    reqwest::header::AUTHORIZATION,
                    format!("MivletTask {}", self.capability.token),
                )
                .header(reqwest::header::ACCEPT, "application/json")
                .json(&body)
                .build()
                .map_err(|_| "Coding transfer request encoding failed.".into())
        })?;
        let mut send = Box::pin(self.client.execute(request));
        let guarded = futures_util::future::poll_fn(
            |cx| match super::super::dispatch::with_current(&self.binding, || {
                ticket.with_current(|| self.account.with_current(|| Ok(send.as_mut().poll(cx))))
            }) {
                Ok(value) => value.map(|value| {
                    value.map_err(|_| {
                        "Coding transfer delivery is uncertain. No task effect was replayed."
                            .to_string()
                    })
                }),
                Err(error) => Poll::Ready(Err(error)),
            },
        );
        tokio::pin!(guarded);
        let response = loop {
            tokio::select! {value=&mut guarded=>break value?,_=tokio::time::sleep(Duration::from_millis(100))=>self.check(ticket)?,}
        };
        self.check(ticket)?;
        let status = response.status();
        if response
            .content_length()
            .is_some_and(|size| size > 1_048_576)
        {
            return Err("Coding transfer response exceeded its bound.".into());
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            self.check(ticket)?;
            let chunk = chunk
                .map_err(|_| "Coding transfer was interrupted; refresh its immutable receipt.")?;
            if bytes.len().saturating_add(chunk.len()) > 1_048_576 {
                return Err("Coding transfer response exceeded its bound.".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        self.check(ticket)?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid coding transfer response.")?;
        if !status.is_success() {
            let code = value
                .get("error")
                .and_then(Value::as_str)
                .filter(|code| {
                    code.len() <= 80 && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
                })
                .unwrap_or("hosted-task-unavailable");
            return Err(format!(
                "Coding transfer failed ({code}); no task was replayed."
            ));
        }
        Ok(value)
    }
}
