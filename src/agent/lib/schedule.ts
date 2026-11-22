import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SCHEDULE_DIALOG } from "../../bridge/protocol";
import type { ScheduleRequest } from "../../schedule";
import { scheduleTools } from "./scheduleTools";
import { text } from "./page";

// Two tools on one mechanism: check_back follows up in this chat; schedule_job
// sets up automation that runs in new chats. Both ask Ardi's background
// through the bridge (see SCHEDULE_DIALOG). The tool definitions are shared
// with OpenCode's MCP server; only `ask` is pi's own.

async function ask(ctx: ExtensionContext, request: ScheduleRequest): Promise<unknown> {
  const answer = await ctx.ui.editor(SCHEDULE_DIALOG, JSON.stringify(request));
  if (answer === undefined) throw new Error("Scheduling isn't available here");
  const reply = JSON.parse(answer) as { result?: unknown; error?: string };
  if (reply.error) throw new Error(reply.error);
  return reply.result;
}

export function registerSchedule(pi: ExtensionAPI) {
  for (const tool of scheduleTools()) {
    pi.registerTool({
      name: tool.name,
      label: tool.label ?? tool.name,
      description: tool.description,
      parameters: tool.parameters as never,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const result = await tool.run(params, { signal, scheduleAsk: (request) => ask(ctx, request as ScheduleRequest) });
        return text(result.text ?? "", result.details);
      },
    });
  }
}
