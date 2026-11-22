// OpenCode 2 server events as chat chunks. A run is one
// session.execution.started..succeeded|failed|interrupted period; text and
// reasoning stream as ready-made deltas; a tool's input.started..called..
// success|failed arc becomes tool_use/tool_result. The `user` chunk for a
// prompt comes from the session itself (emitted on send), not from events.

import type { ChatChunk } from "../../chat";
import type { OcEvent } from "./ocClient";

export type OcNormState = {
  // Whether a run's run_start went out; the next execution end ends it.
  running: boolean;
  // The user stopped the run (execution.interrupted seen).
  interrupted: boolean;
  // Tool id -> name, from session.tool.input.started.
  toolNames: Map<string, string>;
};

export function createOcNormState(): OcNormState {
  return { running: false, interrupted: false, toolNames: new Map() };
}

const errorMessage = (error: unknown): string => (error as { message?: string; type?: string } | undefined)?.message || (error as { type?: string } | undefined)?.type || "Unknown error";

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const item = part as { type?: string; text?: string; uri?: string };
      if (item.type === "text") return item.text ?? "";
      if (item.type === "file") return item.uri ?? "";
      return "";
    })
    .join("\n");
}

export function normalizeOcEvent(event: OcEvent, state: OcNormState): ChatChunk[] {
  const data = event.data;
  switch (event.type) {
    case "session.execution.started": {
      if (state.running) return [];
      state.running = true;
      return [{ type: "run_start", at: Date.now() }];
    }
    case "session.execution.succeeded":
    case "session.execution.interrupted":
    case "session.execution.failed": {
      const chunks: ChatChunk[] = [];
      if (event.type === "session.execution.interrupted") state.interrupted = true;
      if (event.type === "session.execution.failed") chunks.push({ type: "notice", content: errorMessage(data.error), level: "error" });
      if (!state.running) {
        state.interrupted = false;
        return chunks;
      }
      state.running = false;
      const interrupted = state.interrupted;
      state.interrupted = false;
      chunks.push({ type: "run_end", at: Date.now(), ...(interrupted ? { interrupted } : {}) });
      return chunks;
    }
    case "session.text.delta":
      return typeof data.delta === "string" ? [{ type: "text", content: data.delta }] : [];
    case "session.reasoning.delta":
      return typeof data.delta === "string" ? [{ type: "thinking", content: data.delta }] : [];
    case "session.tool.input.started": {
      if (typeof data.id === "string" && typeof data.name === "string") state.toolNames.set(data.id, data.name);
      return [];
    }
    case "session.tool.called": {
      const id = data.id as string;
      return [{ type: "tool_use", id, name: state.toolNames.get(id) ?? "tool", input: (data.input as Record<string, unknown>) ?? {} }];
    }
    case "session.tool.success": {
      return [{ type: "tool_result", id: data.id as string, content: contentText(data.content), isError: false, details: data.metadata }];
    }
    case "session.tool.failed": {
      return [{ type: "tool_result", id: data.id as string, content: errorMessage(data.error) || contentText(data.content), isError: true, details: data.metadata }];
    }
    case "session.step.ended": {
      const output = (data.tokens as { output?: number } | undefined)?.output;
      return output ? [{ type: "usage", outputTokens: output }] : [];
    }
    case "session.retry.scheduled": {
      const attempt = typeof data.attempt === "number" ? ` (attempt ${data.attempt})` : "";
      return [{ type: "notice", content: `Retrying${attempt}: ${errorMessage(data.error)}`, level: "warning" }];
    }
    case "session.compaction.ended": {
      return [{ type: "notice", content: "Context compacted", level: "info" }];
    }
    case "session.compaction.failed": {
      return [{ type: "notice", content: `Compaction failed: ${errorMessage(data.error)}`, level: "warning" }];
    }
    default:
      return [];
  }
}
