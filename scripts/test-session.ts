import { config } from "dotenv";
config({ path: ".env.local", override: true });

import Anthropic from "@anthropic-ai/sdk";

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const ENVIRONMENT_ID = process.env.ANTHROPIC_ENVIRONMENT_ID!;
  const AGENT_ID = process.env.ANTHROPIC_AGENT_ID!;

  if (!AGENT_ID) {
    console.error("ANTHROPIC_AGENT_ID is not set in .env.local");
    process.exit(1);
  }

  console.log("Creating session...");
  const session = await client.beta.sessions.create({
    agent: AGENT_ID,
    environment_id: ENVIRONMENT_ID,
    betas: ["environments-2026-03-01"],
  });

  console.log("Session ID:", session.id);
  console.log("Sending message...");

  await client.beta.sessions.events.send(session.id, {
    events: [{ type: "user.message", content: "run `uname -a && node --version`" }],
  });

  console.log("\nSession started. Watch the poll loop logs for the work item.");
  console.log("Session:", session.id);
}

main().catch((e) => { console.error(e); process.exit(1); });
