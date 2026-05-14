import Anthropic from "@anthropic-ai/sdk";
import { Sandbox } from "@vercel/sandbox";
import { waitUntil } from "@vercel/functions";
import { createHmac, timingSafeEqual } from "node:crypto";
import ms from "ms";

const ENV_ID = process.env.ANTHROPIC_ENVIRONMENT_ID!;
const SNAPSHOT_ID = process.env.SANDBOX_SNAPSHOT_ID!;
const SERVICE_KEY = process.env.ENVIRONMENT_SERVICE_KEY!;
const WEBHOOK_SECRET = process.env.ANTHROPIC_WEBHOOK_SECRET!;
const API_KEY = process.env.ANTHROPIC_API_KEY!;
const BETA = "environments-2026-03-01";

const client = new Anthropic({ apiKey: API_KEY });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

function verify(body: string, header: string | null): boolean {
  const [ver, ts, sig] = (header ?? "").split(",");
  if (ver !== "v1" || !ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const mac = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${ts}.${body}`)
    .digest("hex");
  if (mac.length !== sig.length) return false;
  return timingSafeEqual(Buffer.from(mac), Buffer.from(sig));
}

async function pollAndAck() {
  const work = await client.beta.environments.work.poll(
    ENV_ID,
    { "x-environment-runner-version": "0.1.0", betas: [BETA] },
    { headers: bearer(SERVICE_KEY) },
  );
  if (!work) return null;

  const token = JSON.parse(
    Buffer.from(work.secret!, "base64url").toString(),
  ).session_ingress_token;

  await client.beta.environments.work.ack(
    work.id,
    { environment_id: ENV_ID, betas: [BETA] },
    { headers: bearer(token) },
  );

  return { workId: work.id, sessionId: work.data.id, token };
}

async function spawn(sessionId: string, workId: string, token: string) {
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
}

export async function POST(req: Request): Promise<Response> {
  const body = await req.text();

  if (!verify(body, req.headers.get("x-webhook-signature"))) {
    return new Response("bad signature", { status: 401 });
  }

  const payload = JSON.parse(body);
  if (payload.data.type !== "session.status_run_started") {
    return new Response("ignored");
  }

  const item = await pollAndAck();
  if (!item) return new Response("no_work");

  waitUntil(spawn(item.sessionId, item.workId, item.token));
  return new Response("ok");
}
