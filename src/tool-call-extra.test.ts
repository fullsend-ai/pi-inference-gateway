import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProvider, normalizeContext } from "@earendil-works/pi-ai";
import type { AssistantMessage, FetchFunction, Model, Provider } from "@earendil-works/pi-ai";
import type { DiscoverableApi, GatewayApi, GatewayConfig } from "./config.ts";
import { buildModel, parseModelEntry } from "./discovery.ts";
import { gatewayProviderOptions } from "./provider.ts";
import { openAICompletionsSse, openAICompletionsToolCallSse, openAIResponsesSse } from "./test-fixtures.ts";
import {
  EXTRA_MARKER,
  decodeToolCallId,
  encodeToolCallId,
  restoreRequestBody,
  rewriteChunk,
  rewriteSseStream,
  withToolCallExtra,
} from "./tool-call-extra.ts";

const SIGNATURE = "c2lnLWdlbWluaS10ZXN0";
const EXTRA = { google: { thought_signature: SIGNATURE } };

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("encodeToolCallId / decodeToolCallId", () => {
  it("round-trips the id, the extra_content and the model", () => {
    const id = encodeToolCallId("call_123", { extra: EXTRA, model: "gemini-4-neon" });
    assert.ok(id.startsWith(`call_123${EXTRA_MARKER}`));
    assert.match(id.slice(`call_123${EXTRA_MARKER}`.length), /^[A-Za-z0-9_-]+$/, "the suffix is base64url");
    assert.deepEqual(decodeToolCallId(id), { id: "call_123", extra: EXTRA, model: "gemini-4-neon" });
  });

  it("round-trips without a model", () => {
    assert.deepEqual(decodeToolCallId(encodeToolCallId("c", { extra: { a: 1 } })), { id: "c", extra: { a: 1 } });
  });

  it("keeps an id that itself contains the marker: the last marker starts the suffix", () => {
    const id = encodeToolCallId("a.xc.b", { extra: { a: 1 } });
    assert.equal(decodeToolCallId(id)?.id, "a.xc.b");
  });

  for (const [name, id] of [
    ["no marker", "call_123"],
    ["agentgateway's __thought__ id", "call_1__thought__c2lnLXRlc3Q"],
    ["a suffix outside base64url", "call_1.xc.not+base64"],
    ["a suffix that is not JSON", `call_1.xc.${Buffer.from("nope").toString("base64url")}`],
    ["a payload without an object x", `call_1.xc.${Buffer.from(JSON.stringify({ x: [1] })).toString("base64url")}`],
    ["a non-string model", `call_1.xc.${Buffer.from(JSON.stringify({ m: 1, x: {} })).toString("base64url")}`],
    ["an empty original id", `.xc.${Buffer.from(JSON.stringify({ x: {} })).toString("base64url")}`],
  ] as const) {
    it(`does not decode ${name}`, () => assert.equal(decodeToolCallId(id), undefined));
  }
});

describe("restoreRequestBody", () => {
  const carried = (model?: string) => encodeToolCallId("call_1", { extra: EXTRA, ...(model ? { model } : {}) });
  const body = (model: string, id: string, callExtra?: Record<string, unknown>) =>
    JSON.stringify({
      model,
      messages: [
        { role: "user", content: "read a.txt" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id, type: "function", function: { name: "read", arguments: "{}" }, ...(callExtra ? { extra_content: callExtra } : {}) }],
        },
        { role: "tool", tool_call_id: id, content: "hello" },
      ],
    });

  it("same model: restores both ids and puts extra_content back on the tool call", () => {
    const restored = JSON.parse(restoreRequestBody(body("gemini-4-neon", carried("gemini-4-neon"))) ?? "null");
    assert.equal(restored.messages[1].tool_calls[0].id, "call_1");
    assert.deepEqual(restored.messages[1].tool_calls[0].extra_content, EXTRA);
    assert.equal(restored.messages[2].tool_call_id, "call_1");
  });

  it("another model: restores the ids and drops the carried extra_content", () => {
    const restored = JSON.parse(restoreRequestBody(body("glm-5-3", carried("gemini-4-neon"))) ?? "null");
    assert.equal(restored.messages[1].tool_calls[0].id, "call_1");
    assert.equal("extra_content" in restored.messages[1].tool_calls[0], false);
    assert.equal(restored.messages[2].tool_call_id, "call_1");
  });

  it("no recorded model: puts extra_content back for any model", () => {
    const restored = JSON.parse(restoreRequestBody(body("anything", carried())) ?? "null");
    assert.deepEqual(restored.messages[1].tool_calls[0].extra_content, EXTRA);
  });

  it("an extra_content already on the call wins, key by key", () => {
    const restored = JSON.parse(restoreRequestBody(body("m", carried("m"), { google: { other: 1 }, own: true })) ?? "null");
    assert.deepEqual(restored.messages[1].tool_calls[0].extra_content, { google: { other: 1 }, own: true });
  });

  it("returns undefined when nothing needs restoring", () => {
    assert.equal(restoreRequestBody(body("m", "call_1")), undefined);
    assert.equal(restoreRequestBody(body("m", "call_1__thought__c2ln")), undefined);
    assert.equal(restoreRequestBody("not json .xc. at all"), undefined);
    assert.equal(restoreRequestBody(JSON.stringify({ input: ".xc." })), undefined);
  });
});

describe("rewriteChunk", () => {
  const chunk = (call: Record<string, unknown>) => JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [call] } }] });

  it("suffixes the id of a tool call that carries extra_content, recording the model", () => {
    const out = JSON.parse(rewriteChunk(chunk({ id: "call_1", index: 0, extra_content: EXTRA }), "m") ?? "null");
    assert.deepEqual(decodeToolCallId(out.choices[0].delta.tool_calls[0].id), { id: "call_1", extra: EXTRA, model: "m" });
  });

  it("leaves tool calls without extra_content, without an id, or already carried", () => {
    assert.equal(rewriteChunk(chunk({ id: "call_1", index: 0 })), undefined);
    assert.equal(rewriteChunk(chunk({ index: 0, extra_content: EXTRA })), undefined);
    assert.equal(rewriteChunk(chunk({ id: "", index: 0, extra_content: EXTRA })), undefined);
    assert.equal(rewriteChunk(chunk({ id: encodeToolCallId("c", { extra: EXTRA }), index: 0, extra_content: EXTRA })), undefined);
    assert.equal(rewriteChunk("[DONE]"), undefined);
    assert.equal(rewriteChunk('{"extra_content": not json'), undefined);
  });
});

describe("rewriteSseStream", () => {
  const sse = openAICompletionsToolCallSse("gemini-4-neon", { id: "call_1", name: "read", args: { path: "a.txt" }, extraContent: EXTRA });

  it("rewrites the id when the stream splits the data line mid-line and mid-character", async () => {
    const unicode = openAICompletionsToolCallSse("gemini-4-neon", { id: "call_1", name: "read", args: { path: "ä.txt" }, extraContent: EXTRA });
    const bytes = new TextEncoder().encode(unicode);
    const midLine = new TextEncoder().encode(unicode.slice(0, unicode.indexOf("thought_signature") + 5)).length;
    const midChar = new TextEncoder().encode(unicode.slice(0, unicode.indexOf("ä"))).length + 1; // inside the 2-byte ä
    const [a, b] = [Math.min(midLine, midChar), Math.max(midLine, midChar)];
    const parts = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of [bytes.slice(0, a), bytes.slice(a, b), bytes.slice(b)]) controller.enqueue(part);
        controller.close();
      },
    });
    const rewritten = await text(rewriteSseStream(parts, "gemini-4-neon"));
    const first = JSON.parse(rewritten.split("\n")[0].slice("data: ".length));
    assert.deepEqual(decodeToolCallId(first.choices[0].delta.tool_calls[0].id), { id: "call_1", extra: EXTRA, model: "gemini-4-neon" });
    assert.equal(first.choices[0].delta.tool_calls[0].function.arguments, JSON.stringify({ path: "ä.txt" }));
    assert.ok(rewritten.endsWith("data: [DONE]\n\n"));
  });

  it("splits into one-byte chunks and still gets the same result", async () => {
    const bytes = new TextEncoder().encode(sse);
    const oneByte = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    const whole = await text(rewriteSseStream(streamOf([sse]), "m"));
    assert.equal(await text(rewriteSseStream(oneByte, "m")), whole);
    assert.notEqual(whole, sse);
  });

  it("keeps CRLF line endings", async () => {
    const crlf = sse.replaceAll("\n", "\r\n");
    const out = await text(rewriteSseStream(streamOf([crlf]), "m"));
    assert.equal(out.split("\r\n").length, crlf.split("\r\n").length);
    assert.ok(out.includes(EXTRA_MARKER));
  });

  it("a stream without extra_content comes out byte for byte", async () => {
    const plain = [
      openAICompletionsSse("glm-5-3", "hello ünïcode", "thinking"),
      openAICompletionsToolCallSse("gemini-4-neon", { id: "call_1__thought__c2lnLXRlc3Q", name: "read", args: { path: "a.txt" } }),
      ": keep-alive comment\r\nevent: x\ndata:{\"tight\":true}\n\ndata: unterminated",
    ];
    for (const input of plain) {
      assert.equal(await text(rewriteSseStream(streamOf([input.slice(0, 7), input.slice(7)]), "m")), input);
    }
  });
});

describe("withToolCallExtra", () => {
  const sseResponse = (body: string, headers: Record<string, string> = {}) =>
    new Response(body, { status: 200, headers: { "content-type": "text/event-stream", ...headers } });

  it("leaves other paths and non-string bodies alone", async () => {
    const original = sseResponse(openAICompletionsToolCallSse("m", { id: "c", name: "read", args: {}, extraContent: EXTRA }));
    const inner: FetchFunction = async () => original;
    const fetch = withToolCallExtra(inner);
    assert.equal(await fetch("https://gw.example.com/v1/responses", { method: "POST", body: "{}" }), original);
    assert.equal(await fetch("https://gw.example.com/v1/chat/completions", { method: "POST" }), original);
  });

  it("drops content-length from a rewritten stream and passes a JSON response through", async () => {
    const sse = openAICompletionsToolCallSse("m", { id: "c", name: "read", args: {}, extraContent: EXTRA });
    const fetch = withToolCallExtra(async () => sseResponse(sse, { "content-length": String(sse.length), "x-request-id": "r1" }));
    const response = await fetch("https://gw.example.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "m" }) });
    assert.equal(response.headers.has("content-length"), false);
    assert.equal(response.headers.get("x-request-id"), "r1");
    assert.ok((await response.text()).includes(EXTRA_MARKER));

    const json = new Response("{}", { headers: { "content-type": "application/json" } });
    assert.equal(await withToolCallExtra(async () => json)("https://gw.example.com/v1/chat/completions", { body: "{}" }), json);
  });
});

// --- through pi's real transport -----------------------------------------------------------------

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    id: "gateway",
    baseUrl: "https://gw.example.com",
    apiKeyEnv: "GW_KEY",
    authHeaders: {},
    defaultApi: "openai-responses",
    headers: {},
    modelsPath: "/v1/models",
    include: [],
    exclude: [],
    models: {},
    fallbackModels: [],
    ...overrides,
  };
}

const GEMINI = "acme/test-gemini";
const OTHER = "acme/test-chat";

function provider(): Provider<GatewayApi> {
  const cfg = config();
  const models = ([[GEMINI, "openai-completions"], [OTHER, "openai-completions"], ["test-gpt", "openai-responses"]] as Array<[string, DiscoverableApi]>).map(
    ([id, api]) => {
      const entry = parseModelEntry({ id, api });
      assert.ok(entry);
      return buildModel(entry, cfg);
    },
  );
  return createProvider(gatewayProviderOptions(cfg, models, { env: { GW_KEY: "tok" } }));
}

function modelOf(p: Provider<GatewayApi>, id: string): Model<GatewayApi> {
  const found = p.getModels().find((entry) => entry.id === id);
  assert.ok(found, `${id} should be registered`);
  return found;
}

interface ChatRequest {
  model: string;
  messages: Array<{ role: string; tool_call_id?: string; tool_calls?: Array<{ id: string; extra_content?: unknown }> }>;
}

/**
 * A gateway double for two turns: turn 1 answers with `firstTurn`, every later turn with text, after
 * checking the replayed tool call the way Praxis does (a 400 without extra_content when `strict`).
 */
function twoTurnGateway(firstTurn: string, { strict = false }: { strict?: boolean } = {}) {
  const requests: ChatRequest[] = [];
  const seen: Array<{ headers: Headers; redirect: RequestRedirect | undefined; path: string }> = [];
  const fetch: FetchFunction = async (input, init) => {
    const request = new Request(input, init);
    seen.push({ headers: new Headers(request.headers), redirect: init?.redirect, path: new URL(request.url).pathname });
    const body = JSON.parse(await request.text()) as ChatRequest;
    requests.push(body);
    if (requests.length === 1) return new Response(firstTurn, { status: 200, headers: { "content-type": "text/event-stream" } });
    const replayed = body.messages.flatMap((message) => message.tool_calls ?? []);
    if (strict && replayed.some((call) => call.extra_content === undefined)) {
      return new Response(JSON.stringify({ error: { message: "Function call is missing a thought_signature", code: 400 } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(openAICompletionsSse(body.model, "done"), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { requests, seen, fetch };
}

const TOOLS = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }];
const USER = { role: "user" as const, content: "read a.txt", timestamp: 0 };

async function runTwoTurns(
  gw: ReturnType<typeof twoTurnGateway>,
  firstModel: string,
  secondModel: string = firstModel,
): Promise<{ first: AssistantMessage; second: AssistantMessage; callId: string }> {
  const p = provider();
  const first = await p.streamSimple(modelOf(p, firstModel), normalizeContext({ messages: [USER], tools: TOOLS }), { apiKey: "tok", fetch: gw.fetch }).result();
  assert.equal(first.stopReason, "toolUse", first.errorMessage ?? "");
  const call = first.content.find((block) => block.type === "toolCall");
  assert.ok(call?.type === "toolCall");
  const result = { role: "toolResult" as const, toolCallId: call.id, toolName: "read", content: [{ type: "text" as const, text: "hello" }], isError: false, timestamp: 0 };
  const second = await p
    .streamSimple(modelOf(p, secondModel), normalizeContext({ messages: [USER, first, result], tools: TOOLS }), { apiKey: "tok", fetch: gw.fetch })
    .result();
  return { first, second, callId: call.id };
}

describe("pi end to end: Chat Completions tool calls carry extra_content to the next turn", () => {
  it("Praxis shape: turn 2 carries extra_content on the replayed call, with the gateway's own ids", async () => {
    const gw = twoTurnGateway(openAICompletionsToolCallSse(GEMINI, { id: "call_1", name: "read", args: { path: "a.txt" }, extraContent: EXTRA }), {
      strict: true,
    });
    const { second, callId } = await runTwoTurns(gw, GEMINI);
    assert.equal(second.stopReason, "stop", second.errorMessage ?? "");
    assert.ok(callId.startsWith(`call_1${EXTRA_MARKER}`), "pi stores the carrying id");
    const assistant = gw.requests[1].messages.find((message) => message.role === "assistant");
    assert.equal(assistant?.tool_calls?.[0].id, "call_1");
    assert.deepEqual(assistant?.tool_calls?.[0].extra_content, EXTRA);
    assert.equal(gw.requests[1].messages.find((message) => message.role === "tool")?.tool_call_id, "call_1");
    for (const { headers, redirect } of gw.seen) {
      assert.equal(redirect, "error", "the composed fetch still refuses redirects");
      assert.equal(headers.get("authorization"), "Bearer tok");
      assert.equal(headers.has("x-api-key"), false, "still exactly one auth header");
    }
  });

  it("agentgateway shape: a __thought__ id without extra_content goes back unchanged", async () => {
    const agwId = "call_1__thought__c2lnLWdlbWluaS10ZXN0";
    const gw = twoTurnGateway(openAICompletionsToolCallSse(GEMINI, { id: agwId, name: "read", args: { path: "a.txt" } }));
    const { second, callId } = await runTwoTurns(gw, GEMINI);
    assert.equal(second.stopReason, "stop", second.errorMessage ?? "");
    assert.equal(callId, agwId);
    const assistant = gw.requests[1].messages.find((message) => message.role === "assistant");
    assert.equal(assistant?.tool_calls?.[0].id, agwId);
    assert.equal(assistant?.tool_calls?.[0].extra_content, undefined);
    assert.equal(gw.requests[1].messages.find((message) => message.role === "tool")?.tool_call_id, agwId);
  });

  it("switching to another model drops the carried extra_content but keeps the ids paired", async () => {
    const gw = twoTurnGateway(openAICompletionsToolCallSse(GEMINI, { id: "call_1", name: "read", args: { path: "a.txt" }, extraContent: EXTRA }));
    const { second } = await runTwoTurns(gw, GEMINI, OTHER);
    assert.equal(second.stopReason, "stop", second.errorMessage ?? "");
    const assistant = gw.requests[1].messages.find((message) => message.role === "assistant");
    assert.equal(assistant?.tool_calls?.[0].id, "call_1");
    assert.equal(assistant?.tool_calls?.[0].extra_content, undefined);
    assert.equal(gw.requests[1].messages.find((message) => message.role === "tool")?.tool_call_id, "call_1");
  });

  it("does not touch the Responses transport", async () => {
    const p = provider();
    const bodies: string[] = [];
    const sse = openAIResponsesSse("test-gpt", "ok");
    const fetch: FetchFunction = async (input, init) => {
      bodies.push(await new Request(input, init).text());
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const message = await p.streamSimple(modelOf(p, "test-gpt"), normalizeContext({ messages: [USER] }), { apiKey: "tok", fetch }).result();
    assert.equal(message.stopReason, "stop", message.errorMessage ?? "");
    assert.equal(bodies.length, 1);
  });
});
