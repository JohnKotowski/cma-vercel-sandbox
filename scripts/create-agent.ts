
import Anthropic from "@anthropic-ai/sdk";

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const agent = await client.beta.agents.create({
    name: "Vercel Sandbox Agent",
    description: "Runs shell commands and reads files inside a Vercel Sandbox microVM.",
    model: "claude-sonnet-4-6",
    system: `You are a coding assistant with access to a Linux environment.
You can run shell commands and read files. Use these tools to help the user.
Always show the output of commands you run.`,
    tools: [
      {
        type: "custom",
        name: "run_shell",
        description: "Run a shell command in the sandbox. Returns stdout.",
        input_schema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The shell command to execute.",
            },
          },
          required: ["command"],
        },
      },
      {
        type: "custom",
        name: "read_file",
        description: "Read the contents of a file at the given path.",
        input_schema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Absolute path to the file to read.",
            },
          },
          required: ["path"],
        },
      },
    ],
    betas: ["managed-agents-2026-04-01"],
  });

  console.log("Agent created:");
  console.log("ANTHROPIC_AGENT_ID=" + agent.id);
  console.log("\nAdd this to .env.local.");
}

main().catch((e) => { console.error(e); process.exit(1); });
