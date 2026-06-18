/**
 * cloud-add-worker.ts — Cloud `run_add` worker (Vercel Sandbox).
 *
 * Runs pricingsaas-extract-rabbit's `/add-scrape-extract` inside a Vercel Sandbox
 * booted from the add snapshot (see build-add-snapshot.ts) — turning a pricing
 * URL into a tracked company (add → scrape → extract → upload to vault). This is
 * the worker Rebecca's onboarding heartbeat feeds: it drains `run_add` /
 * `run_add_page` tasks from the shared `claude_tasks` queue, off-Mac, so the
 * onboarding loop doesn't depend on a local seat.
 *
 * Auth (dual): a fresh sandbox has no keychain, so whichever seat we inject wins.
 *   - ADD_WORKER_ANTHROPIC_API_KEY  → injected as ANTHROPIC_API_KEY (metered, no
 *                                     rate-limit wall; same model as the diff worker)
 *   - ADD_WORKER_OAUTH_TOKEN        → injected as CLAUDE_CODE_OAUTH_TOKEN (a Claude
 *                                     sub seat, flat-rate; backs off on Sonnet limit)
 *   Set ONE in ~/.claude/.env. API key wins if both are set.
 *
 * Modes:
 *   --url <pricing_url> [--company-slug <s>] [--page-slug <s>] [--skip-add]
 *                              Run one add directly (no queue) — safe for the test.
 *   --claim                    Claim one pending run_add (then run_add_page) task,
 *                              run it, complete/fail it.
 *   --loop [--max <n>]         Claim+process repeatedly (reusing the warm sandbox)
 *                              until the queue is empty, --max is hit, or the
 *                              wall-clock budget runs out. A "standing" drain.
 *   --stop                     Stop the warm sandbox.
 *
 * Other env (← ~/.claude/.env / extract-rabbit .env, injected at runtime, never baked):
 *   Vercel creds + SANDBOX_ADD_SNAPSHOT_ID  ← cma-vercel-sandbox/.env.local
 *   extract-rabbit .env (queue + vault + cloudinary + GCP creds)  ← host repo .env
 *
 * Usage:
 *   npx tsx scripts/cloud-add-worker.ts --url https://www.gwi.com/pricing
 *   npx tsx scripts/cloud-add-worker.ts --claim
 *   npx tsx scripts/cloud-add-worker.ts --loop --max 5
 *   npx tsx scripts/cloud-add-worker.ts --stop
 */

import { config } from "dotenv";
config({ path: `${__dirname}/../.env.local` }); // Vercel creds + snapshot id
config({ path: `${process.env.HOME}/.claude/.env`, override: false }); // seat + secrets
import { Sandbox } from "@vercel/sandbox";
import { readFileSync, existsSync } from "node:fs";
import ms from "ms";

const EXTRACT_RABBIT_DIR =
  process.env.EXTRACT_RABBIT_DIR || `${process.env.HOME}/Projects/pricingsaas-extract-rabbit`;
const SANDBOX_REPO = "/vercel/sandbox/extract-rabbit";
const SANDBOX_GCP_CREDS = `${SANDBOX_REPO}/gcp-creds.json`;
const SNAPSHOT = process.env.SANDBOX_ADD_SNAPSHOT_ID;
const SANDBOX_NAME = process.env.ADD_WORKER_SANDBOX_NAME || "add-worker";
const MANAGEMENT_API_URL =
  process.env.MANAGEMENT_API_URL ||
  "https://qulnbyjrczvoxemtrili.supabase.co/functions/v1/management";
// A single add (scrape + extract + upload) is minutes; 1200s is generous.
const ADD_TIMEOUT_S = process.env.ADD_TASK_TIMEOUT_S || "1200";

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

// ── shared queue helpers (mirror run-add.sh / cloud-diff-worker.ts) ────────────
async function claimTask(apiKey: string, command: string): Promise<any | null> {
  const res = await fetch(`${MANAGEMENT_API_URL}/tasks/claim`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ command, worker_id: `cloud-${SANDBOX_NAME}` }),
  });
  const json = await res.json().catch(() => ({}));
  if (json?.task) return json.task;
  return null; // empty queue or NOT_FOUND
}
async function completeTask(apiKey: string, id: string, result: any) {
  await fetch(`${MANAGEMENT_API_URL}/tasks/${id}/complete`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ result }),
  }).then((r) => r.json()).catch(() => ({}));
}
async function failTask(apiKey: string, id: string, error: any) {
  await fetch(`${MANAGEMENT_API_URL}/tasks/${id}/fail`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ error }),
  }).then((r) => r.json()).catch(() => ({}));
}
async function releaseTask(apiKey: string, id: string, reason: string) {
  await fetch(`${MANAGEMENT_API_URL}/tasks/${id}/release`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  }).then((r) => r.json()).catch(() => ({}));
}

// ── limit detection (mirror run-add.sh) ────────────────────────────────────────
function hitLimit(output: string): boolean {
  return /your credit balance is too low|rate limit exceeded|too many requests|429 status code|overloaded_error|rate_limit_error|session limit|usage limit reached|limit reached.*reset|resets [0-9]+\s*[ap]m/i.test(
    output
  );
}

// ── build the /add-scrape-extract slash command from task params ───────────────
// Mirrors run-add.sh build_claude_command for run_add + run_add_page.
function buildSlash(command: string, params: any): { slash: string; tabParams: string | null } {
  const url = params?.pricing_page_url;
  const companySlug = params?.company_slug;
  const pageSlug = params?.page_slug;
  if (!url) throw new Error(`missing pricing_page_url for ${command}`);

  let slash = `/add-scrape-extract ${url} --non-interactive`;
  if (command === "run_add_page") {
    if (!companySlug) throw new Error("missing company_slug for run_add_page");
    if (!pageSlug) throw new Error("missing page_slug for run_add_page");
    slash += ` --skip-add --company-slug=${companySlug} --page-slug=${pageSlug}`;
  } else {
    if (companySlug) slash += ` --company-slug=${companySlug}`;
    if (pageSlug) slash += ` --page-slug=${pageSlug}`;
  }

  // Tab params (navigation_hint / pre_screenshot_actions / verification_prompt)
  // go to a file the skill reads — mirror run-add.sh.
  const tab: Record<string, unknown> = {};
  if (params?.navigation_hint) tab.navigation_hint = params.navigation_hint;
  if (params?.pre_screenshot_actions) tab.pre_screenshot_actions = params.pre_screenshot_actions;
  if (params?.verification_prompt) tab.verification_prompt = params.verification_prompt;
  const tabParams = Object.keys(tab).length ? JSON.stringify(tab) : null;
  if (tabParams) slash += ` --tab-params-file=/tmp/tab_params.json`;
  return { slash, tabParams };
}

// ── inject runtime env (.env + GCP creds + seat) into the sandbox ──────────────
function readEnv(): { raw: string; vars: Record<string, string> } {
  const raw = readFileSync(`${EXTRACT_RABBIT_DIR}/.env`, "utf8");
  const vars: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { raw, vars };
}

async function injectEnv(sandbox: Sandbox, envRaw: string, vars: Record<string, string>) {
  const files: { path: string; content: Buffer }[] = [];
  // Rewrite GOOGLE_APPLICATION_CREDENTIALS to the in-sandbox path + ship the file.
  let env = envRaw;
  const gcpPath = vars.GOOGLE_APPLICATION_CREDENTIALS;
  if (gcpPath && existsSync(gcpPath)) {
    files.push({ path: SANDBOX_GCP_CREDS, content: Buffer.from(readFileSync(gcpPath)) });
    env = env.replace(
      /^\s*GOOGLE_APPLICATION_CREDENTIALS\s*=.*$/m,
      `GOOGLE_APPLICATION_CREDENTIALS=${SANDBOX_GCP_CREDS}`
    );
  } else if (gcpPath) {
    console.warn(`⚠️  GOOGLE_APPLICATION_CREDENTIALS file not found locally (${gcpPath}); vault upload may fail.`);
  }
  files.push({ path: `${SANDBOX_REPO}/.env`, content: Buffer.from(env.replace(/\n?$/, "\n")) });
  await sandbox.writeFiles(files);
}

// ── core: run one /add-scrape-extract inside the sandbox (detached + poll) ──────
async function runAddInSandbox(
  sandbox: Sandbox,
  seatEnv: Record<string, string>,
  slash: string,
  tabParams: string | null
): Promise<{ exitCode: number; stdout: string; limited: boolean }> {
  if (tabParams) {
    await sandbox.writeFiles([{ path: "/tmp/tab_params.json", content: Buffer.from(tabParams) }]);
  }
  console.log(`\n→ claude -p "${slash}" (detached + poll, timeout ${ADD_TIMEOUT_S}s)\n`);

  // Detach + poll (a long single stream idles out before the run finishes —
  // same fix as the scrape/onboarding-beat runners).
  await sandbox.runCommand({
    cmd: "bash",
    args: [
      "-c",
      `cd ${SANDBOX_REPO} && rm -f /tmp/add.out /tmp/add.done && ` +
        `nohup bash -c 'timeout ${ADD_TIMEOUT_S} claude -p "$SLASH" --dangerously-skip-permissions > /tmp/add.out 2>&1; echo "EXIT_$?" > /tmp/add.done' >/dev/null 2>&1 &`,
    ],
    env: { ...seatEnv, SLASH: slash },
    detached: true,
  });

  let exitCode = -1;
  const POLL_MS = 15000;
  const maxPolls = Math.ceil((Number(ADD_TIMEOUT_S) + 120) / 15);
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const chk = await sandbox.runCommand({ cmd: "bash", args: ["-c", "cat /tmp/add.done 2>/dev/null || true"] });
    const done = ((await chk.stdout()) || "").trim();
    if (done.startsWith("EXIT_")) {
      exitCode = parseInt(done.slice(5), 10);
      if (Number.isNaN(exitCode)) exitCode = 0;
      break;
    }
    console.log(`··· add running ${(i + 1) * 15}s`);
  }
  const outCmd = await sandbox.runCommand({ cmd: "bash", args: ["-c", "cat /tmp/add.out 2>/dev/null || true"] });
  const stdout = (await outCmd.stdout()) || "";
  return { exitCode, stdout, limited: hitLimit(stdout) };
}

// Resolve the seat to inject (API key wins; else OAuth token).
function resolveSeat(): { env: Record<string, string>; label: string } {
  const apiKey = process.env.ADD_WORKER_ANTHROPIC_API_KEY;
  const oauth = process.env.ADD_WORKER_OAUTH_TOKEN;
  if (apiKey) return { env: { ANTHROPIC_API_KEY: apiKey }, label: "ADD_WORKER_ANTHROPIC_API_KEY (API key)" };
  if (oauth) return { env: { CLAUDE_CODE_OAUTH_TOKEN: oauth }, label: "ADD_WORKER_OAUTH_TOKEN (sub seat)" };
  console.error(
    "No seat: set ADD_WORKER_ANTHROPIC_API_KEY or ADD_WORKER_OAUTH_TOKEN in ~/.claude/.env. Ask John to mint one."
  );
  process.exit(1);
}

// success heuristic (mirror run-add.sh): clean exit, not limited, substantial output.
function judge(exitCode: number, stdout: string, limited: boolean): { ok: boolean; reason: string } {
  if (limited) return { ok: false, reason: "rate/session limit" };
  if (exitCode !== 0) return { ok: false, reason: `exit ${exitCode}` };
  if (stdout.length < 500) return { ok: false, reason: `suspiciously short output (${stdout.length} chars) — likely undetected limit` };
  return { ok: true, reason: "completed" };
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
  if (!SNAPSHOT) {
    console.error("SANDBOX_ADD_SNAPSHOT_ID not set in .env.local. Run build-add-snapshot.ts first.");
    process.exit(1);
  }

  const { env: seatEnv, label: seatLabel } = resolveSeat();
  console.log(`Seat: ${seatLabel}`);
  const { raw: envRaw, vars } = readEnv();
  const queueKey = vars.TASK_QUEUE_API_KEY;

  const loopMode = has("loop");
  const claimMode = has("claim") || loopMode;
  const directUrl = flag("url");
  if (!claimMode && !directUrl) {
    console.error("Usage: cloud-add-worker.ts --url <pricing_url> | --claim | --loop | --stop");
    process.exit(1);
  }
  if (claimMode && !queueKey) {
    console.error("TASK_QUEUE_API_KEY missing from extract-rabbit/.env — needed for --claim/--loop.");
    process.exit(1);
  }

  console.log(`Booting sandbox '${SANDBOX_NAME}' from add snapshot...`);
  const sandbox = await Sandbox.getOrCreate({
    name: SANDBOX_NAME,
    source: { type: "snapshot", snapshotId: SNAPSHOT } as any,
    runtime: "node24",
    timeout: ms("30m"),
    ...credentials,
  });

  try {
    await injectEnv(sandbox, envRaw, vars);

    // Direct mode — one explicit URL, no queue.
    if (directUrl && !claimMode) {
      const command = has("skip-add") ? "run_add_page" : "run_add";
      const params: any = { pricing_page_url: directUrl };
      if (flag("company-slug")) params.company_slug = flag("company-slug");
      if (flag("page-slug")) params.page_slug = flag("page-slug");
      const { slash, tabParams } = buildSlash(command, params);
      const { exitCode, stdout, limited } = await runAddInSandbox(sandbox, seatEnv, slash, tabParams);
      const v = judge(exitCode, stdout, limited);
      console.log("\n──── add tail ────");
      console.log(stdout.slice(-3000));
      console.log(`──── ${v.ok ? "✅" : "❌"} ${v.reason} (exit ${exitCode}) ────`);
      if (!v.ok) process.exitCode = 1;
      return;
    }

    // Queue mode — claim run_add, then run_add_page. Loop drains until empty/budget.
    const maxTasks = loopMode ? Number(flag("max") || "0") || Infinity : 1;
    const budgetMs = ms("26m"); // leave headroom under the 30m sandbox timeout
    const startedAt = Date.now();
    let processed = 0;

    while (processed < maxTasks && Date.now() - startedAt < budgetMs) {
      let task = await claimTask(queueKey!, "run_add");
      let command = "run_add";
      if (!task) {
        task = await claimTask(queueKey!, "run_add_page");
        command = "run_add_page";
      }
      if (!task) {
        console.log(loopMode ? "Queue empty — done draining." : "No pending run_add/run_add_page tasks.");
        break;
      }
      console.log(`\nClaimed ${command} task ${task.id}: ${task.params?.pricing_page_url || "?"}`);

      let slash: string, tabParams: string | null;
      try {
        ({ slash, tabParams } = buildSlash(command, task.params));
      } catch (e: any) {
        await failTask(queueKey!, task.id, { type: "ValidationError", message: e?.message, retryable: false });
        console.log(`❌ ${task.id} bad params: ${e?.message}`);
        continue;
      }

      const { exitCode, stdout, limited } = await runAddInSandbox(sandbox, seatEnv, slash, tabParams);
      console.log("\n──── add tail ────");
      console.log(stdout.slice(-2000));

      if (limited) {
        // Don't burn the task: release it back to pending and stop (retry after reset).
        await releaseTask(queueKey!, task.id, "rate/session limit reached");
        console.log(`⏸️  ${task.id} released (rate/session limit) — stopping drain.`);
        process.exitCode = 3;
        break;
      }

      const v = judge(exitCode, stdout, limited);
      if (v.ok) {
        await completeTask(queueKey!, task.id, {
          success: true,
          exit_code: exitCode,
          stdout: stdout.slice(0, 10000),
          completed_at: new Date().toISOString(),
        });
        console.log(`✅ ${task.id} completed.`);
      } else {
        await failTask(queueKey!, task.id, {
          type: "ExecutionError",
          message: v.reason,
          exit_code: exitCode,
          stdout: stdout.slice(0, 10000),
          retryable: false,
        });
        console.log(`❌ ${task.id} failed: ${v.reason}`);
      }
      processed += 1;
    }
    console.log(`\nProcessed ${processed} task(s).`);
  } finally {
    // Leave warm (auto-stops after idle). Use --stop to tear down.
  }
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
