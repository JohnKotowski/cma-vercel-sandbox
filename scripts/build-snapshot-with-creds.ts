import { Sandbox } from "@vercel/sandbox";
import { readFileSync } from "node:fs";

// NEVER hardcode this. A live Vercel PAT was committed here on 2026-06-23 and sat in local
// history until 2026-07-13; GitHub push protection blocked every push of this branch as a
// result, and this repo's remote (JohnKotowski/cma-vercel-sandbox) is PUBLIC. Read it from the
// environment.
const VERCEL_TOKEN = process.env.VERCEL_TOKEN!;
if (!VERCEL_TOKEN) throw new Error("VERCEL_TOKEN not set (source .env.local)");
const VERCEL_PROJECT_ID = "prj_wzZL7C2opqw2j8gAht76v50nBRhI";
const VERCEL_TEAM_ID = "team_FMfdE1Y8w0eBysZsuejV1koM";

const SDK_URL = "https://app.stainless.com/pkg/s/anthropic-typescript/11dd7e25acfec7caffc11c06d11629f42846b595/dist.tar.gz";

const CHROMIUM_SYSTEM_DEPS = [
  "nss", "nspr", "libxkbcommon", "atk", "at-spi2-atk", "at-spi2-core",
  "libXcomposite", "libXdamage", "libXrandr", "libXfixes", "libXcursor",
  "libXi", "libXtst", "libXScrnSaver", "libXext", "mesa-libgbm", "libdrm",
  "mesa-libGL", "mesa-libEGL", "cups-libs", "alsa-lib", "pango", "cairo",
  "gtk3", "dbus-libs",
];

async function main() {
  console.log("Creating sandbox with explicit credentials...");
  const sandbox = await (Sandbox as any).create({
    runtime: "node24",
    timeout: 300_000,
    keepLastSnapshots: { count: 10, deleteEvicted: true },
    token: VERCEL_TOKEN,
    projectId: VERCEL_PROJECT_ID,
    teamId: VERCEL_TEAM_ID,
  });

  console.log("Writing runner files...");
  await sandbox.writeFiles([
    {
      path: "/vercel/sandbox/package.json",
      content: Buffer.from('{"type":"module"}'),
    },
    {
      path: "/vercel/sandbox/runner.ts",
      content: readFileSync("/Users/john/Projects/cma-vercel-sandbox/sandbox/runner.ts"),
    },
  ]);

  console.log("Installing Anthropic SDK + tsx...");
  await sandbox.runCommand("npm", ["install", SDK_URL, "tsx"]);

  console.log("Installing Chromium system deps...");
  await sandbox.runCommand("sh", ["-c", `sudo dnf install -y --skip-broken ${CHROMIUM_SYSTEM_DEPS.join(" ")} 2>&1 && sudo ldconfig 2>&1`]);

  console.log("Installing agent-browser globally...");
  await sandbox.runCommand("npm", ["install", "-g", "agent-browser"]);

  console.log("Installing agent-browser Chromium...");
  await sandbox.runCommand("npx", ["agent-browser", "install"]);

  console.log("Taking snapshot...");
  const snapshot = await sandbox.snapshot();

  console.log("\nSnapshot created:");
  console.log("SANDBOX_SNAPSHOT_ID=" + snapshot.snapshotId);
  console.log("\nAdd this to .env.local.");

  await sandbox.stop();
}

main().catch((e) => { console.error(e); process.exit(1); });
