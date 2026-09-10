# OpenCode Workerd and Agents fixture

The native provider completes two model requests and one bounded tool proposal
in Workerd. Cloudflare Agents schedules the attempt, waits for exact approval,
and atomically stores a fixed artifact and receipt. OpenCode and Agents use
separate databases. This package admits no real conversation or credentials.
See the [architecture](../../../../docs/architecture/hosted-opencode-prototype.md).

This independently installed package has its own frozen lockfile and is outside
the root workspace glob. The production runner's configuration is unchanged.
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
pnpm --dir apps/hosted-runner/prototypes/opencode --ignore-workspace check:task
```

The first check proves model/tool execution, input rejection, duplicate admission
and interruption. The task check verifies scheduling, artifact bytes/hash,
changed/replayed/cross-workspace/cross-agent approvals and cancellation.
It leaves one approval pending and stores ignored fixture evidence.

Stop and restart the dev process using the same `.wrangler` storage, then run:

```powershell
pnpm --dir apps/hosted-runner/prototypes/opencode --ignore-workspace check:task --after-restart
```

This verifies the pending approval and completed receipt, reads the saved SDK
session without new model/tool calls, and resumes the exact approval once.
Stop the dev process after verification.

Only loopback CLI requests are accepted; browser requests and arbitrary bodies
are rejected. This local guard is not production authentication. `package:check`
is a dry-run. No deployment or real provider-secret configuration is supplied.
