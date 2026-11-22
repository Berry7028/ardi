#!/usr/bin/env node
// A stand-in for `opencode serve`, for bridge tests. Speaks the serve's HTTP
// + SSE API just enough for OpenCodeSession: POST /session, GET /session/{id}
// and /message, PATCH+GET /config, GET /provider, POST prompt_async (204),
// /abort, /summarize, /permissions/{id}, GET /event (SSE).
//
// Event shapes follow api.json's SSE {type, properties}. A prompt for "hold"
// goes busy and stays until aborted; any other text replies "echo: X" and
// goes idle. "tool:" prompts show a completed list_tabs tool part. Abort
// reports MessageAbortedError. FAKE_OPENCODE_LAUNCH_LOG records spawn env.

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
let config: Record<string, unknown> = { model: "fake/m1" };

function save() {
  writeFileSync(STORE, JSON.stringify([...sessions].map(([id, s]) => [id, { id: s.id, messages: s.messages }])));
}

function emit(type: string, properties: Record<string, unknown>) {
  const line = `data: ${JSON.stringify({ id: String(Date.now()), type, properties })}\n\n`;
  for (const res of listeners) res.write(line);
}

const json = (res: any, code: number, body: unknown) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));

function message(session: any, id: string, role: string, time: Record<string, unknown> = {}) {
  const info: Record<string, unknown> = { id, sessionID: session.id, role, time: { created: Date.now(), ...time }, modelID: "m1", providerID: "fake" };
  if (role === "assistant") info.tokens = { output: 3 };
  session.messages.push({ info, parts: [] });
  return session.messages.at(-1);
}

function part(entry: any, fields: Record<string, unknown>) {
  const p = { id: `prt_${entry.parts.length}`, messageID: entry.info.id, sessionID: entry.info.sessionID, ...fields };
  entry.parts.push(p);
  return p;
}

function broadcastEntry(entry: any) {
  emit("message.updated", { info: entry.info });
  for (const p of entry.parts) emit("message.part.updated", { part: p });
}

// Replies to a prompt and ends the run idle.
function reply(session: any, text: string) {
  const reply = message(session, `msg_a${session.messages.length}`, "assistant", { completed: Date.now() });
  if (text.startsWith("tool:")) {
    part(reply, { type: "tool", callID: "call_1", tool: "list_tabs", state: { status: "running", input: {} } });
    emit("message.updated", { info: reply.info });
    emit("message.part.updated", { part: reply.parts[0] });
    reply.parts[0].state = { status: "completed", input: {}, output: "1 tab", metadata: { count: 1 } };
    emit("message.part.updated", { part: reply.parts[0] });
  } else {
    part(reply, { type: "text", text: `echo: ${text}` });
    broadcastEntry(reply);
  }
  emit("session.status", { sessionID: session.id, status: { type: "idle" } });
  emit("session.idle", { sessionID: session.id });
}

// Runs the prompt: user message, then "echo" or a held run; ends idle.
// "hold" stays busy until aborted; "hold:ms" replies after that long.
function run(session: any, text: string) {
  emit("session.status", { sessionID: session.id, status: { type: "busy" } });
  const user = message(session, `msg_u${session.messages.length}`, "user");
  part(user, { type: "text", text });
  broadcastEntry(user);
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
    return; // "hold" idles on abort
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
  const send = (object: boolean) => {
    try {
      return object ? JSON.parse(body || "{}") : undefined;
    } catch {
      return undefined;
    }
  };
  const m = url.pathname.match(/^\/session\/([^/]+)(?:\/(.+))?$/);
  const session = m && sessions.get(m[1]);
  const sub = m?.[2] ?? "";

  if (req.method === "GET" && url.pathname === "/event") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
    listeners.add(res);
    req.on("close", () => listeners.delete(res));
    return;
  }
  if (req.method === "GET" && url.pathname === "/provider") {
    return json(res, 200, { all: [{ id: "fake", name: "Fake", models: { m1: { name: "Fake M1" }, m2: { name: "Fake M2" } } }], connected: ["fake"], default: { fake: "m1" } });
  }
  if (req.method === "GET" && url.pathname === "/config") return json(res, 200, config);
  if (req.method === "PATCH" && url.pathname === "/config") {
    config = { ...config, ...send(true) };
    return json(res, 200, config);
  }
  if (req.method === "POST" && url.pathname === "/session") {
    const id = `ses_${nextSession++}`;
    sessions.set(id, { id, messages: [] });
    save();
    return json(res, 200, { id });
  }
  if (!session) return json(res, 404, { error: "not found" });
  if (req.method === "GET" && !sub) return json(res, 200, { id: session.id, model: { providerID: "fake", modelID: "m1" } });
  if (req.method === "GET" && sub === "message") return json(res, 200, session.messages);
  if (req.method === "POST" && sub === "prompt_async") {
    const request = send(true);
    const text = (request?.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
    setImmediate(() => {
      run(session, text);
      save();
    });
    res.writeHead(204).end();
    return;
  }
  if (req.method === "POST" && sub === "abort") {
    if (session.holding) {
      session.holding = false;
      clearTimeout(session.holdTimer);
      emit("session.error", { sessionID: session.id, error: { name: "MessageAbortedError", data: { message: "The user aborted" } } });
      emit("session.status", { sessionID: session.id, status: { type: "idle" } });
      emit("session.idle", { sessionID: session.id });
    }
    return json(res, 200, true);
  }
  if (req.method === "POST" && sub === "summarize") {
    emit("session.compacted", { sessionID: session.id });
    return json(res, 200, true);
  }
  if (req.method === "POST" && sub.startsWith("permissions/")) return json(res, 200, {});
  return json(res, 404, { error: "not found" });
};

const server = createServer((req, res) => void handle(req, res));

server.listen(port, hostname, () => {
  console.log(`opencode server listening on http://${hostname}:${(server.address() as { port: number }).port}`);
});
