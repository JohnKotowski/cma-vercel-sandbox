/**
 * cloud-scrape-entry.mjs — the SELF-DRIVING, one-shot Claude-capable scrape worker
 * that runs INSIDE a Vercel sandbox (shipped in by the scrape dispatcher).
 *
 * Counterpart to cloud-add-entry.mjs. Exactly one task, then exit — NOT run.sh's
 * poll loop. The dispatcher fans out one sandbox per pending scrape task; each runs
 * this once: claim one `scrape` task → node agent/scripts/scrape.js <slug> → complete/
 * fail → exit. The sandbox auto-stops at its tight timeout right after, near-zero idle.
 *
 * This is the FULL (local-claude) scrape path — the heavy worker that handles
 * `firecrawl-unworkable` / `requires_claude` sites the cheap Firecrawl-only worker
 * released. (We do NOT pass no_claude, so this worker WILL claim requires_claude tasks.)
 *
 * No @vercel/sandbox import — runs in the guest. Pure node24 + the claude CLI + the
 * scrape-rabbit repo (baked in the snapshot). Secrets arrive as process env from the
 * dispatcher; the rest of scrape-rabbit's creds are in the repo's .env (written by the
 * dispatcher), incl. the Google Vision creds file.
 *
 * Env in:
 *   CLAUDE_CODE_OAUTH_TOKEN   the scrape-worker seat (claude auths off this)
 *   TASK_QUEUE_API_KEY        claude_tasks management API
 *   MGMT_URL                  default https://qulnbyjrczvoxemtrili.supabase.co/functions/v1/management
 *   REPO                      default /vercel/sandbox/scrape-rabbit
 *   SCRAPE_TASK_TIMEOUT_S     default 1500 (25m) — one Claude scrape is ~10-20m
 *   WORKER_ID                 label for the claim (default cloud-scrape-entry)
 *
 * Exit codes: 0 = task done or queue empty · 1 = task failed · 3 = released (rate limit).
 */

import { spawn } from "node:child_process";

const MGMT = process.env.MGMT_URL || "https://qulnbyjrczvoxemtrili.supabase.co/functions/v1/management";
const REPO = process.env.REPO || "/vercel/sandbox/scrape-rabbit";
const TIMEOUT_S = Number(process.env.SCRAPE_TASK_TIMEOUT_S || "1500");
const WORKER_ID = process.env.WORKER_ID || "cloud-scrape-entry";
const QUEUE_KEY = process.env.TASK_QUEUE_API_KEY;

function log(...a) { console.log(`[scrape-entry]`, ...a); }

if (!QUEUE_KEY) { console.error("[scrape-entry] TASK_QUEUE_API_KEY missing — cannot claim."); process.exit(1); }
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
  console.error("[scrape-entry] no seat (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY) — claude can't auth.");
  process.exit(1);
}

async function claim(command) {
  // No no_claude flag → this worker WILL claim requires_claude (firecrawl-unworkable) tasks.
  const r = await fetch(`${MGMT}/tasks/claim`, {
    method: "POST",
    headers: { "X-API-Key": QUEUE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ command, worker_id: WORKER_ID }),
  });
  const j = await r.json().catch(() => ({}));
  return j?.task ?? null;
}
async function complete(id, result) {
  await fetch(`${MGMT}/tasks/${id}/complete`, {
    method: "POST", headers: { "X-API-Key": QUEUE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ result }),
  }).then((r) => r.json()).catch(() => ({}));
}
async function fail(id, error) {
  await fetch(`${MGMT}/tasks/${id}/fail`, {
    method: "POST", headers: { "X-API-Key": QUEUE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ error }),
  }).then((r) => r.json()).catch(() => ({}));
}
async function release(id, reason) {
  await fetch(`${MGMT}/tasks/${id}/release`, {
    method: "POST", headers: { "X-API-Key": QUEUE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  }).then((r) => r.json()).catch(() => ({}));
}

const hitLimit = (o) =>
  /your credit balance is too low|rate limit exceeded|too many requests|429 status code|overloaded_error|rate_limit_error|session limit|usage limit reached|limit reached.*reset|resets [0-9]+\s*[ap]m/i.test(o);

// Run `node agent/scripts/scrape.js <slug>` synchronously (we're the main process in
// the guest). Mirrors run.sh's scrape_cmd. Bounded by a hard timeout.
function runScrape(slug) {
  return new Promise((resolve) => {
    // scrape.js invokes the claude CLI for the local-claude verification path; it
    // inherits the injected seat. Unset CLAUDECODE so nested-session detection doesn't fire.
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const child = spawn("node", ["agent/scripts/scrape.js", slug], { cwd: REPO, env });
    let out = "";
    const onData = (d) => { out += d.toString(); };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, TIMEOUT_S * 1000);
    let timedOut = false;
    const t2 = setTimeout(() => { timedOut = true; }, TIMEOUT_S * 1000);
    child.on("close", (code) => {
      clearTimeout(killer); clearTimeout(t2);
      resolve({ code: code ?? -1, out, timedOut });
    });
  });
}

function judge(code, out, timedOut) {
  if (timedOut) return { ok: false, reason: `timeout after ${TIMEOUT_S}s` };
  if (hitLimit(out)) return { ok: false, limit: true, reason: "rate/session limit" };
  if (code !== 0) return { ok: false, reason: `exit ${code}` };
  if (out.length < 300) return { ok: false, reason: `short output (${out.length} chars) — likely undetected limit` };
  return { ok: true, reason: "completed" };
}

async function main() {
  const command = "scrape";
  const task = await claim(command);
  if (!task) { log("queue empty — nothing to claim, exiting."); process.exit(0); }

  const slug = task.slug || task.params?.slug;
  if (!slug) {
    await fail(task.id, { type: "ValidationError", message: "no slug on task", retryable: false });
    log(`✗ ${task.id} has no slug`);
    process.exit(1);
  }
  log(`claimed scrape ${task.id}: ${slug}`);
  log(`→ node agent/scripts/scrape.js ${slug} (timeout ${TIMEOUT_S}s)`);
  const { code, out, timedOut } = await runScrape(slug);
  process.stdout.write(out.slice(-2000) + "\n");

  const v = judge(code, out, timedOut);
  if (v.limit) {
    await release(task.id, "rate/session limit reached");
    log(`⏸️  ${task.id} released (rate/session limit).`);
    process.exit(3);
  }
  if (v.ok) {
    await complete(task.id, { success: true, exit_code: code, stdout: out.slice(0, 10000), completed_at: new Date().toISOString() });
    log(`✅ ${task.id} (${slug}) completed.`);
    process.exit(0);
  }
  await fail(task.id, { type: "ExecutionError", message: v.reason, exit_code: code, stdout: out.slice(0, 10000), retryable: false });
  log(`❌ ${task.id} (${slug}) failed: ${v.reason}`);
  process.exit(1);
}

main().catch((e) => { console.error("[scrape-entry]", e?.message || e); process.exit(1); });
