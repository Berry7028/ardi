import { describe, expect, test } from "bun:test";

import { readOcHistory, type OcHistoryEntry } from "../../../../src/bridge/opencode/ocHistory";

const user = (id: string, text: string, at = 1000): OcHistoryEntry => ({ id, type: "user", text, time: { created: at } });
const assistant = (id: string, content: OcHistoryEntry["content"], at = 2000, extra: Record<string, unknown> = {}): OcHistoryEntry => ({
  id,
  type: "assistant",
  content,
  time: { created: at, completed: at + 500 },
  tokens: { output: 5 },
  ...extra,
});
const text = (content: string) => ({ type: "text", text: content });
const reasoning = (content: string) => ({ type: "reasoning", text: content });
const tool = (id: string, state: Record<string, unknown>) => ({ type: "tool", id, name: "list_tabs", state });

describe("readOcHistory", () => {
  test("a user message then its reply is one run", () => {
    expect(readOcHistory([user("u1", "hi"), assistant("a1", [text("hello")])])).toEqual([
      { role: "user", id: "u1", content: "hi", timestamp: 1000, images: undefined },
      {
        role: "assistant",
        id: "a1",
        blocks: [{ type: "text", content: "hello" }],
        toolCalls: [],
        timestamp: 2000,
        completedAt: 2500,
        durationMs: 1500,
        outputTokens: 5,
        interrupted: undefined,
      },
    ]);
  });

  test("consecutive assistant entries merge into one run", () => {
    const messages = readOcHistory([
      user("u1", "hi"),
      assistant("a1", [reasoning("thinking"), tool("call_t1", { status: "completed", input: {}, content: [{ type: "text", text: "2 tabs" }] })]),
      assistant("a2", [text("done")]),
    ]);
    expect(messages).toHaveLength(2);
    const run = messages[1];
    expect(run).toMatchObject({
      role: "assistant",
      blocks: [
        { type: "thinking", content: "thinking" },
        { type: "tool_use", toolId: "call_t1" },
        { type: "text", content: "done" },
      ],
      toolCalls: [{ id: "call_t1", name: "list_tabs", status: "completed", result: "2 tabs" }],
      outputTokens: 10,
    });
  });

  test("an interrupted idle marks the run interrupted", () => {
    const [run] = readOcHistory([
      user("u1", "hi"),
      assistant("a1", [text("partial")]),
      { id: "i1", type: "idle", outcome: "interrupted", time: { created: 3000 } },
    ]).filter((m) => m.role === "assistant");
    expect(run.interrupted).toBe(true);
  });

  test("a compaction entry is a notice between messages", () => {
    const messages = readOcHistory([
      user("u1", "hi"),
      assistant("a1", [text("hi")]),
      { id: "c1", type: "compaction", status: "completed", time: { created: 2500 } },
      user("u2", "again", 3000),
    ]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "notice", "user"]);
  });

  test("user file attachments become images", () => {
    const entry: OcHistoryEntry = {
      id: "u1",
      type: "user",
      text: "look",
      files: [{ uri: "data:image/png;base64,QUJD", name: "image" }],
      time: { created: 1000 },
    };
    expect(readOcHistory([entry])).toEqual([{ role: "user", id: "u1", content: "look", images: [{ data: "QUJD", mimeType: "image/png" }], timestamp: 1000 }]);
  });

  test("an errored tool keeps its error as the result", () => {
    const [run] = readOcHistory([user("u1", "hi"), assistant("a1", [tool("call_1", { status: "error", input: {}, error: { message: "Tab gone" } })])]).filter(
      (m) => m.role === "assistant",
    );
    expect(run.toolCalls).toEqual([{ id: "call_1", name: "list_tabs", input: {}, status: "error", result: "Tab gone", details: undefined }]);
  });
});
