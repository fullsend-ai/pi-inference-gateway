// agentgateway (github.com/agentgateway/agentgateway) as a documented gateway: the deltas D1–D9
// from the research doc "agentgateway as the second documented gateway for pi-inference-gateway".
// Shapes below are the ones agentgateway's `llm:` mode returns (its /v1/models is synthesised:
// every entry `owned_by: "openai"`, no other metadata, wildcard entries listed literally when
// catalog discovery is off).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createProvider, normalizeContext } from "@earendil-works/pi-ai";
import type { Context, FetchFunction } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { parseConfigFile, type GatewayConfig } from "./config.ts";
import { buildModel, discoverModels, extraModels, findCatalogModel, modelsFromList, parseModelEntry, parseModelList } from "./discovery.ts";
import { createGatewayProvider, gatewayProviderOptions, initialModels, onceWarn } from "./provider.ts";
import { sseFor } from "./test-fixtures.ts";

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

describe("D1: owned_by \"openai\" on every entry does not send Claude to /v1/responses", () => {
  it("routes Claude to anthropic-messages although the gateway says owned_by: openai", () => {
    const { models } = modelsFromList(AGW_LIST, config());
    assert.deepEqual(
      models.map((model) => [model.id, model.api]),
      [
        // Not in pi's anthropic/openai catalog, not claude-: the openai owner decides (agentgateway
        // translates Responses to the model's chat backend; set `api` to use chat directly).
        ["open-weight/glm-5-3", "openai-responses"],
        ["claude-sonnet-5", "anthropic-messages"],
        ["gpt-6-luna", "openai-responses"],
      ],
    );
  });

  it("a claude- id unknown to pi's catalog also beats the owner, with or without a vendor prefix", () => {
    const { models } = modelsFromList(
      { data: [{ id: "claude-future-9", owned_by: "openai" }, { id: "anthropic/claude-future-9", owned_by: "openai" }] },
      config({ defaultApi: "openai-completions" }),
    );
    assert.deepEqual(
      models.map((model) => model.api),
      ["anthropic-messages", "anthropic-messages"],
    );
  });
});

describe("D6 (config-driven): models[id].thinkingLevelMap decides what reasoning_effort carries", () => {
  it("parses a per-model map: level → string or null; warns about anything else", () => {
    const { providers, warnings } = parseConfigFile(
      {
        providers: {
          gw: {
            baseUrl: "https://gateway.example.com",
            models: {
              a: { thinkingLevelMap: { off: "none", high: "high", xhigh: null, ultra: "x", low: 3 } },
              b: { thinkingLevelMap: null },
              c: { thinkingLevelMap: "high" },
            },
          },
        },
      },
      "/home/user",
    );
    assert.deepEqual(providers[0].models.a.thinkingLevelMap, { off: "none", high: "high", xhigh: null });
    assert.equal(providers[0].models.b.thinkingLevelMap, null);
    assert.equal(providers[0].models.c.thinkingLevelMap, undefined);
    assert.equal(warnings.filter((warning) => /thinkingLevelMap/.test(warning)).length, 3, warnings.join("\n"));
  });

  it("merges over the catalog's map on the same transport; null drops it", () => {
    const catalogModel = getBuiltinProviders()
      .flatMap((provider) => getBuiltinModels(provider))
      .find((candidate) => candidate.api === "openai-completions" && candidate.thinkingLevelMap?.high !== undefined && findCatalogModel(candidate.id)?.model === candidate);
    assert.ok(catalogModel, "pi's catalog has no openai-completions model with a thinkingLevelMap; drop this case");
    const entry = parseModelEntry({ id: catalogModel.id, api: "openai-completions" });
    assert.ok(entry);
    const merged = buildModel(entry, config({ models: { [catalogModel.id]: { thinkingLevelMap: { off: "none", high: "custom" } } } }));
    assert.deepEqual(merged.thinkingLevelMap, { ...catalogModel.thinkingLevelMap, off: "none", high: "custom" });
    const dropped = buildModel(entry, config({ models: { [catalogModel.id]: { thinkingLevelMap: null } } }));
    assert.equal(dropped.thinkingLevelMap, undefined);
    const inherited = buildModel(entry, config());
    assert.deepEqual(inherited.thinkingLevelMap, catalogModel.thinkingLevelMap, "no override: copied unchanged");
  });

  it("over pi's real transport, the configured values are what reasoning_effort carries", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch: FetchFunction = async (input, init) => {
      bodies.push(JSON.parse(await new Request(input, init).text()));
      return new Response(sseFor("/v1/chat/completions", "m", "ok"), { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const cfg = config({
      models: {
        "effort-test": {
          api: "openai-completions",
          reasoning: true,
          compat: { supportsReasoningEffort: true },
          thinkingLevelMap: { off: "none", high: "high" },
        },
      },
    });
    const [model] = extraModels(cfg, new Set());
    const provider = createProvider(gatewayProviderOptions(cfg, [model], { env: { GW_KEY: "tok" } }));
    const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] } satisfies Context);
    for (const reasoning of ["high", undefined] as const) {
      for await (const _event of provider.streamSimple(model, context, { apiKey: "tok", fetch, ...(reasoning ? { reasoning } : {}) })) {
        // drain
      }
    }
    assert.deepEqual(
      bodies.map((body) => body.reasoning_effort),
      ["high", "none"],
    );
  });
});

describe("D5: text/plain error bodies are shown, never a credential", () => {
  const text = (status: number, body: string, type = "text/plain") =>
    (async () => new Response(body, { status, headers: { "content-type": type } })) satisfies FetchFunction;

  const TOKEN = "tok-abcdef-123456"; // gitleaks:allow (test fixture)
  const omitted = (status: number) => ({ message: `model list request returned HTTP ${status}: (body omitted)` });

  it("discovery errors carry a text/plain body", async () => {
    await assert.rejects(
      discoverModels(config(), { token: TOKEN, fetch: text(401, "authentication failure: no bearer token found") }),
      { message: "model list request returned HTTP 401: authentication failure: no bearer token found" },
    );
  });

  for (const short of ["k", "k9", "k9z", "abcdefg"]) {
    it(`omits the body when a credential is shorter than 8 characters (${short.length})`, async () => {
      await assert.rejects(discoverModels(config(), { token: short, fetch: text(401, `token ${short} rejected`) }), omitted(401));
    });
  }

  it("replaces embedded occurrences too", async () => {
    await assert.rejects(discoverModels(config(), { token: TOKEN, fetch: text(401, `x${TOKEN}y and key=${TOKEN}`) }), {
      message: "model list request returned HTTP 401: x[redacted]y and key=[redacted]",
    });
  });

  it("redacts a Bearer value and a custom-header value", async () => {
    await assert.rejects(discoverModels(config(), { token: TOKEN, fetch: text(401, `got Bearer ${TOKEN}`) }), (error: Error) => {
      assert.ok(!error.message.includes(TOKEN), error.message);
      return true;
    });
    const cfg = config({ authHeaders: { discovery: "x-gateway-key" } });
    await assert.rejects(discoverModels(cfg, { token: TOKEN, fetch: text(401, `x-gateway-key: ${TOKEN}`) }), (error: Error) => {
      assert.ok(!error.message.includes(TOKEN), error.message);
      return true;
    });
  });

  describe("Basic credentials, in every form", () => {
    const basic = { username: "gateway-user", password: "pa55word-xyz" }; // gitleaks:allow (test fixture)
    const pair = "gateway-user:pa55word-xyz"; // gitleaks:allow (test fixture)
    const encoded = Buffer.from(pair).toString("base64");
    const cfg = config({ authHeaders: { discovery: "basic" } });
    for (const [name, body] of [
      ["the header value", `Basic ${encoded}`],
      ["the base64 pair", `got ${encoded}`],
      ["the decoded pair", `got ${pair}`],
      ["the password alone", "password pa55word-xyz is wrong"],
      ["the username alone", "unknown user gateway-user"],
    ] as const) {
      it(`redacts ${name}`, async () => {
        await assert.rejects(discoverModels(cfg, { credentials: { basic, problems: [] }, fetch: text(401, body) }), (error: Error) => {
          for (const secret of [encoded, pair, "pa55word-xyz", "gateway-user"]) assert.ok(!error.message.includes(secret), error.message);
          assert.match(error.message, /\[redacted\]/);
          return true;
        });
      });
    }

    it("omits the body with the 7-character default username `gateway`", async () => {
      const withDefault = { username: "gateway", password: "pa55word-xyz" }; // gitleaks:allow (test fixture)
      await assert.rejects(
        discoverModels(cfg, { credentials: { basic: withDefault, problems: [] }, fetch: text(401, "unknown user gateway") }),
        omitted(401),
      );
    });
  });

  it("never keeps the prefix of a credential cut by the read limit", async () => {
    for (let offset = 480; offset <= 512; offset++) {
      // Whitespace collapses when the body is flattened, so a cut 500 bytes in can still be shown.
      const body = `${" ".repeat(offset - 1)}a${TOKEN}${"b".repeat(600)}`;
      await assert.rejects(discoverModels(config(), { token: TOKEN, fetch: text(401, body) }), (error: Error) => {
        for (let length = 1; length <= TOKEN.length; length++) {
          assert.ok(!error.message.includes(`a${TOKEN.slice(0, length)}`), `offset ${offset}: prefix of length ${length} kept`);
        }
        return true;
      });
    }
  });

  it("truncates long bodies and strips control characters", async () => {
    await assert.rejects(discoverModels(config(), { token: TOKEN, fetch: text(500, `a\u0007b${"x".repeat(5000)}`) }), (error: Error) => {
      assert.ok(error.message.length < 400, String(error.message.length));
      assert.match(error.message, /HTTP 500: a bx+…$/);
      return true;
    });
  });

  it("does not echo JSON or HTML bodies", async () => {
    await assert.rejects(discoverModels(config(), { token: TOKEN, fetch: text(404, `{"error":"x"}`, "application/json") }), {
      message: "model list request returned HTTP 404",
    });
    await assert.rejects(discoverModels(config(), { token: TOKEN, fetch: text(502, "<html>bad</html>", "text/html") }), {
      message: "model list request returned HTTP 502",
    });
  });

  it("inference errors: pi's own transport already reports the text/plain body", async () => {
    const message = "failed to process LLM request: unsupported conversion: from Responses to provider anthropic (supported: [AnthropicMessages])";
    const cfg = config();
    const model = buildModel({ id: "claude-sonnet-5", api: "openai-responses", endpoints: [], owners: [] }, cfg);
    const provider = createProvider(gatewayProviderOptions(cfg, [model], { env: { GW_KEY: "tok" } }));
    const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] } satisfies Context);
    let error = "";
    for await (const event of provider.streamSimple(model, context, { apiKey: "tok", fetch: text(400, message), maxRetries: 0 })) {
      if (event.type === "error") error = event.error.errorMessage ?? "";
    }
    assert.match(error, /400/);
    assert.ok(error.includes("unsupported conversion: from Responses to provider anthropic"), error);
  });
});

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
