import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: Request) {
  const { message } = await req.json();
  if (!message?.trim()) {
    return Response.json({ error: "message is required" }, { status: 400 });
  }

  const session = await client.beta.sessions.create({
    agent: process.env.ANTHROPIC_AGENT_ID!,
    environment_id: process.env.ANTHROPIC_ENVIRONMENT_ID!,
    betas: ["environments-2026-03-01"],
  });

  await client.beta.sessions.events.send(session.id, {
    events: [{
      type: "user.message",
      content: [{ type: "text", text: message }],
    }],
  });

  return Response.json({ sessionId: session.id });
}
