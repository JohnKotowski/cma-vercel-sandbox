/**
 * Run a command inside a named Vercel Sandbox (Firecracker microVM, US-based IP).
 * Keeps the sandbox alive between calls via getOrCreate — subsequent calls reconnect.
 *
 * Usage:
 *   npx tsx scripts/sandbox-cmd.ts <sandbox-name> <command...>
 *   npx tsx scripts/sandbox-cmd.ts <sandbox-name> --read <path>
 *   npx tsx scripts/sandbox-cmd.ts <sandbox-name> --stop
 */

import { config } from "dotenv";
config({ path: `${__dirname}/../.env.local` });
import { Sandbox } from "@vercel/sandbox";
import ms from "ms";

const SNAPSHOT = process.env.SANDBOX_SNAPSHOT_ID!;

const name = process.argv[2];
if (!name) {
  console.error("Usage: sandbox-cmd <name> <command...>");
  process.exit(1);
}

const rest = process.argv.slice(3);

async function main() {
  if (rest[0] === "--stop") {
    try {
      const sandbox = await Sandbox.get({ name });
      await sandbox.stop();
    } catch (e: any) {
      if (e?.status !== 404) throw e;
    }
    console.log("stopped");
    return;
  }

  const sandbox = await Sandbox.getOrCreate({
    name,
    source: { type: "snapshot", snapshotId: SNAPSHOT },
    runtime: "node24",
    timeout: ms("10m"),
  });

  if (rest[0] === "--read") {
    const buf = await sandbox.readFileToBuffer({ path: rest[1] });
    if (buf) process.stdout.write(buf);
    else {
      console.error("file not found");
      process.exit(1);
    }
    return;
  }

  const command = rest.join(" ");
  const result = await sandbox.runCommand("bash", ["-c", command]);
  const stdout = await result.stdout();
  const stderr = await result.stderr();
  if (stdout) process.stdout.write(stdout);
  if (stderr && result.exitCode !== 0) process.stderr.write(stderr);
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
