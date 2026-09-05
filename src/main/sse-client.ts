export interface ServerEvent { event: string; data: string; id?: string }

export function createEventParser(deliver: (event: ServerEvent) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    for (;;) {
      const separator = /\r?\n\r?\n/.exec(buffer);
      if (!separator) break;
      if (separator.index > 64 * 1024) throw new Error("event frame too large");
      const frame = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      const item: ServerEvent = { event: "message", data: "" };
      const data: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        const key = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (key === "event") item.event = value;
        if (key === "data") data.push(value);
        if (key === "id" && !value.includes("\0")) item.id = value;
      }
      if (data.length) { item.data = data.join("\n"); deliver(item); }
    }
    if (buffer.length > 64 * 1024) throw new Error("event frame too large");
  };
}

export function subscribeToEvents(options: {
  url: string;
  request?: () => Promise<RequestInit>;
  onEvent(event: ServerEvent): void;
  onError?(message: string): void;
}): () => void {
  let stopped = false;
  let cursor = "";
  let backoff = 5_000;
  let retry: NodeJS.Timeout | undefined;
  let connection: AbortController | undefined;
  const connect = async (): Promise<void> => {
    if (stopped) return;
    const controller = new AbortController();
    connection = controller;
    let deadline: NodeJS.Timeout;
    const arm = (ms: number): void => {
      clearTimeout(deadline);
      deadline = setTimeout(() => controller.abort(), ms);
      deadline.unref();
    };
    arm(30_000);
    const began = Date.now();
    let retryFloor = 0;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const init = await options.request?.();
      if (stopped) return;
      const headers = new Headers(init?.headers);
      headers.set("accept", "text/event-stream");
      if (cursor) headers.set("last-event-id", cursor);
      const response = await fetch(options.url, { ...init, headers, signal: controller.signal, redirect: "error" });
      if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
        const retryAfter = response.headers.get("retry-after") ?? "";
        const retryMs = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1_000 : Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(retryMs)) retryFloor = Math.max(0, Math.min(3_600_000, retryMs));
        await response.body?.cancel();
        throw new Error(`event stream HTTP ${response.status}`);
      }
      arm(75_000);
      const parse = createEventParser((event) => {
        options.onEvent(event);
        if (event.id !== undefined) cursor = event.id;
      });
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        arm(75_000);
        parse(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      if (!stopped) options.onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(deadline!);
      controller.abort();
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
      if (!stopped) {
        if (Date.now() - began > 60_000) backoff = 5_000;
        retry = setTimeout(() => void connect(), Math.max(backoff, retryFloor) + Math.floor(Math.random() * backoff / 4));
        retry.unref();
        backoff = Math.min(backoff * 2, 300_000);
      }
    }
  };
  void connect();
  return () => { stopped = true; clearTimeout(retry); connection?.abort(); };
}
