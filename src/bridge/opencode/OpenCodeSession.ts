// One `opencode serve` process on one opencode session for its life (each
// chat has its own bridge). Speaks OpenCode 2's /api surface. Mirrors
// PiSession's shape: the same public methods, the same
// SessionUpdate/BridgeEvent contract, so the extension can't tell which agent
// it's talking to.
//
// Differences from pi: prompts queue client-side (the bridge serializes them;
// a steering message just goes first when the run settles); the schedule
// tools reach the extension through a small HTTP endpoint this session serves
// (the MCP server calls it); permission asks are auto-answered "always",
// matching pi's always-allowed tools. The serve needs a password: the bridge
// sets OPENCODE_SERVER_PASSWORD before spawning it and authenticates every
// request with it.

import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ImageAttachment, ModelInfo, ModelState, QueueAction, QueuedMessage, ThinkingLevel } from "../../chat";
import { restoreOf } from "../../restore";
import type { BridgeEvent, ScheduleReply } from "../protocol";
import { prepareWorkDir, SYSTEM_PROMPT, WORK_DIR } from "../launch";
import { buildServeSpec } from "./ocLaunch";
import { OcClient, type OcEvent } from "./ocClient";
import { createOcNormState, normalizeOcEvent } from "./ocNormalize";
import { readOcHistory, type OcHistoryEntry } from "./ocHistory";

// What a target supplies for its tools to reach the extension over MCP.
export interface OpenCodeTarget {
  // The bundled MCP server (dist/<target>/agent/mcp/mcp-server.js).
  mcpServer: string;
  // Extra instruction text after the system prompt (Ardia's browser guide).
  guide?: string[];
}

type Phase =
  | { state: "idle" }
  | { state: "starting" }
  | { state: "running"; proc: ChildProcess; client: OcClient; sessionId: string; sse: AbortController }
  | { state: "stopped" };

type Message = { text: string; steer: boolean; images?: ImageAttachment[] };

// Bodies the /api endpoints answer with.
type OcSessionInfo = { id: string; model?: { providerID?: string; id?: string } };
type OcModel = { id: string; providerID: string; name?: string };

const STDERR_BUFFER_LIMIT = 8_000;
const PORT_LINE = /127\.0\.0\.1:(\d+)/;

export class OpenCodeSession {
  private phase: Phase = { state: "idle" };
  private models: ModelInfo[] = [];
  private model?: { provider: string; id: string };
  private readonly normalization = createOcNormState();

  // Input order and busy tracking, as in PiInput.
  private steps: Promise<void> = Promise.resolve();
  private stops = 0;
  private pending = 0;
  private tracked = 0;
  private running = false;
  private busy = false;
  private requests = 0;
  private queue: Message[] = [];

  // The schedule endpoint's pending answers, by request id.
  private schedules = new Map<string, (reply: { result?: unknown; error?: string }) => void>();
  private scheduleServer?: Server;
  // The serve process, held from spawn until shutdown: a `starting` or
  // `stopped` phase must still kill it so failed launches leave nothing.
  private serveProc?: ChildProcess;

  constructor(
    private readonly target: OpenCodeTarget,
    private readonly send: (event: BridgeEvent) => void,
    private readonly exit: (code: number) => void = (code) => process.exit(code),
  ) {}

  start(ocSessionId?: string, opencodePath?: string): void {
    if (this.phase.state !== "idle") return;
    this.phase = { state: "starting" };
    this.exclusive(() => this.launch(ocSessionId, opencodePath)).catch((error: unknown) => this.fail(error));
  }

  received(): void {
    this.requests++;
  }

  prompt(text: string, options: { promptId?: string; images?: ImageAttachment[]; steer?: boolean } = {}): Promise<void> {
    const { promptId, images, steer = false } = options;
    return this.step(async (stopped) => {
      const message = { text, images, steer };
      if (stopped()) {
        if (promptId) this.emit({ type: "prompt_result", promptId, started: false });
        this.giveBack([message]);
        return;
      }
      if (this.running || this.queue.length) {
        this.queue.push(message);
        this.reportQueue();
        if (promptId) this.emit({ type: "prompt_result", promptId, started: false });
        return;
      }
      const started = await this.sendPrompt(message);
      if (!started) this.giveBack([message]);
      if (promptId) this.emit({ type: "prompt_result", promptId, started });
    });
  }

  queueAction({ action, index, text }: QueueAction): Promise<void> {
    return this.step(async () => {
      const at = this.queue[index]?.text === text ? index : this.queue.findIndex((m) => m.text === text);
      if (at < 0) return;
      const [message] = this.queue.splice(at, 1);
      if (action === "steer") this.queue.unshift({ ...message, steer: true });
      if (action === "edit") this.giveBack([message]);
      this.reportQueue();
    });
  }

  // Stops the run now. Queued messages go back to the message box first:
  // opencode would still run them when the run settled.
  abort(): Promise<void> {
    this.stops++;
    const stopping = (async () => {
      this.giveBack(this.takeQueue());
      if (this.phase.state === "running") {
        await this.phase.client.post(`/api/session/${this.phase.sessionId}/interrupt`).catch((error: unknown) => this.notice(error));
      }
    })();
    this.track(stopping);
    return stopping;
  }

  compact(): Promise<void> {
    return this.exclusive(async () => {
      if (this.phase.state !== "running") return;
      const compacting = this.phase.client.post(`/api/session/${this.phase.sessionId}/compact`, {}).catch((error: unknown) => {
        this.notice(error);
      });
      this.track(compacting);
    });
  }

  setModel(provider: string, modelId: string): Promise<void> {
    return this.exclusive(async () => {
      if (this.phase.state === "running") {
        await this.phase.client
          .post(`/api/session/${this.phase.sessionId}/model`, { model: { providerID: provider, id: modelId } })
          .catch((error: unknown) => this.notice(error));
      }
      this.model = { provider, id: modelId };
      this.emitModel();
    });
  }

  // opencode's reasoning effort lives in model `variant`s; not mapped yet.
  setThinkingLevel(_level: ThinkingLevel): Promise<void> {
    return this.exclusive(async () => this.emitModel());
  }

  // The extension's answer to a `schedule_request`, back to the MCP tool.
  scheduleReply({ id, result, error }: ScheduleReply): void {
    const answer = this.schedules.get(id);
    if (!answer) return;
    this.schedules.delete(id);
    answer({ result, error });
  }

  async shutdown(): Promise<void> {
    const { phase } = this;
    this.phase = { state: "stopped" };
    this.scheduleServer?.close();
    for (const answer of this.schedules.values()) answer({ error: "Scheduling is gone" });
    this.schedules.clear();
    if (phase.state === "running") phase.sse.abort();
    this.serveProc?.kill();
  }

  private get client(): OcClient | undefined {
    return this.phase.state === "running" ? this.phase.client : undefined;
  }

  // Input steps run one at a time, in the order asked.
  private exclusive(run: () => Promise<void>): Promise<void> {
    return this.step(() => run());
  }

  private step(run: (stopped: () => boolean) => Promise<void>): Promise<void> {
    const stops = this.stops;
    this.pending++;
    this.report();
    const done = this.steps.then(() => run(() => this.stops !== stops)).finally(() => {
      this.pending--;
      this.report();
    });
    this.steps = done.catch(() => undefined);
    return done;
  }

  private track(work: Promise<unknown>): void {
    this.tracked++;
    this.report();
    void work.finally(() => {
      this.tracked--;
      this.report();
    });
  }

  private report(): void {
    const busy = this.running || this.pending > 0 || this.tracked > 0 || this.queue.length > 0;
    if (busy === this.busy) return;
    this.busy = busy;
    this.emit({ type: "busy", busy, requests: this.requests });
  }

  private emit(event: BridgeEvent): void {
    this.send(event);
  }

  private reportQueue(): void {
    const queue: QueuedMessage[] = [
      ...this.queue.filter((m) => m.steer).map(({ text }) => ({ text, steer: true })),
      ...this.queue.filter((m) => !m.steer).map(({ text }) => ({ text, steer: false })),
    ];
    this.emit({ type: "queue", queue });
    this.report();
  }

  private takeQueue(): Message[] {
    const left = this.queue;
    this.queue = [];
    this.reportQueue();
    // Steering first, as they would have run.
    return [...left.filter((m) => m.steer), ...left.filter((m) => !m.steer)];
  }

  private giveBack(messages: Message[]): void {
    const restore = restoreOf(messages);
    if (restore) this.emit({ type: "restore", ...restore });
  }

  private notice(error: unknown): void {
    this.emit({ type: "chunk", chunk: { type: "notice", content: errorMessage(error), level: "error" } });
  }

  private fail(error: unknown, stderr?: string): void {
    if (this.phase.state === "stopped") return;
    this.phase = { state: "stopped" };
    this.scheduleServer?.close();
    this.serveProc?.kill();
    this.emit({ type: "fatal", message: [errorMessage(error), stderr].filter(Boolean).join("\n") });
    this.exit(1);
  }

  private async launch(ocSessionId?: string, opencodePath?: string): Promise<void> {
    if (this.phase.state !== "starting") return;
    prepareWorkDir();
    const spec = buildServeSpec(opencodePath);
    const password = randomBytes(24).toString("base64url");
    const schedule = await this.scheduleEndpoint();

    const instructions = join((await mkdtemp(join(tmpdir(), "ardi-oc-"))), "instructions.md");
    await writeFile(instructions, [await readFile(SYSTEM_PROMPT, "utf8"), environmentSection(), `Today is ${today()}.`, ...(this.target.guide ?? [])].join("\n\n"));
    // Extra config the serve merges in: the system-prompt file and the MCP
    // server that carries this target's tools. codemode stays off so the tools
    // are directly callable instead of behind Code Mode.
    const config = {
      instructions: [instructions],
      mcp: {
        servers: {
          ardi: {
            type: "local",
            command: [globalThis.process.execPath, this.target.mcpServer],
            codemode: false,
            environment: {
              // The bridge's own env vars, which serve inherits and passes on
              // to the MCP server it spawns.
              ARDI_BROWSER_URL: process.env.ARDI_BROWSER_URL ?? "",
              ARDI_BROWSER_TOKEN: process.env.ARDI_BROWSER_TOKEN ?? "",
              ARDI_SCHEDULE_URL: schedule.url,
              ARDI_SCHEDULE_TOKEN: schedule.token,
            },
          },
        },
      },
    };

    const proc = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
    });
    this.serveProc = proc;
    let stderrTail = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_BUFFER_LIMIT);
    });
    proc.on("error", (error) => this.fail(error, stderrTail));
    proc.on("exit", (code, signal) => {
      if (this.phase.state === "stopped") return;
      this.fail(new Error(`opencode exited (${signal ? `signal ${signal}` : `code ${code}`})`), stderrTail);
    });
    const client = new OcClient(`http://${await listenPort(proc)}`, password);

    const sessionId = await this.findSession(client, ocSessionId);

    const sse = new AbortController();
    this.phase = { state: "running", proc, client, sessionId, sse };
    void this.followEvents(client, sessionId, sse.signal);

    const { data: models } = await client.get<{ location: unknown; data: OcModel[] }>(`/api/model?location[directory]=${encodeURIComponent(WORK_DIR)}`);
    this.models = models.map((model) => ({ provider: model.providerID, id: model.id, name: model.name ?? model.id, thinkingLevels: [] }));

    const session = await client.get<{ data: OcSessionInfo }>(`/api/session/${sessionId}`).catch(() => undefined);
    if (session?.data.model?.providerID && session.data.model.id) this.model = { provider: session.data.model.providerID, id: session.data.model.id };
    else {
      const fallback = await client.get<{ data?: OcModel }>(`/api/model/default?location[directory]=${encodeURIComponent(WORK_DIR)}`).catch(() => undefined);
      if (fallback?.data) this.model = { provider: fallback.data.providerID, id: fallback.data.id };
    }

    const history = await client.get<{ data: OcHistoryEntry[] }>(`/api/session/${sessionId}/message`).catch(() => ({ data: [] as OcHistoryEntry[] }));
    this.emit({ type: "ready", ocSessionId: sessionId, history: readOcHistory(history.data), model: this.modelState(), commands: [] });
  }

  private async findSession(client: OcClient, ocSessionId?: string): Promise<string> {
    if (ocSessionId) {
      const existing = await client.get<{ data: OcSessionInfo }>(`/api/session/${ocSessionId}`).catch(() => undefined);
      if (existing) return existing.data.id;
    }
    const created = await client.post<{ data: OcSessionInfo }>("/api/session", { location: { directory: WORK_DIR } });
    return created.data.id;
  }

  // Serves POST /schedule for the MCP server's schedule tools: each call is a
  // schedule_request to the extension, answered by a schedule_reply.
  private async scheduleEndpoint(): Promise<{ url: string; token: string }> {
    const token = randomBytes(24).toString("hex");
    this.scheduleServer = createServer((req, res) => {
      if (req.method !== "POST" || req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(req.method === "POST" ? 403 : 404).end();
        return;
      }
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk));
      req.on("end", () => {
        let request: unknown;
        try {
          request = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid schedule request" }));
          return;
        }
        const id = randomUUID();
        const answered = new Promise<{ result?: unknown; error?: string }>((done) => this.schedules.set(id, done));
        this.emit({ type: "schedule_request", id, request: request as never });
        void answered.then((reply) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(reply)));
      });
    });
    await new Promise<void>((done) => this.scheduleServer!.listen(0, "127.0.0.1", done));
    const port = (this.scheduleServer.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}/schedule`, token };
  }

  private async followEvents(client: OcClient, sessionId: string, signal: AbortSignal): Promise<void> {
    try {
      for await (const event of client.events(signal)) {
        if (this.phase.state !== "running") return;
        if (this.onEvent(event, sessionId) === false) return;
      }
      // The stream ended on its own: the serve is gone or restarting.
      if (this.phase.state === "running") this.fail(new Error("opencode's event stream ended"));
    } catch (error) {
      if (!signal.aborted && this.phase.state === "running") this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // false stops the loop.
  private onEvent(event: OcEvent, sessionId: string): boolean {
    const data = event.data;
    if (event.type === "permission.asked") {
      const id = data.id as string | undefined;
      if (id) void this.client?.post(`/api/session/${sessionId}/permission/${id}/reply`, { decision: "always" }).catch(() => {});
      return true;
    }
    const eventSession = data.sessionID as string | undefined;
    if (eventSession && eventSession !== sessionId) return true;
    for (const chunk of normalizeOcEvent(event, this.normalization)) this.emit({ type: "chunk", chunk });
    if (event.type === "session.execution.started") this.running = true;
    if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") this.running = false;
    // A queued message runs next once the serve goes idle; run_end already
    // went out for the last run.
    const next = !this.running ? (this.queue.find((m) => m.steer) ?? this.queue[0]) : undefined;
    if (next) {
      this.queue.splice(this.queue.indexOf(next), 1);
      // The run counts from now, before the queue report: submitting it is
      // async work an off-screen bridge must stay alive for.
      this.running = true;
      this.reportQueue();
      void this.sendPrompt(next).then((started) => {
        if (!started) {
          this.running = false;
          this.giveBack([next]);
          this.report();
        }
      });
    }
    this.report();
    return true;
  }

  private async sendPrompt(message: Message): Promise<boolean> {
    if (this.phase.state !== "running") return false;
    const { client, sessionId } = this.phase;
    const body: Record<string, unknown> = {
      text: message.text || " ",
      files: (message.images ?? []).map((image) => ({ uri: `data:${image.mimeType};base64,${image.data}`, name: "image" })),
    };
    const sent = await client.post(`/api/session/${sessionId}/prompt`, body).then(
      () => true,
      (error: unknown) => {
        this.notice(error);
        return false;
      },
    );
    if (!sent) return false;
    // The serve only streams assistant deltas, so the user bubble goes out
    // from here.
    this.emit({
      type: "chunk",
      chunk: { type: "user", text: message.text, at: Date.now(), ...(message.images?.length ? { images: message.images } : {}) },
    });
    // Until the serve's execution.started lands, count the run as started so
    // the next prompt queues instead of racing it.
    this.running = true;
    this.report();
    return true;
  }

  private emitModel(): void {
    this.emit({ type: "model", model: this.modelState() });
  }

  private modelState(): ModelState {
    return { models: this.models, current: this.model };
  }
}

// The port the serve chose, from its `server listening on …` line.
function listenPort(proc: ChildProcessByStdio<null, Readable, Readable>): Promise<string> {
  return new Promise((done, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const port = PORT_LINE.exec(buffer)?.[1];
      if (port) {
        clearTimeout(timer);
        proc.stdout.off("data", onData);
        proc.stderr.off("data", onData);
        done(`127.0.0.1:${port}`);
      }
    };
    const timer = setTimeout(() => reject(new Error(`opencode serve didn't report its port: ${buffer.slice(-500)}`)), 15_000);
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.once("exit", () => reject(new Error(`opencode serve exited before reporting its port: ${buffer.slice(-500)}`)));
  });
}

const OS: Partial<Record<NodeJS.Platform, string>> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

// Ardi replaces the agent's prompt, which has no OS or date.
function environmentSection(): string {
  const os = OS[globalThis.process.platform] ?? globalThis.process.platform;
  return globalThis.process.platform === "win32"
    ? `This computer runs ${os}. Run commands in PowerShell syntax; there is no bash.`
    : `This computer runs ${os}.`;
}

function today(): string {
  return new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
