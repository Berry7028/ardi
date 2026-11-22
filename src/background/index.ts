import { joinParts } from "../parts";
import { PANEL_PORT, type PanelRequest, type PanelAnswers, type PanelQuestion } from "../panel-protocol";
import * as pi from "./pi-session";
import * as schedules from "./schedules";
import * as settings from "./settings";
import { mentionableTabs } from "./tabs";
import { setTarget, type BackgroundTarget } from "./target";

// The service worker, started by each target's background entry with its
// browser target.
export function startBackground(target: BackgroundTarget): void {
  setTarget(target);

  if (target.panelPerTab) {
    // The toolbar icon opens that tab's own chat's panel, on that tab only.
    // `onClicked` fires only while the panel doesn't open on action clicks;
    // an install that set it keeps it, so it's switched off again here.
    chrome.runtime.onInstalled.addListener(() => {
      void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    });
    chrome.action.onClicked.addListener((tab) => {
      if (tab.id !== undefined) void pi.openForTab(tab.id);
    });
    chrome.tabs.onActivated.addListener(({ windowId, tabId }) => void pi.tabActivated(windowId, tabId));
    chrome.tabs.onRemoved.addListener((tabId) => void pi.tabClosed(tabId));
  } else {
    // Clicking the toolbar icon opens the side panel.
    chrome.runtime.onInstalled.addListener(() => {
      void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    });
  }
  chrome.runtime.onInstalled.addListener(() => void schedules.rearm());

  // Scheduled jobs. Listeners go in before the first await, so an alarm that
  // woke the worker reaches them.
  void schedules.noteBrowserStart();
  chrome.runtime.onStartup.addListener(() => void schedules.rearm());
  chrome.alarms.onAlarm.addListener((alarm) => {
    void schedules.due(alarm).then((job) => job && pi.runJob(job));
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PANEL_PORT) return;
    void pi.attachPanel(port);
    void pi.start(port);
    port.onMessage.addListener(joinParts<PanelRequest>((req) => void handle(port, req)));
  });

  // The panel's one-off questions. Answered asynchronously (return true).
  chrome.runtime.onMessage.addListener((req: PanelQuestion, _sender, respond) => {
    void answer(req).then(respond);
    return true;
  });
}

// The panel's requests, over its port.
function handle(port: chrome.runtime.Port, req: PanelRequest) {
  switch (req.kind) {
    case "attach":
      return pi.bindPanel(port, req.windowId);
    case "prompt":
      return pi.prompt(port, req.text, req.images, req.steer);
    case "queue_action":
      return pi.queueAction(port, req);
    case "abort":
      return pi.abort(port);
    case "restart":
      return pi.restart(port);
    case "new_session":
      return pi.newSession(port);
    case "switch_session":
      return pi.switchSession(port, req.id);
    case "delete_session":
      return pi.deleteSession(port, req.id);
    case "compact":
      return pi.compact(port);
    case "set_model":
      return pi.setModel(port, req.provider, req.modelId);
    case "set_thinking_level":
      return pi.setThinkingLevel(port, req.level);
  }
}

async function answer(req: PanelQuestion) {
  switch (req.kind) {
    case "get_settings": {
      const saved = await settings.loadSettings();
      return { settings: saved, check: await settings.checkPi(saved.piPath) } satisfies PanelAnswers["get_settings"];
    }
    case "set_pi_path": {
      const result = await settings.setPiPath(req.piPath);
      if (result.saved && !result.check.error) await pi.restartAll();
      return result satisfies PanelAnswers["set_pi_path"];
    }
    case "mention_tabs":
      return { tabs: await mentionableTabs() } satisfies PanelAnswers["mention_tabs"];
    case "list_jobs":
      return { jobs: await schedules.scheduledJobs() } satisfies PanelAnswers["list_jobs"];
    case "save_job":
      return schedules.saveJob(req.job).then(
        (job) => ({ job }) satisfies PanelAnswers["save_job"],
        (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }) satisfies PanelAnswers["save_job"],
      );
    case "delete_job":
      return { deleted: await schedules.deleteJob(req.id) } satisfies PanelAnswers["delete_job"];
  }
}
