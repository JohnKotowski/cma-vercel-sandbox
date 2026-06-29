/**
 * vercel-browser-overflow.ts — burst the requires_browser scrape backlog through
 * Vercel US Sandboxes (Firecracker microVM = US IP), agent-browser tier.
 *
 * Each sandbox: claim ONE requires_browser task (task-helper.js claim-browser — the
 * SAME atomic claim MMB's interaction tier uses, so no double-processing), run
 * `SCRAPE_ONLY=agent-browser SCRAPE_MODE=full node agent/scripts/scrape.js <slug>`
 * (identical to MMB), complete/fail via the helper, exit. Sandbox stopped immediately.
 *
 * Bounded experiment (John, 2026-06-29): measure cost, cap at $5, run ~50 parallel,
 * tear everything down after. Cost meter uses Vercel Sandbox Pro rates:
 *   Active CPU $0.128/vCPU-hr · Provisioned mem $0.0212/GB-hr (2GB/vCPU) · create $0.6/1M.
 * We bill WALL-clock × vCPUs as a conservative UPPER bound (real Active CPU excludes
 * I/O wait — most of a scrape — so true cost is lower; cross-check the Vercel dashboard).
 *
 * Env knobs:
 *   VO_CONCURRENCY   parallel sandboxes (default 50)
 *   VO_BUDGET_USD    hard cap; stop launching when projected spend hits it (default 5)
 *   VO_MAX_TASKS     stop after N tasks attempted (default unlimited)
 *   VO_VCPUS         vCPUs per sandbox (default 2 = Vercel default)
 *   VO_TIMEOUT_S     per-sandbox hard timeout (default 360)
 *   VO_QUEUE_EMPTY_STOP  consecutive empty claims before stopping (default 3)
 *
 * Usage: npx tsx scripts/vercel-browser-overflow.ts
 */
import { config } from "dotenv";
config({ path: `${__dirname}/../.env.local` });
config({ path: `${process.env.HOME}/.claude/.env`, override: false });
import { Sandbox } from "@vercel/sandbox";
import { readFileSync, existsSync, appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import ms from "ms";

const SNAPSHOT = process.env.SANDBOX_SCRAPE_SNAPSHOT_ID;
const SCRAPE_RABBIT_DIR = process.env.SCRAPE_RABBIT_DIR || `${process.env.HOME}/Projects/pricingsaas-scrape-rabbit`;
const REPO = "/vercel/sandbox/scrape-rabbit";
const creds =
  process.env.VERCEL_TOKEN && process.env.VERCEL_PROJECT_ID && process.env.VERCEL_TEAM_ID
    ? { token: process.env.VERCEL_TOKEN, projectId: process.env.VERCEL_PROJECT_ID, teamId: process.env.VERCEL_TEAM_ID }
    : undefined;

const CONCURRENCY = parseInt(process.env.VO_CONCURRENCY || "50", 10);
const BUDGET_USD = parseFloat(process.env.VO_BUDGET_USD || "5");
const MAX_TASKS = parseInt(process.env.VO_MAX_TASKS || "0", 10) || Infinity;
const VCPUS = parseInt(process.env.VO_VCPUS || "2", 10);
const TIMEOUT_S = parseInt(process.env.VO_TIMEOUT_S || "360", 10);
const QUEUE_EMPTY_STOP = parseInt(process.env.VO_QUEUE_EMPTY_STOP || "3", 10);
const LOG = "/tmp/vo-run.log";

// Vercel Sandbox Pro rates.
const CPU_RATE = 0.128 / 3600;            // $/vCPU-second
const MEM_RATE = 0.0212 / 3600;           // $/GB-second
const MEM_GB_PER_VCPU = 2;
const CREATE_COST = 0.6 / 1e6;            // $/creation
function costOf(wallSec: number): number {
  return wallSec * VCPUS * CPU_RATE + wallSec * VCPUS * MEM_GB_PER_VCPU * MEM_RATE + CREATE_COST;
}

const seat = process.env.ADD_WORKER_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN;

// Build a code-only tar of the CURRENT scrape-rabbit once (no node_modules — those stay
// baked in the snapshot). Overlaid per-sandbox so the Vercel scrapes run the SAME code as
// MMB (incl. the per-session isolation + require-real-artifacts contamination fixes) rather
// than the stale code baked in the snapshot.
let CODE_TAR: Buffer;
function buildCodeTar(): Buffer {
  const out = join(mkdtempSync(join(tmpdir(), "vo-sr-")), "sr-code.tar.gz");
  execSync(
    `tar czf "${out}" --exclude=node_modules --exclude=.git --exclude=tmp --exclude=logs ` +
      `--exclude='.DS_Store' --exclude='*.log' -C "${SCRAPE_RABBIT_DIR}" .`,
    { stdio: "ignore" }
  );
  return readFileSync(out);
}

function buildEnv(): Buffer {
  let dotenv = readFileSync(join(SCRAPE_RABBIT_DIR, ".env"), "utf8");
  const m = dotenv.match(/^\s*GOOGLE_APPLICATION_CREDENTIALS\s*=\s*(.+)$/m);
  if (m) dotenv = dotenv.replace(/^\s*GOOGLE_APPLICATION_CREDENTIALS\s*=.*$/m, `GOOGLE_APPLICATION_CREDENTIALS=${REPO}/gcp-creds.json`);
  if (/^\s*SCRAPE_MODE\s*=/m.test(dotenv)) dotenv = dotenv.replace(/^\s*SCRAPE_MODE\s*=.*$/m, `SCRAPE_MODE=full`);
  else dotenv += `\nSCRAPE_MODE=full\n`;
  return Buffer.from(dotenv.replace(/\n?$/, "\n"));
}

function gcpCreds(): Buffer | null {
  const dotenv = readFileSync(join(SCRAPE_RABBIT_DIR, ".env"), "utf8");
  const m = dotenv.match(/^\s*GOOGLE_APPLICATION_CREDENTIALS\s*=\s*(.+)$/m);
  if (!m) return null;
  const credsPath = m[1].trim().replace(/^["']|["']$/g, "");
  const abs = credsPath.startsWith("/") ? credsPath : join(SCRAPE_RABBIT_DIR, credsPath);
  return existsSync(abs) ? readFileSync(abs) : null;
}

function injectFiles() {
  const files: { path: string; content: Buffer }[] = [
    { path: "/tmp/sr-code.tar.gz", content: CODE_TAR },
    { path: "/tmp/vo.env", content: buildEnv() },
  ];
  const c = gcpCreds();
  if (c) files.push({ path: "/tmp/gcp-creds.json", content: c });
  return files;
}

// The in-sandbox program: overlay current code → install agent-browser → claim one browser
// task → agent-browser scrape → complete/fail.
function vmScript(workerId: string): string {
  return [
    `set +e`,
    `mkdir -p ${REPO}`,
    `tar xzf /tmp/sr-code.tar.gz -C ${REPO} 2>/tmp/untar.err || { echo "UNTAR_FAIL"; tail -3 /tmp/untar.err; exit 9; }`,
    `cp /tmp/vo.env ${REPO}/.env`,
    `[ -f /tmp/gcp-creds.json ] && cp /tmp/gcp-creds.json ${REPO}/gcp-creds.json`,
    `cd ${REPO} || { echo "NO_REPO"; exit 9; }`,
    `AB=$(command -v agent-browser || true)`,
    `if [ -z "$AB" ]; then echo "agent-browser MISSING — installing"; npm install -g agent-browser >/tmp/ab-install.log 2>&1; AB=$(command -v agent-browser || true); fi`,
    `echo "PROBE agent-browser=$AB"`,
    `task=$(node agent/workers/helpers/task-helper.js claim-browser "${workerId}" 2>/tmp/claim.err | tail -1)`,
    `tid=$(node -e 'let t={};try{t=JSON.parse(process.argv[1]||"{}")}catch(e){};const x=(t&&t.task)||t||{};process.stdout.write(String((x&&x.id)||""))' "$task")`,
    `slug=$(node -e 'let t={};try{t=JSON.parse(process.argv[1]||"{}")}catch(e){};const x=(t&&t.task)||t||{};process.stdout.write(String((x&&(x.slug||(x.params&&x.params.slug)))||""))' "$task")`,
    `if [ -z "$tid" ]; then echo "QUEUE_EMPTY $(cat /tmp/claim.err 2>/dev/null | tail -1)"; exit 0; fi`,
    `echo "CLAIMED slug=$slug tid=$tid"`,
    `if AGENT_BROWSER_SESSION=vo SCRAPE_ONLY=agent-browser SCRAPE_MODE=full node agent/scripts/scrape.js "$slug" > /tmp/scrape.out 2>&1; then`,
    `  node agent/workers/helpers/task-helper.js complete "$tid" '{"scraper":"agent-browser","tier":"vercel-overflow"}' >/dev/null 2>&1 || true`,
    `  echo "SCRAPE_OK slug=$slug"`,
    `else`,
    `  node agent/workers/helpers/task-helper.js fail "$tid" '{"error":"agent-browser failed in vercel-overflow","tier":"vercel-overflow"}' >/dev/null 2>&1 || true`,
    `  echo "SCRAPE_FAIL slug=$slug"; tail -8 /tmp/scrape.out`,
    `fi`,
  ].join("\n");
}

interface Outcome { name: string; wallSec: number; cost: number; result: string; slug: string; }

const live = new Set<any>();
let spent = 0, attempted = 0, ok = 0, failed = 0, emptyStreak = 0, launched = 0;
const outcomes: Outcome[] = [];

function logln(s: string) { const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`; console.log(line); try { appendFileSync(LOG, line + "\n"); } catch {} }

async function runOne(i: number): Promise<void> {
  const name = `vo-${Date.now()}-${i}`;
  const t0 = Date.now();
  let sandbox: any = null;
  let result = "ERROR", slug = "";
  try {
    sandbox = await Sandbox.create({
      name,
      source: { type: "snapshot", snapshotId: SNAPSHOT } as any,
      runtime: "node24",
      vcpus: VCPUS,
      timeout: ms(`${TIMEOUT_S}s`),
      ...creds,
    } as any);
    live.add(sandbox);
    await sandbox.writeFiles(injectFiles());
    await sandbox.writeFiles([{ path: "/tmp/vo.sh", content: Buffer.from(vmScript(name)) }]);
    await sandbox.runCommand({
      cmd: "bash",
      args: ["-c", `rm -f /tmp/vo.out /tmp/vo.done && nohup bash /tmp/vo.sh > /tmp/vo.out 2>&1; echo DONE_$? > /tmp/vo.done &`],
      env: { CLAUDE_CODE_OAUTH_TOKEN: seat!, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || seat!, WORKER_ID: name },
      detached: true,
    } as any);
    // poll for the done sentinel
    const maxPolls = Math.ceil((TIMEOUT_S + 30) / 10);
    for (let p = 0; p < maxPolls; p++) {
      await new Promise((r) => setTimeout(r, 10000));
      const chk = await sandbox.runCommand({ cmd: "bash", args: ["-c", "cat /tmp/vo.done 2>/dev/null || true"] });
      if (((await chk.stdout()) || "").trim().startsWith("DONE_")) break;
    }
    const out = await sandbox.runCommand({ cmd: "bash", args: ["-c", "cat /tmp/vo.out 2>/dev/null || true"] });
    const text = ((await out.stdout()) || "");
    const last = text.trim().split("\n").map((l) => l.trim());
    slug = (text.match(/slug=([^\s]+)/) || [])[1] || "";
    if (last.some((l) => l.startsWith("SCRAPE_OK"))) result = "OK";
    else if (last.some((l) => l.startsWith("SCRAPE_FAIL"))) result = "FAIL";
    else if (last.some((l) => l.startsWith("QUEUE_EMPTY"))) result = "EMPTY";
    else result = "TIMEOUT";
    if (i === 0) logln(`probe/first-vm output:\n${text.slice(0, 1200)}`);
  } catch (e: any) {
    result = "ERROR";
    logln(`sandbox ${name} error: ${e?.message || e}`);
  } finally {
    if (sandbox) { try { await sandbox.stop(); } catch {} live.delete(sandbox); }
  }
  const wallSec = (Date.now() - t0) / 1000;
  const c = costOf(wallSec);
  spent += c;
  outcomes.push({ name, wallSec, cost: c, result, slug });
  attempted++;
  if (result === "OK") ok++;
  else if (result === "FAIL") failed++;
  if (result === "EMPTY") emptyStreak++; else emptyStreak = 0;
  logln(`#${attempted} ${result} ${slug || "-"} ${wallSec.toFixed(0)}s $${c.toFixed(4)} | spent=$${spent.toFixed(3)} ok=${ok} fail=${failed}`);
}

async function main() {
  if (!SNAPSHOT) { console.error("SANDBOX_SCRAPE_SNAPSHOT_ID missing"); process.exit(1); }
  if (!seat) { console.error("no seat (ADD_WORKER_OAUTH_TOKEN/CLAUDE_CODE_OAUTH_TOKEN)"); process.exit(1); }
  if (!creds) { console.error("Vercel creds missing"); process.exit(1); }
  CODE_TAR = buildCodeTar();
  logln(`START concurrency=${CONCURRENCY} budget=$${BUDGET_USD} maxTasks=${MAX_TASKS === Infinity ? "∞" : MAX_TASKS} vcpus=${VCPUS} timeout=${TIMEOUT_S}s codeTar=${(CODE_TAR.length / 1024 / 1024).toFixed(1)}MB`);

  // graceful teardown on signal
  const teardown = async () => { logln(`teardown: stopping ${live.size} live sandboxes`); for (const s of [...live]) { try { await s.stop(); } catch {} } };
  process.on("SIGINT", async () => { await teardown(); process.exit(130); });

  const inflight = new Set<Promise<void>>();
  let i = 0;
  // rough per-task wall estimate for budget headroom (updated from observed)
  const estWall = () => (outcomes.length ? outcomes.reduce((a, o) => a + o.wallSec, 0) / outcomes.length : TIMEOUT_S * 0.5);

  while (true) {
    const projectedNext = spent + costOf(estWall());
    const stop =
      emptyStreak >= QUEUE_EMPTY_STOP ||
      attempted + inflight.size >= MAX_TASKS ||
      projectedNext > BUDGET_USD;
    if (stop && inflight.size === 0) break;
    if (!stop && inflight.size < CONCURRENCY && attempted + inflight.size < MAX_TASKS) {
      const idx = i++;
      const p = runOne(idx).finally(() => inflight.delete(p));
      inflight.add(p);
      // stagger launches slightly to respect the 200 vCPU/min ramp rate
      await new Promise((r) => setTimeout(r, 700));
    } else {
      await Promise.race(inflight.size ? [...inflight] : [new Promise((r) => setTimeout(r, 500))]);
    }
  }
  await teardown();

  const totalWall = outcomes.reduce((a, o) => a + o.wallSec, 0);
  logln(`\n===== VERCEL BROWSER OVERFLOW — DONE =====`);
  logln(`attempted=${attempted} ok=${ok} fail=${failed} empty=${outcomes.filter(o => o.result === "EMPTY").length} timeout/err=${outcomes.filter(o => o.result === "TIMEOUT" || o.result === "ERROR").length}`);
  logln(`est spend=$${spent.toFixed(3)} (wall-clock UPPER bound; real Active-CPU lower) | $/ok=${ok ? "$" + (spent / ok).toFixed(3) : "n/a"}`);
  logln(`total sandbox wall-time=${(totalWall / 60).toFixed(1)} min · avg ${attempted ? (totalWall / attempted).toFixed(0) : 0}s/task`);
  logln(`live sandboxes remaining=${live.size} (should be 0)`);
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
