# OpenCode Workerd compatibility probe

**2026-09-10: blocked before model/tool execution.** This is an isolated,
reproducible compatibility investigation, not a working hosted-agent feature.
See the [evaluation and implementation design](../../../../docs/architecture/hosted-opencode-prototype.md).

It uses a synthetic model plugin and one `write_summary` tool. The tool would
return an approval-required pause without writing anything. No real model,
credentials, conversation, account or desktop is connected. The current pin
runs plugin setup but fails model resolution before calling the model hook.

This nested package has its own frozen lockfile and is deliberately outside the
root `apps/*` workspace glob. It does not change the existing runner's entrypoint,
bindings, dependencies, deployment configuration or native Windows runtime.

From the repository root, using pnpm 10:

```powershell
pnpm --dir apps/hosted-runner/prototypes/opencode --ignore-workspace install --frozen-lockfile --ignore-scripts
pnpm --dir apps/hosted-runner/prototypes/opencode --ignore-workspace typecheck
$env:WRANGLER_SEND_METRICS='false'
$env:CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV='false'
pnpm --dir apps/hosted-runner/prototypes/opencode --ignore-workspace package:check
pnpm --dir apps/hosted-runner/prototypes/opencode --ignore-workspace dev
```

In another terminal:

```powershell
pnpm --dir apps/hosted-runner/prototypes/opencode --ignore-workspace check:local
```

The compatibility gate currently **exits 1**, with an HTTP 422 from `/run`,
`outcome: failed`, `pluginSetups: 1`, `modelCalls: 0`, `toolCalls: 0`, and
`SessionRunnerModel.UnsupportedPackageError: aisdk:mivlet-synthetic`.
The script separately checks rejected input, browser-origin rejection, repeated
request deduplication within a boot and the cancel endpoint. Passing those checks
does not make the model/tool gate pass. It saves ignored synthetic evidence in
`evidence.local.json`.

Stop the dev process with Ctrl+C, restart the same command without removing
`.wrangler`, then run:

```powershell
pnpm --dir apps/hosted-runner/prototypes/opencode --ignore-workspace check:local --after-restart
```

This checks a new object boot, the same saved session ID, successful SDK retrieval
of that session, and zero new model/tool calls. It does not test continuation of
an interrupted active model turn. Stop the dev process after verification.

The API accepts only loopback CLI requests with empty bodies; there is one fixed
synthetic task. Hostname checks are a local guard, **not production authentication**.
There is no deployment script. `package:check` is a Wrangler dry-run only. Do not
deploy this reproducer, add secrets or point it at a real provider.
