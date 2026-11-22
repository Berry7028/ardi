// A thin HTTP+SSE client for `opencode serve` (the OpenCode 2 /api surface).

export type OcEvent = { id: string; type: string; data: Record<string, unknown> };

export class OcClient {
  private readonly auth: string;

  constructor(
    private readonly base: string,
    password: string,
  ) {
    // The serve expects HTTP Basic (`opencode:<password>`) or ?auth_token=.
    this.auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  }

  get<T>(path: string): Promise<T> {
    return this.req("GET", path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.req("POST", path, body);
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.req("PATCH", path, body);
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: this.auth };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`opencode ${method} ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  // The server's event stream: `data:` lines of {id,type,data}. Yields until
  // the signal aborts or the stream ends; never throws past the first connect
  // (a lost stream ends the generator).
  async *events(signal: AbortSignal): AsyncGenerator<OcEvent> {
    const response = await fetch(`${this.base}/api/event`, { signal, headers: { Accept: "text/event-stream", Authorization: this.auth } });
    if (!response.ok || !response.body) throw new Error(`opencode GET /api/event: HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let at: number;
        while ((at = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, at).trimEnd();
          buffer = buffer.slice(at + 1);
          if (!line.startsWith("data:")) continue;
          try {
            yield JSON.parse(line.slice(5).trim()) as OcEvent;
          } catch {
            // Not JSON.
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }
}
