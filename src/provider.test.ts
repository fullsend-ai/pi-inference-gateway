import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProvider, normalizeContext } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import type { Context, FetchFunction, Model, ModelsPublication, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { GatewayApi, GatewayConfig } from "./config.ts";
import { parseModelEntry, buildModel, extraModels, type GatewayModel } from "./discovery.ts";
import {
  createGatewayFetch,
  createGatewayProvider,
  gatewayAuth,
  gatewayProviderOptions,
  initialModels,
  registerGateways,
  type ProviderRegistry,
} from "./provider.ts";
import { sseFor } from "./test-fixtures.ts";

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

function model(id: string, api: GatewayApi, cfg: GatewayConfig = config()): GatewayModel {
  const entry = parseModelEntry({ id, api });
  assert.ok(entry);
  return buildModel(entry, cfg);
}

/** One model per transport, with ids no pi catalog knows, plus a vendor-prefixed one. */
const MODELS: Array<[string, GatewayApi]> = [
  ["test-claude", "anthropic-messages"],
  ["test-gpt", "openai-responses"],
  ["acme/test-chat", "openai-completions"],
];

interface RecordedRequest {
  url: URL;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** A fetch that records each request and answers with the canned SSE for its path. */
function recorder(reasoning?: string): { calls: RecordedRequest[]; fetch: FetchFunction } {
  const calls: RecordedRequest[] = [];
  const fetch: FetchFunction = async (input, init) => {
    const request = new Request(input, init);
    const text = await request.text();
    const body: Record<string, unknown> = text ? JSON.parse(text) : {};
    calls.push({ url: new URL(request.url), method: request.method, headers: new Headers(request.headers), body });
    const sse = sseFor(new URL(request.url).pathname, String(body.model), "ok", reasoning);
    // A fresh Response per call: pi retries through its own retry loop, and a consumed body fails
    // in a way that looks nothing like its cause.
    return sse === undefined
      ? new Response("not found", { status: 404 })
      : new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { calls, fetch };
}

const CONTEXT = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] } satisfies Context);

function gatewayProvider(cfg: GatewayConfig = config()): Provider<GatewayApi> {
  return createProvider(
    gatewayProviderOptions(
      cfg,
      MODELS.map(([id, api]) => model(id, api, cfg)),
      { env: { GW_KEY: "tok" } },
    ),
  );
}

function providerModel(provider: Provider<GatewayApi>, id: string): Model<GatewayApi> {
  const found = provider.getModels().find((entry) => entry.id === id);
  assert.ok(found, `${id} should be registered`);
  return found;
}

describe("createGatewayFetch", () => {
  const capture = () => {
    const seen: Headers[] = [];
    const baseFetch: FetchFunction = async (input, init) => {
      seen.push(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
      return new Response("{}");
    };
    return { seen, baseFetch };
  };

  it("moves an x-api-key token to authorization: Bearer", async () => {
    const { seen, baseFetch } = capture();
    const fetch = createGatewayFetch({ authHeader: "authorization", token: "tok", baseFetch });
    await fetch("https://gw.example.com/v1/messages", { method: "POST", headers: { "x-api-key": "tok", "x-other": "1" } });
    assert.equal(seen[0].get("authorization"), "Bearer tok");
    assert.equal(seen[0].has("x-api-key"), false);
    assert.equal(seen[0].get("x-other"), "1", "unrelated headers survive");
  });

  it("moves a Bearer token to a custom header", async () => {
    const { seen, baseFetch } = capture();
    const fetch = createGatewayFetch({ authHeader: "x-api-key", token: "tok", baseFetch });
    await fetch("https://gw.example.com/v1/responses", { headers: { authorization: "Bearer tok" } });
    assert.equal(seen[0].get("x-api-key"), "tok");
    assert.equal(seen[0].has("authorization"), false);
  });

  it("reads headers from a Request input", async () => {
    const { seen, baseFetch } = capture();
    const fetch = createGatewayFetch({ authHeader: "authorization", token: "tok", baseFetch });
    await fetch(new Request("https://gw.example.com/x", { headers: { "x-api-key": "tok", "x-keep": "y" } }));
    assert.equal(seen[0].get("authorization"), "Bearer tok");
    assert.equal(seen[0].get("x-keep"), "y");
    assert.equal(seen[0].has("x-api-key"), false);
  });

  it("passes the request through untouched without a token", async () => {
    const { seen, baseFetch } = capture();
    const fetch = createGatewayFetch({ authHeader: "authorization", token: undefined, baseFetch });
    await fetch("https://gw.example.com/x", { headers: { "x-api-key": "k" } });
    assert.equal(seen[0].get("x-api-key"), "k");
  });
});

describe("createProvider integration", () => {
  it("is accepted by pi's own createProvider with a mixed-API model list", () => {
    const provider = gatewayProvider();
    assert.equal(provider.id, "gateway");
    assert.deepEqual(
      provider.getModels().map((entry) => [entry.id, entry.api, entry.baseUrl]),
      [
        ["test-claude", "anthropic-messages", "https://gw.example.com"],
        ["test-gpt", "openai-responses", "https://gw.example.com/v1"],
        ["acme/test-chat", "openai-completions", "https://gw.example.com/v1"],
      ],
    );
    assert.equal(typeof provider.refreshModels, "function", "fetchModels makes it a dynamic provider");
  });

  it("uses ambient api-key auth only: no login, no oauth", () => {
    const provider = gatewayProvider();
    assert.ok(provider.auth.apiKey);
    assert.equal(provider.auth.apiKey.login, undefined);
    assert.equal(provider.auth.oauth, undefined);
  });
});

const PATHS: Record<GatewayApi, string> = {
  "anthropic-messages": "/v1/messages",
  "openai-responses": "/v1/responses",
  "openai-completions": "/v1/chat/completions",
};
const NATIVE: Record<GatewayApi, "x-api-key" | "authorization"> = {
  "anthropic-messages": "x-api-key",
  "openai-responses": "authorization",
  "openai-completions": "authorization",
};

function assertOneAuthHeader(headers: Headers, name: "x-api-key" | "authorization"): void {
  if (name === "authorization") {
    assert.equal(headers.get("authorization"), "Bearer tok");
    assert.equal(headers.has("x-api-key"), false, "exactly one auth header");
  } else {
    assert.equal(headers.get("x-api-key"), "tok");
    assert.equal(headers.has("authorization"), false, "exactly one auth header");
  }
}

describe("end to end through pi's transports", () => {
  for (const [id, api] of MODELS) {
    const path = PATHS[api];

    it(`${api}: POSTs ${path} with its native ${NATIVE[api]} header and the gateway's id verbatim`, async () => {
      const { calls, fetch } = recorder();
      const provider = gatewayProvider();
      const message = await provider.streamSimple(providerModel(provider, id), CONTEXT, { apiKey: "tok", fetch }).result();

      assert.equal(message.stopReason, "stop", `stream failed: ${message.errorMessage ?? "no reason given"}`);
      assert.equal(message.content.length, 1);
      const [block] = message.content;
      assert.ok(block.type === "text" && block.text === "ok", JSON.stringify(block));
      assert.equal(message.usage.output, 2);
      assert.equal(calls.length, 1);
      const [call] = calls;
      assert.equal(call.method, "POST");
      assert.equal(call.url.origin, "https://gw.example.com");
      assert.equal(call.url.pathname, path);
      assertOneAuthHeader(call.headers, NATIVE[api]);
      assert.equal(call.body.model, id);
    });

    for (const header of ["x-api-key", "authorization"] as const) {
      it(`${api}: an authHeader override of ${header} for every API is honoured`, async () => {
        const { calls, fetch } = recorder();
        const all = { "anthropic-messages": header, "openai-responses": header, "openai-completions": header };
        const provider = gatewayProvider(config({ authHeaders: all }));
        const message = await provider.streamSimple(providerModel(provider, id), CONTEXT, { apiKey: "tok", fetch }).result();
        assert.equal(message.stopReason, "stop", `stream failed: ${message.errorMessage ?? "no reason given"}`);
        assert.equal(calls[0].url.pathname, path);
        assertOneAuthHeader(calls[0].headers, header);
      });
    }
  }

  it("a per-API override changes only that API", async () => {
    const provider = gatewayProvider(config({ authHeaders: { "anthropic-messages": "authorization" } }));
    const claude = recorder();
    await provider.streamSimple(providerModel(provider, "test-claude"), CONTEXT, { apiKey: "tok", fetch: claude.fetch }).result();
    assertOneAuthHeader(claude.calls[0].headers, "authorization");
    const gpt = recorder();
    await provider.streamSimple(providerModel(provider, "test-gpt"), CONTEXT, { apiKey: "tok", fetch: gpt.fetch }).result();
    assertOneAuthHeader(gpt.calls[0].headers, "authorization");
  });

  it("sends static config headers on model requests", async () => {
    const { calls, fetch } = recorder();
    const provider = gatewayProvider(config({ headers: { "x-team": "docs" } }));
    await provider.streamSimple(providerModel(provider, "test-claude"), CONTEXT, { apiKey: "tok", fetch }).result();
    assert.equal(calls[0].headers.get("x-team"), "docs");
  });

  it("control: pi's bare Anthropic transport sends x-api-key, which is why it needs no wrapper by default", async () => {
    const { calls, fetch } = recorder();
    await anthropicMessagesApi().streamSimple(model("test-claude", "anthropic-messages"), CONTEXT, { apiKey: "tok", fetch }).result();
    assertOneAuthHeader(calls[0].headers, "x-api-key");
  });
});

describe("one open-weight model routed through every API, with reasoning", () => {
  // The same unlisted id on all three paths, as a path-routed gateway serves it. The canned
  // reasoning arrives as Messages `thinking`, Responses `reasoning_text.*` and Chat Completions
  // `reasoning_content`; each must come back as a pi thinking block before the answer.
  const GLM = "oss/zai-org/glm-5-3";
  for (const api of ["anthropic-messages", "openai-responses", "openai-completions"] as const) {
    it(`${api}: keeps the reasoning as a thinking block and the id verbatim`, async () => {
      const cfg = config({ models: { [GLM]: { api } } });
      const provider = createProvider(gatewayProviderOptions(cfg, extraModels(cfg, new Set()), { env: { GW_KEY: "tok" } }));
      const glm = providerModel(provider, GLM);
      assert.equal(glm.api, api);
      const { calls, fetch } = recorder("thinking it over");
      const message = await provider.streamSimple(glm, CONTEXT, { apiKey: "tok", fetch }).result();
      assert.equal(message.stopReason, "stop", `stream failed: ${message.errorMessage ?? "no reason given"}`);
      assert.deepEqual(
        message.content.map((block) => block.type),
        ["thinking", "text"],
      );
      const [thinking, text] = message.content;
      assert.ok(thinking.type === "thinking" && thinking.thinking.trim() === "thinking it over", JSON.stringify(thinking));
      assert.ok(text.type === "text" && text.text === "ok");
      assert.equal(calls[0].url.pathname, PATHS[api]);
      assert.equal(calls[0].body.model, GLM);
      assertOneAuthHeader(calls[0].headers, NATIVE[api]);
    });
  }
});

describe("gatewayAuth", () => {
  const signal = new AbortController().signal;
  const ctx = { env: async () => undefined, fileExists: async () => false };

  it("resolves the key variable at request time", async () => {
    const env: Record<string, string | undefined> = { GW_KEY: "k1" };
    const auth = gatewayAuth(config(), { env });
    assert.deepEqual(await auth.resolve({ ctx, signal }), { auth: { apiKey: "k1" }, source: "GW_KEY" });
    env.GW_KEY = "k2";
    assert.equal((await auth.resolve({ ctx, signal }))?.auth.apiKey, "k2");
  });

  it("re-reads the token file per resolve", async () => {
    let token = "t1";
    const auth = gatewayAuth(config({ tokenFile: "/run/token" }), { env: {}, readText: async () => token });
    assert.equal((await auth.resolve({ ctx, signal }))?.auth.apiKey, "t1");
    token = "t2";
    assert.equal((await auth.resolve({ ctx, signal }))?.auth.apiKey, "t2");
  });

  it("is undefined when unconfigured, and warns once about a missing token file", async () => {
    assert.equal(await gatewayAuth(config(), { env: {} }).resolve({ ctx, signal }), undefined);
    const warnings: string[] = [];
    const auth = gatewayAuth(config({ tokenFile: "/run/token" }), {
      env: {},
      readText: async () => undefined,
      warn: (message) => warnings.push(message),
    });
    assert.equal(await auth.resolve({ ctx, signal }), undefined);
    assert.equal(await auth.resolve({ ctx, signal }), undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /token file \/run\/token is missing or empty/);
  });
});

function refreshContext(overrides: Partial<RefreshModelsContext> = {}): {
  context: RefreshModelsContext;
  persisted: ModelsPublication[];
} {
  const persisted: ModelsPublication[] = [];
  return {
    persisted,
    context: {
      allowNetwork: false,
      signal: new AbortController().signal,
      publish: async (publication) => {
        persisted.push(publication);
        publication.update?.();
        return true;
      },
      ...overrides,
    },
  };
}

function listFetch(body: unknown): { urls: string[]; fetch: FetchFunction } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify(body), { status: 200 });
    },
  };
}

describe("refresh: fetchModels, persisted snapshot", () => {
  it("fetches and publishes a new list when the network is allowed", async () => {
    const { urls, fetch } = listFetch({ data: [{ id: "new-model", owned_by: "anthropic" }] });
    const provider = createGatewayProvider(config(), { models: [], fresh: false }, { env: { GW_KEY: "tok" }, fetch });
    const { context, persisted } = refreshContext({ allowNetwork: true });
    assert.ok(provider.refreshModels);
    await provider.refreshModels(context);
    assert.deepEqual(urls, ["https://gw.example.com/v1/models"]);
    assert.deepEqual(
      provider.getModels().map((entry) => [entry.id, entry.api]),
      [["new-model", "anthropic-messages"]],
    );
    assert.ok(persisted.some((publication) => publication.persist), "the new list is persisted");
  });

  it("does not touch the network when refresh is offline (pi -p, --list-models)", async () => {
    const { urls, fetch } = listFetch({ data: [] });
    const provider = createGatewayProvider(config(), { models: [], fresh: false }, { env: {}, fetch });
    assert.ok(provider.refreshModels);
    await provider.refreshModels(refreshContext().context);
    assert.deepEqual(urls, []);
  });

  it("restores the persisted snapshot after a failed load-time discovery", async () => {
    const stale = model("stale-model", "openai-responses");
    const provider = createGatewayProvider(config(), { models: [], fresh: false }, { env: {} });
    assert.ok(provider.refreshModels);
    await provider.refreshModels(refreshContext({ stored: { models: [stale] } }).context);
    assert.deepEqual(
      provider.getModels().map((entry) => entry.id),
      ["stale-model"],
    );
  });

  it("withholds the persisted snapshot when load-time discovery succeeded", async () => {
    const current = model("current-model", "openai-responses");
    const dropped = model("dropped-model", "openai-responses");
    const provider = createGatewayProvider(config(), { models: [current], fresh: true }, { env: {} });
    assert.ok(provider.refreshModels);
    await provider.refreshModels(refreshContext({ stored: { models: [dropped] } }).context);
    assert.deepEqual(
      provider.getModels().map((entry) => entry.id),
      ["current-model"],
    );
  });

  it("keeps the previous list when a refresh fails", async () => {
    const fetch: FetchFunction = async () => new Response("down", { status: 503 });
    const provider = createGatewayProvider(config(), { models: [model("kept", "openai-responses")], fresh: true }, { env: {}, fetch });
    assert.ok(provider.refreshModels);
    await assert.rejects(provider.refreshModels(refreshContext({ allowNetwork: true }).context), /HTTP 503/);
    assert.deepEqual(
      provider.getModels().map((entry) => entry.id),
      ["kept"],
    );
  });
});

describe("initialModels", () => {
  it("returns the discovered list as fresh", async () => {
    const { fetch } = listFetch(["a", "b"]);
    const result = await initialModels(config(), { env: {}, fetch });
    assert.equal(result.fresh, true);
    assert.deepEqual(
      result.models.map((entry) => entry.id),
      ["a", "b"],
    );
  });

  it("falls back to config fallbackModels and warns once on failure", async () => {
    const warnings: string[] = [];
    const fetch: FetchFunction = async () => {
      throw new TypeError("connect ECONNREFUSED 127.0.0.1:9");
    };
    const result = await initialModels(config({ fallbackModels: ["fb-1"] }), { env: {}, fetch, warn: (message) => warnings.push(message) });
    assert.equal(result.fresh, false);
    assert.deepEqual(
      result.models.map((entry) => entry.id),
      ["fb-1"],
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[pi-inference-gateway\] gateway: model discovery failed .*ECONNREFUSED.*1 fallback model/);
  });

  it("honours the load-time timeout", async () => {
    const fetch: FetchFunction = (_input, init) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const warnings: string[] = [];
    const result = await initialModels(config(), { env: {}, fetch, warn: (message) => warnings.push(message) }, 20);
    assert.equal(result.fresh, false);
    assert.match(warnings[0], /timed out after 20 ms/);
  });
});

describe("registerGateways", () => {
  function registry(): ProviderRegistry & { providers: Provider<GatewayApi>[] } {
    const providers: Provider<GatewayApi>[] = [];
    return { providers, registerProvider: (provider) => providers.push(provider) };
  }

  it("registers nothing and prints nothing when unconfigured", async () => {
    const pi = registry();
    const warnings: string[] = [];
    const fetch: FetchFunction = async () => {
      throw new Error("must not be called");
    };
    const ids = await registerGateways(pi, { env: {}, home: "/home/user", readText: async () => undefined, fetch, warn: (message) => warnings.push(message) });
    assert.deepEqual(ids, []);
    assert.equal(pi.providers.length, 0);
    assert.deepEqual(warnings, []);
  });

  it("registers the env gateway with its discovered models", async () => {
    const pi = registry();
    const { urls, fetch } = listFetch({
      data: [
        { id: "claude-q", owned_by: "anthropic" },
        { id: "gpt-q", owned_by: "openai" },
        { id: "chat-q", supported_endpoints: ["/v1/chat/completions"] },
      ],
    });
    const ids = await registerGateways(pi, {
      env: { INFERENCE_GATEWAY_BASE_URL: "http://127.0.0.1:4000/v1", INFERENCE_GATEWAY_API_KEY: "tok" },
      home: "/home/user",
      readText: async () => undefined,
      fetch,
      warn: () => assert.fail("no warnings expected"),
    });
    assert.deepEqual(ids, ["gateway"]);
    assert.deepEqual(urls, ["http://127.0.0.1:4000/v1/models"]);
    assert.deepEqual(
      pi.providers[0].getModels().map((entry) => [entry.id, entry.api]),
      [
        ["claude-q", "anthropic-messages"],
        ["gpt-q", "openai-responses"],
        ["chat-q", "openai-completions"],
      ],
    );
  });

  it("still registers (with fallbacks) when discovery fails", async () => {
    const pi = registry();
    const warnings: string[] = [];
    const ids = await registerGateways(pi, {
      env: { INFERENCE_GATEWAY_BASE_URL: "http://127.0.0.1:9" },
      home: "/home/user",
      readText: async () => JSON.stringify({ providers: { gateway: { baseUrl: "http://127.0.0.1:9", fallbackModels: ["fb"] } } }),
      fetch: async () => new Response("", { status: 500 }),
      warn: (message) => warnings.push(message),
    });
    assert.deepEqual(ids, ["gateway"]);
    assert.deepEqual(
      pi.providers[0].getModels().map((entry) => entry.id),
      ["fb"],
    );
    assert.equal(warnings.length, 1);
  });
});
