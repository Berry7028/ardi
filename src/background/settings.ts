import type { PiCheck } from "../bridge/protocol";
import type { Settings } from "../panel-protocol";
import { askBridge } from "./ask-bridge";

// Ardi's settings, in chrome.storage.local. Owned here: the side panel asks
// for them and for changes, and pi-session reads them when it starts pi.

const DEFAULTS: Settings = { piPath: "", agent: "pi", opencodePath: "" };
const KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  const { [KEY]: stored } = await chrome.storage.local.get(KEY);
  return { ...DEFAULTS, ...(stored as Partial<Settings> | undefined) };
}

// Checks `piPath` and saves it only if pi runs from there. Clearing it (back
// to the installed pi) always saves, so a bad path can be undone.
export async function setPiPath(piPath: string): Promise<{ saved: boolean; check: PiCheck }> {
  const check = await checkPi(piPath);
  const saved = !check.error || !piPath;
  if (saved) await chrome.storage.local.set({ [KEY]: { ...(await loadSettings()), piPath } });
  return { saved, check };
}

// Checks `opencodePath` and saves it only if opencode runs from there.
// Clearing it (back to `opencode` on PATH) always saves.
export async function setOpenCodePath(opencodePath: string): Promise<{ saved: boolean; check: PiCheck }> {
  const check = await checkOpenCode(opencodePath);
  const saved = !check.error || !opencodePath;
  if (saved) await chrome.storage.local.set({ [KEY]: { ...(await loadSettings()), opencodePath } });
  return { saved, check };
}

// Saves the agent new chats run on.
export async function setAgent(agent: Settings["agent"]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: { ...(await loadSettings()), agent } });
}

// Asks a short-lived bridge to run `opencode --version`.
export function checkOpenCode(opencodePath: string): Promise<PiCheck> {
  return askBridge(
    { type: "check_opencode", opencodePath: opencodePath || undefined },
    (event) => {
      if (event.type !== "oc_check") return;
      const { type: _, ...check } = event;
      return check;
    },
    (error) => ({ command: opencodePath, error }),
  );
}

// Asks a short-lived bridge to run `pi --version`. It's separate from the
// bridge running pi, which may be down because of a bad path.
export function checkPi(piPath: string): Promise<PiCheck> {
  return askBridge(
    { type: "check_pi", piPath: piPath || undefined },
    (event) => {
      if (event.type !== "pi_check") return;
      const { type: _, ...check } = event;
      return check;
    },
    (error) => ({ command: piPath, error }),
  );
}
