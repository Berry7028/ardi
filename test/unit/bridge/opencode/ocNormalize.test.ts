import { describe, expect, test } from "bun:test";

import { createOcNormState, normalizeOcEvent } from "../../../../src/bridge/opencode/ocNormalize";
import type { OcEvent } from "../../../../src/bridge/opencode/ocClient";

const event = (type: string, data: Record<string, unknown>): OcEvent => ({ id: "1", type, data });
const data = { sessionID: "s", assistantMessageID: "m1" };

function feed(...events: OcEvent[]) {
  const state = createOcNormState();
  return events.flatMap((e) => normalizeOcEvent(e, state));
}

describe("normalizeOcEvent", () => {
  test("an execution start..end is one run", () => {
    expect(feed(event("session.execution.started", data), event("session.execution.succeeded", data))).toEqual([
      { type: "run_start", at: expect.any(Number) },
      { type: "run_end", at: expect.any(Number) },
    ]);
  });

  test("an interrupted execution marks the run interrupted", () => {
    expect(feed(event("session.execution.started", data), event("session.execution.interrupted", { ...data, reason: "user" }))).toEqual([
      { type: "run_start", at: expect.any(Number) },
      { type: "run_end", at: expect.any(Number), interrupted: true },
    ]);
  });

  test("a failed execution is an error notice plus the run end", () => {
    expect(feed(event("session.execution.started", data), event("session.execution.failed", { ...data, error: { type: "ProviderError", message: "401 invalid x-api-key" } }))).toEqual([
      { type: "run_start", at: expect.any(Number) },
      { type: "notice", content: "401 invalid x-api-key", level: "error" },
      { type: "run_end", at: expect.any(Number) },
    ]);
  });

  test("a retry is a warning", () => {
    expect(feed(event("session.retry.scheduled", { ...data, attempt: 2, error: { message: "rate limited" } }))).toEqual([
      { type: "notice", content: "Retrying (attempt 2): rate limited", level: "warning" },
    ]);
  });

  test("text and reasoning deltas stream as text and thinking", () => {
    expect(
      feed(
        event("session.text.delta", { ...data, ordinal: 0, delta: "Hel" }),
        event("session.text.delta", { ...data, ordinal: 0, delta: "lo" }),
        event("session.reasoning.delta", { ...data, ordinal: 0, delta: "hm" }),
      ),
    ).toEqual([
      { type: "text", content: "Hel" },
      { type: "text", content: "lo" },
      { type: "thinking", content: "hm" },
    ]);
  });

  test("a tool call becomes tool_use then tool_result", () => {
    const state = createOcNormState();
    normalizeOcEvent(event("session.tool.input.started", { ...data, id: "c1", name: "read_tab" }), state);
    const use = normalizeOcEvent(event("session.tool.called", { ...data, id: "c1", input: { tab: 1 } }), state);
    const done = normalizeOcEvent(event("session.tool.success", { ...data, id: "c1", content: [{ type: "text", text: "page text" }] }), state);
    expect(use).toEqual([{ type: "tool_use", id: "c1", name: "read_tab", input: { tab: 1 } }]);
    expect(done).toEqual([{ type: "tool_result", id: "c1", content: "page text", isError: false, details: undefined }]);
  });

  test("an errored tool reports isError", () => {
    const state = createOcNormState();
    normalizeOcEvent(event("session.tool.input.started", { ...data, id: "c1", name: "browser_exec" }), state);
    expect(normalizeOcEvent(event("session.tool.failed", { ...data, id: "c1", error: { message: "Tab gone" } }), state)).toEqual([
      { type: "tool_result", id: "c1", content: "Tab gone", isError: true, details: undefined },
    ]);
  });

  test("a tool that skips input.started still names itself", () => {
    expect(feed(event("session.tool.called", { ...data, id: "c1", input: {} }))).toEqual([{ type: "tool_use", id: "c1", name: "tool", input: {} }]);
  });

  test("step end reports output tokens", () => {
    expect(feed(event("session.step.ended", { ...data, tokens: { output: 42 } }))).toEqual([{ type: "usage", outputTokens: 42 }]);
  });

  test("compaction is noticed, unknown events are ignored", () => {
    expect(feed(event("session.compaction.ended", data), event("server.heartbeat", {}), event("session.inbox.delivered", data))).toEqual([
      { type: "notice", content: "Context compacted", level: "info" },
    ]);
  });
});
