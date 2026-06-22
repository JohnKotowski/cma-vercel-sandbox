/**
 * cloud-diff-dispatch.ts — failover fan-out for the cloud diff worker.
 *
 * One tick: look at how many `run_diff` tasks are pending and how many are already
 * running (ANY worker — Mac-mini fleet OR cloud), then spawn up to `CAP - running`
 * detached cloud-diff-worker.ts --claim processes. Each claims ONE task, runs it in
 * its own Vercel sandbox (booted from the diff snapshot), completes/fails it, and
 * lets the sandbox auto-stop at idle. Queue empty or minis keeping up → spawn
 * nothing → $0 idle.
 *
 * This is FAILOVER, not always-on overflow: the queue's `running` count is the
 * shared concurrency budget. When the minis are healthy they hold `running` near
 * CAP, so this dispatcher spawns ~nothing. When a mini goes dark, `running` drops,
 * slots open, and the cloud fills the gap — no explicit "is MMB down?" check
 * needed. Raise CAP above mini steady-state to also use the cloud for overflow.
 *
 * Reuses cloud-diff-worker.ts verbatim (claim/run/complete/fail) — this only does
 * the counting + fan-out. Stateless across ticks: each worker gets a unique
 * sandbox name, so a heartbeat can fire this blindly.
 *
 * Auth + secrets (injected at runtime by cloud-diff-worker, never baked):
 *   - Vercel creds + SANDBOX_DIFF_SNAPSHOT_ID  ← cma-vercel-sandbox/.env.local
 *   - FAILOVER_ANTHROPIC_API_KEY               ← ~/.claude/.env
 *   - diff-rabbit/.env (queue + vault + storage + Gemini) ← host repo
 *
 * Usage:
 *   npx tsx scripts/cloud-diff-dispatch.ts            # one dispatch tick
 *   npx tsx scripts/cloud-diff-dispatch.ts --dry-run  # count + report, spawn nothing
 *   DIFF_WORKER_CONCURRENCY=8 npx tsx scripts/cloud-diff-dispatch.ts
 */

import { config } from "dotenv";
config({ path: `${__dirname}/../.env.local` });
config({ path: `${process.env.HOME}/.claude/.env`, override: false });
import { spawn } from "node:child_process";
import { openSync, readFileSync } from "node:fs";

const DIFF_RABBIT_DIR =
  process.env.DIFF_RABBIT_DIR || `${process.env.HOME}/Projects/pricingsaas-diff-rabbit`;
const WORKER_TS = `${__dirname}/cloud-diff-worker.ts`;
const SNAPSHOT = process.env.SANDBOX_DIFF_SNAPSHOT_ID;
const NAME_PREFIX = process.env.DIFF_WORKER_NAME_PREFIX || "diff-failover-";
// CAP = the WHOLE fleet's intended diff concurrency (mini + cloud), since `running`
// counts every worker. Default 16 = two minis at 8 each: both up → cloud spawns 0;
// one mini down → cloud fills the missing ~8; both down → cloud fills up to 16.
// Each cloud worker burns FAILOVER_ANTHROPIC_API_KEY $ for ~20 min, so this is
// also the cost ceiling — tune via DIFF_WORKER_CONCURRENCY.
const CAP = Number(process.env.DIFF_WORKER_CONCURRENCY || "16");
const MGMT =
  process.env.MANAGEMENT_API_URL || "https://qulnbyjrczvoxemtrili.supabase.co/functions/v1/management";

const argv = process.argv.slice(2);
const has = (n: string) => argv.includes(`--${n}`);
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

function readRepoEnv(): Record<string, string> {
  const raw = readFileSync(`${DIFF_RABBIT_DIR}/.env`, "utf8");
  const vars: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return vars;
}

// The queue is our concurrency source of truth: a `running` run_diff = a worker
// (mini or cloud) actively processing it, so capping on (pending, running) is
// stateless across ticks and needs no sandbox listing.
async function countByStatus(queueKey: string, status: string): Promise<number> {
  const r = await fetch(`${MGMT}/tasks?command=run_diff&status=${status}&limit=1000`, {
    headers: { "X-API-Key": queueKey },
  });
  const j: any = await r.json().catch(() => ({}));
  const tasks = j?.tasks ?? j?.data ?? (Array.isArray(j) ? j : []);
  return Array.isArray(tasks) ? tasks.length : 0;
}

function spawnWorker(name: string) {
  // Detached: launch one cloud-diff-worker.ts --claim, log to /tmp, and move on.
  // Each worker boots its OWN sandbox (unique name) so concurrent claims don't
  // collide on the single warm `diff-failover` sandbox.
  const logPath = `/tmp/${name}.log`;
  const out = openSync(logPath, "a");
  const child = spawn("npx", ["tsx", WORKER_TS, "--claim"], {
    cwd: `${__dirname}/..`,
    env: { ...process.env, DIFF_FAILOVER_SANDBOX_NAME: name },
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  console.log(`[dispatch] spawned ${name} → ${logPath} (pid ${child.pid})`);
}

async function main() {
  if (!SNAPSHOT) {
    console.error("SANDBOX_DIFF_SNAPSHOT_ID not set in .env.local. Run build-diff-snapshot.ts first.");
    process.exit(1);
  }
  if (!process.env.FAILOVER_ANTHROPIC_API_KEY) {
    console.error("FAILOVER_ANTHROPIC_API_KEY not set in ~/.claude/.env — cloud workers can't auth.");
    process.exit(1);
  }
  const dryRun = has("dry-run");
  const cap = Number(flag("cap") || CAP);
  const vars = readRepoEnv();
  const queueKey = vars.TASK_QUEUE_API_KEY;
  if (!queueKey) {
    console.error("TASK_QUEUE_API_KEY missing from diff-rabbit/.env.");
    process.exit(1);
  }

  const [pending, running] = await Promise.all([
    countByStatus(queueKey, "pending"),
    countByStatus(queueKey, "running"),
  ]);
  const slots = Math.max(0, cap - running);
  const toSpawn = Math.min(pending, slots);

  console.log(
    `[dispatch] run_diff pending=${pending} · running=${running}/${cap} (mini+cloud) · slots=${slots} → spawn ${toSpawn}`
  );

  if (dryRun) {
    console.log("[dispatch] --dry-run: spawning nothing.");
    return;
  }
  if (toSpawn === 0) {
    console.log("[dispatch] nothing to spawn (queue empty or minis keeping up).");
    return;
  }

  const stamp = Date.now();
  for (let i = 0; i < toSpawn; i++) {
    spawnWorker(`${NAME_PREFIX}${stamp}-${i}`);
  }
  console.log(`[dispatch] done — fanned out ${toSpawn} cloud diff worker(s).`);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
