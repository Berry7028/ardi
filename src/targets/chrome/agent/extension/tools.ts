// Chrome's tools on pi's extension API. The tool definitions are shared with
// OpenCode's MCP server (../browserTools.ts); this only adapts the result:
// pi resizes images for its model's limits.

import { resizeImage, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOOLS } from "../browserTools";
import type { ToolResult } from "../../../../agent/lib/toolDef";

export default function registerChromeTools(pi: ExtensionAPI) {
  for (const tool of TOOLS) {
    pi.registerTool({
      name: tool.name,
      label: tool.label ?? tool.name,
      description: tool.description,
      parameters: tool.parameters as never,
      annotations: tool.annotations,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const result = await tool.run(params, { signal });
        return piResult(result, ctx?.model?.inputLimits?.images?.resize);
      },
    });
  }
}

async function piResult(result: ToolResult, limits: Parameters<typeof resizeImage>[2]) {
  const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
  if (result.text !== undefined) content.push({ type: "text", text: result.text });
  if (result.image) {
    const resized = await resizeImage(Buffer.from(result.image.data, "base64"), result.image.mimeType, limits);
    content.push({ type: "image", data: resized?.data ?? result.image.data, mimeType: resized?.mimeType ?? result.image.mimeType });
  }
  return { content, details: result.details };
}
