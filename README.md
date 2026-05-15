# Claude Managed Agents with Vercel Sandbox

Run [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) custom tools inside a [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) Firecracker microVM. One fresh VM per session, snapshot-backed cold starts, and credential brokering through the sandbox firewall.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/vercel-labs/cma-vercel-sandbox&env=ANTHROPIC_API_KEY,ANTHROPIC_ENVIRONMENT_ID,ANTHROPIC_AGENT_ID,ANTHROPIC_ENVIRONMENT_KEY,SANDBOX_SNAPSHOT_ID,ANTHROPIC_WEBHOOK_SECRET&envDescription=See%20the%20guide%20for%20how%20to%20obtain%20each%20value&project-name=cma-vercel-sandbox&repository-name=cma-vercel-sandbox)

## How it works

1. A Next.js page lets you type a prompt and run it against a Claude agent.
2. A Vercel Function receives `session.status_run_started` webhooks from Anthropic, polls the work queue, and spawns a Vercel Sandbox from a prebuilt snapshot.
3. The spawned sandbox attaches to the session event stream, executes tool calls (`run_shell`, `read_file`), and posts results back.

Read the full guide for setup, architecture, and credential brokering: [Run Claude Managed Agent tools in Vercel Sandbox](https://vercel.com/guides/run-claude-managed-agent-tools-in-vercel-sandbox).

For streaming long-running sessions to a client (durable polling, replay on refresh, multi-turn chat), see [Build a Claude Managed Agent on Vercel](https://vercel.com/kb/guide/claude-managed-agent-vercel) with Vercel Workflow.

## Setup

### One-time

```bash
pnpm create next-app --example https://github.com/vercel-labs/cma-vercel-sandbox my-cma-sandbox
cd my-cma-sandbox
vercel link
vercel env pull .env.local
```

Run the setup scripts in order:

```bash
pnpm tsx scripts/create-environment.ts  # → ANTHROPIC_ENVIRONMENT_ID
pnpm tsx scripts/create-agent.ts        # → ANTHROPIC_AGENT_ID
pnpm tsx scripts/build-snapshot.ts      # → SANDBOX_SNAPSHOT_ID
```

Add the printed IDs to `.env.local`. Generate an environment key in the Anthropic console and save it as `ANTHROPIC_ENVIRONMENT_KEY`.

### Test locally

```bash
# Terminal 1: create a session
pnpm tsx scripts/test-session.ts
# → Session ID: sesn_01...

# Terminal 2: handle tool calls (bypasses sandbox)
pnpm tsx scripts/run-session.ts sesn_01...

# Full E2E: poll → ack → spawn sandbox
pnpm tsx scripts/test-e2e.ts
```

### Deploy

```bash
vercel env add ANTHROPIC_API_KEY
vercel env add ANTHROPIC_ENVIRONMENT_ID
vercel env add ANTHROPIC_AGENT_ID
vercel env add ANTHROPIC_ENVIRONMENT_KEY
vercel env add SANDBOX_SNAPSHOT_ID
vercel env add ANTHROPIC_WEBHOOK_SECRET
vercel deploy --prod
```

Register a webhook in the Anthropic console for `session.status_run_started`, pointing at:

```
https://your-project.vercel.app/api/webhook?x-vercel-protection-bypass=<bypass-secret>
```

## Environment variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key (session creation from the UI) |
| `ANTHROPIC_ENVIRONMENT_ID` | Self-hosted environment ID (`env_01...`) |
| `ANTHROPIC_AGENT_ID` | Agent ID (`agent_01...`) |
| `ANTHROPIC_ENVIRONMENT_KEY` | Environment key for poll, ack, and sandbox runner |
| `SANDBOX_SNAPSHOT_ID` | Snapshot ID from `build-snapshot.ts` |
| `ANTHROPIC_WEBHOOK_SECRET` | Webhook signing secret from Anthropic console |

## Project structure

```
app/
  page.tsx                  ← prompt input + event stream UI
  api/
    webhook/route.ts        ← verify signature, poll, spawn sandbox
    session/route.ts        ← create session + send message
    session/[id]/route.ts   ← SSE stream of session events
sandbox/
  runner.ts                 ← runs inside each Vercel Sandbox VM
scripts/
  create-environment.ts
  create-agent.ts
  build-snapshot.ts
  test-session.ts
  run-session.ts
  test-e2e.ts
```
