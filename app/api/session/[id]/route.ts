import Anthropic from "@anthropic-ai/sdk";
import type { BetaManagedAgentsSessionEvent } from "@anthropic-ai/sdk/resources/beta/sessions/events";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          new TextEncoder().encode(
            `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
          ),
        );
      };

      // Returns true if this event ends the turn and the stream should close.
      const forward = (ev: BetaManagedAgentsSessionEvent): boolean => {
        switch (ev.type) {
          case "agent.message":
            send("message", {
              text: ev.content.map((c) => ("text" in c ? c.text : "")).join(""),
            });
            return false;
          case "agent.custom_tool_use":
            send("tool_use", { name: ev.name, input: ev.input });
            return false;
          case "user.custom_tool_result":
            send("tool_result", { content: ev.content });
            return false;
          case "session.status_idle":
            if (ev.stop_reason?.type === "end_turn") {
              send("done", { sessionId: id });
              return true;
            }
            return false;
          default:
            return false;
        }
      };

      try {
        // Reconcile existing events first
        for await (const ev of client.beta.sessions.events.list(id, {
          limit: 1000,
        })) {
          if (forward(ev)) return;
        }

        // Stream new events
        const eventStream = await client.beta.sessions.events.stream(id);
        for await (const ev of eventStream) {
          if (forward(ev)) break;
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
