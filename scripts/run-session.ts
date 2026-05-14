/**
 * Direct session runner for local testing.
 * Streams events from a session and handles tool calls without
 * going through the work item poll/ack system.
 *
 * Usage: pnpm run run-session <session-id>
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const SESSION_ID = process.argv[2];
if (!SESSION_ID) {
  console.error("Usage: pnpm run run-session <session-id>");
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const handled = new Set<string>();

// --- Tool implementations ---

async function runTool(name: string, input: unknown): Promise<string> {
  if (name === "run_shell") {
    const cmd = (input as { command: string }).command;
    try {
      return execSync(cmd, { encoding: "utf8", timeout: 30_000 });
    } catch (e: unknown) {
      return (e as { stdout?: string; stderr?: string; message: string }).stderr
        ?? (e as Error).message;
    }
  }
  if (name === "read_file") {
    return await readFile((input as { path: string }).path, "utf8");
  }
  return `unknown tool: ${name}`;
}

async function handleTool(ev: { id: string; name: string; input: unknown }) {
  console.log(`→ tool: ${ev.name}`, JSON.stringify(ev.input));
  const output = await runTool(ev.name, ev.input).catch((e: Error) =>
    `error: ${e.message}`
  );
  console.log(`← result: ${output.slice(0, 200)}`);
  await client.beta.sessions.events.send(SESSION_ID, {
    events: [{
      type: "user.custom_tool_result",
      custom_tool_use_id: ev.id,
      content: [{ type: "text", text: output || "(no output)" }],
    }],
  });
  handled.add(ev.id);
}

async function main() {
  console.log("Running session:", SESSION_ID);

  // Reconcile any tool calls that arrived before we attached
  for await (const ev of client.beta.sessions.events.list(
    SESSION_ID, { limit: 1000 }
  )) {
    if (ev.type === "agent.custom_tool_use" && !handled.has(ev.id)) {
      await handleTool(ev as { id: string; name: string; input: unknown });
    } else if (ev.type === "user.custom_tool_result") {
      handled.add((ev as { custom_tool_use_id: string }).custom_tool_use_id);
    } else if (ev.type === "agent.message") {
      const content = (ev as { content: Array<{ text?: string }> }).content;
      console.log("\nAgent:", content.map(c => c.text).join(""));
    } else if (ev.type === "session.status_idle") {
      const stop = (ev as { stop_reason?: { type: string } }).stop_reason;
      if (stop?.type === "end_turn") {
        console.log("\nSession ended (end_turn).");
        return;
      }
    }
  }

  // Stream new events
  console.log("Streaming events...");
  const stream = await client.beta.sessions.events.stream(SESSION_ID);
  for await (const ev of stream) {
    if (ev.type === "agent.custom_tool_use" && !handled.has(ev.id)) {
      await handleTool(ev as { id: string; name: string; input: unknown });
    } else if (ev.type === "agent.message") {
      const content = (ev as { content: Array<{ text?: string }> }).content;
      console.log("\nAgent:", content.map(c => c.text).join(""));
    } else if (ev.type === "session.status_idle") {
      const stop = (ev as { stop_reason?: { type: string } }).stop_reason;
      if (stop?.type === "end_turn") {
        console.log("\nSession ended (end_turn).");
        break;
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
