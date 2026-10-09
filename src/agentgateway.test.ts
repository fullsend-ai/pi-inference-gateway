// agentgateway (github.com/agentgateway/agentgateway) as a documented gateway: the deltas D1–D9
// from the research doc "agentgateway as the second documented gateway for pi-inference-gateway".
// Shapes below are the ones agentgateway's `llm:` mode returns (its /v1/models is synthesised:
// every entry `owned_by: "openai"`, no other metadata, wildcard entries listed literally when
// catalog discovery is off).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FetchFunction } from "@earendil-works/pi-ai";
import type { GatewayConfig } from "./config.ts";
import { modelsFromList, parseModelList } from "./discovery.ts";
import { createGatewayProvider, initialModels, onceWarn } from "./provider.ts";

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    id: "gateway",
    baseUrl: "https://gateway.example.com",
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

/** What agentgateway's synthesised list looks like (lab, agentgateway 9d36620d, discovery: disabled). */
const AGW_LIST = {
  object: "list",
  data: [
    { id: "open-weight/glm-5-3", object: "model", created: 0, owned_by: "openai" },
    { id: "claude-sonnet-5", object: "model", created: 0, owned_by: "openai" },
    { id: "gpt-6-luna", object: "model", created: 0, owned_by: "openai" },
    { id: "openai/*", object: "model", created: 0, owned_by: "openai" },
  ],
};

describe("D3: wildcard list entries are dropped with one warning", () => {
  it("drops ids containing *", () => {
    const { entries, wildcards } = parseModelList(AGW_LIST);
    assert.deepEqual(
      entries.map((entry) => entry.id),
      ["open-weight/glm-5-3", "claude-sonnet-5", "gpt-6-luna"],
    );
    assert.deepEqual(wildcards, ["openai/*"]);
  });

  it("warns once, naming the ids and pointing at `models`", () => {
    const { models, warnings } = modelsFromList(
      { data: [...AGW_LIST.data, { id: "anthropic/*" }, { id: "*-mini" }] },
      config(),
    );
    assert.equal(models.length, 3);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /openai\/\*, anthropic\/\*, \*-mini/);
    assert.match(warnings[0], /add concrete ids via "models"/);
  });

  it("no warning when nothing was a wildcard", () => {
    assert.deepEqual(modelsFromList({ data: [{ id: "a" }] }, config()).warnings, []);
  });

  it("load-time discovery and a later refresh print it once (registerGateways' onceWarn)", async () => {
    const printed: string[] = [];
    const warn = onceWarn((message) => printed.push(message));
    const fetch: FetchFunction = async () => new Response(JSON.stringify(AGW_LIST), { status: 200 });
    const deps = { env: { GW_KEY: "tok" }, fetch, warn };
    const provider = createGatewayProvider(config(), await initialModels(config(), deps), deps);
    assert.ok(provider.refreshModels);
    await provider.refreshModels({ allowNetwork: true, signal: new AbortController().signal, publish: async () => true });
    assert.equal(printed.length, 1);
    assert.match(printed[0], /^\[pi-inference-gateway\] gateway: ignored wildcard model id\(s\) openai\/\*/);
  });
});
