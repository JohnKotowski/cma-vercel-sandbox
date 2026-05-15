import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const ENV_ID = process.env.ENVIRONMENT_ID!;
const WORK_ID = process.env.WORK_ID!;
const SESSION_ID = process.env.SESSION_ID!;
const BETA = "environments-2026-03-01";

const client = new Anthropic({
  authToken: process.env.ANTHROPIC_ENVIRONMENT_KEY!,
});
const handled = new Set<string>();

async function runTool(name: string, input: unknown): Promise<string> {
  if (name === "run_shell") {
    const cmd = (input as { command: string }).command;
    return execSync(cmd, { encoding: "utf8", timeout: 30_000 });
  }
  if (name === "read_file") {
    return await readFile((input as { path: string }).path, "utf8");
  }
  return `unknown tool: ${name}`;
}

let last: string | undefined;
const hb = setInterval(async () => {
  try {
    const r = await client.beta.environments.work.heartbeat(WORK_ID, {
      environment_id: ENV_ID,
      expected_last_heartbeat: last,
      betas: [BETA],
    });
    last = r.last_heartbeat;
  } catch {}
}, 30_000);

async function handleTool(ev: { id: string; name: string; input: unknown }) {
  const output = await runTool(ev.name, ev.input).catch((e) =>
    `error: ${e instanceof Error ? e.message : String(e)}`
  );
  await client.beta.sessions.events.send(SESSION_ID, {
    events: [{
      type: "user.custom_tool_result",
      custom_tool_use_id: ev.id,
      content: [{ type: "text", text: output || "(no output)" }],
    }],
  });
  handled.add(ev.id);
}

try {
  for await (const ev of client.beta.sessions.events.list(
    SESSION_ID, { limit: 1000 }
  )) {
    if (ev.type === "agent.custom_tool_use" && !handled.has(ev.id)) {
      await handleTool(ev);
    } else if (ev.type === "user.custom_tool_result") {
      handled.add(ev.custom_tool_use_id);
    }
  }

  const stream = await client.beta.sessions.events.stream(SESSION_ID);
  for await (const ev of stream) {
    if (ev.type === "agent.custom_tool_use" && !handled.has(ev.id)) {
      await handleTool(ev);
    }
  }
} finally {
  clearInterval(hb);
  await client.beta.environments.work
    .stop(WORK_ID, { environment_id: ENV_ID, betas: [BETA] })
    .catch((e) => { if (e?.status !== 409) throw e; });
}
