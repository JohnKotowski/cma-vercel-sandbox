/**
 * build-diff-snapshot.ts — Build a Vercel Sandbox snapshot that can run a
 * pricingsaas-diff-rabbit diff worker (the seat-bound stage of Bob's pipeline).
 *
 * This is the cloud-failover counterpart to build-snapshot.ts (which builds the
 * agent_browser_cloud / extract snapshot). The diff snapshot bakes:
 *   - node24 (runtime default)  + python3  (one date calc in prepare-diff.js)
 *   - the `claude` CLI (@anthropic-ai/claude-code) — diff pipeline shells out to
 *     `claude "/worker-diff …"`, "/verify-diff-v2", "/update-pricing"
 *   - the diff-rabbit repo (code only — .claude skills/agents travel with it) +
 *     its node_modules (npm ci)
 *
 * It does NOT bake any secrets: the diff-rabbit .env and the Anthropic API key
 * are injected at runtime by cloud-diff-worker.ts. A fresh sandbox has no
 * macOS keychain, so an injected ANTHROPIC_API_KEY wins → API billing, not a
 * (maxed-out) Max seat. That is the whole point of the failover.
 *
 * Staleness note: this bakes the pipeline CODE into the image, so rebuild the
 * snapshot whenever diff-rabbit's pipeline changes materially. For production
 * (Phase 3) the runner should `git pull` the repo at runtime instead; for the
 * Phase 1 manual test a baked, self-contained image is simpler and correct for
 * the diff under test.
 *
 * Usage:
 *   npx tsx scripts/build-diff-snapshot.ts
 *   DIFF_RABBIT_DIR=/path/to/pricingsaas-diff-rabbit npx tsx scripts/build-diff-snapshot.ts
 *
 * On success prints:  SANDBOX_DIFF_SNAPSHOT_ID=<id>   (add it to .env.local)
 */

import { config } from "dotenv";
config({ path: `${__dirname}/../.env.local` });
import { Sandbox } from "@vercel/sandbox";
import { execSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ms from "ms";

const DIFF_RABBIT_DIR =
  process.env.DIFF_RABBIT_DIR || `${process.env.HOME}/Projects/pricingsaas-diff-rabbit`;

// Where the repo lands inside the sandbox (mirrors build-snapshot.ts's /vercel/sandbox root).
const SANDBOX_REPO = "/vercel/sandbox/diff-rabbit";
const SANDBOX_TARBALL = "/vercel/sandbox/diff-rabbit.tar.gz";

// The claude CLI npm package. Global install puts `claude` on PATH.
const CLAUDE_CLI_PKG = "@anthropic-ai/claude-code";

// Optional explicit Vercel credentials (avoids OIDC requirement in non-interactive envs).
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const credentials =
  VERCEL_TOKEN && VERCEL_PROJECT_ID && VERCEL_TEAM_ID
    ? { token: VERCEL_TOKEN, projectId: VERCEL_PROJECT_ID, teamId: VERCEL_TEAM_ID }
    : undefined;

async function run(sandbox: Sandbox, label: string, cmd: string, args: string[]) {
  console.log(`\n→ ${label}`);
  const result = await sandbox.runCommand(cmd, args);
  const stdout = (await result.stdout())?.trim();
  const stderr = (await result.stderr())?.trim();
  if (stdout) console.log(stdout.slice(-2000));
  if (result.exitCode !== 0) {
    if (stderr) console.error(stderr.slice(-2000));
    throw new Error(`${label} failed (exit ${result.exitCode})`);
  }
}

function buildTarball(): Buffer {
  // Lean tarball: code only. Exclude the heavy/regenerable dirs (node_modules
  // is reinstalled via npm ci; tmp/.git/benchmarks aren't needed to run a diff).
  const out = join(mkdtempSync(join(tmpdir(), "diffrabbit-")), "diff-rabbit.tar.gz");
  console.log(`Packing ${DIFF_RABBIT_DIR} → ${out} (excluding node_modules/.git/tmp/benchmarks)`);
  execSync(
    `tar czf "${out}" ` +
      `--exclude=node_modules --exclude=.git --exclude=tmp --exclude=benchmarks ` +
      `--exclude='.DS_Store' -C "${DIFF_RABBIT_DIR}" .`,
    { stdio: "inherit" }
  );
  return readFileSync(out);
}

async function main() {
  const tarball = buildTarball();
  console.log(`Tarball size: ${(tarball.length / 1024 / 1024).toFixed(1)} MB`);

  console.log("\nCreating build sandbox (node24)...");
  const sandbox = await Sandbox.create({ runtime: "node24", timeout: ms("15m"), keepLastSnapshots: { count: 10, deleteEvicted: true }, ...credentials });

  try {
    // python3 — prepare-diff.js calls `python3 -c` for an ISO-week date calc.
    await run(sandbox, "Install python3", "sh", [
      "-c",
      "command -v python3 >/dev/null 2>&1 || sudo dnf install -y python3 2>&1",
    ]);

    // claude CLI — the diff pipeline shells out to it.
    await run(sandbox, "Install claude CLI", "npm", ["install", "-g", CLAUDE_CLI_PKG]);

    // Upload + unpack the diff-rabbit repo.
    console.log("\n→ Upload diff-rabbit tarball");
    await sandbox.writeFiles([{ path: SANDBOX_TARBALL, content: tarball }]);
    await run(sandbox, "Unpack diff-rabbit", "sh", [
      "-c",
      `mkdir -p ${SANDBOX_REPO} && tar xzf ${SANDBOX_TARBALL} -C ${SANDBOX_REPO} && rm ${SANDBOX_TARBALL}`,
    ]);

    // Install diff-rabbit deps.
    await run(sandbox, "npm ci (diff-rabbit deps)", "sh", [
      "-c",
      `cd ${SANDBOX_REPO} && (npm ci 2>&1 || npm install 2>&1)`,
    ]);

    // Verify the toolchain is present (no API call — just versions).
    await run(sandbox, "Verify toolchain", "sh", [
      "-c",
      `echo "node: $(node --version)"; echo "python3: $(python3 --version 2>&1)"; ` +
        `echo "claude: $(claude --version 2>&1 || echo MISSING)"; ` +
        `echo "pipeline: $(ls ${SANDBOX_REPO}/run-pipeline.sh && echo present)"`,
    ]);

    console.log("\nTaking snapshot...");
    const snapshot = await sandbox.snapshot();
    console.log("\n========================================");
    console.log("SANDBOX_DIFF_SNAPSHOT_ID=" + snapshot.snapshotId);
    console.log("========================================");
    console.log("Add the line above to cma-vercel-sandbox/.env.local");
    console.log(`Repo path inside sandbox: ${SANDBOX_REPO}`);
  } finally {
    await sandbox.stop();
  }
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
