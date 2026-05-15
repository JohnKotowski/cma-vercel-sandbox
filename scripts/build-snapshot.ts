
import { Sandbox } from "@vercel/sandbox";
import { readFileSync } from "node:fs";

const SDK_URL =
  "https://app.stainless.com/pkg/s/anthropic-typescript/11dd7e25acfec7caffc11c06d11629f42846b595/dist.tar.gz";

async function main() {
  console.log("Creating sandbox...");
  const sandbox = await Sandbox.create({ runtime: "node24" });

  console.log("Writing runner files...");
  await sandbox.writeFiles([
    {
      path: "/vercel/sandbox/package.json",
      content: Buffer.from('{"type":"module"}'),
    },
    {
      path: "/vercel/sandbox/runner.ts",
      content: readFileSync("./sandbox/runner.ts"),
    },
  ]);

  console.log("Installing dependencies...");
  await sandbox.runCommand("npm", ["install", SDK_URL, "tsx"]);

  console.log("Taking snapshot...");
  const snapshot = await sandbox.snapshot();

  console.log("\nSnapshot created:");
  console.log("SANDBOX_SNAPSHOT_ID=" + snapshot.snapshotId);
  console.log("\nAdd this to .env.local.");

  await sandbox.stop();
}

main().catch((e) => { console.error(e); process.exit(1); });
