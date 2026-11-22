// Per-tab panels (the Chrome target's `panelPerTab`): the toolbar icon opens
// a panel bound to that tab's own chat, tabs keep separate chats, a tab
// without one drops the panel, and a closed tab takes its chats with it.
// Driven through pi-session like pi-session.test.ts, with the module fresh
// per test.
import "../../support/indexeddb";

import { beforeEach, expect, test } from "bun:test";

import { chromeFake, FakePort } from "../../support/chrome";
import { waitFor } from "../../support/wait";
import type { PanelUpdate } from "../../../src/panel-protocol";
import * as store from "../../../src/background/store";
import { setTarget } from "../../../src/background/target";

type Background = typeof import("../../../src/background/pi-session");

let pi: Background;
let copies = 0;

const updates = (port: FakePort) => port.sent as PanelUpdate[];
const last = <K extends PanelUpdate["kind"]>(kind: K, port: FakePort) =>
  updates(port).findLast((u): u is Extract<PanelUpdate, { kind: K }> => u.kind === kind);

beforeEach(async () => {
  setTarget({ nativeHost: "com.ardi.test", panelPerTab: true });
  for (const chat of await store.listSessions()) await store.deleteSession(chat.id);
  pi = (await import(`../../../src/background/pi-session.ts?tabs=${copies++}`)) as Background;
});

// A panel connecting and binding to `tabId`'s window, as the side panel does.
async function attach(tabId: number, windowId = 1): Promise<FakePort> {
  chromeFake.tabs = [{ id: tabId, windowId, active: true }];
  const port = new FakePort("panel");
  await pi.attachPanel(port.port);
  await pi.bindPanel(port.port, windowId);
  return port;
}

test("the toolbar icon opens a per-tab panel, and installs switch off the shared panel behavior", async () => {
  const { startBackground } = await import(`../../../src/background/index.ts?w=${copies++}`);
  startBackground({ nativeHost: "com.ardi.test", panelPerTab: true });
  // An install that set openPanelOnActionClick keeps it; without this the
  // icon click never reaches onClicked.
  chromeFake.runtimeInstalled.emit();
  await waitFor(() => expect(chromeFake.sidePanelBehavior?.openPanelOnActionClick).toBe(false));

  chromeFake.actionClicked.emit({ id: 20, windowId: 1 });
  await waitFor(() => expect(chromeFake.sidePanelOpened).toContainEqual({ tabId: 20 }));
});

test("the toolbar icon enables and opens the panel on that tab only", async () => {
  await pi.openForTab(10);
  expect(await chrome.sidePanel.getOptions({ tabId: 10 })).toEqual({ path: "src/sidepanel/index.html", enabled: true });
  expect(chromeFake.sidePanelOpened).toEqual([{ tabId: 10 }]);
  // A tab it never opened for stays closed (no options set, Chrome hides it).
  expect(await chrome.sidePanel.getOptions({ tabId: 11 })).toEqual({});
});

test("a binding panel replays that tab's own draft, not another tab's chat", async () => {
  const first = await attach(10);
  await pi.prompt(first.port, "tab ten");
  await waitFor(async () => expect((await store.listSessions())).toHaveLength(1));
  const second = await attach(11);
  expect(last("replay", second)?.session).toMatchObject({ id: 0, title: "" });
  // The new tab's list holds only chats of its own tab (and shared ones).
  expect(last("sessions", second)?.sessions).toEqual([]);
  expect(last("sessions", first)?.sessions).toHaveLength(1);
});

test("activating another tab swaps the panel to that tab's chat; one without a chat drops the panel", async () => {
  const port = await attach(10);
  await pi.prompt(port.port, "tab ten");
  const [chat10] = await store.listSessions();
  const eleven = await store.addSession({ title: "eleven", createdAt: 1, updatedAt: 1, tabId: 11 });

  await pi.tabActivated(1, 11);
  expect(last("replay", port)?.session.id).toBe(eleven.id);

  await pi.tabActivated(1, 12);
  expect(await chrome.sidePanel.getOptions({ tabId: 12 })).toEqual({ enabled: false });

  // Back on a tab with a chat, the panel shows it again.
  await pi.tabActivated(1, 10);
  expect(last("replay", port)?.session.id).toBe(chat10.id);
});

test("a chat sent on one tab stays its tab's: it doesn't land on another tab's panel or list", async () => {
  const ten = await attach(10);
  const eleven = await attach(11);
  await pi.prompt(ten.port, "only here");
  const [chat] = await store.listSessions();
  expect(chat.tabId).toBe(10);
  expect(last("sessions", eleven)?.sessions ?? []).toEqual([]);
  expect(last("live", eleven)).toBeUndefined();
});

test("closing a tab deletes its chats and stops their pi", async () => {
  const port = await attach(10);
  await pi.prompt(port.port, "doomed");
  const [chat] = await store.listSessions();
  const bridge = chromeFake.nativePorts.at(-1)!;
  expect(bridge.disconnected).toBe(false);

  await pi.tabClosed(10);
  expect(await store.listSessions()).toEqual([]);
  expect(bridge.disconnected).toBe(true);
  expect(chat.id).not.toBe((last("sessions", port)?.sessions ?? []).find((s) => s.id === chat.id)?.id);
});

test("a restarted worker replays the chat the tab had open", async () => {
  const port = await attach(10);
  await pi.prompt(port.port, "mine");
  const [chat] = await store.listSessions();

  // The worker (and its in-memory state) is gone; storage survives.
  pi = (await import(`../../../src/background/pi-session.ts?tabs=${copies++}`)) as Background;
  const reopened = await attach(10);
  expect(last("replay", reopened)?.session.id).toBe(chat.id);
});

test("a check-back for a closed panel's chat runs on the same chat, not a duplicate", async () => {
  const port = await attach(10);
  await pi.prompt(port.port, "hello");
  const [chat] = await store.listSessions();
  const bridge = chromeFake.nativePorts.at(-1)!;
  port.close();

  await pi.runJob({ kind: "check_back", id: "cb", chatId: chat.id, note: "again", next: 0 });
  // The prompt went to the chat's own bridge; no second chat or bridge.
  expect(bridge.sent).toContainEqual(expect.objectContaining({ type: "prompt" }));
  expect(chromeFake.nativePorts).toHaveLength(1);
  const reopened = await attach(10);
  expect(last("replay", reopened)?.session.id).toBe(chat.id);
});

test("a repaired pi path revives the disconnected chat on screen", async () => {
  const port = await attach(10);
  await pi.prompt(port.port, "hello");
  const old = chromeFake.nativePorts.at(-1)!;
  old.close();
  await waitFor(() => expect(last("replay", port)?.status).toBe("disconnected"));

  await pi.restartAll();
  expect(chromeFake.nativePorts.length).toBeGreaterThan(1);
  expect(chromeFake.nativePorts.at(-1)!.disconnected).toBe(false);
});

test("a chat not bound to a tab (a scheduled run's) is listed on every panel and binds to the tab that opens it", async () => {
  const shared = await store.addSession({ title: "job run", createdAt: 1, updatedAt: 1 });
  const port = await attach(10);
  expect((last("sessions", port)?.sessions ?? []).map((s) => s.id)).toContain(shared.id);

  await pi.switchSession(port.port, shared.id);
  expect(last("replay", port)?.session.id).toBe(shared.id);
  expect((await store.getSession(shared.id))?.tabId).toBe(10);
});
