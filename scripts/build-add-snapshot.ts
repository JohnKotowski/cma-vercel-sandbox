/**
 * build-add-snapshot.ts — Build a Vercel Sandbox snapshot that can run a
 * pricingsaas-extract-rabbit `run_add` worker (the seat-bound onboarding stage
 * that turns a pricing URL into a tracked company in the catalog).
 *
 * Counterpart to build-diff-snapshot.ts (diff worker) and build-snapshot.ts
 * (agent-browser). The add snapshot bakes:
 *   - node24 (runtime default) + python3
 *   - the `claude` CLI (@anthropic-ai/claude-code) — `/add-scrape-extract`
 *     shells out through it
 *   - the extract-rabbit repo (code only — .claude skills travel with it) + npm ci
 *   - Playwright + its Chromium browser (the scrape step screenshots pricing
 *     pages) + the Chromium system libraries via dnf
 *
 * It bakes NO secrets: the extract-rabbit .env, the GCP creds file, and the seat
 * (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN) are injected at runtime by
 * cloud-add-worker.ts. A fresh sandbox has no macOS keychain, so the injected
 * seat wins.
 *
 * Staleness note: bakes the pipeline CODE into the image — rebuild when
 * extract-rabbit's add/scrape/extract skills change materially. (The worker can
 * also `git pull` at runtime; baked is simpler for the first cut.)
 *
 * Usage:
 *   npx tsx scripts/build-add-snapshot.ts
 *   EXTRACT_RABBIT_DIR=/path/to/pricingsaas-extract-rabbit npx tsx scripts/build-add-snapshot.ts
 *
 * On success prints:  SANDBOX_ADD_SNAPSHOT_ID=<id>   (add it to .env.local)
 */

import { config } from "dotenv";
config({ path: `${__dirname}/../.env.local` });
import { Sandbox } from "@vercel/sandbox";
import { execSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ms from "ms";

const EXTRACT_RABBIT_DIR =
  process.env.EXTRACT_RABBIT_DIR || `${process.env.HOME}/Projects/pricingsaas-extract-rabbit`;

const SANDBOX_REPO = "/vercel/sandbox/extract-rabbit";
const SANDBOX_TARBALL = "/vercel/sandbox/extract-rabbit.tar.gz";
const CLAUDE_CLI_PKG = "@anthropic-ai/claude-code";

// Chromium runtime libraries (same set the agent-browser snapshot installs).
const CHROMIUM_SYSTEM_DEPS = [
  "nss", "nspr", "libxkbcommon", "atk", "at-spi2-atk", "at-spi2-core",
  "libXcomposite", "libXdamage", "libXrandr", "libXfixes", "libXcursor",
  "libXi", "libXtst", "libXScrnSaver", "libXext", "mesa-libgbm", "libdrm",
  "mesa-libGL", "mesa-libEGL", "cups-libs", "alsa-lib", "pango", "cairo",
  "gtk3", "dbus-libs",
];

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
  const out = join(mkdtempSync(join(tmpdir(), "extractrabbit-")), "extract-rabbit.tar.gz");
  console.log(`Packing ${EXTRACT_RABBIT_DIR} → ${out} (excluding node_modules/.git/tmp)`);
  execSync(
    `tar czf "${out}" ` +
      `--exclude=node_modules --exclude=.git --exclude=tmp --exclude=benchmarks ` +
      `--exclude='.DS_Store' --exclude='*.log' -C "${EXTRACT_RABBIT_DIR}" .`,
    { stdio: "inherit" }
  );
  return readFileSync(out);
}

async function main() {
  const tarball = buildTarball();
  console.log(`Tarball size: ${(tarball.length / 1024 / 1024).toFixed(1)} MB`);

  console.log("\nCreating build sandbox (node24)...");
  // Chromium download + npm ci is slow; give it room.
  const sandbox = await Sandbox.create({ runtime: "node24", timeout: ms("20m"), keepLastSnapshots: { count: 10, deleteEvicted: true }, ...credentials });

  try {
    await run(sandbox, "Install python3", "sh", [
      "-c",
      "command -v python3 >/dev/null 2>&1 || sudo dnf install -y python3 2>&1",
    ]);

    await run(sandbox, "Install Chromium system deps (dnf)", "sh", [
      "-c",
      `sudo dnf clean all 2>&1 && sudo dnf install -y --skip-broken ${CHROMIUM_SYSTEM_DEPS.join(" ")} 2>&1 && sudo ldconfig 2>&1`,
    ]);

    await run(sandbox, "Install claude CLI", "npm", ["install", "-g", CLAUDE_CLI_PKG]);

    console.log("\n→ Upload extract-rabbit tarball");
    await sandbox.writeFiles([{ path: SANDBOX_TARBALL, content: tarball }]);
    await run(sandbox, "Unpack extract-rabbit", "sh", [
      "-c",
      `mkdir -p ${SANDBOX_REPO} && tar xzf ${SANDBOX_TARBALL} -C ${SANDBOX_REPO} && rm ${SANDBOX_TARBALL}`,
    ]);

    await run(sandbox, "npm ci (extract-rabbit deps)", "sh", [
      "-c",
      `cd ${SANDBOX_REPO} && (npm ci 2>&1 || npm install 2>&1)`,
    ]);

    // Playwright's own Chromium binary (the system libs above satisfy its deps).
    await run(sandbox, "Install Playwright Chromium", "sh", [
      "-c",
      `cd ${SANDBOX_REPO} && npx playwright install chromium 2>&1 | tail -5`,
    ]);

    await run(sandbox, "Verify toolchain", "sh", [
      "-c",
      `echo "node: $(node --version)"; echo "python3: $(python3 --version 2>&1)"; ` +
        `echo "claude: $(claude --version 2>&1 || echo MISSING)"; ` +
        `echo "playwright: $(cd ${SANDBOX_REPO} && npx playwright --version 2>&1 || echo MISSING)"; ` +
        `echo "skill: $(ls ${SANDBOX_REPO}/.claude/skills/add-scrape-extract/SKILL.md >/dev/null 2>&1 && echo present || echo MISSING)"`,
    ]);

    console.log("\nTaking snapshot...");
    const snapshot = await sandbox.snapshot();
    console.log("\n========================================");
    console.log("SANDBOX_ADD_SNAPSHOT_ID=" + snapshot.snapshotId);
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
