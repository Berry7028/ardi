// Ardia tool entrypoint for pi. Browser commands always use the Ardia CLI's
// `ardia browse` (agent-browser's commands on the running Ardia).
// Bundled into dist/ardia/agent/extension/; pi provides its own extension dependencies.
// The tool definitions are shared with OpenCode's MCP server
// (../browserTools.ts); this adapts results (pi resizes images for its
// model's limits) and supplies each call's chat session id.

import { resolve } from "node:path";
import { resizeImage, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDate } from "../../../../agent/lib/date";
import { registerEnvironment } from "../../../../agent/lib/environment";
import { registerSchedule } from "../../../../agent/lib/schedule";
import { TOOLS } from "../browserTools";
import { BROWSER_GUIDE } from "./guide";

export default function (pi: ExtensionAPI) {
  registerDate(pi);
  registerEnvironment(pi);
  registerSchedule(pi);
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, browser: BROWSER_GUIDE };
  });

  for (const tool of TOOLS(resolve(import.meta.dirname, "../references"))) {
    pi.registerTool({
      name: tool.name,
      label: tool.label ?? tool.name,
      description: tool.description,
      parameters: tool.parameters as never,
      annotations: tool.annotations,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const result = await tool.run(params, { signal, sessionId: ctx?.sessionManager?.getSessionId() });
        const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
        if (result.text !== undefined) content.push({ type: "text", text: result.text });
        if (result.image) {
          const resized = await resizeImage(Buffer.from(result.image.data, "base64"), result.image.mimeType, ctx?.model?.inputLimits?.images?.resize);
          content.push({ type: "image", data: resized?.data ?? result.image.data, mimeType: resized?.mimeType ?? result.image.mimeType });
        }
        return { content, details: result.details };
      },
    });
  }
}
