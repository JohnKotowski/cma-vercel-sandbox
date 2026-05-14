import { config } from "dotenv";
config({ path: ".env.local", override: true });

import Anthropic from "@anthropic-ai/sdk";

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const environment = await client.beta.environments.create({
    name: "vercel-sandbox",
    config: { type: "self_hosted" },
    betas: ["environments-2026-03-01"],
  });

  console.log("Environment created:");
  console.log("ANTHROPIC_ENVIRONMENT_ID=" + environment.id);
  console.log("\nAdd this to .env.local, then generate a service key in the console.");
}

main().catch((e) => { console.error(e); process.exit(1); });
