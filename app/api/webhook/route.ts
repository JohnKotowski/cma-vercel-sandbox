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
  // Prototype: pass auth key directly into sandbox env (not credential-brokered)
  // so we can use allow-all network policy — agent-browser needs to reach any website.
  // Production should use credential brokering with scoped firewall rules.
  const sandbox = await Sandbox.create({
    source: { type: "snapshot", snapshotId: SNAPSHOT_ID },
    runtime: "node24",
    timeout: ms("1h"),
    // One-shot job, never resumed -> no filesystem restore needed. persistent:false disables the
    // automatic ~1 GB snapshot Vercel takes on stop. Leaving it on is what produced 2,885
    // orphaned snapshots / 3.06 TB = $248 of a $249 bill (2026-07-13). See cloud-scrape-worker.ts.
    persistent: false,
    keepLastSnapshots: { count: 1, deleteEvicted: true },
  });

  await sandbox.runCommand({
    cmd: "npx",
    args: ["tsx", "runner.ts"],
    cwd: "/vercel/sandbox",
    env: {
      ENVIRONMENT_ID: ENV_ID,
      ENVIRONMENT_KEY: ENV_KEY,
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
