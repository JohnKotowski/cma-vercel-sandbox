import Anthropic from "@anthropic-ai/sdk";
import { Sandbox } from "@vercel/sandbox";
import { waitUntil } from "@vercel/functions";
import ms from "ms";

const ENV_ID = process.env.ANTHROPIC_ENVIRONMENT_ID!;
const ENV_KEY = process.env.ANTHROPIC_ENVIRONMENT_KEY!;
const SNAPSHOT_ID = process.env.SANDBOX_SNAPSHOT_ID!;
const WEBHOOK_SECRET = process.env.ANTHROPIC_WEBHOOK_SECRET!;
const BETA = "managed-agents-2026-04-01";

const client = new Anthropic({ authToken: ENV_KEY });

async function pollAndAck() {
  const work = await client.beta.environments.work.poll(ENV_ID, {
    reclaim_older_than_ms: 2000,
    betas: [BETA],
  });
  if (!work || work.data.type !== "session") return null;

  await client.beta.environments.work.ack(work.id, {
    environment_id: ENV_ID,
    betas: [BETA],
  });

  return { workId: work.id, sessionId: work.data.id };
}

async function spawn(sessionId: string, workId: string) {
  // Broker auth at the firewall, but only attach it to endpoints scoped
  // to THIS session and work item. A compromised sandbox can't use the
  // injected auth to call /work/poll or read other sessions.
  const inject = [{ headers: { authorization: `Bearer ${ENV_KEY}` } }];

  const sandbox = await Sandbox.create({
    source: { type: "snapshot", snapshotId: SNAPSHOT_ID },
    runtime: "node24",
    timeout: ms("1h"),
    networkPolicy: {
      allow: {
        "api.anthropic.com": [
          {
            match: { path: { startsWith: `/v1/sessions/${sessionId}/` } },
            transform: inject,
          },
          {
            match: {
              path: {
                startsWith: `/v1/environments/${ENV_ID}/work/${workId}/`,
              },
            },
            transform: inject,
          },
        ],
      },
    },
  });

  await sandbox.runCommand({
    cmd: "npx",
    args: ["tsx", "runner.ts"],
    cwd: "/vercel/sandbox",
    env: {
      ENVIRONMENT_ID: ENV_ID,
      WORK_ID: workId,
      SESSION_ID: sessionId,
    },
    detached: true,
  });
}

export async function POST(req: Request): Promise<Response> {
  const body = await req.text();

  let event;
  try {
    event = client.beta.webhooks.unwrap(body, {
      headers: Object.fromEntries(req.headers),
      key: WEBHOOK_SECRET,
    });
  } catch {
    return new Response("bad signature", { status: 401 });
  }

  if (event.data.type !== "session.status_run_started") {
    return new Response("ignored");
  }

  const item = await pollAndAck();
  if (!item) return new Response("no_work");

  waitUntil(spawn(item.sessionId, item.workId));
  return new Response("ok");
}
