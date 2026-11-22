// One `opencode serve` process on one opencode session for its life (each
// chat has its own bridge). Mirrors PiSession's shape: the same public
// methods, the same SessionUpdate/BridgeEvent contract, so the extension
// can't tell which agent it's talking to.
//
// Differences from pi: prompts queue client-side (opencode has no editable
// queue; a steering message just goes first when the run settles); the
// schedule tools reach the extension through a small HTTP endpoint this
// session serves (the MCP server calls it); tool/permission asks are
// auto-answered "always", matching pi's always-allowed tools.

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
import { prepareWorkDir } from "../launch";
import { buildServeSpec, SYSTEM_PROMPT } from "./ocLaunch";
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
        await this.phase.client.post(`/session/${this.phase.sessionId}/abort`).catch((error: unknown) => this.notice(error));
      }
    })();
    this.track(stopping);
    return stopping;
  }

  compact(): Promise<void> {
    return this.exclusive(async () => {
      if (this.phase.state !== "running") return;
      const body: Record<string, unknown> = { auto: false };
      if (this.model) body.providerID = this.model.provider;
      if (this.model) body.modelID = this.model.id;
      const compacting = this.phase.client.post(`/session/${this.phase.sessionId}/summarize`, body).catch((error: unknown) => {
        this.notice(error);
      });
      this.track(compacting);
    });
  }

  setModel(provider: string, modelId: string): Promise<void> {
    return this.exclusive(async () => {
      if (this.phase.state === "running") {
        await this.phase.client.patch("/config", { model: `${provider}/${modelId}` }).catch((error: unknown) => this.notice(error));
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
    if (phase.state !== "running") return;
    phase.sse.abort();
    phase.proc.kill();
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
    this.emit({ type: "fatal", message: [errorMessage(error), stderr].filter(Boolean).join("\n") });
    this.exit(1);
  }

  private async launch(ocSessionId?: string, opencodePath?: string): Promise<void> {
    if (this.phase.state !== "starting") return;
    prepareWorkDir();
    const spec = buildServeSpec(opencodePath);
    const proc = spawn(spec.command, spec.args, { cwd: spec.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
    const client = new OcClient(`http://${await listenPort(proc)}`);

    const sessionId = await this.findSession(client, ocSessionId);
    const schedule = await this.scheduleEndpoint();

    const instructions = join((await mkdtemp(join(tmpdir(), "ardi-oc-"))), "instructions.md");
    await writeFile(instructions, [await readFile(SYSTEM_PROMPT, "utf8"), environmentSection(), `Today is ${today()}.`, ...(this.target.guide ?? [])].join("\n\n"));
    await client.patch("/config", {
      instructions: [instructions],
      mcp: {
        ardi: {
          type: "local",
          command: [globalThis.process.execPath, this.target.mcpServer],
          enabled: true,
          environment: {
            // The bridge's own env vars, which serve inherits and passes on
            // to the MCP server it spawns.
            ARDI_BROWSER_URL: process.env.ARDI_BROWSER_URL ?? "",
            ARDI_BROWSER_TOKEN: process.env.ARDI_BROWSER_TOKEN ?? "",
            ARDI_SCHEDULE_URL: schedule.url,
            ARDI_SCHEDULE_TOKEN: schedule.token,
            ARDI_CHAT_ID: sessionId,
          },
        },
      },
    });

    const sse = new AbortController();
    this.phase = { state: "running", proc, client, sessionId, sse };
    void this.followEvents(client, sessionId, sse.signal);

    const { all: providers, connected } = await client.get<{ all: { id: string; models: Record<string, { name?: string }> }[]; connected: string[]; default: Record<string, string> }>("/provider");
    const connectedSet = new Set(connected);
    this.models = providers
      .filter((provider: { id: string }) => connectedSet.has(provider.id))
      .flatMap((provider: { id: string; models: Record<string, { name?: string }> }) =>
        Object.entries(provider.models).map(([id, model]: [string, { name?: string }]) => ({ provider: provider.id, id, name: model.name ?? id, thinkingLevels: [] })),
      );

    const session = await client.get<{ model?: { providerID?: string; modelID?: string } }>(`/session/${sessionId}`).catch(() => undefined);
    if (session?.model?.providerID && session.model.modelID) this.model = { provider: session.model.providerID, id: session.model.modelID };
    else {
      const config = await client.get<{ model?: string }>("/config").catch(() => undefined);
      const [provider, id] = config?.model?.split("/") ?? [];
      if (provider && id) this.model = { provider, id };
    }

    const entries = await client.get<OcHistoryEntry[]>(`/session/${sessionId}/message`).catch(() => [] as OcHistoryEntry[]);
    this.emit({ type: "ready", ocSessionId: sessionId, history: readOcHistory(entries), model: this.modelState(), commands: [] });
  }

  private async findSession(client: OcClient, ocSessionId?: string): Promise<string> {
    if (ocSessionId) {
      const existing = await client.get<{ id: string }>(`/session/${ocSessionId}`).catch(() => undefined);
      if (existing) return existing.id;
    }
    const created = await client.post<{ id: string }>("/session", {});
    return created.id;
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
    const p = event.properties;
    if (event.type === "permission.asked") {
      const id = (p.permission as { id?: string } | undefined)?.id ?? (p.id as string | undefined);
      if (id) void this.client?.post(`/session/${sessionId}/permissions/${id}`, { response: "always" }).catch(() => {});
      return true;
    }
    const eventSession = p.sessionID as string | undefined;
    if (eventSession && eventSession !== sessionId) return true;
    for (const chunk of normalizeOcEvent(event, this.normalization)) this.emit({ type: "chunk", chunk });
    const status = (p.status as { type?: string } | undefined)?.type;
    if (event.type === "session.status" && status === "busy") this.running = true;
    if (event.type === "session.idle" || (event.type === "session.status" && status === "idle")) this.running = false;
    // A queued message runs next once the serve goes idle; run_end already
    // went out for the last run.
    const next = !this.running ? (this.queue.find((m) => m.steer) ?? this.queue[0]) : undefined;
    if (next) {
      this.queue.splice(this.queue.indexOf(next), 1);
      this.reportQueue();
      void this.sendPrompt(next).then((started) => {
        if (!started) this.giveBack([next]);
      });
    }
    this.report();
    return true;
  }

  private async sendPrompt(message: Message): Promise<boolean> {
    if (this.phase.state !== "running") return false;
    const { client, sessionId } = this.phase;
    const parts: Record<string, unknown>[] = [{ type: "text", text: message.text || " " }];
    for (const image of message.images ?? []) {
      parts.push({ type: "file", mime: image.mimeType, filename: "image", url: `data:${image.mimeType};base64,${image.data}` });
    }
    const body: Record<string, unknown> = { parts };
    if (this.model) body.model = { providerID: this.model.provider, modelID: this.model.id };
    const sent = await client.post(`/session/${sessionId}/prompt_async`, body).then(
      () => true,
      (error: unknown) => {
        this.notice(error);
        return false;
      },
    );
    // Until the serve's busy event lands, count the run as started so the
    // next prompt queues instead of racing it.
    if (sent) {
      this.running = true;
      this.report();
    }
    return sent;
  }

  private emitModel(): void {
    this.emit({ type: "model", model: this.modelState() });
  }

  private modelState(): ModelState {
    return { models: this.models, current: this.model };
  }
}

// The port the serve chose, from its `opencode server listening on …` line.
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
