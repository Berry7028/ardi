// A minimal MCP stdio server, newline-delimited JSON-RPC, for the tools
// OpenCode calls. OpenCode spawns this as a `local` MCP server and inherits
// the bridge's environment, which carries the ARDI_* endpoints the tools
// reach the extension through.

import { toolContent, type ToolDef } from "./toolDef";

type Json = Record<string, unknown>;

function write(message: Json): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export function serveMcp(tools: ToolDef[], options: { sessionId?: string; name?: string; scheduleAsk?: (request: unknown) => Promise<unknown> } = {}): void {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const reply = (id: unknown, result: unknown) => write({ jsonrpc: "2.0", id, result });
  const fail = (id: unknown, code: number, message: string) => write({ jsonrpc: "2.0", id, error: { code, message } });

  async function handle(message: Json): Promise<void> {
    const { id, method, params } = message as { id?: unknown; method?: string; params?: Json };
    if (method === "initialize") {
      return reply(id, {
        protocolVersion: (params?.protocolVersion as string | undefined) ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: options.name ?? "ardi-tools", version: "1.0.0" },
      });
    }
    if (method === "ping") return reply(id, {});
    if (method === "tools/list") {
      return reply(id, { tools: tools.map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters })) });
    }
    if (method === "tools/call") {
      const name = params?.name as string | undefined;
      const tool = name && byName.get(name);
      if (!tool) return fail(id, -32602, `Unknown tool ${name}`);
      try {
        const result = await tool.run((params?.arguments as Record<string, unknown> | undefined) ?? {}, { sessionId: options.sessionId, scheduleAsk: options.scheduleAsk });
        return reply(id, { content: toolContent(result) });
      } catch (error) {
        return reply(id, { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] });
      }
    }
    // Notifications (initialized, cancelled) have no id and no answer.
    if (id !== undefined) fail(id, -32601, `Unknown method ${method}`);
  }

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      try {
        void handle(JSON.parse(line) as Json);
      } catch {
        // Not JSON: not ours.
      }
    }
  });
}
