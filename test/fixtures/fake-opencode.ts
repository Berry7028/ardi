#!/usr/bin/env node
// A stand-in for OpenCode 2's `opencode serve`, for bridge tests. Speaks the
// /api HTTP + SSE surface just enough for OpenCodeSession: POST+GET
// /api/session, GET /api/session/{id}/message, GET /api/model(+default), POST
// /api/session/{id}/prompt|interrupt|compact|model|permission/{id}/reply, GET
// /api/event (SSE). Auth headers are accepted, not checked.
//
// Events use the v2 {id,type,created,data} envelope. A prompt for "hold" runs
// until interrupted; "hold:ms" replies after that long; any other text
// replies "echo: X" and the execution succeeds. "tool:" prompts show a
// completed list_tabs tool call. FAKE_OPENCODE_LAUNCH_LOG records spawn env.
// FAKE_OC_FAIL_PROMPT / FAKE_OC_FAIL_MODEL force 500s on those endpoints.

import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("0.0.0-fake");
  process.exit(0);
}
if (process.env.FAKE_OPENCODE_LAUNCH_LOG) {
  writeFileSync(process.env.FAKE_OPENCODE_LAUNCH_LOG, JSON.stringify({ args, cwd: process.cwd(), pid: process.pid }));
}

const port = Number(args[args.indexOf("--port") + 1]);
const hostname = args[args.indexOf("--hostname") + 1] || "127.0.0.1";

let nextSession = 0;
// Sessions persist in the temp home, so a resumed session keeps its messages.
const STORE = join(process.env.HOME!, "fake-oc-sessions.json");
const sessions: Map<string, any> = new Map(existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : []);
for (const id of sessions.keys()) nextSession = Math.max(nextSession, Number(id.replace("ses_", "")) + 1);
const listeners = new Set<any>();

function save() {
  writeFileSync(STORE, JSON.stringify([...sessions].map(([id, s]) => [id, { id: s.id, messages: s.messages }])));
}

function emit(type: string, data: Record<string, unknown>) {
  const line = `data: ${JSON.stringify({ id: `evt_${Date.now()}_${Math.random()}`, type, created: Date.now(), data })}\n\n`;
  for (const res of listeners) res.write(line);
}

const json = (res: any, code: number, body: unknown) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));

// Replies to a prompt and ends the execution.
function reply(session: any, text: string) {
  const assistantID = `msg_a${session.messages.length}`;
  if (text.startsWith("tool:")) {
    emit("session.tool.input.started", { sessionID: session.id, assistantMessageID: assistantID, id: "call_1", name: "list_tabs" });
    emit("session.tool.called", { sessionID: session.id, assistantMessageID: assistantID, id: "call_1", input: {}, executed: true });
    emit("session.tool.success", { sessionID: session.id, assistantMessageID: assistantID, id: "call_1", content: [{ type: "text", text: "1 tab" }], metadata: { count: 1 }, executed: true });
    session.messages.push({
      id: assistantID,
      type: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      tokens: { output: 3 },
      content: [{ type: "tool", id: "call_1", name: "list_tabs", state: { status: "completed", input: {}, content: [{ type: "text", text: "1 tab" }], metadata: { count: 1 } } }],
    });
  } else {
    emit("session.text.delta", { sessionID: session.id, assistantMessageID: assistantID, ordinal: 0, delta: `echo: ${text}` });
    session.messages.push({
      id: assistantID,
      type: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      tokens: { output: 3 },
      content: [{ type: "text", text: `echo: ${text}` }],
    });
  }
  emit("session.step.ended", { sessionID: session.id, assistantMessageID: assistantID, finish: "stop", cost: 0, tokens: { output: 3 } });
  emit("session.execution.succeeded", { sessionID: session.id });
}

// Runs the prompt: user message recorded, then "echo" or a held run.
// "hold" stays running until interrupted; "hold:ms" replies after that long.
function run(session: any, text: string) {
  session.messages.push({ id: `msg_u${session.messages.length}`, type: "user", text, time: { created: Date.now() } });
  emit("session.execution.started", { sessionID: session.id });
  if (text === "hold" || text.startsWith("hold:")) {
    session.holding = true;
    const ms = text === "hold" ? null : Number(text.slice(5));
    if (ms !== null) {
      session.holdTimer = setTimeout(() => {
        session.holding = false;
        reply(session, text);
        save();
      }, ms);
    }
    return; // "hold" ends on interrupt
  }
  reply(session, text);
}

const handle = async (req: any, res: any) => {
  const url = new URL(req.url ?? "/", "http://x");
  let body = "";
  req.on("data", (c: Buffer) => (body += c));
  await new Promise<void>((done) => {
    req.on("end", () => done());
  });
  const send = () => {
    try {
      return JSON.parse(body || "{}");
    } catch {
      return undefined;
    }
  };
  const m = url.pathname.match(/^\/api\/session\/([^/]+)(?:\/(.+))?$/);
  const session = m && sessions.get(m[1]);
  const sub = m?.[2] ?? "";

  if (req.method === "GET" && url.pathname === "/api/event") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ id: "evt_0", type: "server.connected", created: Date.now(), data: {} })}\n\n`);
    listeners.add(res);
    req.on("close", () => listeners.delete(res));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/model") {
    if (process.env.FAKE_OC_FAIL_MODEL) return json(res, 500, { error: "model refused" });
    return json(res, 200, { location: { directory: "/" }, data: [{ id: "m1", providerID: "fake", name: "Fake M1" }, { id: "m2", providerID: "fake", name: "Fake M2" }] });
  }
  if (req.method === "GET" && url.pathname === "/api/model/default") {
    return json(res, 200, { location: { directory: "/" }, data: { id: "m1", providerID: "fake", name: "Fake M1" } });
  }
  if (req.method === "POST" && url.pathname === "/api/session") {
    const id = `ses_${nextSession++}`;
    sessions.set(id, { id, messages: [] });
    save();
    return json(res, 200, { data: { id } });
  }
  if (!session) return json(res, 404, { error: "not found" });
  if (req.method === "GET" && !sub) return json(res, 200, { data: { id: session.id, model: { providerID: "fake", id: "m1" } } });
  if (req.method === "GET" && sub === "message") return json(res, 200, { data: session.messages, cursor: {} });
  if (process.env.FAKE_OC_FAIL_PROMPT && req.method === "POST" && sub === "prompt") return json(res, 500, { error: "prompt refused" });
  if (req.method === "POST" && sub === "prompt") {
    const request = send();
    const text = request?.text ?? "";
    setImmediate(() => {
      run(session, text);
      save();
    });
    return json(res, 200, { data: { id: `msg_u${session.messages.length}`, text } });
  }
  if (req.method === "POST" && sub === "interrupt") {
    if (session.holding) {
      session.holding = false;
      clearTimeout(session.holdTimer);
      emit("session.execution.interrupted", { sessionID: session.id, reason: "user" });
      return json(res, 200, { interrupted: true });
    }
    return json(res, 200, { interrupted: false });
  }
  if (req.method === "POST" && sub === "compact") {
    emit("session.compaction.ended", { sessionID: session.id });
    return json(res, 200, { data: {} });
  }
  if (req.method === "POST" && sub === "model") {
    session.model = send()?.model;
    res.writeHead(204).end();
    return;
  }
  if (req.method === "POST" && sub.match(/^permission\/[^/]+\/reply$/)) {
    res.writeHead(204).end();
    return;
  }
  return json(res, 404, { error: "not found" });
};

const server = createServer((req, res) => void handle(req, res));

server.listen(port, hostname, () => {
  console.log(`server listening on http://${hostname}:${(server.address() as { port: number }).port}`);
});
