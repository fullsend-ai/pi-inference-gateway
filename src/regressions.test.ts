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
