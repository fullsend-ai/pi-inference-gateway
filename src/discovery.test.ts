import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { FetchFunction } from "@earendil-works/pi-ai";
import type { GatewayConfig } from "./config.ts";
import {
  DEFAULTS,
  LIMITS,
  baseUrlFor,
  buildModel,
  catalogCandidates,
  discoverModels,
  discoveryHeaders,
  fallbackModels,
  fetchModelList,
  findCatalogModel,
  globMatch,
  isIncluded,
  modelsFromList,
  parseModelEntry,
  parseModelList,
  selectApi,
  separatorVariants,
  stripVendorPrefix,
} from "./discovery.ts";

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    id: "gateway",
    baseUrl: "https://gw.example.com",
    apiKeyEnv: "INFERENCE_GATEWAY_API_KEY",
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

/** Real catalog ids, so these tests keep asserting something true after a pi bump. */
const ANTHROPIC_ID = getBuiltinModels("anthropic")[0].id;
const OPENAI_ID = getBuiltinModels("openai")[0].id;

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(respond: (call: Call) => Response | Promise<Response>): { calls: Call[]; fetch: FetchFunction } {
  const calls: Call[] = [];
  const fetch: FetchFunction = async (input, init) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetch };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

describe("parseModelList shapes", () => {
  it("parses the OpenAI list shape", () => {
    const { entries, dropped } = parseModelList({
      object: "list",
      data: [
        { id: "claude-sonnet-5", object: "model", created: 0, owned_by: "anthropic" },
        { id: "gpt-6-luna", object: "model", created: 0, owned_by: "openai" },
      ],
    });
    assert.equal(dropped, 0);
    assert.deepEqual(
      entries.map((entry) => [entry.id, entry.owners]),
      [
        ["claude-sonnet-5", ["anthropic"]],
        ["gpt-6-luna", ["openai"]],
      ],
    );
  });

  it("parses a {models:[...]} body", () => {
    const { entries } = parseModelList({ models: [{ id: "a" }, { name: "b" }] });
    assert.deepEqual(
      entries.map((entry) => entry.id),
      ["a", "b"],
    );
  });

  it("parses a bare array of objects or strings (agentgateway-style)", () => {
    const { entries } = parseModelList(["m1", { id: "m2" }, { model: "m3" }]);
    assert.deepEqual(
      entries.map((entry) => entry.id),
      ["m1", "m2", "m3"],
    );
  });

  it("rejects a body without a list", () => {
    assert.throws(() => parseModelList({ object: "list" }), /no `data` or `models` array/);
    assert.throws(() => parseModelList("models"), /no `data` or `models` array/);
    assert.throws(() => parseModelList(null), /no `data` or `models` array/);
  });

  it("keeps vendor/model ids verbatim", () => {
    const { entries } = parseModelList({ data: [{ id: "anthropic/claude-sonnet-5" }, { id: "vertex_ai/gemini-x" }] });
    assert.deepEqual(
      entries.map((entry) => entry.id),
      ["anthropic/claude-sonnet-5", "vertex_ai/gemini-x"],
    );
  });
});

describe("parseModelEntry LiteLLM-style fields", () => {
  it("reads flat LiteLLM model-info fields", () => {
    const entry = parseModelEntry({
      id: "claude-x",
      owned_by: "openai",
      litellm_provider: "vertex_ai-anthropic_models",
      max_input_tokens: 200000,
      max_output_tokens: 64000,
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
      cache_read_input_token_cost: 3e-7,
      cache_creation_input_token_cost: 0.00000375,
      supports_vision: true,
      supports_reasoning: true,
      supported_endpoints: ["/v1/messages", "/v1/chat/completions"],
    });
    assert.ok(entry);
    assert.deepEqual(entry.owners, ["openai", "vertex_ai-anthropic_models"]);
    assert.equal(entry.contextWindow, 200000);
    assert.equal(entry.maxTokens, 64000);
    assert.deepEqual(entry.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    assert.equal(entry.vision, true);
    assert.equal(entry.reasoning, true);
    assert.deepEqual(entry.endpoints, ["/v1/messages", "/v1/chat/completions"]);
  });

  it("reads LiteLLM /model/info entries (model_name + nested model_info)", () => {
    const entry = parseModelEntry({
      model_name: "team-claude",
      litellm_params: { model: "anthropic/claude-sonnet-5" },
      model_info: { litellm_provider: "anthropic", max_tokens: 8192, supports_vision: false },
    });
    assert.ok(entry);
    assert.equal(entry.id, "team-claude");
    assert.deepEqual(entry.owners, ["anthropic"]);
    assert.equal(entry.maxTokens, 8192);
    assert.equal(entry.vision, false);
  });

  it("reads context_window / context_length / input_modalities / display_name", () => {
    assert.equal(parseModelEntry({ id: "a", context_window: 1000 })?.contextWindow, 1000);
    assert.equal(parseModelEntry({ id: "a", context_length: "2000" })?.contextWindow, 2000);
    assert.equal(parseModelEntry({ id: "a", input_modalities: ["text", "image"] })?.vision, true);
    assert.equal(parseModelEntry({ id: "a", input_modalities: ["text"] })?.vision, false);
    assert.equal(parseModelEntry({ id: "a", display_name: "Model A" })?.name, "Model A");
  });

  it("reads explicit api and endpoint hints", () => {
    assert.equal(parseModelEntry({ id: "a", api: "openai-completions" })?.api, "openai-completions");
    assert.equal(parseModelEntry({ id: "a", api: "google-vertex" })?.api, undefined);
    assert.deepEqual(parseModelEntry({ id: "a", endpoint: "/v1/responses" })?.endpoints, ["/v1/responses"]);
    assert.deepEqual(parseModelEntry({ id: "a", inference_endpoint: "/v1/messages" })?.endpoints, ["/v1/messages"]);
    assert.deepEqual(parseModelEntry({ id: "a", endpoints: ["/v1/chat/completions", 3] })?.endpoints, [
      "/v1/chat/completions",
    ]);
  });
});

describe("sanitisation", () => {
  it("drops ids that are empty, too long, non-string, or contain whitespace/control characters", () => {
    const { entries, dropped } = parseModelList({
      data: [
        { id: "" },
        { id: "x".repeat(LIMITS.maxIdLength + 1) },
        { id: "x".repeat(LIMITS.maxIdLength) },
        { id: 42 },
        { id: "a b" },
        { id: "a\u0000b" },
        { id: "a\u001bb" },
        { id: "ok" },
        null,
        [],
      ],
    });
    assert.deepEqual(
      entries.map((entry) => entry.id.length),
      [LIMITS.maxIdLength, 2],
    );
    assert.equal(dropped, 8);
  });

  it("keeps the first of duplicate ids", () => {
    const { entries, dropped } = parseModelList({ data: [{ id: "a", owned_by: "x" }, { id: "a", owned_by: "y" }] });
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].owners, ["x"]);
    assert.equal(dropped, 1);
  });

  it(`caps the list at ${LIMITS.maxModels} models`, () => {
    const data = Array.from({ length: LIMITS.maxModels + 5 }, (_, index) => ({ id: `m${index}` }));
    const { entries, dropped } = parseModelList({ data });
    assert.equal(entries.length, LIMITS.maxModels);
    assert.equal(dropped, 5);
  });

  it("accepts only positive bounded integers for token counts", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, LIMITS.maxTokenCount + 1, "12abc", true, null]) {
      assert.equal(parseModelEntry({ id: "a", context_window: bad })?.contextWindow, undefined, String(bad));
    }
    assert.equal(parseModelEntry({ id: "a", context_window: LIMITS.maxTokenCount })?.contextWindow, LIMITS.maxTokenCount);
  });

  it("accepts only finite, non-negative, bounded prices", () => {
    for (const bad of [-1, Number.NaN, Infinity, "abc", 1]) {
      assert.equal(parseModelEntry({ id: "a", input_cost_per_token: bad })?.cost, undefined, String(bad));
    }
    assert.deepEqual(parseModelEntry({ id: "a", input_cost_per_token: "0.000001" })?.cost, { input: 1 });
    assert.deepEqual(parseModelEntry({ id: "a", input_cost_per_token: 0 })?.cost, { input: 0 });
  });

  it("drops names with control characters", () => {
    assert.equal(parseModelEntry({ id: "a", display_name: "x\u0007y" })?.name, undefined);
  });
});

describe("fetchModelList", () => {
  it("GETs with redirect: error, the given headers and an abort signal", async () => {
    const { calls, fetch } = stubFetch(() => json({ data: [] }));
    await fetchModelList({ url: "https://gw.example.com/v1/models", headers: { authorization: "Bearer t" }, fetch });
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, "https://gw.example.com/v1/models");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer t");
    assert.equal(headers.get("accept"), "application/json");
  });

  it("turns a redirect into an error", async () => {
    // A real fetch with redirect: "error" throws a TypeError; a stub that returns the 3xx must fail too.
    const thrown = stubFetch(() => {
      throw new TypeError("fetch failed: unexpected redirect");
    });
    await assert.rejects(fetchModelList({ url: "https://gw.example.com/v1/models", headers: {}, fetch: thrown.fetch }), /request failed/);
    const returned = stubFetch(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/" } }));
    await assert.rejects(fetchModelList({ url: "https://gw.example.com/v1/models", headers: {}, fetch: returned.fetch }), /HTTP 302/);
  });

  it("rejects non-2xx responses; a text/plain body is shown with the request's credentials redacted", async () => {
    const { fetch } = stubFetch(() => new Response("denied for x-key-123456 here", { status: 401 }));
    await assert.rejects(fetchModelList({ url: "https://gw.example.com/v1/models", headers: { "x-api-key": "x-key-123456" }, fetch }), {
      message: "model list request returned HTTP 401: denied for [redacted] here",
    });
  });

  it("rejects a body declared over the size limit", async () => {
    const { fetch } = stubFetch(
      () => new Response("{}", { status: 200, headers: { "content-length": String(LIMITS.maxBodyBytes + 1) } }),
    );
    await assert.rejects(fetchModelList({ url: "https://gw.example.com/v1/models", headers: {}, fetch }), /over the/);
  });

  it("rejects a streamed body that grows over the size limit", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(32);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
        if (sent > LIMITS.maxBodyBytes * 4) controller.close();
      },
    });
    const { fetch } = stubFetch(() => new Response(stream, { status: 200 }));
    await assert.rejects(fetchModelList({ url: "https://gw.example.com/v1/models", headers: {}, fetch }), /exceeds/);
    assert.ok(sent <= LIMITS.maxBodyBytes + 2 * chunk.byteLength, `read ${sent} bytes before giving up`);
  });

  it("times out", async () => {
    const { fetch } = stubFetch(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    await assert.rejects(
      fetchModelList({ url: "https://gw.example.com/v1/models", headers: {}, fetch, timeoutMs: 20 }),
      /timed out after 20 ms/,
    );
  });

  it("honours the caller's signal", async () => {
    const controller = new AbortController();
    const { fetch } = stubFetch(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const pending = fetchModelList({ url: "https://gw.example.com/v1/models", headers: {}, fetch, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /request failed/);
  });

  it("rejects invalid JSON", async () => {
    const { fetch } = stubFetch(() => new Response("<html>", { status: 200 }));
    await assert.rejects(fetchModelList({ url: "https://gw.example.com/v1/models", headers: {}, fetch }), /not valid JSON/);
  });
});

describe("discovery error bodies without a content-type", () => {
  const TOKEN = "tok-untyped-0123456789"; // gitleaks:allow (test fixture)
  /** A byte body sets no content-type, unlike a string body (text/plain). */
  const untyped = (status: number, body: string | Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}): FetchFunction =>
    async () => {
      const response = new Response(typeof body === "string" ? new TextEncoder().encode(body) : body, { status, headers });
      assert.equal(response.headers.get("content-type"), headers["content-type"] ?? null);
      return response;
    };
  const http = (status: number, detail?: string) => ({
    message: `model list request returned HTTP ${status}${detail === undefined ? "" : `: ${detail}`}`,
  });

  it("shows a short plain body", async () => {
    await assert.rejects(discoverModels(config(), { token: TOKEN, fetch: untyped(401, "invalid API key") }), http(401, "invalid API key"));
  });

  it("treats an empty content-type like a missing one", async () => {
    const fetch = untyped(401, "invalid API key", { "content-type": "" });
    await assert.rejects(discoverModels(config(), { token: TOKEN, fetch }), http(401, "invalid API key"));
  });

  it("redacts the credential", async () => {
    const fetch = untyped(401, `invalid API key ${TOKEN}`);
    await assert.rejects(discoverModels(config(), { token: TOKEN, fetch }), http(401, "invalid API key [redacted]"));
  });

  it("truncates a long body without keeping a credential prefix", async () => {
    for (let offset = 480; offset <= 512; offset++) {
      const body = `${" ".repeat(offset - 1)}a${TOKEN}${"b".repeat(600)}`;
      await assert.rejects(discoverModels(config(), { token: TOKEN, fetch: untyped(401, body) }), (error: Error) => {
        for (let length = 1; length <= TOKEN.length; length++) {
          assert.ok(!error.message.includes(`a${TOKEN.slice(0, length)}`), `offset ${offset}: prefix of length ${length} kept`);
        }
        return true;
      });
    }
    await assert.rejects(discoverModels(config(), { token: TOKEN, fetch: untyped(500, "x".repeat(5000)) }), (error: Error) => {
      assert.match(error.message, /^model list request returned HTTP 500: x{200}…$/);
      return true;
    });
  });

  it("keeps a multi-byte character cut by the read limit from hiding the body", async () => {
    // One ASCII byte first, so the 512-byte cut lands inside a two-byte "é".
    await assert.rejects(discoverModels(config(), { token: TOKEN, fetch: untyped(500, `a${"é".repeat(600)}`) }), (error: Error) => {
      assert.match(error.message, /^model list request returned HTTP 500: aé{199}…$/);
      return true;
    });
  });

  it("omits the body when a credential is shorter than 8 characters", async () => {
    await assert.rejects(discoverModels(config(), { token: "k9z", fetch: untyped(401, "token k9z rejected") }), http(401, "(body omitted)"));
  });

  it("still does not echo JSON or HTML bodies", async () => {
    const json = untyped(401, `{"error":"invalid API key"}`, { "content-type": "application/json" });
    await assert.rejects(discoverModels(config(), { token: TOKEN, fetch: json }), http(401));
    const html = untyped(502, "<html>bad</html>", { "content-type": "text/html" });
    await assert.rejects(discoverModels(config(), { token: TOKEN, fetch: html }), http(502));
  });

  it("adds nothing for an empty or non-UTF-8 body", async () => {
    await assert.rejects(discoverModels(config(), { token: TOKEN, fetch: untyped(401, "") }), http(401));
    const binary = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x41]);
    await assert.rejects(discoverModels(config(), { token: TOKEN, fetch: untyped(401, binary) }), http(401));
  });
});

describe("selectApi precedence", () => {
  const entry = (fields: Record<string, unknown>) => {
    const parsed = parseModelEntry({ id: "custom-model", ...fields });
    assert.ok(parsed);
    return parsed;
  };

  it("1. config override beats everything", () => {
    const cfg = config({ models: { "custom-model": { api: "openai-completions" } } });
    assert.equal(selectApi(entry({ api: "anthropic-messages", owned_by: "anthropic" }), cfg), "openai-completions");
  });

  it("2. gateway `api` hint beats endpoints and owner", () => {
    assert.equal(
      selectApi(entry({ api: "openai-completions", supported_endpoints: ["/v1/messages"], owned_by: "anthropic" }), config()),
      "openai-completions",
    );
  });

  it("2. endpoints: messages for Anthropic owners, else responses, else chat", () => {
    const all = ["/v1/messages", "/v1/responses", "/v1/chat/completions"];
    assert.equal(selectApi(entry({ supported_endpoints: all, owned_by: "anthropic" }), config()), "anthropic-messages");
    assert.equal(selectApi(entry({ supported_endpoints: all, owned_by: "openai" }), config()), "openai-responses");
    assert.equal(selectApi(entry({ supported_endpoints: all }), config()), "openai-responses");
    assert.equal(selectApi(entry({ supported_endpoints: ["/v1/chat/completions"], owned_by: "anthropic" }), config()), "openai-completions");
    assert.equal(selectApi(entry({ supported_endpoints: ["/v1/messages"] }), config()), "anthropic-messages");
    assert.equal(selectApi(entry({ endpoint: "/v1/chat/completions" }), config()), "openai-completions");
    assert.equal(selectApi(entry({ inference_endpoint: "/v1/responses/" }), config()), "openai-responses");
  });

  it("2. endpoints beat owner", () => {
    assert.equal(selectApi(entry({ endpoints: ["/v1/chat/completions"], owned_by: "openai" }), config()), "openai-completions");
  });

  it("5. owner: anthropic variants → messages, openai/azure → responses", () => {
    for (const owner of ["anthropic", "Anthropic", "vertex_ai-anthropic_models"]) {
      assert.equal(selectApi(entry({ owned_by: owner }), config({ defaultApi: "openai-completions" })), "anthropic-messages", owner);
    }
    assert.equal(selectApi(entry({ litellm_provider: "anthropic" }), config({ defaultApi: "openai-completions" })), "anthropic-messages");
    for (const owner of ["openai", "azure", "openai-internal"]) {
      assert.equal(selectApi(entry({ provider: owner }), config({ defaultApi: "openai-completions" })), "openai-responses", owner);
    }
  });

  it("3 before 5: the pi catalog beats the owner (agentgateway reports owned_by openai for Claude)", () => {
    const parsed = parseModelEntry({ id: ANTHROPIC_ID, owned_by: "openai" });
    assert.ok(parsed);
    assert.equal(selectApi(parsed, config()), "anthropic-messages");
    const gpt = parseModelEntry({ id: OPENAI_ID, owned_by: "anthropic" });
    assert.ok(gpt);
    assert.equal(selectApi(gpt, config()), "openai-responses");
  });

  it("4 before 5: a claude- id beats an openai owner", () => {
    assert.equal(selectApi(entry({ id: "claude-future-9", owned_by: "openai" }), config()), "anthropic-messages");
  });

  it("5 before 6: an owner beats an other-provider catalog hit", () => {
    const gemini = parseModelEntry({ id: getBuiltinModels("google")[0].id, owned_by: "openai" });
    assert.ok(gemini);
    assert.equal(selectApi(gemini, config()), "openai-responses");
  });

  it("3. pi catalog: anthropic id → messages, openai id → responses, also after a vendor prefix", () => {
    const cfg = config({ defaultApi: "openai-completions" });
    for (const [id, api] of [
      [ANTHROPIC_ID, "anthropic-messages"],
      [`anthropic/${ANTHROPIC_ID}`, "anthropic-messages"],
      [OPENAI_ID, "openai-responses"],
      [`openai/${OPENAI_ID}`, "openai-responses"],
    ]) {
      const parsed = parseModelEntry({ id, owned_by: "system" });
      assert.ok(parsed);
      assert.equal(selectApi(parsed, cfg), api, id);
    }
  });

  it("5. ambiguous owners (hosts, aggregators, placeholders) are no signal", () => {
    const cfg = config({ defaultApi: "openai-completions" });
    for (const owner of ["vertex", "bedrock", "azure_ai", "openrouter", "system", "library", ""]) {
      assert.equal(selectApi(entry({ owned_by: owner }), cfg), "openai-completions", JSON.stringify(owner));
    }
    // ...so a Claude id the proxy reports as owned_by "vertex" still reaches the catalog rule.
    const claude = parseModelEntry({ id: ANTHROPIC_ID, owned_by: "vertex" });
    assert.ok(claude);
    assert.equal(selectApi(claude, cfg), "anthropic-messages");
  });

  it("4. a claude- id unknown to pi's anthropic catalog → messages, also after a vendor prefix", () => {
    const cfg = config({ defaultApi: "openai-completions" });
    for (const id of ["claude-future-9", "anthropic/claude-future-9", "a/b/claude-future-9"]) {
      const parsed = parseModelEntry({ id, owned_by: "vertex" });
      assert.ok(parsed);
      assert.equal(selectApi(parsed, cfg), "anthropic-messages", id);
    }
  });

  it("4 before 6: a Claude id only in an aggregator catalog still → messages", () => {
    // Aggregators (github-copilot, opencode, ...) list Claude ids with dotted versions that pi's
    // anthropic catalog spells differently; rule 6 would send these to chat completions.
    const aggregatorOnly = getBuiltinProviders()
      .flatMap((provider) => getBuiltinModels(provider).map((model) => model.id))
      .find((id) => stripVendorPrefix(id).startsWith("claude-") && findCatalogModel(id)?.source !== "anthropic");
    assert.ok(aggregatorOnly, "pi's catalog no longer lists a Claude id outside `anthropic`; drop this case");
    const parsed = parseModelEntry({ id: aggregatorOnly, owned_by: "vertex" });
    assert.ok(parsed);
    assert.equal(selectApi(parsed, config({ defaultApi: "openai-responses" })), "anthropic-messages");
  });

  it("6. pi catalog under any other provider → chat completions, never a native API", () => {
    const gemini = getBuiltinModels("google")[0];
    assert.equal(gemini.api, "google-generative-ai", "control: pi's own transport for it is native");
    const parsed = parseModelEntry({ id: gemini.id, owned_by: "vertex" });
    assert.ok(parsed);
    assert.equal(selectApi(parsed, config()), "openai-completions");
  });

  it("6. a vendor/org/model id with a dashed version matches the catalog's dotted one", () => {
    const parsed = parseModelEntry({ id: "oss/zai-org/glm-5-3" });
    assert.ok(parsed);
    const match = findCatalogModel(parsed.id);
    assert.ok(match, "glm-5-3 should match pi's glm-5.3");
    assert.equal(match.model.id, "glm-5.3");
    assert.equal(match.source, "zai");
    assert.equal(selectApi(parsed, config()), "openai-completions");
    const model = buildModel(parsed, config());
    assert.equal(model.id, "oss/zai-org/glm-5-3", "the request id stays verbatim");
    assert.equal(model.contextWindow, match.model.contextWindow);
    assert.equal(model.reasoning, match.model.reasoning);
  });

  it("7. defaultApi when nothing else matches", () => {
    assert.equal(selectApi(entry({ owned_by: "someone" }), config({ defaultApi: "openai-completions" })), "openai-completions");
    assert.equal(selectApi(entry({}), config()), "openai-responses");
  });
});

describe("baseUrlFor", () => {
  it("gives OpenAI transports /v1 and Anthropic the bare root", () => {
    assert.equal(baseUrlFor("anthropic-messages", "https://gw.example.com/p"), "https://gw.example.com/p");
    assert.equal(baseUrlFor("openai-responses", "https://gw.example.com/p"), "https://gw.example.com/p/v1");
    assert.equal(baseUrlFor("openai-completions", "https://gw.example.com"), "https://gw.example.com/v1");
  });
});

describe("separatorVariants / catalogCandidates", () => {
  it("swaps - and . only between digits", () => {
    assert.deepEqual(separatorVariants("glm-5-3"), ["glm-5-3", "glm-5.3"]);
    assert.deepEqual(separatorVariants("glm-5.3"), ["glm-5.3", "glm-5-3"]);
    assert.deepEqual(separatorVariants("gpt-4o"), ["gpt-4o"]);
    assert.deepEqual(separatorVariants("claude-haiku-4-5"), ["claude-haiku-4-5", "claude-haiku-4.5"]);
  });

  it("tries the exact id (and its variants), then without the vendor prefix", () => {
    assert.deepEqual(catalogCandidates("oss/zai-org/glm-5-3"), ["oss/zai-org/glm-5-3", "oss/zai-org/glm-5.3", "glm-5-3", "glm-5.3"]);
  });

  it("prefers an anthropic/openai hit over any other provider's", () => {
    assert.equal(findCatalogModel(ANTHROPIC_ID)?.source, "anthropic");
    assert.equal(findCatalogModel(OPENAI_ID)?.source, "openai");
  });
});

describe("findCatalogModel / stripVendorPrefix", () => {
  it("strips only for the lookup", () => {
    assert.equal(stripVendorPrefix("anthropic/claude-x"), "claude-x");
    assert.equal(stripVendorPrefix("a/b/c"), "c");
    assert.equal(stripVendorPrefix("plain"), "plain");
    assert.equal(findCatalogModel(`anthropic/${ANTHROPIC_ID}`)?.model.id, ANTHROPIC_ID);
    assert.equal(findCatalogModel("no-such-model-anywhere"), undefined);
  });
});

describe("buildModel metadata precedence", () => {
  const catalog = getBuiltinModels("anthropic").find((model) => model.id === ANTHROPIC_ID);
  assert.ok(catalog);

  it("config override → gateway → pi catalog → defaults, per field", () => {
    const entry = parseModelEntry({
      id: ANTHROPIC_ID,
      owned_by: "anthropic",
      max_output_tokens: 1234,
      input_cost_per_token: 0.000001,
    });
    assert.ok(entry);
    const model = buildModel(entry, config({ models: { [ANTHROPIC_ID]: { contextWindow: 4321, name: "Pinned" } } }));
    assert.equal(model.name, "Pinned", "config");
    assert.equal(model.contextWindow, 4321, "config");
    assert.equal(model.maxTokens, 1234, "gateway");
    assert.equal(model.cost.input, 1, "gateway");
    assert.equal(model.cost.output, catalog.cost.output, "catalog");
    assert.equal(model.cost.tiers, undefined, "tiers are dropped once any rate comes from elsewhere");
    assert.equal(model.reasoning, catalog.reasoning, "catalog");
    assert.deepEqual(model.input, catalog.input, "catalog");
  });

  it("copies the whole catalog entry when the gateway says nothing", () => {
    const entry = parseModelEntry({ id: ANTHROPIC_ID });
    assert.ok(entry);
    const model = buildModel(entry, config());
    assert.equal(model.api, "anthropic-messages");
    assert.equal(model.name, catalog.name);
    assert.equal(model.contextWindow, catalog.contextWindow);
    assert.equal(model.maxTokens, catalog.maxTokens);
    assert.deepEqual(model.cost, catalog.cost);
    assert.deepEqual(model.thinkingLevelMap, catalog.thinkingLevelMap);
  });

  it("uses safe defaults for an unknown model", () => {
    const entry = parseModelEntry({ id: "unknown-model-xyz" });
    assert.ok(entry);
    const model = buildModel(entry, config());
    assert.equal(model.api, "openai-responses");
    assert.equal(model.name, "unknown-model-xyz");
    assert.equal(model.contextWindow, DEFAULTS.contextWindow);
    assert.equal(model.maxTokens, DEFAULTS.maxTokens);
    assert.deepEqual(model.input, ["text"]);
    assert.equal(model.reasoning, false);
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(model.compat, undefined);
    assert.equal(model.thinkingLevelMap, undefined);
  });

  it("keeps a vendor/model id verbatim while borrowing the catalog's metadata", () => {
    const entry = parseModelEntry({ id: `anthropic/${ANTHROPIC_ID}` });
    assert.ok(entry);
    const model = buildModel(entry, config());
    assert.equal(model.id, `anthropic/${ANTHROPIC_ID}`);
    assert.equal(model.provider, "gateway");
    assert.equal(model.contextWindow, catalog.contextWindow);
  });

  it("routes the base URL by transport and carries static headers", () => {
    const entry = parseModelEntry({ id: "m", owned_by: "anthropic" });
    assert.ok(entry);
    const model = buildModel(entry, config({ headers: { "x-team": "docs" } }));
    assert.equal(model.baseUrl, "https://gw.example.com");
    assert.deepEqual(model.headers, { "x-team": "docs" });
    const openai = parseModelEntry({ id: "m", owned_by: "openai" });
    assert.ok(openai);
    assert.equal(buildModel(openai, config()).baseUrl, "https://gw.example.com/v1");
  });

  it("copies compat and thinkingLevelMap only from a catalog entry on the same transport", () => {
    const withMap = getBuiltinModels("openai").find((model) => model.thinkingLevelMap && model.compat);
    assert.ok(withMap, "pi's openai catalog no longer has a model with both thinkingLevelMap and compat");
    const same = parseModelEntry({ id: withMap.id });
    assert.ok(same);
    const onResponses = buildModel(same, config());
    assert.equal(onResponses.api, "openai-responses");
    assert.deepEqual(onResponses.thinkingLevelMap, withMap.thinkingLevelMap);
    assert.deepEqual(onResponses.compat, withMap.compat);

    const onChat = buildModel(same, config({ models: { [withMap.id]: { api: "openai-completions" } } }));
    assert.equal(onChat.api, "openai-completions");
    assert.equal(onChat.thinkingLevelMap, undefined);
    assert.equal(onChat.compat, undefined);
    assert.equal(onChat.contextWindow, withMap.contextWindow, "transport-neutral fields still come from the catalog");
  });

  it("never copies allowedFallbackModels (it becomes a `fallbacks` body field)", () => {
    const source = getBuiltinModels("anthropic").find((model) => (model.compat?.allowedFallbackModels?.length ?? 0) > 0);
    if (!source) return; // nothing in this pi's catalog sets it
    const entry = parseModelEntry({ id: source.id });
    assert.ok(entry);
    const model = buildModel(entry, config());
    assert.equal(model.api, "anthropic-messages");
    assert.ok(model.compat, "the rest of the compat flags are still copied");
    assert.equal("allowedFallbackModels" in model.compat, false);
  });

  it("vision: config input → supports_vision → catalog", () => {
    const entry = parseModelEntry({ id: ANTHROPIC_ID, supports_vision: false });
    assert.ok(entry);
    assert.deepEqual(buildModel(entry, config()).input, ["text"]);
    assert.deepEqual(
      buildModel(entry, config({ models: { [ANTHROPIC_ID]: { input: ["text", "image"] } } })).input,
      ["text", "image"],
    );
  });
});

describe("compat overrides", () => {
  const withCompat = getBuiltinModels("openai").find((model) => model.compat && Object.keys(model.compat).length > 1);
  assert.ok(withCompat, "pi's openai catalog no longer has a model with several compat flags");
  const [firstKey] = Object.keys(withCompat.compat ?? {});

  it("merges an override over the copied catalog compat", () => {
    const entry = parseModelEntry({ id: withCompat.id });
    assert.ok(entry);
    const model = buildModel(entry, config({ models: { [withCompat.id]: { compat: { [firstKey]: false, extraFlag: "x" } } } }));
    assert.deepEqual(model.compat, { ...withCompat.compat, [firstKey]: false, extraFlag: "x" });
  });

  it("null drops the catalog compat entirely", () => {
    const entry = parseModelEntry({ id: withCompat.id });
    assert.ok(entry);
    const model = buildModel(entry, config({ models: { [withCompat.id]: { compat: null } } }));
    assert.equal(model.compat, undefined);
    assert.deepEqual(model.thinkingLevelMap, withCompat.thinkingLevelMap, "only compat is dropped");
  });

  it("applies to a model with no catalog compat", () => {
    const entry = parseModelEntry({ id: "unknown-model-c" });
    assert.ok(entry);
    assert.deepEqual(buildModel(entry, config({ models: { "unknown-model-c": { compat: { supportsStore: false } } } })).compat, {
      supportsStore: false,
    });
  });

  it("never brings back allowedFallbackModels through a merge", () => {
    const source = getBuiltinModels("anthropic").find((model) => (model.compat?.allowedFallbackModels?.length ?? 0) > 0);
    if (!source) return;
    const entry = parseModelEntry({ id: source.id });
    assert.ok(entry);
    const model = buildModel(entry, config({ models: { [source.id]: { compat: { supportsTemperature: true } } } }));
    assert.ok(model.compat);
    assert.equal("allowedFallbackModels" in model.compat, false);
  });

  it("does not leak one model's override into the shared catalog entry", () => {
    const entry = parseModelEntry({ id: withCompat.id });
    assert.ok(entry);
    buildModel(entry, config({ models: { [withCompat.id]: { compat: { [firstKey]: "mutated" } } } }));
    const pristine = getBuiltinModels("openai").find((model) => model.id === withCompat.id)?.compat ?? {};
    assert.notEqual(Object.entries(pristine).find(([key]) => key === firstKey)?.[1], "mutated");
  });
});

describe("include / exclude", () => {
  it("matches * globs", () => {
    assert.equal(globMatch("claude-*", "claude-sonnet-5"), true);
    assert.equal(globMatch("*embed*", "text-embedding-3"), true);
    assert.equal(globMatch("*embed*", "gpt-4"), false);
    assert.equal(globMatch("claude-*", "xclaude-1"), false, "anchored at both ends");
    assert.equal(globMatch("gpt-4.1", "gpt-421"), false, "dots are literal");
  });

  it("include narrows, exclude removes", () => {
    const cfg = { include: ["claude-*", "gpt-*"], exclude: ["*embed*"] };
    assert.equal(isIncluded("claude-x", cfg), true);
    assert.equal(isIncluded("gpt-embed", cfg), false);
    assert.equal(isIncluded("llama", cfg), false);
    assert.equal(isIncluded("llama", { include: [], exclude: [] }), true);
  });

  it("applies in modelsFromList", () => {
    const { models } = modelsFromList({ data: [{ id: "claude-a" }, { id: "embed-b" }] }, config({ exclude: ["embed-*"] }));
    assert.deepEqual(
      models.map((model) => model.id),
      ["claude-a"],
    );
  });
});

describe("discoverModels", () => {
  it("fetches {baseUrl}{modelsPath} with the token as a bearer token by default", async () => {
    const { calls, fetch } = stubFetch(() => json({ data: [{ id: "claude-z", owned_by: "anthropic" }] }));
    const models = await discoverModels(config({ headers: { "x-team": "docs" } }), { token: "tok", fetch });
    assert.equal(calls[0].url, "https://gw.example.com/v1/models");
    const headers = new Headers(calls[0].init?.headers);
    assert.equal(headers.get("authorization"), "Bearer tok");
    assert.equal(headers.get("x-team"), "docs");
    assert.deepEqual(
      models.map((model) => [model.id, model.api]),
      [["claude-z", "anthropic-messages"]],
    );
  });

  it("uses the configured auth header and models path", async () => {
    const { calls, fetch } = stubFetch(() => json(["some-model"]));
    await discoverModels(config({ authHeaders: { discovery: "x-api-key" }, modelsPath: "/models" }), { token: "tok", fetch });
    assert.equal(calls[0].url, "https://gw.example.com/models");
    const headers = new Headers(calls[0].init?.headers);
    assert.equal(headers.get("x-api-key"), "tok");
    assert.equal(headers.has("authorization"), false);
  });

  it("sends no auth header without a token", () => {
    assert.deepEqual(discoveryHeaders({ headers: {}, authHeaders: {} }, undefined), {});
  });

  it("uses Bearer by default even when a transport overrides its header", () => {
    assert.deepEqual(discoveryHeaders({ headers: {}, authHeaders: { "anthropic-messages": "authorization", "openai-responses": "x-api-key" } }, "t"), {
      authorization: "Bearer t",
    });
  });
});

describe("fallbackModels", () => {
  it("builds the configured fallback entries", () => {
    const models = fallbackModels(config({ fallbackModels: [ANTHROPIC_ID, { id: "gpt-q", owned_by: "openai" }] }));
    assert.deepEqual(
      models.map((model) => [model.id, model.api]),
      [
        [ANTHROPIC_ID, "anthropic-messages"],
        ["gpt-q", "openai-responses"],
      ],
    );
    assert.deepEqual(fallbackModels(config()), []);
  });

  it("includes config-added models, so a dead gateway still offers them", () => {
    const models = fallbackModels(config({ models: { "gpt-6-luna": { api: "openai-responses" } } }));
    assert.deepEqual(
      models.map((model) => [model.id, model.api]),
      [["gpt-6-luna", "openai-responses"]],
    );
  });
});

describe("config-added models", () => {
  it("adds unlisted models that have an api, ignoring include/exclude", () => {
    const cfg = config({
      exclude: ["gpt-*"],
      models: {
        "gpt-6-luna": { api: "openai-responses" },
        "oss/zai-org/glm-5-3": { api: "anthropic-messages" },
        "no-api": { contextWindow: 5 },
      },
    });
    const { models } = modelsFromList({ data: [{ id: "claude-sonnet-x", owned_by: "vertex" }] }, cfg);
    assert.deepEqual(
      models.map((model) => [model.id, model.api, model.baseUrl]),
      [
        ["claude-sonnet-x", "anthropic-messages", "https://gw.example.com"],
        ["gpt-6-luna", "openai-responses", "https://gw.example.com/v1"],
        ["oss/zai-org/glm-5-3", "anthropic-messages", "https://gw.example.com"],
      ],
    );
  });

  it("takes metadata from the override, then the catalog, then defaults", () => {
    const luna = getBuiltinModels("openai").find((model) => model.id === OPENAI_ID);
    assert.ok(luna);
    const { models } = modelsFromList([], config({
      models: { [OPENAI_ID]: { api: "openai-responses", maxTokens: 77 }, "mystery-1": { api: "openai-completions" } },
    }));
    const [fromCatalog, unknown] = models;
    assert.equal(fromCatalog.maxTokens, 77);
    assert.equal(fromCatalog.contextWindow, luna.contextWindow);
    assert.equal(unknown.contextWindow, DEFAULTS.contextWindow);
  });

  it("only overrides a model the gateway does list", () => {
    const { models } = modelsFromList({ data: [{ id: "m", owned_by: "openai" }] }, config({ models: { m: { api: "openai-completions" } } }));
    assert.deepEqual(
      models.map((model) => [model.id, model.api]),
      [["m", "openai-completions"]],
    );
  });
});
