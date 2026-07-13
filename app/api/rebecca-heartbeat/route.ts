/**
 * /api/rebecca-heartbeat — Rebecca's onboarding heartbeat, fully off-Mac.
 *
 * Hit by Vercel Cron on a schedule (see vercel.json). Each tick, with NO Mac in
 * the loop:
 *   1. DISPATCH — count pending + running run_add tasks, fan out up to
 *      (CAP - running) one-shot add sandboxes (each runs the embedded
 *      cloud-add-entry: claim one → /add-scrape-extract → complete → exit).
 *   2. BEAT — if no onboarding beat is currently running, fire one (boot the
 *      agent-browser snapshot, ship the onboarding-heartbeat skill, run claude -p
 *      to claim 5 → discover → record → queue run_add → reconcile → self-report).
 *      The beat's own claim rail throttles it (monitor if a batch is in flight).
 *
 * Everything the sandboxes need is injected from Vercel env vars (no local files):
 *   CRON_SECRET                 Vercel Cron bearer auth
 *   SPONSOR_ID                  partner to work (Nue)
 *   ADD_WORKER_OAUTH_TOKEN      seat for add VMs (claude)
 *   ONBOARDING_BEAT_OAUTH_TOKEN seat for the beat VM (claude)
 *   MC_HOOK_SECRET              rail auth (= PARTNER_ONBOARDING_SECRET)
 *   SPARK_ANON_KEY              edge-fn gateway apikey
 *   TASK_QUEUE_API_KEY          claude_tasks management API
 *   SANDBOX_ADD_SNAPSHOT_ID     add-worker snapshot
 *   SANDBOX_SNAPSHOT_ID         agent-browser snapshot (beat)
 *   EXTRACT_RABBIT_DOTENV       full extract-rabbit .env contents (for add VMs)
 *   GCP_CREDS_JSON              GCP service-account JSON (for add VMs' vault upload)
 *   ADD_WORKER_CONCURRENCY      cap (default 5)
 *
 * In production on Vercel the Sandbox SDK authenticates via the project's OIDC
 * token automatically — no Vercel token needed here.
 */

import { Sandbox } from "@vercel/sandbox";
import { ENTRY_MJS, SKILL_MD } from "./_payloads";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

const MGMT =
  process.env.MANAGEMENT_API_URL || "https://qulnbyjrczvoxemtrili.supabase.co/functions/v1/management";
const ADD_SNAPSHOT = process.env.SANDBOX_ADD_SNAPSHOT_ID;
const BEAT_SNAPSHOT = process.env.SANDBOX_SNAPSHOT_ID;
const CAP = Number(process.env.ADD_WORKER_CONCURRENCY || "5");
const ADD_REPO = "/vercel/sandbox/extract-rabbit";
const ADD_GCP = `${ADD_REPO}/gcp-creds.json`;
const ADD_ENTRY = "/vercel/sandbox/cloud-add-entry.mjs";
const ADD_TASK_TIMEOUT_S = process.env.ADD_TASK_TIMEOUT_S || "1080";
const ADD_SANDBOX_TIMEOUT_MS = Number(process.env.ADD_SANDBOX_TIMEOUT_MS || 20 * 60 * 1000);
const BEAT_SANDBOX_NAME = process.env.ONBOARDING_SANDBOX_NAME || "rebecca-onboarding";
const BEAT_TIMEOUT_S = process.env.ONBOARDING_BEAT_TIMEOUT_S || "1500";

async function countByStatus(queueKey: string, command: string, status: string): Promise<number> {
  const r = await fetch(`${MGMT}/tasks?command=${command}&status=${status}&limit=500`, {
    headers: { "X-API-Key": queueKey },
  });
  const j: any = await r.json().catch(() => ({}));
  const tasks = j?.tasks ?? j?.data ?? (Array.isArray(j) ? j : []);
  return Array.isArray(tasks) ? tasks.length : 0;
}

/** Files every add-VM needs: the entry script, repo .env (GCP path rewritten), GCP creds. */
function addFiles() {
  const files: { path: string; content: Buffer }[] = [
    { path: ADD_ENTRY, content: Buffer.from(ENTRY_MJS) },
  ];
  let env = (process.env.EXTRACT_RABBIT_DOTENV || "").replace(/\\n/g, "\n");
  const gcp = process.env.GCP_CREDS_JSON;
  if (gcp) {
    files.push({ path: ADD_GCP, content: Buffer.from(gcp) });
    if (/^\s*GOOGLE_APPLICATION_CREDENTIALS\s*=/m.test(env)) {
      env = env.replace(/^\s*GOOGLE_APPLICATION_CREDENTIALS\s*=.*$/m, `GOOGLE_APPLICATION_CREDENTIALS=${ADD_GCP}`);
    } else {
      env += `\nGOOGLE_APPLICATION_CREDENTIALS=${ADD_GCP}\n`;
    }
  }
  files.push({ path: `${ADD_REPO}/.env`, content: Buffer.from(env.replace(/\n?$/, "\n")) });
  return files;
}

async function dispatchAdds(queueKey: string) {
  const [pendAdd, pendPage, runAdd, runPage] = await Promise.all([
    countByStatus(queueKey, "run_add", "pending"),
    countByStatus(queueKey, "run_add_page", "pending"),
    countByStatus(queueKey, "run_add", "running"),
    countByStatus(queueKey, "run_add_page", "running"),
  ]);
  const pending = pendAdd + pendPage;
  const running = runAdd + runPage;
  const toSpawn = Math.max(0, Math.min(pending, CAP - running));
  const out = { pending, running, cap: CAP, spawned: 0 };
  if (toSpawn === 0 || !ADD_SNAPSHOT) return out;

  const files = addFiles();
  const stamp = Date.now();
  const seat = process.env.ADD_WORKER_OAUTH_TOKEN;
  for (let i = 0; i < toSpawn; i++) {
    try {
      const sandbox = await Sandbox.create({
        name: `add-task-${stamp}-${i}`,
        source: { type: "snapshot", snapshotId: ADD_SNAPSHOT } as any,
        runtime: "node24",
        timeout: ADD_SANDBOX_TIMEOUT_MS,
        // One-shot job, never resumed -> no filesystem restore needed. persistent:false disables the
        // automatic ~1 GB snapshot Vercel takes on stop. Leaving it on is what produced 2,885
        // orphaned snapshots / 3.06 TB = $248 of a $249 bill (2026-07-13). See cloud-scrape-worker.ts.
        persistent: false,
        keepLastSnapshots: { count: 1, deleteEvicted: true },
      } as any);
      await sandbox.writeFiles(files);
      await sandbox.runCommand({
        cmd: "bash",
        args: ["-c", `nohup node ${ADD_ENTRY} > /tmp/add-entry.out 2>&1 &`],
        env: {
          ...(seat ? { CLAUDE_CODE_OAUTH_TOKEN: seat } : {}),
          TASK_QUEUE_API_KEY: queueKey,
          MGMT_URL: MGMT,
          REPO: ADD_REPO,
          ADD_TASK_TIMEOUT_S,
          WORKER_ID: `add-task-${stamp}-${i}`,
        },
        detached: true,
      } as any);
      out.spawned += 1;
    } catch (e: any) {
      console.error("dispatch spawn failed:", e?.message || e);
    }
  }
  return out;
}

async function beatRunning(): Promise<boolean> {
  try {
    const s: any = await Sandbox.get({ name: BEAT_SANDBOX_NAME } as any);
    const st = s?.status;
    return st === "running" || st === "pending" || st === "stopping";
  } catch {
    return false; // not found / stopped → free to fire
  }
}

function beatPrompt(sponsorId: string): string {
  return [
    `Run exactly ONE partner-onboarding beat for sponsor_id ${sponsorId}.`,
    `Follow the "onboarding-heartbeat" skill precisely (all steps).`,
    ``,
    `Substrate: you are INSIDE the Vercel sandbox. agent-browser is a local CLI —`,
    `set AB="agent-browser" and call it directly. Do NOT use sandbox-cmd / nested sandboxes.`,
    `Rail secrets are in your environment: MC_HOOK_SECRET, SPARK_ANON_KEY, TASK_QUEUE_API_KEY.`,
    ``,
    `LIVE: execute all steps including the ops/ingest rail writes.`,
    `When discovery hits a bot/WAF challenge, fall back to Firecrawl (FIRECRAWL_API_KEY) per the skill.`,
    ``,
    `FINAL STEP: POST the heartbeat envelope JSON to`,
    `https://qubxtjxiajxnumduwcbk.supabase.co/functions/v1/mc_heartbeat_ingest with header`,
    `x-mc-secret: $MC_HOOK_SECRET and body {agent_id:"rebecca", beat_id, started_ts, ended_ts,`,
    `status, summary, actions, goal_progress, substrate:"vercel"} so the beat shows in MC.`,
  ].join("\n");
}

async function fireBeat(): Promise<{ fired: boolean; reason?: string }> {
  if (!BEAT_SNAPSHOT) return { fired: false, reason: "no SANDBOX_SNAPSHOT_ID" };
  if (await beatRunning()) return { fired: false, reason: "beat already running" };
  const sponsorId = process.env.SPONSOR_ID;
  const seat = process.env.ONBOARDING_BEAT_OAUTH_TOKEN || process.env.ADD_WORKER_OAUTH_TOKEN;
  if (!sponsorId || !seat) return { fired: false, reason: "missing SPONSOR_ID or beat seat" };

  const sandbox = await Sandbox.getOrCreate({
    name: BEAT_SANDBOX_NAME,
    source: { type: "snapshot", snapshotId: BEAT_SNAPSHOT } as any,
    runtime: "node24",
    timeout: 30 * 60 * 1000,
  } as any);
  await sandbox.writeFiles([
    { path: "/root/.claude/skills/onboarding-heartbeat/SKILL.md", content: Buffer.from(SKILL_MD) },
  ]);
  // Ensure claude CLI (snapshot has agent-browser; CLI may be absent).
  await sandbox.runCommand("bash", [
    "-c",
    `command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || true`,
  ]);
  await sandbox.runCommand({
    cmd: "bash",
    args: [
      "-c",
      `cd /root && rm -f /tmp/beat.out /tmp/beat.done && ` +
        `nohup bash -c 'timeout ${BEAT_TIMEOUT_S} claude -p "$BEAT_PROMPT" --dangerously-skip-permissions > /tmp/beat.out 2>&1; echo done > /tmp/beat.done' >/dev/null 2>&1 &`,
    ],
    env: {
      BEAT_PROMPT: beatPrompt(sponsorId),
      CLAUDE_CODE_OAUTH_TOKEN: seat,
      MC_HOOK_SECRET: process.env.MC_HOOK_SECRET || "",
      PARTNER_ONBOARDING_SECRET: process.env.MC_HOOK_SECRET || "",
      SPARK_ANON_KEY: process.env.SPARK_ANON_KEY || "",
      TASK_QUEUE_API_KEY: process.env.TASK_QUEUE_API_KEY || "",
      FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY || "",
      SPONSOR_ID: sponsorId,
    },
    detached: true,
  } as any);
  return { fired: true };
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const secret = process.env.CRON_SECRET;
  if (secret && auth !== `Bearer ${secret}`) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }
  const queueKey = process.env.TASK_QUEUE_API_KEY;
  if (!queueKey) {
    return new Response(JSON.stringify({ error: "TASK_QUEUE_API_KEY not set" }), { status: 500 });
  }

  const result: any = { ts: new Date().toISOString() };
  try {
    result.dispatch = await dispatchAdds(queueKey);
  } catch (e: any) {
    result.dispatch_error = e?.message || String(e);
  }
  try {
    result.beat = await fireBeat();
  } catch (e: any) {
    result.beat_error = e?.message || String(e);
  }
  return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
}
