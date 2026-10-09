import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIG_FILE_NAME,
  agentDir,
  envProvider,
  expandHome,
  loadConfig,
  mergeProviders,
  normalizeBaseUrl,
  parseConfigFile,
  resolveToken,
} from "./config.ts";

const HOME = "/home/user";

describe("normalizeBaseUrl", () => {
  it("strips trailing slashes and a trailing /v1", () => {
    assert.equal(normalizeBaseUrl("https://gw.example.com"), "https://gw.example.com");
    assert.equal(normalizeBaseUrl("https://gw.example.com/"), "https://gw.example.com");
    assert.equal(normalizeBaseUrl("https://gw.example.com/v1"), "https://gw.example.com");
    assert.equal(normalizeBaseUrl("https://gw.example.com/v1/"), "https://gw.example.com");
    assert.equal(normalizeBaseUrl("  http://127.0.0.1:4000/proxy/v1 "), "http://127.0.0.1:4000/proxy");
  });

  it("keeps a path prefix that is not /v1", () => {
    assert.equal(normalizeBaseUrl("https://gw.example.com/llm"), "https://gw.example.com/llm");
    assert.equal(normalizeBaseUrl("https://gw.example.com/v1beta"), "https://gw.example.com/v1beta");
  });

  it("rejects non-http schemes, credentials, query and fragment", () => {
    assert.throws(() => normalizeBaseUrl("ftp://gw.example.com"), /http or https/);
    assert.throws(() => normalizeBaseUrl("file:///etc/passwd"), /http or https/);
    assert.throws(() => normalizeBaseUrl("https://user:pw@gw.example.com"), /credentials/);
    assert.throws(() => normalizeBaseUrl("https://gw.example.com?x=1"), /query/);
    assert.throws(() => normalizeBaseUrl("https://gw.example.com#x"), /fragment/);
    assert.throws(() => normalizeBaseUrl("not a url"), /valid URL/);
  });
});

describe("agentDir / expandHome", () => {
  it("honours PI_CODING_AGENT_DIR, expanding ~", () => {
    assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/tmp/agent" }, HOME), "/tmp/agent");
    assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~/alt" }, HOME), "/home/user/alt");
  });

  it("defaults to ~/.pi/agent", () => {
    assert.equal(agentDir({}, HOME), "/home/user/.pi/agent");
    assert.equal(agentDir({ PI_CODING_AGENT_DIR: "  " }, HOME), "/home/user/.pi/agent");
  });

  it("expands only a leading ~", () => {
    assert.equal(expandHome("~/x/token", HOME), "/home/user/x/token");
    assert.equal(expandHome("~", HOME), HOME);
    assert.equal(expandHome("/abs/~/x", HOME), "/abs/~/x");
  });
});

describe("envProvider", () => {
  it("is disabled without a base URL", () => {
    assert.deepEqual(envProvider({}, HOME), { providers: [], warnings: [] });
    assert.deepEqual(envProvider({ INFERENCE_GATEWAY_BASE_URL: " " }, HOME), { providers: [], warnings: [] });
  });

  it("builds the default provider, referencing the key by variable name", () => {
    const { providers, warnings } = envProvider(
      { INFERENCE_GATEWAY_BASE_URL: "https://gw.example.com/v1", INFERENCE_GATEWAY_API_KEY: "k" },
      HOME,
    );
    assert.deepEqual(warnings, []);
    assert.equal(providers.length, 1);
    const [provider] = providers;
    assert.equal(provider.id, "gateway");
    assert.equal(provider.baseUrl, "https://gw.example.com");
    assert.equal(provider.apiKeyEnv, "INFERENCE_GATEWAY_API_KEY");
    assert.equal(provider.tokenFile, undefined);
    assert.equal(provider.authHeader, "authorization");
    assert.equal(provider.defaultApi, "openai-responses");
    assert.equal(provider.modelsPath, "/v1/models");
    assert.equal(JSON.stringify(provider).includes('"k"'), false, "the key value must not be copied");
  });

  it("reads provider id, default API and token file", () => {
    const { providers } = envProvider(
      {
        INFERENCE_GATEWAY_BASE_URL: "http://127.0.0.1:4000",
        INFERENCE_GATEWAY_PROVIDER_ID: "litellm",
        INFERENCE_GATEWAY_DEFAULT_API: "openai-completions",
        INFERENCE_GATEWAY_TOKEN_FILE: "~/.config/gw/token",
      },
      HOME,
    );
    assert.equal(providers[0].id, "litellm");
    assert.equal(providers[0].defaultApi, "openai-completions");
    assert.equal(providers[0].tokenFile, "/home/user/.config/gw/token");
  });

  it("warns and falls back on invalid id and API", () => {
    const { providers, warnings } = envProvider(
      {
        INFERENCE_GATEWAY_BASE_URL: "http://127.0.0.1:4000",
        INFERENCE_GATEWAY_PROVIDER_ID: "has/slash",
        INFERENCE_GATEWAY_DEFAULT_API: "google-vertex",
      },
      HOME,
    );
    assert.equal(providers[0].id, "gateway");
    assert.equal(providers[0].defaultApi, "openai-responses");
    assert.equal(warnings.length, 2);
  });

  it("warns and disables on an invalid base URL", () => {
    const { providers, warnings } = envProvider({ INFERENCE_GATEWAY_BASE_URL: "ftp://x.example.com" }, HOME);
    assert.equal(providers.length, 0);
    assert.match(warnings[0], /INFERENCE_GATEWAY_BASE_URL/);
  });
});

describe("parseConfigFile", () => {
  it("parses a full provider entry", () => {
    const { providers, warnings } = parseConfigFile(
      {
        providers: {
          gateway: {
            baseUrl: "https://gw.example.com/",
            apiKeyEnv: "GW_KEY",
            authHeader: "X-API-Key",
            defaultApi: "openai-completions",
            headers: { "X-Team": "docs" },
            modelsPath: "/models",
            include: ["claude-*", "gpt-*"],
            exclude: ["*embed*"],
            models: {
              "claude-sonnet-5": { api: "anthropic-messages", contextWindow: 1000000, input: ["image"] },
            },
            fallbackModels: ["claude-sonnet-5"],
          },
        },
      },
      HOME,
    );
    assert.deepEqual(warnings, []);
    assert.equal(providers.length, 1);
    const [provider] = providers;
    assert.equal(provider.baseUrl, "https://gw.example.com");
    assert.equal(provider.apiKeyEnv, "GW_KEY");
    assert.equal(provider.authHeader, "x-api-key");
    assert.equal(provider.defaultApi, "openai-completions");
    assert.deepEqual(provider.headers, { "x-team": "docs" });
    assert.equal(provider.modelsPath, "/models");
    assert.deepEqual(provider.include, ["claude-*", "gpt-*"]);
    assert.deepEqual(provider.exclude, ["*embed*"]);
    assert.deepEqual(provider.models["claude-sonnet-5"], {
      api: "anthropic-messages",
      contextWindow: 1000000,
      input: ["text", "image"],
    });
    assert.deepEqual(provider.fallbackModels, ["claude-sonnet-5"]);
  });

  it("expands ~ in tokenFile", () => {
    const { providers } = parseConfigFile(
      { providers: { gw: { baseUrl: "https://gw.example.com", tokenFile: "~/.config/gw/token" } } },
      HOME,
    );
    assert.equal(providers[0].tokenFile, "/home/user/.config/gw/token");
  });

  it("refuses a literal apiKey and credential headers", () => {
    const { providers, warnings } = parseConfigFile(
      {
        providers: {
          a: { baseUrl: "https://a.example.com", apiKey: "secret" },
          b: { baseUrl: "https://b.example.com", headers: { Authorization: "Bearer x", "x-api-key": "y", ok: "1" } },
        },
      },
      HOME,
    );
    assert.deepEqual(
      providers.map((provider) => provider.id),
      ["b"],
    );
    assert.deepEqual(providers[0].headers, { ok: "1" });
    assert.equal(warnings.length, 3);
    assert.equal(warnings.join("\n").includes("secret"), false, "warnings must not echo the key");
  });

  it("skips invalid entries with a warning and keeps valid ones", () => {
    const { providers, warnings } = parseConfigFile(
      {
        providers: {
          "bad/id": { baseUrl: "https://x.example.com" },
          nourl: {},
          badurl: { baseUrl: "javascript:alert(1)" },
          notobj: 3,
          good: { baseUrl: "https://good.example.com" },
        },
      },
      HOME,
    );
    assert.deepEqual(
      providers.map((provider) => provider.id),
      ["good"],
    );
    assert.equal(warnings.length, 4);
  });

  it("falls back on invalid optional fields", () => {
    const { providers, warnings } = parseConfigFile(
      {
        providers: {
          gw: {
            baseUrl: "https://gw.example.com",
            apiKeyEnv: "not a var",
            authHeader: "bad header",
            defaultApi: "nope",
            modelsPath: "v1/models",
            include: "claude-*",
            headers: { "x-bad": "a\r\nb" },
            models: { m: { api: "nope", contextWindow: -1, maxTokens: 1.5 } },
            fallbackModels: "m",
          },
        },
      },
      HOME,
    );
    const [provider] = providers;
    assert.equal(provider.apiKeyEnv, undefined);
    assert.equal(provider.authHeader, "authorization");
    assert.equal(provider.defaultApi, "openai-responses");
    assert.equal(provider.modelsPath, "/v1/models");
    assert.deepEqual(provider.include, []);
    assert.deepEqual(provider.headers, {});
    assert.deepEqual(provider.models.m, {});
    assert.deepEqual(provider.fallbackModels, []);
    assert.equal(warnings.length, 8);
  });

  it("rejects a file without a providers object", () => {
    assert.equal(parseConfigFile([], HOME).providers.length, 0);
    assert.equal(parseConfigFile({ gateway: {} }, HOME).warnings.length, 1);
  });
});

describe("mergeProviders", () => {
  it("lets the environment supply the connection and the file everything else", () => {
    const fromEnv = envProvider(
      { INFERENCE_GATEWAY_BASE_URL: "https://env.example.com", INFERENCE_GATEWAY_DEFAULT_API: "anthropic-messages" },
      HOME,
    ).providers;
    const fromFile = parseConfigFile(
      {
        providers: {
          gateway: {
            baseUrl: "https://file.example.com",
            apiKeyEnv: "FILE_KEY",
            include: ["claude-*"],
            models: { "claude-sonnet-5": { contextWindow: 1000 } },
          },
          other: { baseUrl: "https://other.example.com" },
        },
      },
      HOME,
    ).providers;
    const merged = mergeProviders(fromEnv, fromFile);
    assert.deepEqual(
      merged.map((provider) => provider.id),
      ["gateway", "other"],
    );
    const [gateway] = merged;
    assert.equal(gateway.baseUrl, "https://env.example.com");
    assert.equal(gateway.apiKeyEnv, "INFERENCE_GATEWAY_API_KEY");
    assert.equal(gateway.defaultApi, "anthropic-messages");
    assert.deepEqual(gateway.include, ["claude-*"]);
    assert.equal(gateway.models["claude-sonnet-5"].contextWindow, 1000);
  });
});

describe("loadConfig", () => {
  const readNothing = async () => undefined;

  it("is empty and silent when nothing is configured", async () => {
    const result = await loadConfig({ env: {}, home: HOME, readText: readNothing });
    assert.deepEqual(result.providers, []);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.path, `/home/user/.pi/agent/${CONFIG_FILE_NAME}`);
  });

  it("reads the file from PI_CODING_AGENT_DIR", async () => {
    const seen: string[] = [];
    const result = await loadConfig({
      env: { PI_CODING_AGENT_DIR: "/tmp/agent" },
      home: HOME,
      readText: async (path) => {
        seen.push(path);
        return JSON.stringify({ providers: { gw: { baseUrl: "https://gw.example.com" } } });
      },
    });
    assert.deepEqual(seen, [`/tmp/agent/${CONFIG_FILE_NAME}`]);
    assert.equal(result.providers[0].id, "gw");
  });

  it("warns on invalid JSON and still returns the env provider", async () => {
    const result = await loadConfig({
      env: { INFERENCE_GATEWAY_BASE_URL: "https://gw.example.com" },
      home: HOME,
      readText: async () => "{ not json",
    });
    assert.equal(result.providers.length, 1);
    assert.match(result.warnings[0], /invalid JSON/);
  });

  it("warns when the file cannot be read", async () => {
    const result = await loadConfig({
      env: {},
      home: HOME,
      readText: async () => {
        throw new Error("EACCES");
      },
    });
    assert.equal(result.providers.length, 0);
    assert.match(result.warnings[0], /EACCES/);
  });
});

describe("resolveToken", () => {
  it("reads the API key variable at call time", async () => {
    const env: Record<string, string | undefined> = { GW_KEY: " k1 " };
    assert.equal(await resolveToken({ apiKeyEnv: "GW_KEY" }, env), "k1");
    env.GW_KEY = "k2";
    assert.equal(await resolveToken({ apiKeyEnv: "GW_KEY" }, env), "k2");
  });

  it("re-reads the token file on every call, and it wins over the variable", async () => {
    let contents = "t1\n";
    const read = async () => contents;
    const config = { apiKeyEnv: "GW_KEY", tokenFile: "/run/token" };
    assert.equal(await resolveToken(config, { GW_KEY: "k" }, read), "t1");
    contents = "t2\n";
    assert.equal(await resolveToken(config, { GW_KEY: "k" }, read), "t2");
  });

  it("is undefined when unconfigured, empty, missing or malformed", async () => {
    assert.equal(await resolveToken({}, {}), undefined);
    assert.equal(await resolveToken({ apiKeyEnv: "GW_KEY" }, {}), undefined);
    assert.equal(await resolveToken({ apiKeyEnv: "GW_KEY" }, { GW_KEY: "  " }), undefined);
    assert.equal(await resolveToken({ tokenFile: "/missing" }, {}, async () => undefined), undefined);
    assert.equal(await resolveToken({ tokenFile: "/t" }, {}, async () => "a\nb"), undefined);
  });
});
