import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          new TextEncoder().encode(
            `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
          )
        );
      };

      try {
        // Reconcile existing events first
        for await (const ev of client.beta.sessions.events.list(id, { limit: 1000 })) {
          if (ev.type === "agent.message") {
            const content = (ev as { content: Array<{ text?: string }> }).content;
            send("message", { text: content.map(c => c.text ?? "").join("") });
          } else if (ev.type === "agent.custom_tool_use") {
            send("tool_use", { name: (ev as { name: string }).name, input: (ev as { input: unknown }).input });
          } else if (ev.type === "user.custom_tool_result") {
            send("tool_result", { content: (ev as { content: Array<{ text?: string }> }).content });
          } else if (ev.type === "session.status_idle") {
            const stop = (ev as { stop_reason?: { type: string } }).stop_reason;
            if (stop?.type === "end_turn") {
              send("done", { sessionId: id });
              controller.close();
              return;
            }
          }
        }

        // Stream new events
        const eventStream = await client.beta.sessions.events.stream(id);
        for await (const ev of eventStream) {
          if (ev.type === "agent.message") {
            const content = (ev as { content: Array<{ text?: string }> }).content;
            send("message", { text: content.map(c => c.text ?? "").join("") });
          } else if (ev.type === "agent.custom_tool_use") {
            send("tool_use", { name: (ev as { name: string }).name, input: (ev as { input: unknown }).input });
          } else if (ev.type === "user.custom_tool_result") {
            send("tool_result", { content: (ev as { content: Array<{ text?: string }> }).content });
          } else if (ev.type === "session.status_idle") {
            const stop = (ev as { stop_reason?: { type: string } }).stop_reason;
            if (stop?.type === "end_turn") {
              send("done", { sessionId: id });
              break;
            }
          }
        }
      } catch (e) {
        send("error", { message: (e as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
