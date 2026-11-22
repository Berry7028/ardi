// A saved opencode session (GET /session/{id}/message's [{info, parts}]) as
// chat history, the same shape piHistory produces: consecutive assistant
// entries merge into one run; tool parts map onto ToolCall.

import type { AssistantBlock, ChatMessage, ImageAttachment, ToolCall } from "../../chat";

export type OcPart = Record<string, unknown> & { id?: string; type?: string; messageID?: string };
export type OcHistoryEntry = { info: Record<string, unknown>; parts: OcPart[] };

function textOf(part: OcPart): string {
  return typeof part.text === "string" ? part.text : "";
}

function imageOf(part: OcPart): ImageAttachment | undefined {
  const url = typeof part.url === "string" ? part.url : "";
  const mime = typeof part.mime === "string" ? part.mime : "";
  const data = /^data:.*?;base64,(.*)$/s.exec(url)?.[1];
  return mime.startsWith("image/") && data ? { data, mimeType: mime } : undefined;
}

const asString = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");

function toolCall(part: OcPart): ToolCall | undefined {
  const state = part.state as { status?: string; input?: Record<string, unknown>; output?: string; error?: string; metadata?: unknown } | undefined;
  const status = state?.status === "completed" ? "completed" : state?.status === "error" ? "error" : "running";
  return {
    id: asString(part.callID) || asString(part.id),
    name: asString(part.tool) || "tool",
    input: state?.input ?? {},
    status,
    result: status === "error" ? (state?.error ?? "Tool failed") : state?.output,
    details: state?.metadata,
  };
}

const at = (info: Record<string, unknown>): number => (info.time as { created?: number } | undefined)?.created ?? 0;
const completedAt = (info: Record<string, unknown>): number | undefined => (info.time as { completed?: number } | undefined)?.completed;
const aborted = (info: Record<string, unknown>): boolean => (info.error as { name?: string } | undefined)?.name === "MessageAbortedError";

export function readOcHistory(entries: OcHistoryEntry[]): ChatMessage[] {
  const sorted = [...entries].sort((a, b) => at(a.info) - at(b.info));
  const messages: ChatMessage[] = [];
  // The assistant run being accumulated; flushed at the next non-assistant entry.
  let run: { id: string; blocks: AssistantBlock[]; toolCalls: ToolCall[]; from: number; timestamp: number; completedAt?: number; outputTokens: number; interrupted: boolean } | undefined;

  const flush = () => {
    if (!run) return;
    const done = run.completedAt;
    messages.push({
      role: "assistant",
      id: run.id,
      blocks: run.blocks,
      toolCalls: run.toolCalls,
      timestamp: run.timestamp,
      completedAt: done,
      durationMs: done ? done - run.from : undefined,
      outputTokens: run.outputTokens || undefined,
      interrupted: run.interrupted || undefined,
    });
    run = undefined;
  };

  for (const { info, parts } of sorted) {
    const role = info.role as string | undefined;
    if (role === "user") {
      flush();
      const text = parts.filter((p) => p.type === "text").map(textOf).join("");
      const images = parts.map(imageOf).filter((i): i is ImageAttachment => !!i);
      if (text || images.length) {
        messages.push({ role: "user", id: String(info.id), content: text, images: images.length ? images : undefined, timestamp: at(info) });
      }
      continue;
    }
    if (role !== "assistant") {
      flush();
      continue;
    }
    for (const part of parts) {
      if (part.type === "compaction") {
        flush();
        messages.push({ role: "notice", id: String(part.id ?? info.id), content: "Context compacted", level: "info", timestamp: at(info) });
        continue;
      }
      if (!run) {
        const previous = messages[messages.length - 1];
        const from = previous?.role === "user" ? previous.timestamp : at(info);
        run = { id: String(info.id), blocks: [], toolCalls: [], from, timestamp: at(info), outputTokens: 0, interrupted: false };
      }
      switch (part.type) {
        case undefined:
          break;
        case "text":
          if (textOf(part)) run.blocks.push({ type: "text", content: textOf(part) });
          break;
        case "reasoning":
          if (textOf(part)) run.blocks.push({ type: "thinking", content: textOf(part) });
          break;
        case "tool": {
          const call = toolCall(part);
          if (call) {
            run.blocks.push({ type: "tool_use", toolId: call.id });
            run.toolCalls.push(call);
          }
          break;
        }
        default:
          break;
      }
    }
    if (run) {
      run.outputTokens += ((info.tokens as { output?: number } | undefined)?.output ?? 0);
      run.completedAt = completedAt(info) ?? run.completedAt;
      run.interrupted ||= aborted(info);
    }
  }
  flush();
  return messages;
}
