import { describe, expect, test } from "bun:test";

import { readOcHistory, type OcHistoryEntry } from "../../../../src/bridge/opencode/ocHistory";

const user = (id: string, text: string, at = 1000): OcHistoryEntry => ({
  info: { id, role: "user", time: { created: at } },
  parts: [{ id: `${id}p`, type: "text", messageID: id, text }],
});
const assistant = (id: string, parts: OcHistoryEntry["parts"], at = 2000, info: Record<string, unknown> = {}): OcHistoryEntry => ({
  info: { id, role: "assistant", time: { created: at, completed: at + 500 }, tokens: { output: 5 }, ...info },
  parts,
});
const text = (id: string, messageID: string, content: string) => ({ id, type: "text", messageID, text: content });
const reasoning = (id: string, messageID: string, content: string) => ({ id, type: "reasoning", messageID, text: content });
const tool = (id: string, messageID: string, state: Record<string, unknown>) => ({ id, type: "tool", messageID, callID: `call_${id}`, tool: "list_tabs", state });

describe("readOcHistory", () => {
  test("a user message then its reply is one run", () => {
    expect(readOcHistory([user("u1", "hi"), assistant("a1", [text("p1", "a1", "hello")])])).toEqual([
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
      assistant("a1", [reasoning("r1", "a1", "thinking"), tool("t1", "a1", { status: "completed", input: {}, output: "2 tabs" })]),
      assistant("a2", [text("p2", "a2", "done")]),
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

  test("an aborted reply's run is interrupted", () => {
    const [run] = readOcHistory([user("u1", "hi"), assistant("a1", [text("p1", "a1", "partial")], 2000, { error: { name: "MessageAbortedError" } })]).filter(
      (m) => m.role === "assistant",
    );
    expect(run.interrupted).toBe(true);
  });

  test("a compaction part is a notice between messages", () => {
    const messages = readOcHistory([user("u1", "hi"), assistant("a1", [text("p1", "a1", "hi"), { id: "c1", type: "compaction", messageID: "a1" }]), user("u2", "again", 3000)]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "notice", "user"]);
  });

  test("user image parts become attachments", () => {
    const entry: OcHistoryEntry = {
      info: { id: "u1", role: "user", time: { created: 1000 } },
      parts: [
        { id: "f1", type: "file", messageID: "u1", mime: "image/png", url: "data:image/png;base64,QUJD" },
        { id: "t1", type: "text", messageID: "u1", text: "look" },
      ],
    };
    expect(readOcHistory([entry])).toEqual([{ role: "user", id: "u1", content: "look", images: [{ data: "QUJD", mimeType: "image/png" }], timestamp: 1000 }]);
  });
});
