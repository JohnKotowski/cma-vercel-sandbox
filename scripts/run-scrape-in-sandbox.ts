/**
 * run-scrape-in-sandbox.ts — run the scrape blast (blitz_scrape.py) in a Vercel Sandbox.
 * Claude-free: scrapes use remote APIs (Firecrawl + Cloudflare Browser Rendering) + Cloudinary
 * + Google Vision OCR. NO Claude seat. Plan: agent-erik/docs/scrapes-to-vercel-plan.md (Phase 1).
 *
 * Ships scrape-rabbit (incl. its .env + the Vision service-account JSON) + blitz_scrape.py into
 * a microVM, ensures python3 + google-auth, runs blitz --from-queue --workers N detached with a
 * 15s heartbeat so the output stream never idles out, then prints the full log.
 *
 * Wrapper (run-scrape-in-sandbox.sh) tars scrape-rabbit to TAR_PATH and ships BLITZ_PATH.
 * Usage: tsx run-scrape-in-sandbox.ts <workers> [--dry-run] [--keep]
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

const workers = process.argv[2] || "10";
const dryRun = process.argv.includes("--dry-run");
const keep = process.argv.includes("--keep");
// SLUGS_JSON env = explicit [[slug,url],...] list → run --slugs (bypasses queue/local race). Else --from-queue.
const slugsJson = process.env.SLUGS_JSON;
const TAR_PATH = process.env.TAR_PATH || "/tmp/scrape-rabbit.tar.gz";
const BLITZ_PATH = process.env.BLITZ_PATH || `${process.env.HOME}/Projects/agent-bob/blitz_scrape.py`;
const NAME = "scrape-blast-test";

async function sh(sandbox: any, label: string, command: string, note = "") {
  console.log(`\n──── ${label} ${note}────`);
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
  console.log(`Booting sandbox '${NAME}' for scrape blast (workers=${workers}, dry_run=${dryRun})`);
  const sandbox = await Sandbox.getOrCreate({
    name: NAME,
    source: { type: "snapshot", snapshotId: SNAPSHOT },
    runtime: "node24",
    timeout: ms("30m"),
    ...credentials,
  });

  console.log("Uploading scrape-rabbit tarball + blitz_scrape.py …");
  const tar = readFileSync(TAR_PATH);
  const blitz = readFileSync(BLITZ_PATH);
  const files = [
    { path: "/tmp/scrape-rabbit.tar.gz", content: tar },
    { path: "/tmp/blitz_scrape.py", content: blitz },
  ];
  if (slugsJson) files.push({ path: "/tmp/slugs.json", content: Buffer.from(slugsJson) });
  await sandbox.writeFiles(files);
  console.log(`  tarball ${(tar.length / 1024 / 1024).toFixed(1)}MB + blitz ${(blitz.length / 1024).toFixed(0)}KB`);

  // Unpack (keeps scrape-rabbit's own .env + the Vision creds JSON), place blitz, ensure python+deps.
  // NOTE: blitz_scrape.py loads env from the HARDCODED path ~/Projects/pricingsaas-scrape-rabbit/.env,
  // so we must unpack to exactly that path (not ~/scrape-rabbit).
  if (await sh(sandbox, "setup: unpack + python3 + google-auth",
    `set -e
     RABBIT=~/Projects/pricingsaas-scrape-rabbit
     rm -rf "$RABBIT" && mkdir -p "$RABBIT"
     tar -xzf /tmp/scrape-rabbit.tar.gz -C "$RABBIT"
     cp /tmp/blitz_scrape.py "$RABBIT/blitz_scrape.py"
     # Distinct worker id so cloud claims are attributable vs any concurrent Mac blast.
     sed -i 's/^BLITZ_WORKER_ID = .*/BLITZ_WORKER_ID = "blitz-cloud-test"/' "$RABBIT/blitz_scrape.py"
     sed -i 's/level=logging.INFO/level=logging.DEBUG/' "$RABBIT/blitz_scrape.py"   # surface per-slug HTTP status
     grep -m1 '^BLITZ_WORKER_ID' "$RABBIT/blitz_scrape.py"
     command -v python3 >/dev/null || sudo dnf install -y python3 2>&1 | tail -2
     python3 -m ensurepip --upgrade 2>/dev/null || sudo dnf install -y python3-pip 2>&1 | tail -2
     # google-auth is REQUIRED for Vision service-account OCR. Install for real + verify the
     # import, fail loudly if it doesn't (silent best-effort here previously broke OCR -> 403).
     # blitz needs BOTH google-auth AND requests (for google.auth.transport.requests.Request).
     # google-auth alone leaves _GOOGLE_AUTH_OK=False -> SA path skipped -> API-key 403.
     python3 -m pip install --user google-auth requests 2>&1 | tail -4
     python3 -c "from google.oauth2 import service_account; from google.auth.transport.requests import Request; print('google-auth+requests import: OK')" \
       || { echo "FATAL: google-auth/requests import failed — OCR would 403"; exit 1; }
     echo "python: $(python3 --version)"
     echo "env loads: CLOUDFLARE_ACCOUNT_ID present in .env = $(grep -c '^CLOUDFLARE_ACCOUNT_ID=' "$RABBIT/.env")"
     echo "creds file: $(ls "$RABBIT"/pricing-explorer-031fb1604866.json 2>/dev/null && echo yes || echo NO)"`)) {
    console.error("Setup failed — aborting.");
    if (!keep) await sandbox.stop();
    process.exit(1);
  }

  // Run the blast detached with a 15s heartbeat (keeps the sandbox stream alive on a multi-min run).
  // Raw Firecrawl probe first (matches blitz's request) — decisive on auth/network from the sandbox,
  // independent of blitz's own logging.
  await sh(sandbox, "firecrawl probe (raw, from sandbox)",
    `cd ~/Projects/pricingsaas-scrape-rabbit
     set -a; source .env; set +a
     echo "FIRECRAWL_API_KEY set=${"$"}{FIRECRAWL_API_KEY:+yes} len=${"$"}{#FIRECRAWL_API_KEY}"
     curl -s -m 40 -o /tmp/fc.out -w "Firecrawl HTTP %{http_code} (%{time_total}s)\\n" -X POST https://api.firecrawl.dev/v1/scrape \
       -H "Authorization: Bearer ${"$"}FIRECRAWL_API_KEY" -H "Content-Type: application/json" \
       -d '{"url":"https://stripe.com/pricing","formats":["markdown"],"timeout":30000}'
     echo "--- response head ---"; head -c 500 /tmp/fc.out; echo`);

  const mode = slugsJson ? `--slugs /tmp/slugs.json` : `--from-queue`;
  const code = await sh(sandbox, `run: blitz_scrape.py ${mode} (DEBUG)`,
    `cd ~/Projects/pricingsaas-scrape-rabbit
     nohup python3 blitz_scrape.py ${mode} --workers ${workers}${dryRun ? " --dry-run" : ""} > /tmp/blast.log 2>&1 &
     PID=${"$"}!
     for i in ${"$"}(seq 1 80); do
       kill -0 ${"$"}PID 2>/dev/null || break
       echo "··· scraping ${"$"}((i*15))s"; sleep 15
     done
     echo "=== blast log ==="; cat /tmp/blast.log`, "(blast can take several min) ");

  console.log(`\n════ done in ${((Date.now() - t0) / 1000).toFixed(0)}s — blast exit ${code} ════`);
  if (!keep) { await sandbox.stop(); console.log("sandbox stopped"); }
  process.exit(code);
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
