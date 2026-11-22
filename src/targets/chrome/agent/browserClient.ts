import { RELAY_TOKEN_ENV, RELAY_URL_ENV } from "../../../bridge/protocol";
import type { BrowserRequest } from "../protocol";

const STALE_EXTENSION = "Ardi's extension is older than its agent and can't do this yet. Ask the user to reload Ardi in chrome://extensions, then try again; don't look for another way.";

// The bridge's relay endpoint (ARDI_BROWSER_URL/TOKEN), set for whichever
// agent host spawned us — pi's extension loader or OpenCode's MCP server.
export async function request<T>(body: BrowserRequest, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const response = await fetch(process.env[RELAY_URL_ENV]!, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env[RELAY_TOKEN_ENV]}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(35_000), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) throw new Error(`Browser bridge returned HTTP ${response.status}`);
  const reply = await response.json() as { result?: T; error?: string };
  // The service worker answers this to an operation it lacks: the extension
  // wasn't reloaded after the tools were updated.
  if (reply.error === "Unknown browser operation") throw new Error(STALE_EXTENSION);
  if (reply.error) throw new Error(reply.error);
  return reply.result as T;
}
