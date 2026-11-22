// opencode's server events as chat chunks. Adapted in spirit from
// normalization/piEventNormalization.ts: a run is one busy..idle period
// (one user prompt through its whole tool loop); text and reasoning parts
// stream by suffix-diff; a tool part's state transitions become
// tool_use/tool_result. A user message becomes a `user` chunk when its text
// part arrives (after its message's role is known); its file parts that are
// images become the chunk's attachments.

import type { ChatChunk, ImageAttachment } from "../../chat";
import type { OcEvent } from "./ocClient";

type PartState = {
  messageID: string;
  type: string;
  // Accumulating text of a text/reasoning part, for suffix diffs.
  text: string;
  // A tool part whose tool_use chunk went out already.
  announced?: boolean;
  // A text/reasoning part held back until its message's role was known.
  withheld?: boolean;
};

export type OcNormState = {
  // Whether a run's run_start went out; the next idle ends it.
  running: boolean;
  // The user stopped the run (MessageAbortedError seen).
  interrupted: boolean;
  // messageID -> role, from message.updated.
  roles: Map<string, string>;
  // messageIDs already shown as `user` chunks.
  userShown: Set<string>;
  // User text that arrived before its message's role was known.
  pendingUserText: Map<string, string>;
  // User image parts collected for the `user` chunk, per message.
  userFiles: Map<string, ImageAttachment[]>;
  parts: Map<string, PartState>;
};

export function createOcNormState(): OcNormState {
  return { running: false, interrupted: false, roles: new Map(), userShown: new Set(), pendingUserText: new Map(), userFiles: new Map(), parts: new Map() };
}

const textOf = (part: Record<string, unknown>) => (typeof part.text === "string" ? part.text : "");

// New tail of `next` after `seen` (part.updated can resend the whole text).
function suffix(seen: string, next: string): string {
  if (!next) return "";
  if (next.startsWith(seen)) return next.slice(seen.length);
  return next;
}

function imageOf(part: Record<string, unknown>): ImageAttachment | undefined {
  const url = typeof part.url === "string" ? part.url : "";
  const mime = typeof part.mime === "string" ? part.mime : "";
  const data = /^data:.*?;base64,(.*)$/s.exec(url)?.[1];
  return mime.startsWith("image/") && data ? { data, mimeType: mime } : undefined;
}

export function normalizeOcEvent(event: OcEvent, state: OcNormState): ChatChunk[] {
  const p = event.properties;
  switch (event.type) {
    case "session.status": {
      const status = (p.status as { type?: string } | undefined)?.type;
      if (status === "busy" && !state.running) {
        state.running = true;
        return [{ type: "run_start", at: Date.now() }];
      }
      if (status === "retry") {
        const retry = p.status as { attempt?: number; message?: string };
        return [{ type: "notice", content: `Retrying${retry.attempt ? ` (attempt ${retry.attempt})` : ""}${retry.message ? `: ${retry.message}` : ""}`, level: "warning" }];
      }
      return [];
    }
    case "session.idle": {
      if (!state.running) return [];
      state.running = false;
      const interrupted = state.interrupted;
      state.interrupted = false;
      return [{ type: "run_end", at: Date.now(), ...(interrupted ? { interrupted } : {}) }];
    }
    case "session.error": {
      const error = p.error as { name?: string; data?: { message?: string } } | undefined;
      if (error?.name === "MessageAbortedError") {
        // The user stopped it; the coming idle marks the run interrupted.
        state.interrupted = true;
        return [];
      }
      const message = error?.data?.message || error?.name || "Unknown error";
      return [{ type: "notice", content: message, level: "error" }];
    }
    case "session.compacted": {
      return [{ type: "notice", content: "Context compacted", level: "info" }];
    }
    case "message.updated": {
      const info = p.info as { id?: string; role?: string } | undefined;
      if (!info?.id || !info.role) return [];
      const wasKnown = state.roles.has(info.id);
      state.roles.set(info.id, info.role);
      if (info.role === "user") {
        if (wasKnown || state.userShown.has(info.id)) return [];
        const text = state.pendingUserText.get(info.id);
        if (text === undefined) return [];
        state.pendingUserText.delete(info.id);
        state.userShown.add(info.id);
        const images = state.userFiles.get(info.id);
        state.userFiles.delete(info.id);
        return [{ type: "user", text, at: Date.now(), ...(images?.length ? { images } : {}) }];
      }
      // Assistant: flush parts withheld until the role was known.
      const chunks: ChatChunk[] = [];
      for (const part of state.parts.values()) {
        if (part.messageID !== info.id || !part.withheld || !part.text) continue;
        part.withheld = false;
        chunks.push({ type: part.type === "reasoning" ? "thinking" : "text", content: part.text });
      }
      return chunks;
    }
    case "message.part.updated": {
      const part = p.part as Record<string, unknown> | undefined;
      if (!part?.id || !part.messageID) return [];
      return partChunks(part, state);
    }
    default:
      return [];
  }
}

function partChunks(part: Record<string, unknown>, state: OcNormState): ChatChunk[] {
  const partID = part.id as string;
  const messageID = part.messageID as string;
  const type = part.type as string;
  const role = state.roles.get(messageID);

  if (role === "user") {
    if (type === "file") {
      const image = imageOf(part);
      if (!image) return [];
      if (!state.userShown.has(messageID)) {
        state.userFiles.set(messageID, [...(state.userFiles.get(messageID) ?? []), image]);
        return [];
      }
      // The text went out already; the image gets a bubble of its own.
      return [{ type: "user", text: "", at: Date.now(), images: [image] }];
    }
    if (type === "text") {
      if (state.userShown.has(messageID)) return [];
      state.userShown.add(messageID);
      const images = state.userFiles.get(messageID);
      state.userFiles.delete(messageID);
      return [{ type: "user", text: textOf(part), at: Date.now(), ...(images?.length ? { images } : {}) }];
    }
    return [];
  }

  if (type === "text" && !role) {
    // A part before its message: remember it for when the role arrives.
    state.pendingUserText.set(messageID, textOf(part));
  }

  const known = state.parts.get(partID) ?? { messageID, type, text: "", withheld: !role && (type === "text" || type === "reasoning") };
  state.parts.set(partID, known);

  switch (type) {
    case "text":
    case "reasoning": {
      const delta = suffix(known.text, textOf(part));
      known.text = textOf(part) || known.text;
      if (known.withheld || !delta) return [];
      return [{ type: type === "reasoning" ? "thinking" : "text", content: delta }];
    }
    case "tool": {
      const status = (part.state as { status?: string } | undefined)?.status;
      const toolState = part.state as { input?: Record<string, unknown>; output?: string; error?: string; metadata?: unknown } | undefined;
      if (!known.announced && status !== undefined && status !== "pending") {
        known.announced = true;
        return [{ type: "tool_use", id: part.callID as string, name: part.tool as string, input: toolState?.input ?? {} }];
      }
      if (status === "completed") {
        return [{ type: "tool_result", id: part.callID as string, content: toolState?.output ?? "", isError: false, details: toolState?.metadata }];
      }
      if (status === "error") {
        return [{ type: "tool_result", id: part.callID as string, content: toolState?.error ?? "Tool failed", isError: true, details: toolState?.metadata }];
      }
      return [];
    }
    case "step-finish": {
      const tokens = (part.tokens as { output?: number } | undefined)?.output;
      return tokens ? [{ type: "usage", outputTokens: tokens }] : [];
    }
    case "retry": {
      const error = part.error as { message?: string } | undefined;
      const attempt = typeof part.attempt === "number" ? ` (attempt ${part.attempt})` : "";
      return [{ type: "notice", content: `Retrying${attempt}${error?.message ? `: ${error.message}` : ""}`, level: "warning" }];
    }
    case "compaction": {
      const auto = part.auto === true;
      const overflow = part.overflow === true;
      return [{ type: "notice", content: `Context compacted${overflow ? " (overflow)" : auto ? " (auto)" : ""}`, level: "info" }];
    }
    default:
      return [];
  }
}
