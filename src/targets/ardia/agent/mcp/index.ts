// Ardia's tools as an MCP stdio server, spawned by OpenCode (`mcp` config
// type "local"). Reaches the extension through the bridge's schedule
// endpoint, via the ARDI_* env the bridge passes opencode's serve.

import { resolve } from "node:path";

import { serveMcp } from "../../../../agent/lib/mcp";
import { askScheduleHttp, scheduleTools } from "../../../../agent/lib/scheduleTools";
import { TOOLS } from "../browserTools";

serveMcp([...TOOLS(resolve(import.meta.dirname, "../references")), ...scheduleTools()], { sessionId: process.env.ARDI_CHAT_ID, name: "ardi-ardia", scheduleAsk: askScheduleHttp() });
