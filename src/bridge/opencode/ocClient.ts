// A thin HTTP+SSE client for `opencode serve`.

export type OcEvent = { id: string; type: string; properties: Record<string, unknown> };

export class OcClient {
  constructor(private readonly base: string) {}

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
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`opencode ${method} ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  // The server's event stream: `data:` lines of {id,type,properties}. Yields
  // until the signal aborts or the stream ends; never throws past the first
  // connect (a lost stream ends the generator).
  async *events(signal: AbortSignal): AsyncGenerator<OcEvent> {
    const response = await fetch(`${this.base}/event`, { signal, headers: { Accept: "text/event-stream" } });
    if (!response.ok || !response.body) throw new Error(`opencode GET /event: HTTP ${response.status}`);
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
