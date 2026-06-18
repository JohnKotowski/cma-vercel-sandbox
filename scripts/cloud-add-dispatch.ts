/**
 * cloud-add-dispatch.ts — the fan-out dispatcher for the cloud add_page worker.
 *
 * One tick (fired by the heartbeat clock): look at how many `run_add` /
 * `run_add_page` tasks are pending, see how many add-VMs are already running,
 * and spawn up to `CAP - running` fresh one-shot sandboxes — each runs
 * cloud-add-entry.mjs (claim ONE task → add → complete → exit). Fire-and-forget:
 * we kick each entry off detached and return; the sandbox auto-stops at its tight
 * timeout right after its single task. Queue empty → spawn nothing → $0 idle.
 *
 * This is the "one VM per task, max 5 at once, wake on the heartbeat, sleep when
 * the queue's empty" model. NOT a long-lived drainer (no 30-min-timeout cliff)
 * and NOT run-add.sh's poll loop (each VM does exactly one task).
 *
 * Concurrency is capped by counting live add-VMs via Sandbox.list({namePrefix})
 * — robust across ticks and stateless, so a heartbeat can fire it blindly.
 *
 * Auth + secrets (injected at runtime, never baked): same as cloud-add-worker.ts —
 * ADD_WORKER_OAUTH_TOKEN (sub) or ADD_WORKER_ANTHROPIC_API_KEY (key) from
 * ~/.claude/.env; extract-rabbit .env + GCP creds from the host repo.
 *
 * Usage:
 *   npx tsx scripts/cloud-add-dispatch.ts            # one dispatch tick
 *   npx tsx scripts/cloud-add-dispatch.ts --dry-run  # count + report, spawn nothing
 *   ADD_WORKER_CONCURRENCY=5 npx tsx scripts/cloud-add-dispatch.ts
 */

import { config } from "dotenv";
config({ path: `${__dirname}/../.env.local` });
config({ path: `${process.env.HOME}/.claude/.env`, override: false });
import { Sandbox } from "@vercel/sandbox";
import { readFileSync, existsSync } from "node:fs";

const EXTRACT_RABBIT_DIR =
  process.env.EXTRACT_RABBIT_DIR || `${process.env.HOME}/Projects/pricingsaas-extract-rabbit`;
const SANDBOX_REPO = "/vercel/sandbox/extract-rabbit";
const SANDBOX_GCP_CREDS = `${SANDBOX_REPO}/gcp-creds.json`;
const SANDBOX_ENTRY = "/vercel/sandbox/cloud-add-entry.mjs";
const ENTRY_LOCAL = `${__dirname}/cloud-add-entry.mjs`;
const SNAPSHOT = process.env.SANDBOX_ADD_SNAPSHOT_ID;
const NAME_PREFIX = process.env.ADD_WORKER_NAME_PREFIX || "add-task-";
const CAP = Number(process.env.ADD_WORKER_CONCURRENCY || "5");
const MGMT =
  process.env.MANAGEMENT_API_URL || "https://qulnbyjrczvoxemtrili.supabase.co/functions/v1/management";
const ADD_TASK_TIMEOUT_S = process.env.ADD_TASK_TIMEOUT_S || "1080"; // 18m per add
const SANDBOX_TIMEOUT_MS = Number(process.env.ADD_SANDBOX_TIMEOUT_MS || 20 * 60 * 1000); // 20m VM max life

const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const credentials =
  VERCEL_TOKEN && VERCEL_PROJECT_ID && VERCEL_TEAM_ID
    ? { token: VERCEL_TOKEN, projectId: VERCEL_PROJECT_ID, teamId: VERCEL_TEAM_ID }
    : undefined;

const argv = process.argv.slice(2);
const has = (n: string) => argv.includes(`--${n}`);
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

function resolveSeat(): { env: Record<string, string>; label: string } {
  const apiKey = process.env.ADD_WORKER_ANTHROPIC_API_KEY;
  const oauth = process.env.ADD_WORKER_OAUTH_TOKEN;
  if (oauth) return { env: { CLAUDE_CODE_OAUTH_TOKEN: oauth }, label: "ADD_WORKER_OAUTH_TOKEN (sub seat)" };
  if (apiKey) return { env: { ANTHROPIC_API_KEY: apiKey }, label: "ADD_WORKER_ANTHROPIC_API_KEY (API key)" };
  console.error("No seat: set ADD_WORKER_OAUTH_TOKEN or ADD_WORKER_ANTHROPIC_API_KEY in ~/.claude/.env.");
  process.exit(1);
}

function readRepoEnv(): { raw: string; vars: Record<string, string> } {
  const raw = readFileSync(`${EXTRACT_RABBIT_DIR}/.env`, "utf8");
  const vars: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { raw, vars };
}

/** The files every add-VM needs: the entry script, the repo .env (GCP path rewritten), the GCP creds. */
function sandboxFiles(envRaw: string, vars: Record<string, string>): { path: string; content: Buffer }[] {
  const files: { path: string; content: Buffer }[] = [
    { path: SANDBOX_ENTRY, content: Buffer.from(readFileSync(ENTRY_LOCAL)) },
  ];
  let env = envRaw;
  const gcpPath = vars.GOOGLE_APPLICATION_CREDENTIALS;
  if (gcpPath && existsSync(gcpPath)) {
    files.push({ path: SANDBOX_GCP_CREDS, content: Buffer.from(readFileSync(gcpPath)) });
    env = env.replace(/^\s*GOOGLE_APPLICATION_CREDENTIALS\s*=.*$/m, `GOOGLE_APPLICATION_CREDENTIALS=${SANDBOX_GCP_CREDS}`);
  } else if (gcpPath) {
    console.warn(`⚠️  GOOGLE_APPLICATION_CREDENTIALS file not found (${gcpPath}); vault upload may fail.`);
  }
  files.push({ path: `${SANDBOX_REPO}/.env`, content: Buffer.from(env.replace(/\n?$/, "\n")) });
  return files;
}

// Count tasks for a command in a given status. The queue is our concurrency
// source of truth: a `running` run_add task = a worker actively processing it,
// so capping on (pending, running) needs no Vercel sandbox listing and is
// stateless across heartbeat ticks. (Note: `running` counts ANY worker on that
// task — cloud add-VMs or a local run-add.sh — so the cap bounds *total* run_add
// concurrency, which is the safe interpretation.)
async function countByStatus(queueKey: string, command: string, status: string): Promise<number> {
  const r = await fetch(`${MGMT}/tasks?command=${command}&status=${status}&limit=500`, {
    headers: { "X-API-Key": queueKey },
  });
  const j: any = await r.json().catch(() => ({}));
  const tasks = j?.tasks ?? j?.data ?? (Array.isArray(j) ? j : []);
  return Array.isArray(tasks) ? tasks.length : 0;
}

async function main() {
  if (!SNAPSHOT) {
    console.error("SANDBOX_ADD_SNAPSHOT_ID not set in .env.local. Run build-add-snapshot.ts first.");
    process.exit(1);
  }
  const dryRun = has("dry-run");
  const cap = Number(flag("cap") || CAP);
  const { env: seatEnv, label: seatLabel } = resolveSeat();
  const { raw: envRaw, vars } = readRepoEnv();
  const queueKey = vars.TASK_QUEUE_API_KEY;
  if (!queueKey) {
    console.error("TASK_QUEUE_API_KEY missing from extract-rabbit/.env.");
    process.exit(1);
  }

  const [pendAdd, pendPage, runAdd, runPage] = await Promise.all([
    countByStatus(queueKey, "run_add", "pending"),
    countByStatus(queueKey, "run_add_page", "pending"),
    countByStatus(queueKey, "run_add", "running"),
    countByStatus(queueKey, "run_add_page", "running"),
  ]);
  const pending = pendAdd + pendPage;
  const running = runAdd + runPage;
  const slots = Math.max(0, cap - running);
  const toSpawn = Math.min(pending, slots);

  console.log(
    `[dispatch] seat=${seatLabel} pending=${pending} (run_add ${pendAdd} + run_add_page ${pendPage}) · activeAddVMs=${running}/${cap} · slots=${slots} → spawn ${toSpawn}`
  );

  if (dryRun) {
    console.log("[dispatch] --dry-run: spawning nothing.");
    return;
  }
  if (toSpawn === 0) {
    console.log("[dispatch] nothing to spawn (queue empty or at cap).");
    return;
  }

  const files = sandboxFiles(envRaw, vars);
  const stamp = Date.now();
  let spawned = 0;
  for (let i = 0; i < toSpawn; i++) {
    const name = `${NAME_PREFIX}${stamp}-${i}`;
    try {
      const sandbox = await Sandbox.create({
        name,
        source: { type: "snapshot", snapshotId: SNAPSHOT } as any,
        runtime: "node24",
        timeout: SANDBOX_TIMEOUT_MS,
        ...(credentials as any),
      } as any);
      await sandbox.writeFiles(files);
      // Fire-and-forget: launch the one-shot entry detached, then move on. The
      // entry claims one task, adds it, marks it done, exits; the VM auto-stops
      // at its timeout. We do NOT await the add.
      await sandbox.runCommand({
        cmd: "bash",
        args: ["-c", `nohup node ${SANDBOX_ENTRY} > /tmp/add-entry.out 2>&1 &`],
        env: {
          ...seatEnv,
          TASK_QUEUE_API_KEY: queueKey,
          MGMT_URL: MGMT,
          REPO: SANDBOX_REPO,
          ADD_TASK_TIMEOUT_S,
          WORKER_ID: name,
        },
        detached: true,
      });
      console.log(`[dispatch] spawned ${name}`);
      spawned += 1;
    } catch (e: any) {
      console.error(`[dispatch] spawn ${name} failed: ${e?.message || e}`);
    }
  }
  console.log(`[dispatch] done — spawned ${spawned}/${toSpawn} add-VM(s).`);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
