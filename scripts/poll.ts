/**
 * Local poll-based control plane.
 * Run this instead of the webhook during local development.
 */

import Anthropic from "@anthropic-ai/sdk";
import { Sandbox } from "@vercel/sandbox";
import ms from "ms";

const ENV_ID = process.env.ANTHROPIC_ENVIRONMENT_ID!;
const ENV_KEY = process.env.ANTHROPIC_ENVIRONMENT_KEY!;
const SNAPSHOT_ID = process.env.SANDBOX_SNAPSHOT_ID!;
const BETA = "environments-2026-03-01";

const client = new Anthropic({ authToken: ENV_KEY });

async function spawn(sessionId: string, workId: string) {
  console.log(`Spawning sandbox for session ${sessionId}...`);
  const sandbox = await Sandbox.create({
    source: { type: "snapshot", snapshotId: SNAPSHOT_ID },
    runtime: "node24",
    timeout: ms("1h"),
  });

  await sandbox.runCommand({
    cmd: "npx",
    args: ["tsx", "runner.ts"],
    cwd: "/vercel/sandbox",
    env: {
      ENVIRONMENT_ID: ENV_ID,
      WORK_ID: workId,
      SESSION_ID: sessionId,
      ANTHROPIC_ENVIRONMENT_KEY: ENV_KEY,
    },
    detached: true,
  });

  console.log(`Sandbox spawned for session ${sessionId}`);
}

async function main() {
  console.log("Poll loop started. Waiting for work items...");
  console.log("Press Ctrl+C to stop.\n");

  for (;;) {
    const work = await client.beta.environments.work.poll(
      ENV_ID,
      { betas: [BETA] },
    ).catch((e: Error) => {
      console.error("Poll error:", e.message);
      return null;
    });

    if (!work) {
      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
      continue;
    }

    if (work.data.type !== "session") continue;

    const sessionId = work.data.id;
    console.log(`Work item received: session=${sessionId}`);

    await client.beta.environments.work.ack(work.id, {
      environment_id: ENV_ID,
      betas: [BETA],
    });

    spawn(sessionId, work.id).catch((e: Error) =>
      console.error("Spawn error:", e.message),
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
