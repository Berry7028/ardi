// A tool as both pi's extension API and OpenCode's MCP server can register
// it: one definition, two adapters. `parameters` is a JSON Schema object
// (TypeBox produces one); pi and MCP both take it as is.
//
// `run` is the tool's whole behavior. `ctx.sessionId` is the agent session's
// id (pi's sessionManager id, or the OpenCode session id via ARDI_CHAT_ID) for
// tools that keep per-chat state such as Ardia's browse session.

export type ToolResult = {
  text?: string;
  // Structured result data the panel's tool card shows (a tab, a patch…).
  details?: unknown;
  // pi resizes this for its model's limits; OpenCode's MCP client gets it raw.
  image?: { data: string; mimeType: string };
};

export type ToolContext = {
  signal?: AbortSignal;
  sessionId?: string;
  // The schedule tools' channel to the extension (pi's UI dialog or the
  // bridge's HTTP endpoint), supplied by the adapter per call.
  scheduleAsk?: (request: unknown) => Promise<unknown>;
};

export type ToolDef = {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  annotations?: Record<string, unknown>;
  run(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
};

// A result's MCP content blocks (pi builds its own from ToolResult).
export function toolContent(result: ToolResult): ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] {
  const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
  if (result.text !== undefined) content.push({ type: "text", text: result.text });
  if (result.image) content.push({ type: "image", ...result.image });
  return content;
}
