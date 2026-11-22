import { describe, expect, test } from "bun:test";

import { createOcNormState, normalizeOcEvent } from "../../../../src/bridge/opencode/ocNormalize";
import type { OcEvent } from "../../../../src/bridge/opencode/ocClient";

const event = (type: string, properties: Record<string, unknown>): OcEvent => ({ id: "1", type, properties });
const status = (type: string) => event("session.status", { sessionID: "s", status: { type } });
const info = (id: string, role: string) => event("message.updated", { info: { id, role, sessionID: "s" } });
const part = (fields: Record<string, unknown>) => event("message.part.updated", { part: { id: "p1", messageID: "m1", sessionID: "s", ...fields } });

function feed(...events: OcEvent[]) {
  const state = createOcNormState();
  return events.flatMap((e) => normalizeOcEvent(e, state));
}

describe("normalizeOcEvent", () => {
  test("a busy..idle period is one run", () => {
    expect(feed(status("busy"), status("idle"), event("session.idle", { sessionID: "s" }))).toEqual([
      { type: "run_start", at: expect.any(Number) },
      { type: "run_end", at: expect.any(Number) },
    ]);
  });

  test("a retry is a warning, not a run", () => {
    expect(feed(status("retry"))).toEqual([{ type: "notice", content: "Retrying", level: "warning" }]);
  });

  test("an abort marks the run interrupted", () => {
    expect(
      feed(status("busy"), event("session.error", { error: { name: "MessageAbortedError", data: { message: "aborted" } } }), event("session.idle", { sessionID: "s" })),
    ).toEqual([
      { type: "run_start", at: expect.any(Number) },
      { type: "run_end", at: expect.any(Number), interrupted: true },
    ]);
  });

  test("a non-abort error is an error notice", () => {
    expect(feed(event("session.error", { error: { name: "ProviderError", data: { message: "401 invalid x-api-key" } } }))).toEqual([
      { type: "notice", content: "401 invalid x-api-key", level: "error" },
    ]);
  });

  test("user text becomes a user chunk once the role is known", () => {
    // The text part may arrive before its message's role.
    expect(feed(part({ type: "text", text: "hi" }), info("m1", "user"))).toEqual([{ type: "user", text: "hi", at: expect.any(Number) }]);
    expect(feed(info("m1", "user"), part({ type: "text", text: "hi" }))).toEqual([{ type: "user", text: "hi", at: expect.any(Number) }]);
  });

  test("user file parts become the user chunk's images", () => {
    expect(
      feed(
        info("m1", "user"),
        part({ type: "file", mime: "image/png", url: "data:image/png;base64,QUJD" }),
        part({ type: "text", text: "look" }),
      ),
    ).toEqual([{ type: "user", text: "look", at: expect.any(Number), images: [{ data: "QUJD", mimeType: "image/png" }] }]);
  });

  test("assistant text streams by suffix diff", () => {
    const state = createOcNormState();
    normalizeOcEvent(info("m1", "assistant"), state);
    const deltas = [
      normalizeOcEvent(part({ type: "text", text: "Hel" }), state),
      normalizeOcEvent(part({ type: "text", text: "Hello" }), state),
      normalizeOcEvent(part({ type: "text", text: "Hello!" }), state),
    ].flat();
    expect(deltas).toEqual([
      { type: "text", content: "Hel" },
      { type: "text", content: "lo" },
      { type: "text", content: "!" },
    ]);
  });

  test("assistant reasoning streams as thinking", () => {
    const state = createOcNormState();
    normalizeOcEvent(info("m1", "assistant"), state);
    expect(normalizeOcEvent(part({ type: "reasoning", text: "hm" }), state)).toEqual([{ type: "thinking", content: "hm" }]);
  });

  test("a text part before its message's role is held back", () => {
    // With no role known, a text part could be the user's own text.
    expect(feed(part({ type: "text", text: "draft" }), info("m1", "assistant"))).toEqual([{ type: "text", content: "draft" }]);
  });

  test("tool parts become tool_use then tool_result", () => {
    const state = createOcNormState();
    normalizeOcEvent(info("m1", "assistant"), state);
    const use = normalizeOcEvent(part({ type: "tool", callID: "c1", tool: "read_tab", state: { status: "running", input: { tab: 1 } } }), state);
    const done = normalizeOcEvent(part({ type: "tool", callID: "c1", tool: "read_tab", state: { status: "completed", input: { tab: 1 }, output: "page text" } }), state);
    expect(use).toEqual([{ type: "tool_use", id: "c1", name: "read_tab", input: { tab: 1 } }]);
    expect(done).toEqual([{ type: "tool_result", id: "c1", content: "page text", isError: false, details: undefined }]);
  });

  test("an errored tool reports isError", () => {
    const state = createOcNormState();
    normalizeOcEvent(info("m1", "assistant"), state);
    normalizeOcEvent(part({ type: "tool", callID: "c1", tool: "browser_exec", state: { status: "running", input: {} } }), state);
    expect(normalizeOcEvent(part({ type: "tool", callID: "c1", tool: "browser_exec", state: { status: "error", error: "Tab gone" } }), state)).toEqual([
      { type: "tool_result", id: "c1", content: "Tab gone", isError: true, details: undefined },
    ]);
  });

  test("step-finish reports output tokens", () => {
    const state = createOcNormState();
    normalizeOcEvent(info("m1", "assistant"), state);
    expect(normalizeOcEvent(part({ type: "step-finish", tokens: { output: 42 } }), state)).toEqual([{ type: "usage", outputTokens: 42 }]);
  });

  test("compaction and unknown events are ignored or noticed", () => {
    expect(feed(event("server.heartbeat", {}), event("message.updated", { info: { id: "m1" } }))).toEqual([]);
    expect(feed(event("session.compacted", { sessionID: "s" }))).toEqual([{ type: "notice", content: "Context compacted", level: "info" }]);
  });
});
