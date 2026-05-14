
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SESSION_ID = process.argv[2];
if (!SESSION_ID) {
  console.error("Usage: pnpm run read-session <session-id>");
  process.exit(1);
}

async function main() {
  console.log("Reading events for session:", SESSION_ID);
  for await (const ev of client.beta.sessions.events.list(SESSION_ID, { limit: 100 })) {
    console.log(JSON.stringify(ev, null, 2));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
