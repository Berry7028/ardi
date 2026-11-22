// Native messaging host: the browser starts a target's bridge entry (built to
// dist/<target>/bridge/main.js, via ~/.ardi/runtime/<target>/launch.sh (launch.cmd on Windows),
// written by the installer) when the extension connects, and closes our stdin
// when it disconnects. Runs on Node.

import { exitAfterFlush, onExtensionMessage, sendToExtension } from "./nativeMessaging";
import { checkPi, type PiTarget } from "./launch";
import { PiSession } from "./PiSession";
import { checkOpenCode } from "./opencode/ocLaunch";
import { OpenCodeSession, type OpenCodeTarget } from "./opencode/OpenCodeSession";
import { joinParts } from "../parts";
import type { TabMention } from "../mention";
import { RELAY_TOKEN_ENV, RELAY_URL_ENV, type BridgeEvent, type BridgeRequest, type BrowserReply } from "./protocol";

// A local endpoint pi's tools call to reach the extension (see protocol.ts).
export interface BrowserRelay {
  readonly url: string;
  readonly token: string;
  reply(reply: BrowserReply): void;
  dispose(): void;
}

export interface BridgeTarget extends PiTarget {
  relay?(send: (event: BridgeEvent) => void): Promise<BrowserRelay>;
  // The tabs the user may @ mention, when the browser shows the extension
  // more tabs than that; null when it can't tell.
  mentionableTabs?(): Promise<TabMention[] | null>;
  // What OpenCode needs for this target's tools (its bundled MCP server).
  opencode?: OpenCodeTarget;
}

// A session as either agent implements it.
type AgentSession = Pick<
  PiSession,
  "received" | "prompt" | "queueAction" | "abort" | "compact" | "setModel" | "setThinkingLevel" | "scheduleReply" | "shutdown"
>;

// Stdin is read only once the relay listens, so pi always gets its address.
export async function runBridge(target: BridgeTarget): Promise<void> {
  const relay = await target.relay?.(sendToExtension);
  // pi reaches the extension only through this host's own relay, never one
  // it inherited.
  delete process.env[RELAY_URL_ENV];
  delete process.env[RELAY_TOKEN_ENV];
  if (relay) {
    process.env[RELAY_URL_ENV] = relay.url;
    process.env[RELAY_TOKEN_ENV] = relay.token;
  }
  // The agent a `start` names (pi by default) decides which session runs:
  // a chat never switches agent once started.
  let session: AgentSession | undefined;
  let received = 0;

  onExtensionMessage(
    joinParts<BridgeRequest>((request) => {
      // Replies answer the agent, not the user: they aren't counted as requests.
      if (request.type !== "browser_reply" && request.type !== "schedule_reply") {
        received++;
        session?.received();
      }
      switch (request.type) {
        case "browser_reply":
          return relay?.reply(request);
        case "schedule_reply":
          return session?.scheduleReply(request);
        case "start": {
          if (request.agent === "opencode") {
            if (!target.opencode) return sendToExtension({ type: "fatal", message: "This build doesn't support OpenCode." });
            const oc = new OpenCodeSession(target.opencode, sendToExtension, exitAfterFlush);
            session = oc;
            for (let i = 0; i < received; i++) oc.received();
            return oc.start(request.ocSessionId, request.opencodePath);
          }
          const pi = new PiSession(target, sendToExtension, exitAfterFlush);
          session = pi;
          for (let i = 0; i < received; i++) pi.received();
          return pi.start(request.sessionFile, request.piPath);
        }
        case "check_pi":
          return void checkPi(request.piPath).then((check) => sendToExtension({ type: "pi_check", ...check }));
        case "check_opencode":
          return void checkOpenCode(request.opencodePath).then((check) => sendToExtension({ type: "oc_check", ...check }));
        case "list_tabs":
          return void (target.mentionableTabs?.() ?? Promise.resolve(null)).then((tabs) => sendToExtension({ type: "tabs", tabs }));
        case "prompt":
          return void session?.prompt(request.text, { promptId: request.promptId, images: request.images, steer: request.steer });
        case "queue_action":
          return void session?.queueAction(request);
        case "abort":
          return void session?.abort();
        case "compact":
          return void session?.compact();
        case "set_model":
          return void session?.setModel(request.provider, request.modelId);
        case "set_thinking_level":
          return void session?.setThinkingLevel(request.level);
      }
    }),
    () => {
      relay?.dispose();
      void (session?.shutdown() ?? Promise.resolve()).finally(() => exitAfterFlush(0));
    },
  );
}
