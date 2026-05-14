/**
 * Local poll-based control plane.
 * Run this instead of the webhook during local development.
 * No deployment or public URL needed.
 */
import { config } from "dotenv";
config({ path: ".env.local", override: true });

import Anthropic from "@anthropic-ai/sdk";
import { Sandbox } from "@vercel/sandbox";
import ms from "ms";

const ENV_ID = process.env.ANTHROPIC_ENVIRONMENT_ID!;
const SERVICE_KEY = process.env.ENVIRONMENT_SERVICE_KEY!;
const SNAPSHOT_ID = process.env.SANDBOX_SNAPSHOT_ID!;
const API_KEY = process.env.ANTHROPIC_API_KEY!;
const BETA = "environments-2026-03-01";

const client = new Anthropic({ apiKey: API_KEY });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function spawn(sessionId: string, workId: string, token: string) {
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
      API_KEY,
      TOKEN: token,
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
      { "x-environment-runner-version": "0.1.0", betas: [BETA] },
      { headers: bearer(SERVICE_KEY) },
    ).catch((e: Error) => {
      console.error("Poll error:", e.message);
      return null;
    });

    if (!work) {
      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
      continue;
    }

    console.log(`Work item received: ${work.id}`);

    const token = JSON.parse(
      Buffer.from(work.secret!, "base64url").toString(),
    ).session_ingress_token;

    await client.beta.environments.work.ack(
      work.id,
      { environment_id: ENV_ID, betas: [BETA] },
      { headers: bearer(token) },
    );

    console.log(`Acked work item ${work.id}`);
    spawn(work.data.id, work.id, token).catch((e: Error) =>
      console.error("Spawn error:", e.message)
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
