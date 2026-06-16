/**
 * run-diff-in-sandbox.ts — Phase 1 of pipeline cloud failover (diffs only, 1 worker).
 *
 * Runs ONE diff (run-pipeline.sh <slug> <period>) inside a Vercel Sandbox using an
 * Anthropic API KEY (not a Max seat) — proving seat-bound diff work can run off the
 * Mac when local subscriptions are maxed. Plan: agent-erik/docs/pipeline-cloud-failover-plan.md
 *
 * Setup expected from the wrapper (run-diff-in-sandbox.sh):
 *   - env: FAILOVER_ANTHROPIC_API_KEY, MANAGEMENT_API_KEY, MANAGEMENT_API_URL, TASK_QUEUE_API_KEY
 *   - a tarball of pricingsaas-diff-rabbit at TAR_PATH (excl .git/node_modules/tmp)
 *
 * Usage: tsx run-diff-in-sandbox.ts <slug> <period> [--keep]
 */
import { config } from "dotenv";
config({ path: `${__dirname}/../.env.local` });
import { Sandbox } from "@vercel/sandbox";
import ms from "ms";
import { readFileSync } from "node:fs";

const SNAPSHOT = process.env.SANDBOX_SNAPSHOT_ID!;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const credentials =
  VERCEL_TOKEN && VERCEL_PROJECT_ID && VERCEL_TEAM_ID
    ? { token: VERCEL_TOKEN, projectId: VERCEL_PROJECT_ID, teamId: VERCEL_TEAM_ID }
    : undefined;

const slug = process.argv[2];
const period = process.argv[3];
const keep = process.argv.includes("--keep");
const force = process.argv.includes("--force");
const probe = process.argv.includes("--probe"); // auth-only: skip the pipeline, just test that the token authenticates
const TAR_PATH = process.env.TAR_PATH || "/tmp/diff-rabbit.tar.gz";
const NAME = "diff-failover-test";

if (!slug || !period) {
  console.error("Usage: tsx run-diff-in-sandbox.ts <slug> <period> [--keep]");
  process.exit(1);
}
// Two auth modes (subscription preferred — flat-rate, no per-token bill):
//   FAILOVER_CLAUDE_OAUTH_TOKEN → run as a Max SUBSCRIPTION seat (CLAUDE_CODE_OAUTH_TOKEN),
//     exactly how the local diff workers auth (diffs.sh). Flat-rate; cost = sandbox compute only.
//   FAILOVER_ANTHROPIC_API_KEY  → run on a metered API key (pay-per-token).
const OAUTH = process.env.FAILOVER_CLAUDE_OAUTH_TOKEN;
const APIKEY = process.env.FAILOVER_ANTHROPIC_API_KEY;
if (!OAUTH && !APIKEY) {
  console.error("Provide FAILOVER_CLAUDE_OAUTH_TOKEN (subscription, flat-rate) or FAILOVER_ANTHROPIC_API_KEY (metered)");
  process.exit(1);
}
const authMode = OAUTH ? "SUBSCRIPTION (flat-rate seat)" : "API key (metered)";

// We ship diff-rabbit's OWN .env (rides in the tarball) so the sandbox replicates the local
// worker's environment exactly — Cloudinary, vault upload, edge fn URLs, etc. We only append
// the chosen auth. Subscription mode also drops a synthetic ~/.claude/.credentials.json, just
// like diffs.sh does locally (the macOS keychain hack is NOT needed on Linux).
const AUTH_ENV = OAUTH ? `\nCLAUDE_CODE_OAUTH_TOKEN=${OAUTH}\n` : `\nANTHROPIC_API_KEY=${APIKEY}\n`;
const CREDS_JSON = JSON.stringify({ claudeAiOauth: { accessToken: OAUTH, expiresAt: Date.now() + 365 * 24 * 3600 * 1000 } });

async function sh(sandbox: any, label: string, command: string, timeoutNote = "") {
  console.log(`\n──── ${label} ${timeoutNote}────`);
  const r = await sandbox.runCommand("bash", ["-c", command]);
  const out = await r.stdout();
  const err = await r.stderr();
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  console.log(`(exit ${r.exitCode})`);
  return r.exitCode as number;
}

async function main() {
  const t0 = Date.now();
  console.log(`Booting sandbox '${NAME}' (snapshot ${SNAPSHOT?.slice(0, 12)}…) for ${slug}/${period}`);
  const sandbox = await Sandbox.getOrCreate({
    name: NAME,
    source: { type: "snapshot", snapshotId: SNAPSHOT },
    runtime: "node24",
    timeout: ms("30m"),
    ...credentials,
  });

  console.log(`Uploading diff-rabbit tarball + auth (${authMode}) …`);
  const tar = readFileSync(TAR_PATH);
  const files: { path: string; content: Buffer }[] = [
    { path: "/tmp/diff-rabbit.tar.gz", content: tar },
    { path: "/tmp/auth.env", content: Buffer.from(AUTH_ENV) },
  ];
  if (OAUTH) files.push({ path: "/tmp/creds.json", content: Buffer.from(CREDS_JSON) });
  await sandbox.writeFiles(files);
  console.log(`  tarball ${(tar.length / 1024 / 1024).toFixed(1)}MB uploaded`);

  // Unpack (keeps diff-rabbit's own .env), append the chosen auth, drop subscription creds
  // (oauth mode), install deps + claude CLI + jq.
  if (await sh(sandbox, "setup: unpack + npm install + claude CLI",
    `set -e
     rm -rf ~/diff-rabbit && mkdir -p ~/diff-rabbit
     tar -xzf /tmp/diff-rabbit.tar.gz -C ~/diff-rabbit
     cat /tmp/auth.env >> ~/diff-rabbit/.env
     ${OAUTH ? "mkdir -p ~/.claude && cp /tmp/creds.json ~/.claude/.credentials.json && chmod 600 ~/.claude/.credentials.json" : ""}
     cd ~/diff-rabbit
     command -v jq >/dev/null || sudo dnf install -y jq 2>&1 | tail -2
     npm install --no-audit --no-fund 2>&1 | tail -5
     npm install -g @anthropic-ai/claude-code 2>&1 | tail -3
     echo "claude: $(which claude || echo MISSING) $(claude --version 2>/dev/null || true)"
     echo "jq: $(which jq || echo MISSING)"
     echo "node: $(node --version)"`)) {
    console.error("Setup failed — aborting before the diff run.");
    if (!keep) await sandbox.stop();
    process.exit(1);
  }

  // Run ONE diff. Source .env (set -a exports it so the claude child sees ANTHROPIC_API_KEY).
  const runStep = probe
    // Auth probe only: a ~1-token call to confirm the token authenticates in the cloud.
    // `timeout` caps a rate-limit hang so we get a definitive answer fast + cheap.
    ? `cd ~/diff-rabbit
       set -a; source .env; set +a
       ${OAUTH ? "unset ANTHROPIC_API_KEY" : ""}
       echo "auth check (${authMode}): CLAUDE_CODE_OAUTH_TOKEN set=${"$"}{CLAUDE_CODE_OAUTH_TOKEN:+yes} ANTHROPIC_API_KEY set=${"$"}{ANTHROPIC_API_KEY:+yes}"
       echo "--- auth probe (timeout 90s) ---"
       timeout 90 claude -p "Reply with exactly: AUTHOK" --dangerously-skip-permissions 2>&1 | head -20
       echo "--- probe exit ${"$"}{PIPESTATUS[0]:-?} ---"`
    : `cd ~/diff-rabbit
       set -a; source .env; set +a
       ${OAUTH ? "unset ANTHROPIC_API_KEY" : ""}
       echo "auth check (${authMode}): CLAUDE_CODE_OAUTH_TOKEN set=${"$"}{CLAUDE_CODE_OAUTH_TOKEN:+yes} ANTHROPIC_API_KEY set=${"$"}{ANTHROPIC_API_KEY:+yes}"
       ./run-pipeline.sh ${slug} ${period}${force ? " --force" : ""} 2>&1`;
  const code = await sh(sandbox, probe ? "run: auth probe" : "run: ./run-pipeline.sh", runStep,
    probe ? "" : "(diff can take several min) ");

  console.log(`\n════ done in ${((Date.now() - t0) / 1000).toFixed(0)}s — run-pipeline exit ${code} ════`);
  if (!keep) { await sandbox.stop(); console.log("sandbox stopped"); }
  else console.log(`sandbox '${NAME}' left running (--keep)`);
  process.exit(code);
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
