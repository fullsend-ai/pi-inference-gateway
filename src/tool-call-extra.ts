import type { FetchFunction } from "@earendil-works/pi-ai";

/**
 * Carries a tool call's `extra_content` through pi's Chat Completions transport.
 *
 * Some gateways attach opaque per-call data to each streamed tool call as `extra_content` and need
 * it back on that call in the next request. Gemini's `thought_signature`
 * (`extra_content.google.thought_signature`) is the case that matters: without it, turn 2 is a 400.
 * pi's transport keeps neither the field nor any unknown field, but it does keep the tool-call id
 * verbatim (for every provider except `openai`, and for ids without `|`) and stores it in the session.
 *
 * So, on Chat Completions only:
 * - **response**: a streamed tool call that carries `extra_content` gets its id rewritten to
 *   `<id>.xc.<base64url(JSON of extra_content)>`;
 * - **request**: every id with that suffix is restored to `<id>`, and the decoded object is put
 *   back as that tool call's `extra_content`. Tool results get the plain id.
 *
 * Nothing in here knows what is inside `extra_content`. A stream with no `extra_content` is passed
 * through byte for byte, and a request with no suffixed id is sent unchanged, so gateways that
 * carry the data some other way (agentgateway's `<id>__thought__<sig>`) are not touched.
 *
 * Only the chunk that carries the id is rewritten: pi takes a tool call's id from the first chunk
 * that has one. `extra_content` that arrives on a later chunk than the id is not carried.
 */

/** `.` is outside the base64url alphabet, so the last `.xc.` always starts the suffix. */
export const EXTRA_MARKER = ".xc.";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodeToolCallId(id: string, extra: Record<string, unknown>): string {
  return `${id}${EXTRA_MARKER}${Buffer.from(JSON.stringify(extra), "utf8").toString("base64url")}`;
}

/** The original id and the carried object, or undefined when the id has no valid suffix. */
export function decodeToolCallId(id: string): { id: string; extra: Record<string, unknown> } | undefined {
  const at = id.lastIndexOf(EXTRA_MARKER);
  if (at < 0) return undefined;
  const payload = id.slice(at + EXTRA_MARKER.length);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return undefined;
  try {
    const extra: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isPlainObject(extra) ? { id: id.slice(0, at), extra } : undefined;
  } catch {
    return undefined;
  }
}

// --- request ------------------------------------------------------------------------------------

/**
 * A Chat Completions request body with every suffixed id restored and its `extra_content` put back,
 * or undefined when nothing changed (the caller then sends the original body).
 */
export function restoreRequestBody(body: string): string | undefined {
  if (!body.includes(EXTRA_MARKER)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.messages)) return undefined;
  let changed = false;
  for (const message of parsed.messages) {
    if (!isPlainObject(message)) continue;
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (!isPlainObject(call) || typeof call.id !== "string") continue;
        const decoded = decodeToolCallId(call.id);
        if (!decoded) continue;
        call.id = decoded.id;
        // A value pi (or a future pi) already sends wins over the carried one, key by key.
        call.extra_content = isPlainObject(call.extra_content) ? { ...decoded.extra, ...call.extra_content } : decoded.extra;
        changed = true;
      }
    }
    if (typeof message.tool_call_id === "string") {
      const decoded = decodeToolCallId(message.tool_call_id);
      if (decoded) {
        message.tool_call_id = decoded.id;
        changed = true;
      }
    }
  }
  return changed ? JSON.stringify(parsed) : undefined;
}

// --- response -----------------------------------------------------------------------------------

/** One SSE `data:` payload with tool-call ids rewritten, or undefined when it needs no change. */
export function rewriteChunk(data: string): string | undefined {
  if (!data.includes("extra_content")) return undefined;
  let chunk: unknown;
  try {
    chunk = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isPlainObject(chunk) || !Array.isArray(chunk.choices)) return undefined;
  let changed = false;
  for (const choice of chunk.choices) {
    const calls = isPlainObject(choice) && isPlainObject(choice.delta) ? choice.delta.tool_calls : undefined;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (!isPlainObject(call) || typeof call.id !== "string" || call.id === "" || !isPlainObject(call.extra_content)) continue;
      if (decodeToolCallId(call.id)) continue; // already carried (a replayed or re-sent id)
      call.id = encodeToolCallId(call.id, call.extra_content);
      changed = true;
    }
  }
  return changed ? JSON.stringify(chunk) : undefined;
}

/**
 * Rewrites the `data:` lines of an SSE stream with {@link rewriteChunk}. Lines are split on `\n`
 * (an optional trailing `\r` is kept); every other line and every unchanged `data:` line is passed
 * through exactly as received.
 */
export function rewriteSseStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const rewriteLine = (line: string): string => {
    const cr = line.endsWith("\r") ? "\r" : "";
    const content = cr ? line.slice(0, -1) : line;
    if (!content.startsWith("data:")) return line;
    const data = content.slice(5).trimStart();
    const rewritten = rewriteChunk(data);
    return rewritten === undefined ? line : `data: ${rewritten}${cr}`;
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        pending += decoder.decode(bytes, { stream: true });
        const end = pending.lastIndexOf("\n");
        if (end < 0) return;
        const complete = pending.slice(0, end + 1);
        pending = pending.slice(end + 1);
        controller.enqueue(encoder.encode(complete.split("\n").map(rewriteLine).join("\n")));
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending) controller.enqueue(encoder.encode(rewriteLine(pending)));
      },
    }),
  );
}

// --- fetch --------------------------------------------------------------------------------------

function requestPath(input: Parameters<FetchFunction>[0]): string {
  const raw = input instanceof Request ? input.url : String(input);
  try {
    return new URL(raw).pathname;
  } catch {
    return raw;
  }
}

/**
 * Wraps a fetch so Chat Completions requests and streamed responses carry `extra_content` (see the
 * module comment). Any other path, a non-string body, and a non-SSE response are left alone.
 */
export function withToolCallExtra(inner: FetchFunction): FetchFunction {
  return async (input, init) => {
    if (!requestPath(input).endsWith("/chat/completions")) return inner(input, init);
    const restored = typeof init?.body === "string" ? restoreRequestBody(init.body) : undefined;
    const response = await inner(input, restored === undefined ? init : { ...init, body: restored });
    const type = response.headers.get("content-type") ?? "";
    if (!response.body || !type.includes("text/event-stream")) return response;
    return new Response(rewriteSseStream(response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
