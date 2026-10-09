// Lessons from other pi gateway extensions (research doc "pi-inference-gateway: Lessons from
// Third-Party pi Provider Extensions", adopt list). One describe block per lesson.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createModels, createProvider, InMemoryModelsStore, normalizeContext } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { Context, FetchFunction, ModelsPublication, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import { sseFor } from "./test-fixtures.ts";
import { loadConfig, type GatewayApi, type GatewayConfig } from "./config.ts";
import { LIMITS, buildModel, discoverModels, modelsFromList, parseModelEntry, parseModelList, type GatewayModel } from "./discovery.ts";
import {
  FACTORY_DISCOVERY_TIMEOUT_MS,
  SNAPSHOT_STAMP,
  createGatewayProvider,
  factoryDiscovery,
  gatewayAuth,
  gatewayProviderOptions,
  initialModels,
  registerGateways,
} from "./provider.ts";

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

const ENV = { GW_KEY: "tok" };

function listFetch(...bodies: unknown[]): { urls: string[]; fetch: FetchFunction } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify(bodies[Math.min(urls.length - 1, bodies.length - 1)]), { status: 200 });
    },
  };
}

function refreshContext(overrides: Partial<RefreshModelsContext> = {}): { context: RefreshModelsContext; published: ModelsPublication[] } {
  const published: ModelsPublication[] = [];
  return {
    published,
    context: {
      allowNetwork: false,
      signal: new AbortController().signal,
      publish: async (publication) => {
        published.push(publication);
        publication.update?.();
        return true;
      },
      ...overrides,
    },
  };
}

const ids = (models: readonly { id: string }[]) => models.map((model) => model.id);

describe("lesson 1: an all-invalid or empty list is a failure, not an empty catalog", () => {
  for (const [name, body] of [
    ["an empty list", { data: [] }],
    ["a list whose every entry is malformed", { data: [{ id: "" }, { id: "a b" }, null, 42] }],
    ["a list of wildcard entries only", { data: [{ id: "openai/*", owned_by: "openai" }] }],
    ["a list of non-chat models only", { data: [{ id: "text-embed-4", mode: "embedding" }] }],
  ] as const) {
    it(`discoverModels rejects ${name}`, async () => {
      const { fetch } = listFetch(body);
      await assert.rejects(discoverModels(config(), { token: "tok", fetch }), /no usable model|empty/);
    });
  }

  it("names what was dropped", async () => {
    const { fetch } = listFetch({ data: [{ id: "openai/*" }, { id: "a b" }, { id: "embed-x", mode: "embedding" }] });
    await assert.rejects(discoverModels(config(), { token: "tok", fetch }), /1 wildcard, 1 non-chat, 1 malformed/);
  });

  it("initialModels falls back (fresh: false), so pi's saved snapshot is restored", async () => {
    const { fetch } = listFetch({ data: [] });
    const warnings: string[] = [];
    const result = await initialModels(config({ fallbackModels: ["fb"] }), { env: ENV, fetch, warn: (message) => warnings.push(message) });
    assert.equal(result.fresh, false);
    assert.deepEqual(ids(result.models), ["fb"]);
    assert.match(warnings[0], /model discovery failed \(model list is empty\)/);
  });

  it("a refresh that returns an empty list keeps the current models", async () => {
    const { fetch } = listFetch({ data: [{ id: "keep-me" }] }, { data: [] });
    const seeded = createGatewayProvider(config(), await initialModels(config(), { env: ENV, fetch }), { env: ENV, fetch });
    assert.deepEqual(ids(seeded.getModels()), ["keep-me"]);
    assert.ok(seeded.refreshModels);
    const { context, published } = refreshContext({ allowNetwork: true });
    await assert.rejects(seeded.refreshModels(context), /model list is empty/);
    assert.deepEqual(ids(seeded.getModels()), ["keep-me"]);
    assert.equal(published.length, 0, "nothing is persisted over the last good list");
  });

  it("fallbackModels: [] (the config default) is not an error", async () => {
    const { fetch } = listFetch({ data: [{ id: "a" }] });
    const result = await initialModels(config(), { env: ENV, fetch });
    assert.equal(result.fresh, true);
    assert.deepEqual(modelsFromList([], config()).models, []);
  });
});

describe("lesson 2: PI_OFFLINE and INFERENCE_GATEWAY_DISCOVERY_TIMEOUT_MS", () => {
  const BASE = { INFERENCE_GATEWAY_BASE_URL: "http://127.0.0.1:4000", INFERENCE_GATEWAY_API_KEY: "tok" };
  const FILE = JSON.stringify({ providers: { gateway: { baseUrl: "http://127.0.0.1:4000", fallbackModels: ["fb"] } } });

  async function register(env: Record<string, string>) {
    const providers: Provider<GatewayApi>[] = [];
    const warnings: string[] = [];
    const { urls, fetch } = listFetch({ data: [{ id: "live" }] });
    const registered = await registerGateways(
      { registerProvider: (provider) => providers.push(provider) },
      { env: { ...BASE, ...env }, home: "/home/user", readText: async () => FILE, fetch, warn: (message) => warnings.push(message) },
    );
    return { registered, urls, warnings, models: ids(providers[0]?.getModels() ?? []) };
  }

  for (const value of ["1", "true", "0", ""]) {
    it(`PI_OFFLINE=${JSON.stringify(value)} skips load-time discovery silently (pi treats any set value as offline)`, async () => {
      const { registered, urls, warnings, models } = await register({ PI_OFFLINE: value });
      assert.deepEqual(registered, ["gateway"]);
      assert.deepEqual(urls, []);
      assert.deepEqual(warnings, []);
      assert.deepEqual(models, ["fb"], "fallbacks now, pi's saved snapshot on its offline refresh");
    });
  }

  it("INFERENCE_GATEWAY_DISCOVERY_TIMEOUT_MS=0 skips load-time discovery silently", async () => {
    const { urls, warnings, models } = await register({ INFERENCE_GATEWAY_DISCOVERY_TIMEOUT_MS: "0" });
    assert.deepEqual(urls, []);
    assert.deepEqual(warnings, []);
    assert.deepEqual(models, ["fb"]);
  });

  it("a positive value is the load-time timeout", async () => {
    const providers: Provider<GatewayApi>[] = [];
    const warnings: string[] = [];
    const hang: FetchFunction = (_input, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    await registerGateways(
      { registerProvider: (provider) => providers.push(provider) },
      {
        env: { ...BASE, INFERENCE_GATEWAY_DISCOVERY_TIMEOUT_MS: "25" },
        home: "/home/user",
        readText: async () => undefined,
        fetch: hang,
        warn: (message) => warnings.push(message),
      },
    );
    assert.match(warnings.join("\n"), /timed out after 25 ms/);
  });

  it("an invalid value warns and keeps the default", async () => {
    const { urls, warnings, models } = await register({ INFERENCE_GATEWAY_DISCOVERY_TIMEOUT_MS: "soon" });
    assert.deepEqual(urls, ["http://127.0.0.1:4000/v1/models"]);
    assert.deepEqual(models, ["live"]);
    assert.match(warnings.join("\n"), /INFERENCE_GATEWAY_DISCOVERY_TIMEOUT_MS: must be a whole number of milliseconds \(0 skips/);
  });

  it("factoryDiscovery reads both switches", () => {
    assert.deepEqual(factoryDiscovery({}), { skip: false, timeoutMs: FACTORY_DISCOVERY_TIMEOUT_MS, warnings: [] });
    assert.deepEqual(factoryDiscovery({ INFERENCE_GATEWAY_DISCOVERY_TIMEOUT_MS: "1500" }), { skip: false, timeoutMs: 1500, warnings: [] });
    assert.equal(factoryDiscovery({ PI_OFFLINE: "1", INFERENCE_GATEWAY_DISCOVERY_TIMEOUT_MS: "1500" }).skip, true);
  });
});

describe("E4: a file provider's baseUrl that the environment overrides is reported", () => {
  it("warns once when INFERENCE_GATEWAY_BASE_URL replaces a different file baseUrl", async () => {
    const { providers, warnings } = await loadConfig({
      env: { INFERENCE_GATEWAY_BASE_URL: "https://gateway.example.com", INFERENCE_GATEWAY_API_KEY: "tok" },
      home: "/home/user",
      readText: async () => JSON.stringify({ providers: { gateway: { baseUrl: "https://other.example.com/v1" } } }),
    });
    assert.equal(providers[0].baseUrl, "https://gateway.example.com");
    assert.equal(warnings.length, 1, warnings.join("\n"));
    assert.match(warnings[0], /providers\.gateway\.baseUrl \(https:\/\/other\.example\.com\) is ignored: INFERENCE_GATEWAY_BASE_URL \(https:\/\/gateway\.example\.com\) configures this provider/);
  });

  it("is silent when both name the same gateway (after normalisation)", async () => {
    const { warnings } = await loadConfig({
      env: { INFERENCE_GATEWAY_BASE_URL: "https://gateway.example.com/v1/" },
      home: "/home/user",
      readText: async () => JSON.stringify({ providers: { gateway: { baseUrl: "https://gateway.example.com" } } }),
    });
    assert.deepEqual(warnings, []);
  });
});

describe("lesson 5: persisted snapshots are version-stamped", () => {
  function stale(id: string, api: GatewayApi): GatewayModel {
    const entry = parseModelEntry({ id, api });
    assert.ok(entry);
    return buildModel(entry, config());
  }

  it("an unstamped (older) snapshot re-derives each model's api from the current rules", async () => {
    // Saved before D1: agentgateway's owned_by "openai" had put Claude on Responses.
    const provider = createGatewayProvider(config(), { models: [], fresh: false }, { env: ENV });
    assert.ok(provider.refreshModels);
    await provider.refreshModels(refreshContext({ stored: { models: [stale("claude-sonnet-5", "openai-responses")] } }).context);
    assert.deepEqual(
      provider.getModels().map((model) => [model.id, model.api]),
      [["claude-sonnet-5", "anthropic-messages"]],
    );
  });

  it("a snapshot with the current stamp keeps the api it was saved with (it may have come from a gateway hint)", async () => {
    const provider = createGatewayProvider(config(), { models: [], fresh: false }, { env: ENV });
    assert.ok(provider.refreshModels);
    const stored = { models: [stale("hinted-model", "openai-completions")], etag: SNAPSHOT_STAMP };
    await provider.refreshModels(refreshContext({ stored }).context);
    assert.deepEqual(
      provider.getModels().map((model) => [model.id, model.api]),
      [["hinted-model", "openai-completions"]],
    );
  });

  it("a network refresh persists the stamp, and pi's real store hands it back", async () => {
    const store = new InMemoryModelsStore();
    const { fetch } = listFetch({ data: [{ id: "a" }] });
    const models = createModels({ modelsStore: store });
    models.setProvider(createGatewayProvider(config(), { models: [], fresh: false }, { env: ENV, fetch }));
    const result = await models.refresh({ allowNetwork: true });
    assert.equal(result.errors.size, 0);
    const saved = await store.read("gateway");
    assert.equal(saved?.etag, SNAPSHOT_STAMP);
    assert.deepEqual(ids(saved?.models ?? []), ["a"]);
  });
});

describe("lesson 6: maxTokens never exceeds contextWindow; placeholder windows are reported", () => {
  it("caps maxTokens at contextWindow, whatever the source", () => {
    const fromGateway = modelsFromList({ data: [{ id: "small", context_window: 8192, max_output_tokens: 32768 }] }, config()).models[0];
    assert.equal(fromGateway.maxTokens, 8192);
    const fromConfig = buildModel({ id: "cfg", endpoints: [], owners: [] }, config({ models: { cfg: { contextWindow: 4096 } } }));
    assert.equal(fromConfig.maxTokens, 4096, "the 16K default is capped too");
    const fine = modelsFromList({ data: [{ id: "big", context_window: 200000, max_output_tokens: 32768 }] }, config()).models[0];
    assert.equal(fine.maxTokens, 32768);
  });

  const catalogModel = getBuiltinModels("anthropic").find((model) => model.contextWindow >= 4 * 8192);

  it("warns once when gateway windows are 4x or more off pi's catalog, naming the models", () => {
    assert.ok(catalogModel, "pi's anthropic catalog has no model with a window over 32K; drop this case");
    const { warnings } = modelsFromList(
      {
        data: [
          { id: catalogModel.id, context_window: 8192 },
          { id: "other-a", context_window: 8192 },
          { id: "other-b", context_window: 8192 },
        ],
      },
      config(),
    );
    assert.equal(warnings.length, 1, warnings.join("\n"));
    assert.match(warnings[0], new RegExp(`${catalogModel.id} \\(gateway 8192, pi's catalog ${catalogModel.contextWindow}\\)`));
    assert.match(warnings[0], /3 listed models report the same 8192/);
    assert.match(warnings[0], /models\[id\]\.contextWindow/);
  });

  it("is silent when the gateway agrees with the catalog, or a config override sets the window", () => {
    assert.ok(catalogModel);
    assert.deepEqual(modelsFromList({ data: [{ id: catalogModel.id, context_window: catalogModel.contextWindow }] }, config()).warnings, []);
    const overridden = config({ models: { [catalogModel.id]: { contextWindow: 8192 } } });
    assert.deepEqual(modelsFromList({ data: [{ id: catalogModel.id, context_window: 8192 }] }, overridden).warnings, []);
  });
});

describe("lesson 4: opt-in session affinity with a hashed session id", () => {
  const SESSION = "raw-session-id-1234";
  const HASHED = `pi-${createHash("sha256").update(SESSION).digest("hex").slice(0, 32)}`;
  const AFFINITY_HEADERS = ["x-session-affinity", "x-session-id", "session_id", "x-client-request-id"];

  async function requests(cfg: GatewayConfig) {
    const calls: { path: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const fetch: FetchFunction = async (input, init) => {
      const request = new Request(input, init);
      const body: Record<string, unknown> = JSON.parse(await request.text());
      const path = new URL(request.url).pathname;
      calls.push({ path, headers: request.headers, body });
      return new Response(sseFor(path, String(body.model), "ok"), { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const models = (["anthropic-messages", "openai-responses", "openai-completions"] as const).map((api) =>
      buildModel({ id: `m-${api}`, api, endpoints: [], owners: [] }, cfg),
    );
    const provider = createProvider(gatewayProviderOptions(cfg, models, { env: ENV }));
    const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] } satisfies Context);
    for (const model of models) {
      for await (const _event of provider.streamSimple(model, context, { apiKey: "tok", fetch, sessionId: SESSION })) {
        // drain
      }
    }
    return calls;
  }

  it("is off by default: no affinity header on Messages or Chat Completions, no cache key on chat", async () => {
    const calls = await requests(config());
    const messages = calls.find((call) => call.path === "/v1/messages");
    const chat = calls.find((call) => call.path === "/v1/chat/completions");
    assert.ok(messages && chat);
    for (const call of [messages, chat]) {
      for (const name of AFFINITY_HEADERS) assert.equal(call.headers.get(name), null, `${call.path} ${name}`);
    }
    assert.equal(chat.body.prompt_cache_key, undefined);
    const responses = calls.find((call) => call.path === "/v1/responses");
    assert.equal(responses?.body.prompt_cache_key, SESSION, "control: pi's Responses transport sends the raw id natively");
  });

  it("when on, every transport carries only the hashed id: affinity headers and prompt_cache_key", async () => {
    const calls = await requests(config({ sessionAffinity: true }));
    assert.equal(calls.length, 3);
    for (const call of calls) {
      const raw = JSON.stringify([...call.headers]) + JSON.stringify(call.body);
      assert.ok(!raw.includes(SESSION), `${call.path} leaks the raw session id`);
    }
    const byPath = (path: string) => calls.find((call) => call.path === path);
    assert.equal(byPath("/v1/messages")?.headers.get("x-session-affinity"), HASHED);
    assert.equal(byPath("/v1/chat/completions")?.headers.get("x-session-affinity"), HASHED);
    assert.equal(byPath("/v1/chat/completions")?.body.prompt_cache_key, HASHED);
    assert.equal(byPath("/v1/responses")?.body.prompt_cache_key, HASHED);
  });

  it("a per-model compat override still wins", () => {
    const cfg = config({ sessionAffinity: true, models: { quiet: { api: "anthropic-messages", compat: { sendSessionAffinityHeaders: false } } } });
    const model = buildModel({ id: "quiet", endpoints: [], owners: [] }, cfg);
    assert.equal(model.api === "anthropic-messages" ? model.compat?.sendSessionAffinityHeaders : undefined, false);
  });

  it("is configured by the file key or INFERENCE_GATEWAY_SESSION_AFFINITY", async () => {
    const fromFile = await loadConfig({
      env: {},
      home: "/home/user",
      readText: async () => JSON.stringify({ providers: { gw: { baseUrl: "https://gateway.example.com", sessionAffinity: true } } }),
    });
    assert.equal(fromFile.providers[0].sessionAffinity, true);
    for (const [value, expected] of [["1", true], ["true", true], ["0", false], ["no", false]] as const) {
      const fromEnv = await loadConfig({
        env: { INFERENCE_GATEWAY_BASE_URL: "https://gateway.example.com", INFERENCE_GATEWAY_SESSION_AFFINITY: value },
        home: "/home/user",
        readText: async () => undefined,
      });
      assert.equal(fromEnv.providers[0].sessionAffinity, expected, value);
    }
    const bad = await loadConfig({
      env: { INFERENCE_GATEWAY_BASE_URL: "https://gateway.example.com", INFERENCE_GATEWAY_SESSION_AFFINITY: "maybe" },
      home: "/home/user",
      readText: async () => undefined,
    });
    assert.match(bad.warnings.join("\n"), /INFERENCE_GATEWAY_SESSION_AFFINITY: must be/);
  });
});

describe("auth never returns a baseUrl", () => {
  it("gatewayAuth().resolve() sets no auth.baseUrl, for a token or for Basic", async () => {
    // pi-ai models.js: a ModelAuth.baseUrl replaces every model's baseUrl, which would break the
    // root (Messages) vs root/v1 (OpenAI) split this provider relies on.
    for (const env of [{ GW_KEY: "tok" }, { GW_PASS: "pw" }]) {
      const result = await gatewayAuth(config({ passwordEnv: "GW_PASS" }), { env }).resolve({
        ctx: { env: async () => undefined, fileExists: async () => false },
        signal: new AbortController().signal,
      });
      assert.ok(result);
      assert.equal("baseUrl" in result.auth, false);
    }
  });
});

describe("lesson 3: non-chat models are dropped before the list cap", () => {
  it("drops LiteLLM modes and types that are not chat", () => {
    const { entries, nonChat } = parseModelList({
      data: [
        { id: "embed-a", mode: "embedding" },
        { model_name: "img-a", model_info: { mode: "image_generation" } },
        { id: "whisper-a", mode: "audio_transcription" },
        { id: "tts-a", mode: "audio_speech" },
        { id: "rerank-a", mode: "rerank" },
        { id: "mod-a", mode: "moderation" },
        { id: "video-a", mode: "video_generation" },
        { id: "embed-b", type: "embeddings" },
        { id: "img-b", architecture: { output_modalities: ["image"] } },
        { id: "chat-a", mode: "chat" },
        { id: "resp-a", mode: "responses" },
        { id: "plain-a", object: "model" },
        { id: "multi-a", architecture: { output_modalities: ["text", "image"] } },
      ],
    });
    assert.deepEqual(ids(entries), ["chat-a", "resp-a", "plain-a", "multi-a"]);
    assert.equal(nonChat, 9);
  });

  it("does not let non-chat entries crowd chat models out of the cap", () => {
    const data = [
      ...Array.from({ length: LIMITS.maxModels }, (_, index) => ({ id: `embed-${index}`, mode: "embedding" })),
      { id: "the-chat-model", mode: "chat" },
    ];
    const { entries, dropped } = parseModelList({ data });
    assert.deepEqual(ids(entries), ["the-chat-model"]);
    assert.equal(dropped, 0, "non-chat entries are counted separately");
  });
});
