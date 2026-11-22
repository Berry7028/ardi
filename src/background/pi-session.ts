import type { ChatChunk, ChatMessage, ImageAttachment, ModelState, PiCommand, QueueAction, QueuedMessage, ThinkingLevel } from "../chat";
import type { BridgeEvent, BridgeRequest } from "../bridge/protocol";
import { plainMentions } from "../mention";
import { restoreOf } from "../restore";
import { joinParts, postInParts } from "../parts";
import type { PanelUpdate, PiStatus, SessionMeta } from "../panel-protocol";
import { runMessage, type Scheduled } from "../schedule";
import * as schedules from "./schedules";
import { loadSettings } from "./settings";
import * as store from "./store";
import { target, type BrowserLink } from "./target";

// Owns the chats and their bridge connections. Each chat with pi running has
// its own bridge (its own pi process, on that chat's session for life), so a
// chat the user leaves while pi works keeps going in the background. Lives in
// the service worker, so it keeps running when the side panel is closed. An
// open native port keeps the service worker alive (Chrome 105+).
//
// pi's session file is the record of the conversation: on start the bridge
// returns its history, and `live` holds what happened since. Only the chat
// list is stored here (IndexedDB).
//
// A chat belongs to a browser tab: the Chrome build opens a side panel per
// tab, each showing that tab's chat (`bound` maps tab id to its chat).
// Targets without per-tab panels share one chat across every panel, keyed
// under GLOBAL. Chats with no `tabId` (scheduled runs, chats from before
// per-tab panels) appear in every panel's list and bind to the tab that
// opens them.
const TITLE_LEN = 60;

// Messages sent to a bridge that pi hasn't answered yet, with the browser
// permission callback of the run they may start. If that bridge goes away
// first, they go back to the message box: the chat never showed them.
type Unanswered = Map<string, { text: string; images?: ImageAttachment[]; accept?: () => void }>;

// A chat's bridge connection, one phase at a time:
// - down: no bridge.
// - starting: settings are being read before the bridge opens; `started`
//   settles once it's open with `start` sent (or the start was given up).
// - connecting/connected: a port, until and after the bridge reports pi
//   ready, with the target's browser link for it, what it hasn't answered,
//   and what its pi is doing: a run (for the chat list) and its queue.
//   `sent` counts requests posted on it; the bridge's latest `busy` report
//   gives `acked` (how many it had received) and `reportedBusy`. It has
//   work while it reports busy or hasn't yet reported on everything sent.
type Live = {
  state: "connecting" | "connected";
  port: chrome.runtime.Port;
  browser: BrowserLink | null;
  unanswered: Unanswered;
  running: boolean;
  queue: QueuedMessage[];
  sent: number;
  acked: number;
  reportedBusy: boolean;
};
type Connection = { state: "down" } | { state: "starting"; started: Promise<void> } | Live;

// Text and images for the message box.
type Returned = { text: string; images?: ImageAttachment[] }[];

// A chat and what its pi reported: the stored chat, pi's history for it
// (null while it loads), and what pi sent since.
type Chat = {
  meta: SessionMeta;
  history: ChatMessage[] | null;
  live: ChatChunk[];
  model: ModelState;
  commands: PiCommand[];
  connection: Connection;
};

// The key under which targets without per-tab panels keep their one chat.
const GLOBAL = -1;
// The chat each panel shows, by its port.
const screens = new Map<chrome.runtime.Port, Chat>();
// The tab a panel's port belongs to: GLOBAL on targets without per-tab panels.
const portTab = new Map<chrome.runtime.Port, number>();
// The window a panel's port lives in, on per-tab targets only.
const portWindow = new Map<chrome.runtime.Port, number>();
// Tab id -> the chat its panel shows (GLOBAL for the shared chat). Keeps the
// chat while its panel is closed so switching back to the tab replays it.
const bound = new Map<number, Chat>();
// Chats off screen that pi still works on. Leaving an idle chat stops its pi;
// a chat that finishes off screen stops it then.
const away = new Set<Chat>();

// Text for a chat's message box that no panel showing that chat could take
// (none open, or the chat is off screen), by chat id, until one can. In
// chrome.storage.local: Chrome may stop the worker meanwhile.
const HELD = "held";
type Held = Record<string, Returned>;
// The last model and commands pi reported, shown for a chat until its own pi
// is up.
let lastModel: ModelState = { models: [] };
let lastCommands: PiCommand[] = [];
const panels = new Set<chrome.runtime.Port>();

// A new chat lives only in memory until its first message; then it's stored
// and joins the chat list. Drafts have id 0 (IndexedDB ids start at 1).
const DRAFT_ID = 0;

function draft(tabId?: number): SessionMeta {
  const now = Date.now();
  return { id: DRAFT_ID, title: "", createdAt: now, updatedAt: now, ...(tabId !== undefined && tabId !== GLOBAL ? { tabId } : {}) };
}

function isDraft(meta: SessionMeta): boolean {
  return meta.id === DRAFT_ID;
}

function opened(meta: SessionMeta): Chat {
  return {
    meta, history: isDraft(meta) ? [] : null, live: [], model: lastModel, commands: lastCommands, connection: { state: "down" },
  };
}

// The chat on screen for shared panels, in chrome.storage.local, so a
// restarted worker comes back to it. Per tab the same lives in CURRENT_TABS.
const CURRENT_CHAT = "currentChat";
// Per tab, which of its chats is open, so a restarted worker replays it.
const CURRENT_TABS = "currentTabs";

// The chat a tab already has: bound, the one it had open before a worker
// restart, or its latest stored one; undefined when it never had one.
async function lookupTab(tabId: number): Promise<Chat | undefined> {
  const existing = bound.get(tabId);
  if (existing) return existing;
  const { [CURRENT_TABS]: currents = {} } = await chrome.storage.local.get(CURRENT_TABS);
  const id = (currents as Record<string, number>)[tabId];
  const saved = typeof id === "number" && id !== DRAFT_ID ? await store.getSession(id) : undefined;
  const meta = id === DRAFT_ID ? draft(tabId) : saved ?? (await store.listSessions()).find((s) => s.tabId === tabId);
  if (!meta) return undefined;
  const chat = opened(meta);
  bindTab(tabId, chat);
  return chat;
}

// A tab's chat: the one it has, else a fresh draft bound to it.
async function chatForTab(tabId: number): Promise<Chat> {
  const existing = await lookupTab(tabId);
  if (existing) return existing;
  const chat = opened(draft(tabId));
  bindTab(tabId, chat);
  return chat;
}

function bindTab(tabId: number, c: Chat) {
  bound.set(tabId, c);
  void (async () => {
    const { [CURRENT_TABS]: currents = {} } = await chrome.storage.local.get(CURRENT_TABS);
    await chrome.storage.local.set({ [CURRENT_TABS]: { ...(currents as Record<string, number>), [tabId]: c.meta.id } });
  })();
}

const ready: Promise<void> = (async () => {
  const { [CURRENT_CHAT]: id } = await chrome.storage.local.get(CURRENT_CHAT);
  const saved = typeof id === "number" && id !== DRAFT_ID ? await store.getSession(id) : undefined;
  bound.set(GLOBAL, opened(id === DRAFT_ID ? draft() : (saved ?? (await store.listSessions())[0] ?? draft())));
})();

// Keeps chat `c`, under new metadata (it was stored, or got its file).
function setMeta(c: Chat, meta: SessionMeta) {
  c.meta = meta;
  for (const [t, shown] of bound) {
    if (shown !== c) continue;
    if (t === GLOBAL) void chrome.storage.local.set({ [CURRENT_CHAT]: meta.id });
    else void (async () => {
      const { [CURRENT_TABS]: currents = {} } = await chrome.storage.local.get(CURRENT_TABS);
      await chrome.storage.local.set({ [CURRENT_TABS]: { ...(currents as Record<string, number>), [t]: meta.id } });
    })();
  }
}

// `c`'s bridge while it's open.
function live(c: Chat): Live | undefined {
  const conn = c.connection;
  return conn.state === "connecting" || conn.state === "connected" ? conn : undefined;
}

function status(c: Chat): PiStatus {
  const { state } = c.connection;
  return state === "down" ? "disconnected" : state === "starting" ? "connecting" : state;
}

function setConnection(c: Chat, next: Connection) {
  c.connection = next;
  toScreen(c, { kind: "status", status: status(c) });
}

// Whether any panel shows `c`.
function onScreen(c: Chat): boolean {
  for (const shown of screens.values()) if (shown === c) return true;
  return false;
}

// Shown only while `c` is on a panel's screen; a chat off screen is replayed
// when a panel comes back to it.
function toScreen(c: Chat, update: PanelUpdate) {
  for (const [p, shown] of screens) if (shown === c) postInParts(p, update);
}

async function sessionsUpdateFor(tabId: number): Promise<PanelUpdate> {
  const all = await store.listSessions();
  const sessions = tabId === GLOBAL ? all : all.filter((s) => s.tabId === tabId || s.tabId === undefined);
  const ids = new Set(sessions.map((s) => s.id));
  const chats = new Set([...bound.values(), ...away]);
  const running = [...chats].filter((c) => live(c)?.running && !isDraft(c.meta) && ids.has(c.meta.id)).map((c) => c.meta.id);
  return { kind: "sessions", sessions, currentId: bound.get(tabId)?.meta.id ?? DRAFT_ID, running };
}

async function broadcastSessions() {
  for (const p of panels) {
    const update = await sessionsUpdateFor(portTab.get(p) ?? GLOBAL);
    // The panel may have closed while its update was read.
    if (!panels.has(p)) continue;
    try {
      postInParts(p, update);
    } catch {
      // Posting to a port that just went away.
    }
  }
}

function pushLive(c: Chat, chunk: ChatChunk) {
  c.live.push(chunk);
  toScreen(c, { kind: "live", chunk });
}

function replay(c: Chat): PanelUpdate {
  return { kind: "replay", status: status(c), session: c.meta, history: c.history, live: c.live, queue: live(c)?.queue ?? [], model: c.model, commands: c.commands };
}

// `c`'s bridge has work left. Only the bridge knows what it has in hand (a
// run, a queue, input on its way to pi, a compaction), so nothing here
// guesses from pi's events; what it hasn't reported on yet counts as work.
function busy(c: Chat): boolean {
  const conn = live(c);
  return !!conn && (conn.reportedBusy || conn.acked < conn.sent);
}

// A chat off screen that pi is done with stops its pi and is dropped.
function settle(c: Chat) {
  if (onScreen(c) || busy(c)) return;
  stop(c);
  away.delete(c);
}

// Shuts `c`'s bridge down, dropping what it hasn't answered.
function stop(c: Chat) {
  void closeConnection(c, "drop");
}

// Takes `c`'s bridge down: nothing runs or waits any more, what it hasn't
// answered goes back to the message box or is dropped, and its browser link
// is disposed (the returned promise).
function closeConnection(c: Chat, unanswered: "hand back" | "drop"): Promise<void> {
  const old = live(c);
  setConnection(c, { state: "down" });
  if (!old) return Promise.resolve();
  if (old.running) void broadcastSessions();
  if (unanswered === "hand back") giveBack(c, [...old.unanswered.values()]);
  old.unanswered.clear();
  const disposed = old.browser?.dispose() ?? Promise.resolve();
  old.port.disconnect();
  return disposed;
}

// To the message box of the panels showing `c`; else held for `c` until a
// panel shows it.
let holding: Promise<void> = Promise.resolve();
function giveBack(c: Chat, messages: Returned) {
  if (!messages.length) return;
  const restore = restoreOf(messages);
  if (onScreen(c) && restore) return toScreen(c, { kind: "restore", ...restore });
  const id = c.meta.id;
  holding = holding.then(async () => {
    const { [HELD]: held = {} } = await chrome.storage.local.get(HELD);
    const all = held as Held;
    await chrome.storage.local.set({ [HELD]: { ...all, [id]: [...(all[id] ?? []), ...messages] } });
  });
}

// Hands what's held for each panel's chat to that panel (or `to` only). It's
// handed over before it's cleared from storage, while that chat is known to
// be on screen, and stays held if no panel took it.
function handOver(to?: chrome.runtime.Port): Promise<void> {
  holding = holding
    .then(async () => {
      const { [HELD]: held = {} } = await chrome.storage.local.get(HELD);
      const all = { ...(held as Held) };
      const ports = to ? [to].filter((p) => panels.has(p)) : [...panels];
      for (const p of ports) {
        const c = screens.get(p);
        const mine = c && all[c.meta.id];
        const restore = mine && restoreOf(mine);
        if (!restore) continue;
        postInParts(p, { kind: "restore", ...restore });
        delete all[c.meta.id];
      }
      await chrome.storage.local.set({ [HELD]: all });
    })
    .catch(() => undefined);
  return holding;
}

// Drops what's held for a deleted chat.
function dropHeld(id: number) {
  holding = holding
    .then(async () => {
      const { [HELD]: held = {} } = await chrome.storage.local.get(HELD);
      const { [id]: _, ...rest } = held as Held;
      await chrome.storage.local.set({ [HELD]: rest });
    })
    .catch(() => undefined);
}

// `c` is unset only before the worker has read which chats are open.
function post(c: Chat | undefined, request: BridgeRequest) {
  const conn = c && live(c);
  if (!conn) return;
  conn.sent++;
  postInParts(conn.port, request);
}

function setRunning(conn: Live, running: boolean) {
  if (conn.running === running) return;
  conn.running = running;
  void broadcastSessions();
}

// Events from `conn`, the bridge `c` has open.
async function onBridgeEvent(c: Chat, conn: Live, event: Exclude<BridgeEvent, { type: "browser_request" | "browser_cancel" }>) {
  switch (event.type) {
    case "prompt_result": {
      const sent = conn.unanswered.get(event.promptId);
      conn.unanswered.delete(event.promptId);
      if (event.started) sent?.accept?.();
      break;
    }
    case "ready": {
      // The bridge reports the session pi is on; for a new chat that's the
      // first time Ardi learns its file.
      const { meta } = c;
      if (event.sessionFile !== meta.piSessionFile) {
        meta.piSessionFile = event.sessionFile;
        if (!isDraft(meta)) await store.putSession(meta);
      }
      // History is everything pi saved before it started.
      c.history = event.history;
      c.model = lastModel = event.model;
      c.commands = lastCommands = event.commands;
      conn.state = "connected";
      toScreen(c, replay(c));
      break;
    }
    case "busy":
      conn.reportedBusy = event.busy;
      conn.acked = event.requests;
      settle(c);
      break;
    case "history":
      // Only until pi's own `ready`.
      if (c.history) break;
      c.history = event.history;
      toScreen(c, replay(c));
      break;
    case "model":
      c.model = lastModel = event.model;
      toScreen(c, { kind: "model", model: c.model });
      break;
    case "chunk":
      pushLive(c, event.chunk);
      if (event.chunk.type === "run_start") setRunning(conn, true);
      if (event.chunk.type === "run_end") setRunning(conn, false);
      break;
    case "queue":
      conn.queue = event.queue;
      toScreen(c, { kind: "queue", queue: conn.queue });
      break;
    case "restore":
      giveBack(c, [event]);
      break;
    case "fatal":
      pushLive(c, { type: "notice", content: event.message, level: "error" });
      giveBack(c, [...conn.unanswered.values()]);
      conn.unanswered.clear();
      break;
    case "schedule_request": {
      const reply = await schedules.answerTool(event.request, { chatId: c.meta.id, model: c.model }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
      );
      // A reply answers pi's tool, not the user: not counted in `sent`.
      if (live(c) === conn) postInParts(conn.port, { type: "schedule_reply", id: event.id, ...reply });
      break;
    }
    case "pi_check":
    case "tabs":
      // Only sent to the one-shot ports of ask-bridge.ts.
      break;
  }
}

// Opens `c`'s bridge and sends `start` in one go once settings are read, so
// a caller that awaited it finds the bridge open (or down for good) with
// `start` already sent ahead of anything it posts. Calls meanwhile share it.
function startChat(c: Chat): Promise<void> {
  if (c.connection.state === "starting") return c.connection.started;
  if (c.connection.state !== "down") return Promise.resolve();
  const starting: Extract<Connection, { state: "starting" }> = { state: "starting", started: Promise.resolve() };
  setConnection(c, starting);
  starting.started = connect(c, starting);
  return starting.started;
}

async function connect(c: Chat, starting: Connection) {
  const { piPath } = await loadSettings();
  // Restarted, stopped or left while settings were read.
  if (c.connection !== starting) return;
  // What pi sent belongs to the pi that's gone.
  c.live = [];
  const p = chrome.runtime.connectNative(target().nativeHost);
  const isCurrent = () => c.connection === conn;
  // Replies go only to the port that asked, not a replacement.
  const link = target().connectBrowser?.((reply) => { if (isCurrent()) postInParts(p, reply); }) ?? null;
  const conn: Live = {
    state: "connecting", port: p, browser: link, unanswered: new Map(), running: false, queue: [], sent: 0, acked: 0, reportedBusy: false,
  };
  p.onMessage.addListener(joinParts<BridgeEvent>((event) => {
    if (!isCurrent()) return;
    if (event.type === "browser_request" || event.type === "browser_cancel") return link?.receive(event);
    void onBridgeEvent(c, conn, event);
  }));
  p.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message;
    if (err) console.warn("pi bridge disconnected:", err);
    // Replaced or stopped already: that took care of what it hadn't answered.
    if (!isCurrent()) return void link?.dispose();
    void closeConnection(c, "hand back");
    settle(c);
  });
  setConnection(c, conn);
  post(c, { type: "start", sessionFile: c.meta.piSessionFile, piPath: piPath || undefined });
}

// What the panels and settings ask for runs one request at a time, in the
// order asked: a message still being stored must not land in a chat the user
// switched to meanwhile, nor be passed by a new chat. Stop and restart don't
// wait: a message being stored when pi restarts goes to the new pi.
let queue: Promise<unknown> = Promise.resolve();

function inOrder<A extends unknown[]>(run: (...args: A) => unknown): (...args: A) => Promise<void> {
  return (...args) => {
    const done = queue.then(() => run(...args)).then(() => undefined);
    queue = done.catch((error: unknown) => console.error("request failed:", error));
    return done;
  };
}

// Puts `c` on `p`'s screen: replayed, its session list sent, held messages
// handed over.
async function show(p: chrome.runtime.Port, c: Chat) {
  screens.set(p, c);
  if (c.meta.unread) await seen(c);
  postInParts(p, replay(c));
  postInParts(p, await sessionsUpdateFor(portTab.get(p) ?? GLOBAL));
  await handOver(p);
}

// A panel shows `c`: what a scheduled run did there is no longer unread.
async function seen(c: Chat) {
  c.meta.unread = false;
  await store.putSession(c.meta);
}

// Puts `next` on `p`'s screen: back to its chat if pi still works on it, else
// a fresh pi on its session. The chat left keeps its pi only while it's busy.
async function switchTo(p: chrome.runtime.Port, next: SessionMeta, { stopLeft = false } = {}) {
  const left = screens.get(p);
  const tabId = portTab.get(p) ?? GLOBAL;
  const back = isDraft(next) ? undefined : [...away].find((c) => c.meta.id === next.id);
  if (back) away.delete(back);
  const shown = back ?? opened(next);
  // A shared chat (a scheduled run's, or one from before per-tab panels)
  // picked up here becomes this tab's.
  if (tabId !== GLOBAL && shown.meta.tabId !== tabId) {
    shown.meta.tabId = tabId;
    if (!isDraft(shown.meta)) await store.putSession(shown.meta);
  }
  if (tabId === GLOBAL) {
    // One chat, shared by every panel: they all replay it.
    bound.set(GLOBAL, shown);
    for (const p2 of panels) {
      screens.set(p2, shown);
      postInParts(p2, replay(shown));
    }
    void chrome.storage.local.set({ [CURRENT_CHAT]: next.id });
  } else {
    // A chat can't be on two screens: a panel that had it goes back to its
    // own tab's chat (or a draft if that was it).
    for (const [other, c] of screens) {
      if (other === p || c !== shown) continue;
      const t = portTab.get(other) ?? GLOBAL;
      let own = bound.get(t);
      if (!own || own === shown) {
        own = opened(draft(t));
        bindTab(t, own);
      }
      screens.set(other, own);
      postInParts(other, replay(own));
    }
    bindTab(tabId, shown);
    screens.set(p, shown);
    postInParts(p, replay(shown));
  }
  if (left) {
    if (stopLeft) stop(left);
    if (busy(left)) away.add(left);
    else stop(left);
  }
  void handOver();
  if (shown.meta.unread) await seen(shown);
  await broadcastSessions();
  await startChat(shown);
}

export const newSession = inOrder(async (p: chrome.runtime.Port) => {
  await ready;
  if (!isDraft(screens.get(p)?.meta ?? draft())) await switchTo(p, draft(portTab.get(p) ?? GLOBAL));
});

export const switchSession = inOrder(async (p: chrome.runtime.Port, id: number) => {
  await ready;
  const meta = await store.getSession(id);
  if (meta && meta.id !== screens.get(p)?.meta.id) await switchTo(p, meta);
});

export const deleteSession = inOrder(async (_p: chrome.runtime.Port, id: number) => {
  await ready;
  await store.deleteSession(id);
  dropHeld(id);
  await schedules.dropCheckBack(id);
  for (const c of away) {
    if (c.meta.id !== id) continue;
    stop(c);
    away.delete(c);
  }
  const gone: number[] = [];
  for (const [t, c] of bound) if (c.meta.id === id) { bound.delete(t); gone.push(t); }
  if (gone.length) {
    const { [CURRENT_TABS]: currents = {} } = await chrome.storage.local.get(CURRENT_TABS);
    const rest = { ...(currents as Record<string, number>) };
    for (const t of gone) delete rest[t];
    await chrome.storage.local.set({ [CURRENT_TABS]: rest });
  }
  let switched = false;
  for (const [p2, c] of Array.from(screens)) {
    if (c.meta.id !== id) continue;
    const t = portTab.get(p2) ?? GLOBAL;
    const all = await store.listSessions();
    const sessions = t === GLOBAL ? all : all.filter((s) => s.tabId === t || s.tabId === undefined);
    await switchTo(p2, sessions[0] ?? draft(t), { stopLeft: true });
    switched = true;
  }
  if (!switched) await broadcastSessions();
});

export const prompt = inOrder(async (p: chrome.runtime.Port, text: string, images?: ImageAttachment[], steer?: boolean) => {
  await ready;
  const c = screens.get(p);
  // The chat it was sent from, even if the user moves on meanwhile.
  if (c) await send(c, text, images, steer);
});

// Runs what came due: a check-back prompts its chat; a job, a new chat named
// after it, on the job's model and effort. A chat off screen runs
// in the background like one the user left, and is marked unread.
export const runJob = inOrder(async (run: Scheduled) => {
  await ready;
  // Storage first: once the chat is picked, nothing may wait until the prompt
  // is sent, or its bridge could report idle and be stopped meanwhile.
  const now = Date.now();
  let meta: SessionMeta | undefined;
  if (run.kind === "job") {
    meta = await store.addSession({ title: run.title.slice(0, TITLE_LEN), createdAt: now, updatedAt: now, unread: true });
  } else {
    meta = await store.getSession(run.chatId);
    // The chat was deleted.
    if (!meta) return;
    meta.updatedAt = now;
    const chatId = meta.id;
    if (![...screens.values()].some((c) => c.meta.id === chatId)) meta.unread = true;
    await store.putSession(meta);
  }
  const chatId = meta.id;
  const shown = [...screens.values()].find((c) => c.meta.id === chatId);
  const c = shown ?? [...away].find((a) => a.meta.id === chatId) ?? opened(meta);
  if (!shown) {
    away.add(c);
    c.meta.updatedAt = now;
    c.meta.unread = true;
  }
  // From here to the prompt nothing waits: a bridge that reports idle in
  // between would be stopped as a chat off screen with nothing to do.
  await startChat(c);
  const conn = live(c);
  // pi couldn't start; the run is skipped.
  if (!conn) return;
  if (run.kind === "job") {
    if (run.model) post(c, { type: "set_model", provider: run.model.provider, modelId: run.model.id });
    if (run.thinkingLevel) post(c, { type: "set_thinking_level", level: run.thinkingLevel });
  }
  deliver(conn, runMessage(run), undefined, false, conn.browser?.preparePrompt());
  await broadcastSessions();
});

// Sends a message to `c`'s pi, starting it if needed. A draft becomes a
// stored chat named after its first message.
async function send(c: Chat, text: string, images?: ImageAttachment[], steer = false) {
  await startChat(c);
  const origin = live(c);
  const accept = origin?.browser?.preparePrompt();
  const current = c.meta;
  current.updatedAt = Date.now();
  if (isDraft(current)) {
    // First message: the chat becomes real and joins the list.
    const { id: _, ...meta } = current;
    const stored = await store.addSession({ ...meta, title: plainMentions(text).slice(0, TITLE_LEN) });
    // `ready` can name the session file while the chat is being stored.
    setMeta(c, { ...stored, piSessionFile: current.piSessionFile });
    if (c.meta.piSessionFile !== stored.piSessionFile) await store.putSession(c.meta);
    queueMicrotask(() => void broadcastSessions());
  } else {
    await store.putSession(current);
  }
  // The bridge may have gone away while storing; then a new one starts.
  await startChat(c);
  const sentTo = live(c);
  if (!sentTo) return giveBack(c, [{ text, images }]);
  // A restart during storage writes must not drop the message. Permission
  // callbacks belong to their original controller, not the replacement port.
  deliver(sentTo, text, images, steer, origin?.port === sentTo.port ? accept : undefined);
}

// Posts a prompt to an open bridge; it waits in `unanswered` until pi answers.
function deliver(conn: Live, text: string, images: ImageAttachment[] | undefined, steer: boolean, accept?: () => void) {
  const promptId = crypto.randomUUID();
  conn.unanswered.set(promptId, { text, images, accept });
  // The chat shows it once pi starts it (a `user` chunk).
  const request: Extract<BridgeRequest, { type: "prompt" }> = { type: "prompt", text, images, promptId };
  if (steer) request.steer = true;
  conn.sent++;
  postInParts(conn.port, request);
}

export function queueAction(p: chrome.runtime.Port, { action, index, text }: QueueAction) {
  post(screens.get(p), { type: "queue_action", action, index, text });
}

export function abort(p: chrome.runtime.Port) {
  const c = screens.get(p);
  if (c) live(c)?.browser?.cancel();
  post(c, { type: "abort" });
}

// Starts pi for the chat `p` shows.
export async function start(p: chrome.runtime.Port): Promise<void> {
  await ready;
  const c = screens.get(p);
  if (c) await startChat(c);
}

// Restarts `p`'s chat's pi; pi resumes the same session.
export async function restart(p: chrome.runtime.Port) {
  await ready;
  const c = screens.get(p);
  if (!c) return;
  await closeConnection(c, "hand back");
  await startChat(c);
}

// Restarts every chat's pi: settings changed.
export async function restartAll() {
  await ready;
  for (const c of new Set([...bound.values(), ...away])) {
    if (c.connection.state === "down") continue;
    await closeConnection(c, "hand back");
    await startChat(c);
  }
}

export const compact = inOrder((p: chrome.runtime.Port) => {
  post(screens.get(p), { type: "compact" });
});

export const setModel = inOrder((p: chrome.runtime.Port, provider: string, modelId: string) => {
  post(screens.get(p), { type: "set_model", provider, modelId });
});

export const setThinkingLevel = inOrder((p: chrome.runtime.Port, level: ThinkingLevel) => {
  post(screens.get(p), { type: "set_thinking_level", level });
});

// A panel connected. On shared-panel targets it attaches to the shared chat
// at once; on per-tab targets it waits for the panel's `attach` with its
// window, since a port doesn't say which tab it opened for.
export async function attachPanel(p: chrome.runtime.Port) {
  panels.add(p);
  p.onDisconnect.addListener(() => {
    panels.delete(p);
    screens.delete(p);
    portTab.delete(p);
    portWindow.delete(p);
  });
  if (target().panelPerTab) return;
  await ready;
  portTab.set(p, GLOBAL);
  await show(p, bound.get(GLOBAL)!);
}

// `attach` from a tab-scoped panel, with the window it opened in: binds the
// port to the window's active tab and shows that tab's chat.
export const bindPanel = inOrder(async (p: chrome.runtime.Port, windowId: number) => {
  if (!target().panelPerTab) return;
  await ready;
  portWindow.set(p, windowId);
  const [active] = await chrome.tabs.query({ active: true, windowId });
  const tabId = active?.id ?? GLOBAL;
  portTab.set(p, tabId);
  const chat = await chatForTab(tabId);
  await show(p, chat);
  // Like a shared panel connecting: the tab's chat comes up with its panel.
  await startChat(chat);
});

// The toolbar icon on a tab (per-tab targets): open that tab's chat's panel,
// on that tab only.
export const openForTab = inOrder(async (tabId: number) => {
  if (!target().panelPerTab) return;
  await ready;
  await chatForTab(tabId);
  const path = chrome.runtime.getManifest().side_panel?.default_path ?? "src/sidepanel/index.html";
  await chrome.sidePanel.setOptions({ tabId, path, enabled: true });
  await chrome.sidePanel.open({ tabId });
});

// A tab becoming active swaps its window's panel to that tab's chat, or
// drops the panel from the tab if the tab has no chat of its own.
export const tabActivated = inOrder(async (windowId: number, tabId: number) => {
  await ready;
  const next = await lookupTab(tabId);
  for (const [p, w] of portWindow) {
    if (w !== windowId) continue;
    if (!next) {
      screens.delete(p);
      portTab.delete(p);
      // The panel closes itself once the tab stops allowing it.
      void chrome.sidePanel.setOptions({ tabId, enabled: false });
      continue;
    }
    const left = screens.get(p);
    portTab.set(p, tabId);
    if (left === next) continue;
    await show(p, next);
    if (left) {
      if (busy(left)) away.add(left);
      else stop(left);
    }
    await startChat(next);
  }
});

// A tab closing ends its chats: their pis stop and their entries are dropped.
export const tabClosed = inOrder(async (tabId: number) => {
  await ready;
  const c = bound.get(tabId);
  if (c) stop(c);
  bound.delete(tabId);
  for (const [p, t] of portTab) {
    if (t !== tabId) continue;
    screens.delete(p);
    portTab.delete(p);
    portWindow.delete(p);
  }
  for (const meta of await store.listSessions()) {
    if (meta.tabId !== tabId) continue;
    await store.deleteSession(meta.id);
    dropHeld(meta.id);
    await schedules.dropCheckBack(meta.id);
  }
  for (const a of Array.from(away)) {
    if (a.meta.tabId !== tabId) continue;
    stop(a);
    away.delete(a);
  }
  const { [CURRENT_TABS]: currents = {} } = await chrome.storage.local.get(CURRENT_TABS);
  const rest = { ...(currents as Record<string, number>) };
  delete rest[tabId];
  await chrome.storage.local.set({ [CURRENT_TABS]: rest });
  await broadcastSessions();
});
