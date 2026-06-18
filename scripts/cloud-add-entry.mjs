/**
 * cloud-add-entry.mjs — the SELF-DRIVING, one-shot add worker that runs INSIDE a
 * Vercel sandbox (shipped in by cloud-add-dispatch.ts).
 *
 * Exactly one task, then exit — deliberately NOT run-add.sh's poll loop. The
 * dispatcher fans out one sandbox per pending task; each sandbox runs this once:
 *   claim one run_add (then run_add_page) → /add-scrape-extract → complete/fail → exit.
 * The sandbox auto-stops at its (tight) timeout right after, so there's near-zero idle.
 *
 * No @vercel/sandbox import — this runs in the guest, not the orchestrator. Pure
 * node24 (global fetch) + the claude CLI + the extract-rabbit repo (all baked in
 * the snapshot). Secrets arrive as process env from the dispatcher; the rest of
 * the pipeline's creds are in the repo's .env (written by the dispatcher).
 *
 * Env in:
 *   CLAUDE_CODE_OAUTH_TOKEN   the add-worker seat (claude auths off this)
 *   TASK_QUEUE_API_KEY        claude_tasks management API
 *   MGMT_URL                  default https://qulnbyjrczvoxemtrili.supabase.co/functions/v1/management
 *   REPO                      default /vercel/sandbox/extract-rabbit
 *   ADD_TASK_TIMEOUT_S        default 1080 (18m) — one add is ~14m
 *   WORKER_ID                 label for the claim (default cloud-add-entry)
 *
 * Exit codes: 0 = task done or queue empty · 1 = task failed · 3 = released (rate limit).
 */

import { spawn } from "node:child_process";

const MGMT = process.env.MGMT_URL || "https://qulnbyjrczvoxemtrili.supabase.co/functions/v1/management";
const REPO = process.env.REPO || "/vercel/sandbox/extract-rabbit";
const TIMEOUT_S = Number(process.env.ADD_TASK_TIMEOUT_S || "1080");
const WORKER_ID = process.env.WORKER_ID || "cloud-add-entry";
const QUEUE_KEY = process.env.TASK_QUEUE_API_KEY;

function log(...a) { console.log(`[add-entry]`, ...a); }

if (!QUEUE_KEY) { console.error("[add-entry] TASK_QUEUE_API_KEY missing — cannot claim."); process.exit(1); }
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
  console.error("[add-entry] no seat (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY) — claude can't auth.");
  process.exit(1);
}

async function claim(command) {
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

// Mirror run-add.sh / cloud-add-worker.ts buildSlash.
function buildSlash(command, params) {
  const url = params?.pricing_page_url;
  if (!url) throw new Error(`missing pricing_page_url for ${command}`);
  const companySlug = params?.company_slug;
  const pageSlug = params?.page_slug;
  let slash = `/add-scrape-extract ${url} --non-interactive`;
  if (command === "run_add_page") {
    if (!companySlug) throw new Error("missing company_slug for run_add_page");
    if (!pageSlug) throw new Error("missing page_slug for run_add_page");
    slash += ` --skip-add --company-slug=${companySlug} --page-slug=${pageSlug}`;
  } else {
    if (companySlug) slash += ` --company-slug=${companySlug}`;
    if (pageSlug) slash += ` --page-slug=${pageSlug}`;
  }
  return slash;
}

// Run claude -p synchronously (we're the main process in the guest — no external
// stream to idle out, unlike the launcher). Bounded by a hard timeout.
function runClaude(slash) {
  return new Promise((resolve) => {
    // claude inherits the injected seat (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY).
    const child = spawn("claude", ["-p", slash, "--dangerously-skip-permissions"], {
      cwd: REPO,
      env: process.env,
    });
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
  if (out.length < 500) return { ok: false, reason: `short output (${out.length} chars) — likely undetected limit` };
  return { ok: true, reason: "completed" };
}

async function main() {
  let command = "run_add";
  let task = await claim("run_add");
  if (!task) { command = "run_add_page"; task = await claim("run_add_page"); }
  if (!task) { log("queue empty — nothing to claim, exiting."); process.exit(0); }

  log(`claimed ${command} ${task.id}: ${task.params?.pricing_page_url || "?"}`);
  let slash;
  try {
    slash = buildSlash(command, task.params);
  } catch (e) {
    await fail(task.id, { type: "ValidationError", message: String(e?.message || e), retryable: false });
    log(`✗ ${task.id} bad params: ${e?.message}`);
    process.exit(1);
  }

  log(`→ claude -p "${slash}" (timeout ${TIMEOUT_S}s)`);
  const { code, out, timedOut } = await runClaude(slash);
  process.stdout.write(out.slice(-2000) + "\n");

  const v = judge(code, out, timedOut);
  if (v.limit) {
    await release(task.id, "rate/session limit reached");
    log(`⏸️  ${task.id} released (rate/session limit).`);
    process.exit(3);
  }
  if (v.ok) {
    await complete(task.id, { success: true, exit_code: code, stdout: out.slice(0, 10000), completed_at: new Date().toISOString() });
    log(`✅ ${task.id} completed.`);
    process.exit(0);
  }
  await fail(task.id, { type: "ExecutionError", message: v.reason, exit_code: code, stdout: out.slice(0, 10000), retryable: false });
  log(`❌ ${task.id} failed: ${v.reason}`);
  process.exit(1);
}

main().catch((e) => { console.error("[add-entry]", e?.message || e); process.exit(1); });
