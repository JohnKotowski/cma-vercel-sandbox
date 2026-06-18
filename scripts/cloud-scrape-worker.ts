/**
 * cloud-scrape-worker.ts — run ONE Claude-capable scrape off-Mac in a Vercel Sandbox.
 *
 * Single-shot launcher (counterpart to cloud-add-worker.ts): boots a sandbox from the
 * scrape snapshot (SANDBOX_SCRAPE_SNAPSHOT_ID — scrape-rabbit + claude + playwright baked),
 * injects scrape-rabbit's .env + the Google Vision creds + the seat at runtime, ships in
 * cloud-scrape-entry.mjs, and runs it once: claim one `scrape` task → node scrape.js <slug>
 * → complete/fail → exit. Proves the heavy (firecrawl-unworkable) scrape path works with the
 * Macs down. The dispatcher will fan this out one-per-task, capped, on the heartbeat.
 *
 * Usage:
 *   npx tsx scripts/cloud-scrape-worker.ts            # claim + scrape one task, poll to done
 *   npx tsx scripts/cloud-scrape-worker.ts --stop     # stop the warm sandbox
 */

import { config } from "dotenv";
config({ path: `${__dirname}/../.env.local` });
config({ path: `${process.env.HOME}/.claude/.env`, override: false });
import { Sandbox } from "@vercel/sandbox";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import ms from "ms";

const SNAPSHOT = process.env.SANDBOX_SCRAPE_SNAPSHOT_ID;
const SCRAPE_RABBIT_DIR = process.env.SCRAPE_RABBIT_DIR || `${process.env.HOME}/Projects/pricingsaas-scrape-rabbit`;
// Unique per run — Sandbox.create 400s on a name that still exists (even stopped).
const SANDBOX_NAME = process.env.SCRAPE_WORKER_NAME || `scrape-worker-${Date.now()}`;
const REPO = "/vercel/sandbox/scrape-rabbit";
const ENTRY = "/vercel/sandbox/cloud-scrape-entry.mjs";
const ENTRY_LOCAL = `${__dirname}/cloud-scrape-entry.mjs`;
const MGMT = process.env.MANAGEMENT_API_URL || "https://qulnbyjrczvoxemtrili.supabase.co/functions/v1/management";
const TIMEOUT_S = process.env.SCRAPE_TASK_TIMEOUT_S || "1500";

const creds =
  process.env.VERCEL_TOKEN && process.env.VERCEL_PROJECT_ID && process.env.VERCEL_TEAM_ID
    ? { token: process.env.VERCEL_TOKEN, projectId: process.env.VERCEL_PROJECT_ID, teamId: process.env.VERCEL_TEAM_ID }
    : undefined;

const argv = process.argv.slice(2);
const has = (n: string) => argv.includes(`--${n}`);

// Build the files to inject: the entry, scrape-rabbit's .env (GOOGLE_APPLICATION_CREDENTIALS
// rewritten to the in-sandbox path), and the Google Vision creds JSON.
function injectFiles() {
  const files: { path: string; content: Buffer }[] = [
    { path: ENTRY, content: readFileSync(ENTRY_LOCAL) },
  ];
  let dotenv = readFileSync(join(SCRAPE_RABBIT_DIR, ".env"), "utf8");
  // Resolve the GOOGLE_APPLICATION_CREDENTIALS file (relative in scrape-rabbit's .env).
  const m = dotenv.match(/^\s*GOOGLE_APPLICATION_CREDENTIALS\s*=\s*(.+)$/m);
  if (m) {
    const credsPath = m[1].trim().replace(/^["']|["']$/g, "");
    const abs = credsPath.startsWith("/") ? credsPath : join(SCRAPE_RABBIT_DIR, credsPath);
    if (existsSync(abs)) {
      const dest = `${REPO}/gcp-creds.json`;
      files.push({ path: dest, content: readFileSync(abs) });
      dotenv = dotenv.replace(/^\s*GOOGLE_APPLICATION_CREDENTIALS\s*=.*$/m, `GOOGLE_APPLICATION_CREDENTIALS=${dest}`);
    }
  }
  // Force the heavy (local-claude) path — the whole point off-Mac. scrape-rabbit's local
  // .env is SCRAPE_MODE=firecrawl-only, which would short-circuit + release the very
  // firecrawl-unworkable tasks we exist to handle. Replace it (don't just append).
  if (/^\s*SCRAPE_MODE\s*=/m.test(dotenv)) dotenv = dotenv.replace(/^\s*SCRAPE_MODE\s*=.*$/m, `SCRAPE_MODE=full`);
  else dotenv += `\nSCRAPE_MODE=full\n`;
  files.push({ path: `${REPO}/.env`, content: Buffer.from(dotenv.replace(/\n?$/, "\n")) });
  return files;
}

async function main() {
  if (has("stop")) {
    try { const s = await Sandbox.get({ name: SANDBOX_NAME, ...creds }); await s.stop(); console.log("stopped"); }
    catch (e: any) { if (e?.status !== 404) throw e; console.log("no sandbox"); }
    return;
  }
  if (!SNAPSHOT) { console.error("SANDBOX_SCRAPE_SNAPSHOT_ID not set in .env.local"); process.exit(1); }
  const seat = process.env.ADD_WORKER_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!seat) { console.error("No seat (ADD_WORKER_OAUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN)."); process.exit(1); }
  const queueKey = process.env.TASK_QUEUE_API_KEY!;

  console.log(`Booting scrape sandbox '${SANDBOX_NAME}' from ${SNAPSHOT}…`);
  const sandbox = await Sandbox.create({
    name: SANDBOX_NAME,
    source: { type: "snapshot", snapshotId: SNAPSHOT } as any,
    runtime: "node24",
    timeout: ms("30m"),
    ...creds,
  });

  await sandbox.writeFiles(injectFiles());
  console.log("→ injected entry + scrape-rabbit .env + google creds");

  await sandbox.runCommand({
    cmd: "bash",
    args: ["-c", `cd ${REPO} && rm -f /tmp/scrape.out /tmp/scrape.done && nohup bash -c 'node ${ENTRY} > /tmp/scrape.out 2>&1; echo "EXIT_$?" > /tmp/scrape.done' >/dev/null 2>&1 &`],
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: seat,
      TASK_QUEUE_API_KEY: queueKey,
      MGMT_URL: MGMT,
      REPO,
      SCRAPE_TASK_TIMEOUT_S: TIMEOUT_S,
      WORKER_ID: SANDBOX_NAME,
    },
    detached: true,
  });
  console.log(`→ scrape entry launched (timeout ${TIMEOUT_S}s); polling…`);

  let exit = -1;
  const maxPolls = Math.ceil((Number(TIMEOUT_S) + 120) / 15);
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, 15000));
    const chk = await sandbox.runCommand({ cmd: "bash", args: ["-c", "cat /tmp/scrape.done 2>/dev/null || true"] });
    const done = ((await chk.stdout()) || "").trim();
    if (done.startsWith("EXIT_")) { exit = parseInt(done.slice(5), 10) || 0; break; }
    if (i % 4 === 0) {
      const tail = await sandbox.runCommand({ cmd: "bash", args: ["-c", "tail -3 /tmp/scrape.out 2>/dev/null || true"] });
      console.log(`··· ${(i + 1) * 15}s: ${((await tail.stdout()) || "").trim().split("\n").pop()}`);
    }
  }
  const out = await sandbox.runCommand({ cmd: "bash", args: ["-c", "cat /tmp/scrape.out 2>/dev/null || true"] });
  console.log("\n──── scrape tail ────");
  console.log(((await out.stdout()) || "").slice(-3000));
  console.log(`\n(exit ${exit})`);
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
