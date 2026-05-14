"use client";

import { useState, useRef } from "react";

type Event =
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; content: Array<{ text?: string }> }
  | { type: "message"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export default function Home() {
  const [message, setMessage] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const esRef = useRef<EventSource | null>(null);

  async function run() {
    if (!message.trim() || status === "running") return;
    setEvents([]);
    setSessionId(null);
    setStatus("running");

    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const { sessionId: id, error } = await res.json();
    if (error) {
      setStatus("error");
      setEvents([{ type: "error", message: error }]);
      return;
    }
    setSessionId(id);

    esRef.current?.close();
    const es = new EventSource(`/api/session/${id}`);
    esRef.current = es;

    es.addEventListener("tool_use", (e) => {
      const data = JSON.parse(e.data);
      setEvents(prev => [...prev, { type: "tool_use", name: data.name, input: data.input }]);
    });
    es.addEventListener("tool_result", (e) => {
      const data = JSON.parse(e.data);
      setEvents(prev => [...prev, { type: "tool_result", content: data.content }]);
    });
    es.addEventListener("message", (e) => {
      const data = JSON.parse(e.data);
      setEvents(prev => [...prev, { type: "message", text: data.text }]);
    });
    es.addEventListener("done", () => {
      setStatus("done");
      es.close();
    });
    es.addEventListener("error", (e) => {
      const data = JSON.parse((e as MessageEvent).data ?? "{}");
      setEvents(prev => [...prev, { type: "error", message: data.message ?? "stream error" }]);
      setStatus("error");
      es.close();
    });
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 flex flex-col items-center px-4 py-16">
      <div className="w-full max-w-2xl flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
            CMA Vercel Sandbox
          </h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Run a prompt against a Claude agent with a private Vercel Sandbox.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <textarea
            className="w-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 resize-none"
            rows={4}
            placeholder="run `uname -a && node --version`"
            value={message}
            onChange={e => setMessage(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(); }}
          />
          <button
            onClick={run}
            disabled={status === "running" || !message.trim()}
            className="self-end rounded-lg bg-zinc-900 dark:bg-zinc-50 px-5 py-2 text-sm font-medium text-zinc-50 dark:text-zinc-900 transition-opacity disabled:opacity-40 hover:opacity-80"
          >
            {status === "running" ? "Running…" : "Run"}
          </button>
        </div>

        {sessionId && (
          <p className="text-xs text-zinc-400 font-mono">session: {sessionId}</p>
        )}

        {events.length > 0 && (
          <div className="flex flex-col gap-3">
            {events.map((ev, i) => {
              if (ev.type === "tool_use") return (
                <div key={i} className="rounded-lg bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 px-4 py-3">
                  <p className="text-xs font-medium text-amber-700 dark:text-amber-300 mb-1">
                    tool: {ev.name}
                  </p>
                  <pre className="text-xs text-amber-900 dark:text-amber-100 whitespace-pre-wrap break-all">
                    {JSON.stringify(ev.input, null, 2)}
                  </pre>
                </div>
              );
              if (ev.type === "tool_result") return (
                <div key={i} className="rounded-lg bg-zinc-100 dark:bg-zinc-800 px-4 py-3">
                  <p className="text-xs font-medium text-zinc-500 mb-1">result</p>
                  <pre className="text-xs text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-all">
                    {ev.content.map(c => c.text ?? "").join("")}
                  </pre>
                </div>
              );
              if (ev.type === "message") return (
                <div key={i} className="rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 px-4 py-3">
                  <p className="text-xs font-medium text-zinc-500 mb-1">agent</p>
                  <p className="text-sm text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap">{ev.text}</p>
                </div>
              );
              if (ev.type === "error") return (
                <div key={i} className="rounded-lg bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 px-4 py-3">
                  <p className="text-xs font-medium text-red-700 dark:text-red-300">error</p>
                  <p className="text-sm text-red-900 dark:text-red-100">{ev.message}</p>
                </div>
              );
              return null;
            })}
          </div>
        )}

        {status === "running" && events.length === 0 && (
          <div className="text-sm text-zinc-400 animate-pulse">
            Waiting for agent…
          </div>
        )}
      </div>
    </div>
  );
}
