// Regression tests for code-review findings. Each was written failing first, against the code
// before its fix.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryModelsStore, createModels, normalizeContext } from "@earendil-works/pi-ai";
import type { Context, FetchFunction, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { loadConfig, parseConfigFile, type GatewayApi, type GatewayConfig } from "./config.ts";
import { buildModel, parseModelEntry, type GatewayModel } from "./discovery.ts";
import { createGatewayProvider, initialModels } from "./provider.ts";
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

const CONTEXT = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] } satisfies Context);
const ENV = { GW_KEY: "tok" };

function ids(list: readonly Model<string>[]): string[] {
  return list.map((entry) => entry.id);
}

function context(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  return {
    allowNetwork: false,
    signal: new AbortController().signal,
    publish: async (publication) => {
      publication.update?.();
      return true;
    },
    ...overrides,
  };
}

describe("review 1: inference requests never follow redirects", () => {
  for (const api of ["anthropic-messages", "openai-responses", "openai-completions"] as const) {
    it(`${api}: sends redirect: "error" with no auth-header override`, async () => {
      const redirects: string[] = [];
      const fetch: FetchFunction = async (input, init) => {
        const request = new Request(input, init);
        redirects.push(request.redirect);
        const body = JSON.parse(await request.text());
        return new Response(sseFor(new URL(request.url).pathname, String(body.model), "ok"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };
      const provider = createGatewayProvider(config(), { models: [model(`m-${api}`, api)], fresh: true }, { env: ENV });
      const target = provider.getModels().find((entry) => entry.id === `m-${api}`);
      assert.ok(target);
      const message = await provider.streamSimple(target, CONTEXT, { apiKey: "tok", fetch }).result();
      assert.equal(message.stopReason, "stop", message.errorMessage ?? "");
      assert.deepEqual(redirects, ["error"]);
    });
  }

  it("a redirecting gateway fails the request instead of forwarding x-api-key", async () => {
    // Emulates fetch against a gateway answering 307 → another origin: with redirect: "error" the
    // fetch rejects; with "follow" it re-sends to `location`, stripping only `authorization`
    // cross-origin (Fetch spec), so `x-api-key` would reach the other host.
    const leaked: (string | null)[] = [];
    const fetch: FetchFunction = async (input, init) => {
      const request = new Request(input, init);
      if (request.redirect === "error") throw new TypeError("fetch failed: unexpected redirect");
      const followed = new Headers(request.headers);
      followed.delete("authorization");
      leaked.push(followed.get("x-api-key"));
      const body = JSON.parse(await request.text());
      return new Response(sseFor("/v1/messages", String(body.model), "ok"), { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const provider = createGatewayProvider(config(), { models: [model("c", "anthropic-messages")], fresh: true }, { env: ENV });
    const target = provider.getModels()[0];
    const message = await provider.streamSimple(target, CONTEXT, { apiKey: "tok", fetch, maxRetries: 0 }).result();
    assert.deepEqual(leaked, [], "the key was forwarded to the redirect target");
    assert.equal(message.stopReason, "error");
  });
});

describe("review 2: a restored snapshot is rebound to the current connection", () => {
  it("uses the current baseUrl and headers, not the cached ones", async () => {
    const old = config({ baseUrl: "https://old.example.com", headers: { "x-old": "1" } });
    const cached = [model("gpt-q", "openai-responses", old), model("claude-q", "anthropic-messages", old)];
    const current = config({ baseUrl: "https://new.example.com", headers: { "x-new": "2" } });
    const provider = createGatewayProvider(current, { models: [], fresh: false }, { env: ENV });
    assert.ok(provider.refreshModels);
    await provider.refreshModels(context({ stored: { models: cached } }));
    const restored = provider.getModels();
    assert.deepEqual(
      restored.map((entry) => [entry.id, entry.baseUrl, entry.headers]),
      [
        ["gpt-q", "https://new.example.com/v1", { "x-new": "2" }],
        ["claude-q", "https://new.example.com", { "x-new": "2" }],
      ],
    );
  });

  it("applies current overrides and filters to the cached models", async () => {
    const cached = [model("gpt-q", "openai-responses"), model("drop-me", "openai-responses")];
    const current = config({ exclude: ["drop-*"], models: { "gpt-q": { api: "openai-completions", maxTokens: 7 } } });
    const provider = createGatewayProvider(current, { models: [], fresh: false }, { env: ENV });
    assert.ok(provider.refreshModels);
    await provider.refreshModels(context({ stored: { models: cached } }));
    assert.deepEqual(
      provider.getModels().map((entry) => [entry.id, entry.api, entry.maxTokens]),
      [["gpt-q", "openai-completions", 7]],
    );
  });

  it("drops cached entries from another provider id", async () => {
    const foreign = model("x", "openai-responses", config({ id: "other" }));
    const provider = createGatewayProvider(config(), { models: [], fresh: false }, { env: ENV });
    assert.ok(provider.refreshModels);
    await provider.refreshModels(context({ stored: { models: [foreign] } }));
    assert.deepEqual(ids(provider.getModels()), []);
  });
});

describe("review 3: a successful refresh replaces the startup list (through pi's real Models)", () => {
  function gateway(lists: unknown[]) {
    let call = 0;
    const fetch: FetchFunction = async () => new Response(JSON.stringify(lists[Math.min(call++, lists.length - 1)]), { status: 200 });
    return { fetch, deps: { env: ENV, fetch } };
  }

  it("removes a model the gateway dropped, and clears on an empty list", async () => {
    const { deps } = gateway([{ data: [{ id: "a" }, { id: "b" }] }, { data: [{ id: "a" }] }, { data: [] }]);
    const cfg = config();
    const startup = await initialModels(cfg, deps);
    assert.equal(startup.fresh, true);
    const models = createModels({ modelsStore: new InMemoryModelsStore() });
    models.setProvider(createGatewayProvider(cfg, startup, deps));
    assert.deepEqual(ids(models.getModels("gateway")), ["a", "b"]);

    const first = await models.refresh({ allowNetwork: true });
    assert.equal(first.errors.size, 0, [...first.errors.values()].join());
    assert.deepEqual(ids(models.getModels("gateway")), ["a"]);

    const second = await models.refresh({ allowNetwork: true });
    assert.equal(second.errors.size, 0, [...second.errors.values()].join());
    assert.deepEqual(ids(models.getModels("gateway")), []);
  });

  it("a later process restores the persisted list when its own discovery fails", async () => {
    const store = new InMemoryModelsStore();
    const online = gateway([{ data: [{ id: "a" }] }, { data: [{ id: "a" }, { id: "c" }] }]);
    const cfg = config();
    const first = createModels({ modelsStore: store });
    first.setProvider(createGatewayProvider(cfg, await initialModels(cfg, online.deps), online.deps));
    await first.refresh({ allowNetwork: true });
    assert.deepEqual(ids(first.getModels("gateway")), ["a", "c"]);

    const down: FetchFunction = async () => {
      throw new TypeError("fetch failed");
    };
    const offlineDeps = { env: ENV, fetch: down, warn: () => {} };
    const second = createModels({ modelsStore: store });
    second.setProvider(createGatewayProvider(cfg, await initialModels(cfg, offlineDeps), offlineDeps));
    await second.refresh({ allowNetwork: false });
    assert.deepEqual(ids(second.getModels("gateway")), ["a", "c"]);
  });
});

describe("review 5: config model ids are validated like gateway ids", () => {
  it("skips override and extra-model ids that are blank, too long, or contain whitespace/control characters", () => {
    const { providers, warnings } = parseConfigFile(
      {
        providers: {
          gw: {
            baseUrl: "https://gw.example.com",
            models: {
              "a b": { api: "openai-responses" },
              "x\u0007y": { api: "openai-responses" },
              [" "]: { api: "openai-responses" },
              ["m".repeat(257)]: { api: "openai-responses" },
              ok: { api: "openai-responses" },
            },
          },
        },
      },
      "/home/user",
    );
    assert.deepEqual(Object.keys(providers[0].models), ["ok"]);
    assert.equal(warnings.length, 4);
  });
});

describe("review 6: an explicit INFERENCE_GATEWAY_DEFAULT_API wins over the file", () => {
  const file = JSON.stringify({ providers: { gateway: { baseUrl: "https://gw.example.com", defaultApi: "openai-completions" } } });

  it("explicit env value equal to the built-in default still wins", async () => {
    const { providers } = await loadConfig({
      env: { INFERENCE_GATEWAY_BASE_URL: "https://gw.example.com", INFERENCE_GATEWAY_DEFAULT_API: "openai-responses" },
      home: "/home/user",
      readText: async () => file,
    });
    assert.equal(providers[0].defaultApi, "openai-responses");
  });

  it("unset env value leaves the file's", async () => {
    const { providers } = await loadConfig({
      env: { INFERENCE_GATEWAY_BASE_URL: "https://gw.example.com" },
      home: "/home/user",
      readText: async () => file,
    });
    assert.equal(providers[0].defaultApi, "openai-completions");
  });
});

describe("review 8: model ids that are Object.prototype names cannot corrupt config dicts", () => {
  it("keeps __proto__ as an ordinary own key", () => {
    const { providers } = parseConfigFile(
      JSON.parse('{"providers":{"gw":{"baseUrl":"https://gw.example.com","models":{"__proto__":{"api":"openai-completions"},"ok":{"api":"openai-responses"}}}}}'),
      "/home/user",
    );
    const { models } = providers[0];
    assert.equal(Object.getPrototypeOf(models), Object.prototype, "the dict's prototype is untouched");
    assert.ok(Object.hasOwn(models, "__proto__"));
    assert.deepEqual(Object.keys(models).sort(), ["__proto__", "ok"]);
  });

  it("does not read inherited properties as overrides", () => {
    for (const id of ["constructor", "toString", "hasOwnProperty"]) {
      const entry = parseModelEntry({ id });
      assert.ok(entry);
      const built = buildModel(entry, config());
      assert.equal(built.name, id, `${id} picked up an inherited override`);
    }
  });
});
