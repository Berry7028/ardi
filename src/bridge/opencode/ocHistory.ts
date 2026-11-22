// A saved opencode session (GET /api/session/{id}/message's {data: [...]}) as
// chat history, the same shape piHistory produces: consecutive assistant
// entries merge into one run; tool content maps onto ToolCall.

import type { AssistantBlock, ChatMessage, ImageAttachment, ToolCall } from "../../chat";

export type OcContent = Record<string, unknown> & { type?: string; id?: string };
export type OcHistoryEntry = Record<string, unknown> & { id?: string; type?: string };

const asString = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");

const textOf = (content: OcContent): string => (typeof content.text === "string" ? content.text : "");

// A user's file attachment whose uri is a data URL becomes an image.
function imageOf(file: Record<string, unknown>): ImageAttachment | undefined {
  const uri = typeof file.uri === "string" ? file.uri : "";
  const match = /^data:(.*?);base64,(.*)$/s.exec(uri);
  if (!match || !match[1].startsWith("image/")) return undefined;
  return { data: match[2], mimeType: match[1] };
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((part) => asString((part as { text?: string; uri?: string }).text ?? (part as { uri?: string }).uri)).filter(Boolean).join("\n");
}

function toolCall(content: OcContent): ToolCall | undefined {
  const state = content.state as { status?: string; input?: Record<string, unknown>; content?: unknown; error?: { message?: string }; metadata?: unknown } | undefined;
  const status = state?.status === "completed" ? "completed" : state?.status === "error" ? "error" : "running";
  return {
    id: asString(content.id),
    name: asString(content.name) || "tool",
    input: state?.input ?? {},
    status,
    result: status === "error" ? ((state?.error as { message?: string } | undefined)?.message ?? "Tool failed") : contentText(state?.content),
    details: state?.metadata,
  };
}

const at = (entry: OcHistoryEntry): number => (entry.time as { created?: number } | undefined)?.created ?? 0;
const completedAt = (entry: OcHistoryEntry): number | undefined => (entry.time as { completed?: number } | undefined)?.completed;

export function readOcHistory(entries: OcHistoryEntry[]): ChatMessage[] {
  const sorted = [...entries].sort((a, b) => at(a) - at(b));
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

  for (const entry of sorted) {
    if (entry.type === "user") {
      flush();
      const text = asString(entry.text);
      const images = ((entry.files as Record<string, unknown>[] | undefined) ?? []).map(imageOf).filter((i): i is ImageAttachment => !!i);
      if (text || images.length) {
        messages.push({ role: "user", id: asString(entry.id), content: text, images: images.length ? images : undefined, timestamp: at(entry) });
      }
      continue;
    }
    if (entry.type === "compaction") {
      flush();
      messages.push({ role: "notice", id: asString(entry.id), content: "Context compacted", level: "info", timestamp: at(entry) });
      continue;
    }
    if (entry.type === "idle") {
      if (run && entry.outcome === "interrupted") run.interrupted = true;
      continue;
    }
    if (entry.type !== "assistant") {
      flush();
      continue;
    }
    const content = (entry.content as OcContent[] | undefined) ?? [];
    if (!run) {
      const previous = messages[messages.length - 1];
      const from = previous?.role === "user" ? previous.timestamp : at(entry);
      run = { id: asString(entry.id), blocks: [], toolCalls: [], from, timestamp: at(entry), outputTokens: 0, interrupted: false };
    }
    for (const part of content) {
      switch (part.type) {
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
    run.outputTokens += ((entry.tokens as { output?: number } | undefined)?.output ?? 0);
    run.completedAt = completedAt(entry) ?? run.completedAt;
  }
  flush();
  return messages;
}
