/**
 * End-to-end test: create session → poll → ack → spawn sandbox → wait for result.
 */

import Anthropic from "@anthropic-ai/sdk";
import { Sandbox } from "@vercel/sandbox";
import ms from "ms";

const ENV_ID = process.env.ANTHROPIC_ENVIRONMENT_ID!;
const ENV_KEY = process.env.ANTHROPIC_ENVIRONMENT_KEY!;
const SNAPSHOT = process.env.SANDBOX_SNAPSHOT_ID!;
const AGENT = process.env.ANTHROPIC_AGENT_ID!;
const BETA = "managed-agents-2026-04-01";

async function main() {
  const api = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const worker = new Anthropic({ authToken: ENV_KEY });

  const session = await api.beta.sessions.create({
    agent: AGENT,
    environment_id: ENV_ID,
    betas: [BETA],
  });
  console.log("session:", session.id);

  await api.beta.sessions.events.send(session.id, {
    events: [{
      type: "user.message",
      content: [{ type: "text", text: "run echo hello-from-sandbox" }],
    }],
  });

  let work = null;
  for (let i = 0; i < 60; i++) {
    const item = await worker.beta.environments.work.poll(ENV_ID, {
      betas: [BETA],
      reclaim_older_than_ms: 1000,
    });
    if (item?.data.type === "session" && item.data.id === session.id) {
      work = item;
      break;
    }
    if (item) {
      console.log("skipping unrelated work item:", item.id);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!work) {
    console.error("no work item after 60s");
    process.exit(1);
  }

  console.log("work:", work.id);
  await worker.beta.environments.work.ack(work.id, {
    environment_id: ENV_ID,
    betas: [BETA],
  });
  console.log("ack ok");

  const sandbox = await Sandbox.create({
    source: { type: "snapshot", snapshotId: SNAPSHOT },
    runtime: "node24",
    timeout: ms("10m"),
  });
  await sandbox.runCommand({
    cmd: "npx",
    args: ["tsx", "runner.ts"],
    cwd: "/vercel/sandbox",
    env: {
      ENVIRONMENT_ID: ENV_ID,
      WORK_ID: work.id,
      SESSION_ID: session.id,
      ANTHROPIC_ENVIRONMENT_KEY: ENV_KEY,
    },
    detached: true,
  });
  console.log("sandbox spawned, waiting for tool result...");

  for (let i = 0; i < 60; i++) {
    for await (const ev of api.beta.sessions.events.list(session.id, { limit: 50 })) {
      if (ev.type === "user.custom_tool_result") {
        const text = (ev.content as Array<{ text?: string }>)
          .map((c) => c.text ?? "").join("");
        console.log("tool result:", text);
      }
      if (ev.type === "session.status_idle" && ev.stop_reason?.type === "end_turn") {
        console.log("session complete");
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error("timed out");
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
