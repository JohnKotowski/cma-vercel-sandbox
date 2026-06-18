/**
 * onboarding-beat-worker.ts — run ONE Rebecca partner-onboarding beat in a Vercel Sandbox.
 *
 * This is the runner under Rebecca's `onboarding-heartbeat` skill. It boots a microVM from
 * the agent-browser snapshot (SANDBOX_SNAPSHOT_ID — already has agent-browser + Chromium),
 * auths a headless `claude -p` session with Rebecca's dedicated OAuth seat, ships her skill
 * in, and runs ONE beat for a sponsor: claim ≤5 → discover pricing pages (agent-browser
 * Claude Loop, run LOCALLY in this sandbox) → record → schedule run_add → reconcile →
 * emit the heartbeat goal envelope. All DB writes go through the partner_onboarding_ops /
 * _ingest edge-fn rails (service-role); the beat never touches the DB directly.
 *
 * Why off-Mac: the whole beat is one self-contained sandbox session. The clock can fire it
 * (Supabase pg_cron → this runner on Vercel) with every Mac down. See
 * agent-erik/docs/fleet-heartbeat-spec.md (§4.3, substrate=vercel).
 *
 * Modes:
 *   --sponsor <uuid>            Run one live beat for that sponsor.
 *   --sponsor <uuid> --dry-run  Discover + report, but tell the beat to SKIP all rail writes
 *                               (no claim mutation, no record, no run_add) — proves discovery
 *                               + auth + skill load without moving Nue's tracking state.
 *   --stop                      Stop the warm sandbox.
 *
 * Auth & secrets (nothing baked into the snapshot — all injected at runtime):
 *   - Vercel creds + SANDBOX_SNAPSHOT_ID            ← cma-vercel-sandbox/.env.local
 *   - REBECCA_ONBOARDING_CLAUDE_OAUTH_TOKEN         ← ~/.claude/.env  (→ CLAUDE_CODE_OAUTH_TOKEN
 *                                                     in the sandbox, so claude -p runs on
 *                                                     Rebecca's seat, isolated/identifiable)
 *   - PARTNER_ONBOARDING_SECRET (= MC_HOOK_SECRET)  ← ~/.claude/.env  (rail auth)
 *   - SPARK_ANON_KEY                                ← ~/.claude/.env  (edge-fn gateway apikey)
 *   - TASK_QUEUE_API_KEY                            ← ~/.claude/.env  (claude_tasks run_add)
 *
 * Usage:
 *   npx tsx scripts/onboarding-beat-worker.ts --sponsor 4bbb7dd2-b5fc-437f-a4bb-ef9c894a7e8b --dry-run
 *   npx tsx scripts/onboarding-beat-worker.ts --sponsor 4bbb7dd2-b5fc-437f-a4bb-ef9c894a7e8b
 *   npx tsx scripts/onboarding-beat-worker.ts --stop
 */

import { config } from "dotenv";
config({ path: `${__dirname}/../.env.local` }); // Vercel creds + snapshot id
config({ path: `${process.env.HOME}/.claude/.env`, override: false }); // Rebecca token + rail secrets
import { Sandbox } from "@vercel/sandbox";
import { readFileSync } from "node:fs";
import ms from "ms";

const SNAPSHOT = process.env.SANDBOX_SNAPSHOT_ID;
const SANDBOX_NAME = process.env.ONBOARDING_SANDBOX_NAME || "rebecca-onboarding";
const SKILL_PATH =
  process.env.ONBOARDING_SKILL_PATH ||
  `${process.env.HOME}/Projects/agent-rebecca/.claude/skills/onboarding-heartbeat/SKILL.md`;
// 25m: a full 5-company discovery loop + run_add scheduling + reconcile is comfortably bounded.
const BEAT_TIMEOUT_S = process.env.ONBOARDING_BEAT_TIMEOUT_S || "1500";

const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const credentials =
  VERCEL_TOKEN && VERCEL_PROJECT_ID && VERCEL_TEAM_ID
    ? { token: VERCEL_TOKEN, projectId: VERCEL_PROJECT_ID, teamId: VERCEL_TEAM_ID }
    : undefined;

// ── arg parsing ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (n: string) => argv.includes(`--${n}`);

// ── the beat prompt handed to `claude -p` inside the sandbox ──────────────────
// Rebecca's skill carries the full 6-step procedure; this just points her at it,
// pins the substrate (in-sandbox agent-browser, NOT sandbox-cmd indirection), and
// demands a single machine-readable envelope as the last stdout line.
function beatPrompt(sponsorId: string, dryRun: boolean): string {
  return [
    `Run exactly ONE partner-onboarding beat for sponsor_id ${sponsorId}.`,
    `Follow the "onboarding-heartbeat" skill precisely (all 6 steps).`,
    ``,
    `Substrate: you are INSIDE the Vercel sandbox. agent-browser is a local CLI —`,
    `set AB="agent-browser" and call it directly. Do NOT use sandbox-cmd / nested sandboxes.`,
    `Rail secrets are already in your environment: MC_HOOK_SECRET, SPARK_ANON_KEY, TASK_QUEUE_API_KEY.`,
    ``,
    dryRun
      ? `DRY RUN: perform Step 1 claim_batch and Step 2 discovery, but DO NOT call any` +
        ` write rail (no record, no run_add, no reconcile). Report what you WOULD have written.`
      : `LIVE: execute all 6 steps including the ops/ingest rail writes.`,
    ``,
    `Output: print human-readable progress as you go, then as the VERY LAST LINE of`,
    `stdout print ONLY the heartbeat envelope JSON (the {"agent_id":"rebecca",...} object`,
    `from Step 6) on a single line, with no markdown fences. Nothing after it.`,
  ].join("\n");
}

// require an env var, fail loudly (a missing secret would make the beat fail-open/silent)
function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} not set (looked in ~/.claude/.env). Cannot run the beat.`);
    process.exit(1);
  }
  return v;
}

// Report the beat to mc_heartbeat_ingest (MC project) so it lands in mc_heartbeat_runs
// and shows in Rebecca's Heartbeat tab. Auth: x-mc-secret (MC_HOOK_SECRET).
async function postBeat(env: any, startedAt: string, secret: string, exitCode: number) {
  const status = env?.status === "acted" ? "acted" : env?.status === "skipped" ? "skipped" : exitCode === 0 && env ? "acted" : "error";
  const payload = {
    agent_id: env?.agent_id || "rebecca",
    beat_id: `hb_${Date.now()}`,
    started_ts: startedAt,
    ended_ts: new Date().toISOString(),
    status,
    summary: env?.summary ?? null,
    actions: Array.isArray(env?.actions) ? env.actions : [],
    goal_progress: env?.goal_progress ?? null,
    substrate: "vercel",
  };
  const r = await fetch("https://qubxtjxiajxnumduwcbk.supabase.co/functions/v1/mc_heartbeat_ingest", {
    method: "POST",
    headers: { "x-mc-secret": secret, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  console.log(`beat ingest: HTTP ${r.status} ${JSON.stringify(j)}`);
}

async function main() {
  if (has("stop")) {
    try {
      const sandbox = await Sandbox.get({ name: SANDBOX_NAME, ...credentials });
      await sandbox.stop();
      console.log("stopped");
    } catch (e: any) {
      if (e?.status !== 404) throw e;
      console.log("no sandbox to stop");
    }
    return;
  }

  const sponsorId = flag("sponsor");
  const dryRun = has("dry-run");
  if (!sponsorId) {
    console.error(
      "Usage: onboarding-beat-worker.ts --sponsor <uuid> [--dry-run]  |  --stop"
    );
    process.exit(1);
  }
  if (!SNAPSHOT) {
    console.error("SANDBOX_SNAPSHOT_ID not set in .env.local (the agent-browser snapshot).");
    process.exit(1);
  }

  // Seat resolution. Production intent = Rebecca's dedicated onboarding seat (isolated spend).
  // Override chain lets us fall back to the session's own seat when hers is saturated:
  //   ONBOARDING_BEAT_OAUTH_TOKEN > REBECCA_ONBOARDING_CLAUDE_OAUTH_TOKEN > CLAUDE_CODE_OAUTH_TOKEN
  const oauthToken =
    process.env.ONBOARDING_BEAT_OAUTH_TOKEN ||
    process.env.REBECCA_ONBOARDING_CLAUDE_OAUTH_TOKEN ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!oauthToken) {
    console.error(
      "No OAuth seat token (set ONBOARDING_BEAT_OAUTH_TOKEN, REBECCA_ONBOARDING_CLAUDE_OAUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN)."
    );
    process.exit(1);
  }
  const seatLabel = process.env.ONBOARDING_BEAT_OAUTH_TOKEN
    ? "ONBOARDING_BEAT_OAUTH_TOKEN (override)"
    : process.env.REBECCA_ONBOARDING_CLAUDE_OAUTH_TOKEN
    ? "REBECCA_ONBOARDING_CLAUDE_OAUTH_TOKEN (rebecca seat)"
    : "CLAUDE_CODE_OAUTH_TOKEN (session seat)";
  console.log(`Seat: ${seatLabel}`);
  const railSecret = process.env.PARTNER_ONBOARDING_SECRET || need("MC_HOOK_SECRET");
  const anonKey = need("SPARK_ANON_KEY");
  const queueKey = need("TASK_QUEUE_API_KEY");

  const skill = readFileSync(SKILL_PATH, "utf8");

  console.log(
    `Booting sandbox '${SANDBOX_NAME}' for onboarding beat (sponsor=${sponsorId}, dry_run=${dryRun})`
  );
  const sandbox = await Sandbox.getOrCreate({
    name: SANDBOX_NAME,
    // SDK typings omit "snapshot" but it's supported at runtime (see cloud-diff-worker.ts).
    source: { type: "snapshot", snapshotId: SNAPSHOT } as any,
    runtime: "node24",
    timeout: ms("30m"),
    ...credentials,
  });

  try {
    // Ship Rebecca's skill into the sandbox's user skills dir so `claude -p` discovers it.
    await sandbox.writeFiles([
      {
        path: "/root/.claude/skills/onboarding-heartbeat/SKILL.md",
        content: Buffer.from(skill),
      },
    ]);

    // Ensure the Claude Code CLI is present (the agent-browser snapshot has the SDK + tsx +
    // agent-browser, but not necessarily the CLI). Idempotent: skips if already installed.
    console.log("Ensuring claude CLI in sandbox…");
    const ensure = await sandbox.runCommand("bash", [
      "-c",
      `command -v claude >/dev/null 2>&1 && { echo "claude present: $(claude --version 2>&1 | head -1)"; exit 0; }
       npm install -g @anthropic-ai/claude-code 2>&1 | tail -3
       claude --version 2>&1 | head -1`,
    ]);
    process.stdout.write((await ensure.stdout()) || "");
    process.stderr.write((await ensure.stderr()) || "");
    if (ensure.exitCode !== 0) {
      console.error("Failed to provision claude CLI — aborting.");
      process.exitCode = 1;
      return;
    }

    // Run the beat. Secrets pass via the command env, never written to disk in the sandbox.
    // CLAUDE_CODE_OAUTH_TOKEN auths claude on Rebecca's seat (fresh VM has no keychain, so
    // this token wins → her seat, not whatever default). --dangerously-skip-permissions
    // because there is no human to approve tool calls in a headless beat.
    const prompt = beatPrompt(sponsorId, dryRun);
    const beatStartedAt = new Date().toISOString();
    console.log(`\n→ claude -p (onboarding beat, timeout ${BEAT_TIMEOUT_S}s)\n`);
    const run = await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-c",
        `cd /root && timeout ${BEAT_TIMEOUT_S} claude -p "$BEAT_PROMPT" --dangerously-skip-permissions`,
      ],
      env: {
        BEAT_PROMPT: prompt,
        CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
        MC_HOOK_SECRET: railSecret,
        PARTNER_ONBOARDING_SECRET: railSecret,
        SPARK_ANON_KEY: anonKey,
        TASK_QUEUE_API_KEY: queueKey,
        SPONSOR_ID: sponsorId,
      },
    });
    const stdout = (await run.stdout()) || "";
    const stderr = (await run.stderr()) || "";

    // Last non-empty stdout line = the heartbeat envelope JSON.
    const lines = stdout.split("\n").filter((l) => l.trim());
    const lastLine = lines[lines.length - 1] || "";
    let envelope: any = null;
    try {
      envelope = JSON.parse(lastLine);
    } catch {
      /* beat crashed before emitting the envelope */
    }

    console.log("\n──── beat tail ────");
    console.log((stdout + "\n" + stderr).slice(-3000));
    console.log("──── envelope ────");
    console.log(JSON.stringify(envelope, null, 2), `\n(exit ${run.exitCode})`);

    if (!envelope) {
      console.error("No heartbeat envelope parsed from beat output — treat as error.");
      process.exitCode = 1;
    }

    // Record the beat to mc_heartbeat_ingest so it shows in Rebecca's Heartbeat tab.
    // Live beats only — a dry run shouldn't pollute the beat log.
    const hbSecret = process.env.MC_HOOK_SECRET || railSecret;
    if (!dryRun && hbSecret) {
      await postBeat(envelope, beatStartedAt, hbSecret, run.exitCode).catch((e) =>
        console.error("beat ingest failed:", e?.message || e),
      );
    }
  } finally {
    // Leave warm (auto-stops after idle). Use --stop to tear down between cadences.
  }
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
