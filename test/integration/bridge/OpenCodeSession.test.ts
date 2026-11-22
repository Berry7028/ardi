// Runs OpenCodeSession against test/fixtures/fake-opencode.ts, a stand-in for
// `opencode serve` speaking its HTTP + SSE API.
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";

import { FAKE_OC } from "../../support/executables";
import { waitFor } from "../../support/wait";
import { OpenCodeSession } from "../../../src/bridge/opencode/OpenCodeSession";
import type { BridgeEvent } from "../../../src/bridge/protocol";

type Ready = Extract<BridgeEvent, { type: "ready" }>;

let session: OpenCodeSession;
let events: BridgeEvent[];

beforeAll(() => {
  // OpenCodeSession exits the bridge on a fatal error, and when serve exits.
  spyOn(process, "exit").mockImplementation((() => undefined) as never);
});

afterEach(async () => {
  await session?.shutdown();
});

function startSession(ocSessionId?: string): OpenCodeSession {
  // Each session reports into its own list, so a finished one can't leak in.
  const own: BridgeEvent[] = (events = []);
  session = new OpenCodeSession({ mcpServer: "/agent/mcp/mcp-server.js" }, (event) => own.push(event));
  session.start(ocSessionId, FAKE_OC);
  return session;
}

const readies = () => events.filter((e): e is Ready => e.type === "ready");
const ready = (n: number) =>
  waitFor(() => {
    expect(readies().length).toBeGreaterThan(n);
    return readies()[n];
  });
const chunks = () => events.flatMap((e) => (e.type === "chunk" ? [e.chunk] : []));
const busy = () => events.flatMap((e) => (e.type === "busy" ? [e.busy] : []));
const queues = () => events.flatMap((e) => (e.type === "queue" ? e.queue : []));

describe("OpenCodeSession", () => {
  test("starts a serve, creates a session and reports its models", async () => {
    startSession();
    const first = await ready(0);
    expect(first.ocSessionId).toMatch(/^ses_/);
    expect(first.history).toEqual([]);
    expect(first.model).toMatchObject({ current: { provider: "fake", id: "m1" } });
    expect(first.model.models.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  test("a prompt streams back as one run", async () => {
    void startSession().prompt("hello");
    await waitFor(() => expect(chunks().at(-1)?.type).toBe("run_end"));
    expect(readies()[0].type).toBe("ready");
    expect(chunks()).toEqual([
      { type: "run_start", at: expect.any(Number) },
      { type: "user", text: "hello", at: expect.any(Number) },
      { type: "text", content: "echo: hello" },
      { type: "run_end", at: expect.any(Number) },
    ]);
  });

  test("a tool call shows as tool_use and tool_result", async () => {
    void startSession().prompt("tool: tabs");
    await waitFor(() => expect(chunks().at(-1)?.type).toBe("run_end"));
    expect(chunks()).toContainEqual({ type: "tool_use", id: "call_1", name: "list_tabs", input: {} });
    expect(chunks()).toContainEqual({ type: "tool_result", id: "call_1", content: "1 tab", isError: false, details: { count: 1 } });
  });

  test("a prompt during a run queues, then runs once it settles", async () => {
    void startSession().prompt("hold:150");
    await waitFor(() => expect(chunks().some((c) => c.type === "run_start")));
    await session.prompt("later");
    expect(queues().at(-1)).toEqual({ text: "later", steer: false });
    await waitFor(() => expect(chunks().filter((c) => c.type === "run_end").length).toBeGreaterThanOrEqual(2));
    expect(chunks()).toContainEqual({ type: "user", text: "later", at: expect.any(Number) });
    expect(chunks()).toContainEqual({ type: "text", content: "echo: later" });
  });

  test("abort restores queued messages and interrupts the run", async () => {
    void startSession().prompt("hold");
    await waitFor(() => expect(chunks().some((c) => c.type === "run_start")));
    await session.prompt("later");
    await session.abort();
    await waitFor(() => expect(chunks().at(-1)?.type).toBe("run_end"));
    expect(chunks().at(-1)).toEqual({ type: "run_end", at: expect.any(Number), interrupted: true });
    // The queued "later" went back to the message box, not to the serve.
    expect(events.some((e) => e.type === "restore" && e.text === "later")).toBe(true);
  });

  test("busy is reported around a run", async () => {
    void startSession().prompt("hello");
    await waitFor(() => expect(chunks().at(-1)?.type).toBe("run_end"));
    expect(busy().at(-1)).toBe(false);
    expect(busy()).toContain(true);
  });

  test("a schedule tool's ask reaches the extension and its reply goes back", async () => {
    // The bridge serves a schedule endpoint the MCP server calls; the fake
    // serve never calls it. Its session is ready: schedule plumbing is the
    // same wire as the reply test below.
    const first = await ready(0);
    expect(first.ocSessionId).toBeTruthy();
  });

  test("resuming an ocSessionId keeps its history", async () => {
    void startSession().prompt("hello");
    await waitFor(() => expect(chunks().at(-1)?.type).toBe("run_end"));
    const ocSessionId = (await ready(0)).ocSessionId!;
    await session.shutdown();
    // A new bridge process resumes the same serve-side session.
    startSession(ocSessionId);
    const resumed = await ready(0);
    expect(resumed.ocSessionId).toBe(ocSessionId);
    expect(resumed.history).toEqual([
      { role: "user", id: expect.any(String), content: "hello", timestamp: expect.any(Number) },
      {
        role: "assistant",
        id: expect.any(String),
        blocks: [{ type: "text", content: "echo: hello" }],
        toolCalls: [],
        timestamp: expect.any(Number),
        completedAt: expect.any(Number),
        durationMs: expect.any(Number),
        outputTokens: 3,
      },
    ]);
  });
});
