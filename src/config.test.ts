import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIG_FILE_NAME,
  LOCAL_CONFIG_FILE_NAME,
  agentDir,
  authHeaderEntry,
  authHeaderFor,
  bindEnvCredentials,
  resolveCredentials,
  parseAuthHeaderEnv,
  parseAuthHeaders,
  parseExtraModelsEnv,
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
    assert.deepEqual(envProvider({}, HOME), { providers: [], warnings: [], defaultApiSet: false });
    assert.deepEqual(envProvider({ INFERENCE_GATEWAY_BASE_URL: " " }, HOME), { providers: [], warnings: [], defaultApiSet: false });
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
    assert.deepEqual(provider.authHeaders, {}, "every transport keeps its native header");
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
    assert.deepEqual(provider.authHeaders, {
      "anthropic-messages": "x-api-key",
      "openai-responses": "x-api-key",
      "openai-completions": "x-api-key",
      discovery: "x-api-key",
    });
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
    assert.deepEqual(provider.authHeaders, {}, "every transport keeps its native header");
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

describe("compat override parsing", () => {
  it("accepts primitive flags, null, and warns on the rest", () => {
    const { providers, warnings } = parseConfigFile(
      {
        providers: {
          gw: {
            baseUrl: "https://gw.example.com",
            models: {
              a: { compat: { supportsStore: false, maxTokensField: "max_tokens", n: 2, bad: { x: 1 }, "bad key": true } },
              b: { compat: null },
              c: { compat: "no" },
            },
          },
        },
      },
      HOME,
    );
    const { models } = providers[0];
    assert.deepEqual(models.a.compat, { supportsStore: false, maxTokensField: "max_tokens", n: 2 });
    assert.equal(models.b.compat, null);
    assert.equal("compat" in models.c, false);
    assert.equal(warnings.length, 3);
  });
});

describe("auth header overrides", () => {
  it("native defaults: x-api-key for Messages, Bearer for the OpenAI transports and discovery", () => {
    const none = { authHeaders: {} };
    assert.equal(authHeaderFor(none, "anthropic-messages"), "x-api-key");
    assert.equal(authHeaderFor(none, "openai-responses"), "authorization");
    assert.equal(authHeaderFor(none, "openai-completions"), "authorization");
    assert.equal(authHeaderFor(none, "discovery"), "authorization");
  });

  it("accepts a per-target object in the file", () => {
    const warnings: string[] = [];
    const parsed = parseAuthHeaders({ "anthropic-messages": "Authorization", discovery: "x-api-key" }, "p", warnings);
    assert.deepEqual(parsed, { "anthropic-messages": "authorization", discovery: "x-api-key" });
    assert.equal(authHeaderFor({ authHeaders: parsed }, "anthropic-messages"), "authorization");
    assert.equal(authHeaderFor({ authHeaders: parsed }, "openai-responses"), "authorization", "unset targets stay native");
    assert.deepEqual(warnings, []);
  });

  it("warns on unknown targets and bad header names", () => {
    const warnings: string[] = [];
    assert.deepEqual(parseAuthHeaders({ "google-vertex": "x-api-key", "openai-responses": "bad header" }, "p", warnings), {});
    assert.equal(warnings.length, 2);
    assert.deepEqual(parseAuthHeaders(42, "p", warnings), {});
    assert.equal(warnings.length, 3);
  });

  it("reads INFERENCE_GATEWAY_AUTH_HEADER as one header or target=header pairs", () => {
    const warnings: string[] = [];
    assert.equal(parseAuthHeaderEnv("X-Api-Key", warnings)["openai-completions"], "x-api-key");
    assert.deepEqual(parseAuthHeaderEnv("anthropic-messages=authorization, discovery=x-api-key", warnings), {
      "anthropic-messages": "authorization",
      discovery: "x-api-key",
    });
    assert.deepEqual(warnings, []);
    assert.deepEqual(parseAuthHeaderEnv("nope=authorization", warnings), {});
    assert.equal(warnings.length, 1);
    const { providers } = envProvider(
      { INFERENCE_GATEWAY_BASE_URL: "https://gw.example.com", INFERENCE_GATEWAY_AUTH_HEADER: "anthropic-messages=authorization" },
      HOME,
    );
    assert.deepEqual(providers[0].authHeaders, { "anthropic-messages": "authorization" });
  });
});

describe("auth schemes and Basic credentials", () => {
  it("accepts bearer (alias of authorization), basic and header names", () => {
    const warnings: string[] = [];
    assert.deepEqual(parseAuthHeaders({ "anthropic-messages": "x-api-key", "openai-responses": "Bearer", discovery: "BASIC" }, "p", warnings), {
      "anthropic-messages": "x-api-key",
      "openai-responses": "authorization",
      discovery: "basic",
    });
    assert.equal(parseAuthHeaderEnv("basic", warnings).discovery, "basic");
    assert.deepEqual(warnings, []);
  });

  it("builds the exact header bytes per scheme", () => {
    const credentials = { token: "tok", basic: { username: "gateway", password: "test-pass" }, problems: [] }; // gitleaks:allow (test fixture)
    assert.deepEqual(authHeaderEntry("authorization", credentials), ["authorization", "Bearer tok"]);
    assert.deepEqual(authHeaderEntry("x-api-key", credentials), ["x-api-key", "tok"]);
    assert.deepEqual(authHeaderEntry("basic", credentials), ["authorization", "Basic Z2F0ZXdheTp0ZXN0LXBhc3M="]);
    assert.deepEqual(authHeaderEntry("basic", { basic: { username: "svc", password: "p@ss w:rd" }, problems: [] }), [ // gitleaks:allow (test fixture)
      "authorization",
      "Basic c3ZjOnBAc3MgdzpyZA==",
    ]);
    assert.equal(authHeaderEntry("basic", { token: "tok", problems: [] }), undefined);
    assert.equal(authHeaderEntry("authorization", { basic: { username: "u", password: "p" }, problems: [] }), undefined);
  });

  it("resolves Basic from env vars, with gateway as the default username", async () => {
    const config = { usernameEnv: "U", passwordEnv: "P" };
    assert.deepEqual((await resolveCredentials(config, { P: "pw" })).basic, { username: "gateway", password: "pw" });
    assert.deepEqual((await resolveCredentials(config, { U: "svc", P: "pw" })).basic, { username: "svc", password: "pw" });
    assert.deepEqual((await resolveCredentials({ ...config, username: "lit" }, { P: "pw" })).basic, { username: "lit", password: "pw" });
    assert.equal((await resolveCredentials(config, {})).basic, undefined, "no password, no Basic");
  });

  it("re-reads the password file each call, and it wins over the variable", async () => {
    let file = "p1\n";
    const config = { passwordEnv: "P", passwordFile: "/run/pw" };
    const read = async () => file;
    assert.equal((await resolveCredentials(config, { P: "env" }, read)).basic?.password, "p1");
    file = "p2\n";
    assert.equal((await resolveCredentials(config, { P: "env" }, read)).basic?.password, "p2");
  });

  it("rejects a username containing ':' without echoing it", async () => {
    const result = await resolveCredentials({ usernameEnv: "U", passwordEnv: "P" }, { U: "a:b", P: "pw" });
    assert.equal(result.basic, undefined);
    assert.equal(result.problems.length, 1);
    assert.equal(result.problems[0].includes("a:b"), false);
    const { warnings } = parseConfigFile({ providers: { gw: { baseUrl: "https://gw.example.com", username: "a:b" } } }, HOME);
    assert.equal(warnings.length, 1);
  });

  it("refuses a literal password in the file", () => {
    const { providers, warnings } = parseConfigFile({ providers: { gw: { baseUrl: "https://gw.example.com", password: "s3cret" } } }, HOME); // gitleaks:allow (test fixture)
    assert.equal(providers.length, 0);
    assert.equal(warnings.join().includes("s3cret"), false);
  });

  it("wires the INFERENCE_GATEWAY_BASIC_* variables into the env provider", () => {
    const { providers } = envProvider(
      { INFERENCE_GATEWAY_BASE_URL: "https://gw.example.com", INFERENCE_GATEWAY_BASIC_PASSWORD_FILE: "~/.config/gw/pass" },
      HOME,
    );
    assert.equal(providers[0].usernameEnv, "INFERENCE_GATEWAY_BASIC_USER");
    assert.equal(providers[0].passwordEnv, "INFERENCE_GATEWAY_BASIC_PASSWORD");
    assert.equal(providers[0].passwordFile, "/home/user/.config/gw/pass");
  });
});

describe("trusted-URL binding of INFERENCE_GATEWAY_* credentials", () => {
  const file = (baseUrl: string, extra: Record<string, unknown> = {}) =>
    async () => JSON.stringify({ providers: { other: { baseUrl, apiKeyEnv: "INFERENCE_GATEWAY_API_KEY", ...extra } } });

  it("refuses a file provider that names an INFERENCE_GATEWAY_* credential for another URL", async () => {
    const { providers, warnings } = await loadConfig({
      env: { INFERENCE_GATEWAY_BASE_URL: "https://gw.example.com", INFERENCE_GATEWAY_API_KEY: "k" },
      home: HOME,
      readText: file("https://elsewhere.example.com"),
    });
    assert.deepEqual(
      providers.map((provider) => provider.id),
      ["gateway"],
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /other: refused .*INFERENCE_GATEWAY_API_KEY.*https:\/\/elsewhere\.example\.com/);
    assert.equal(warnings[0].includes('"k"'), false);
  });

  it("refuses it when INFERENCE_GATEWAY_BASE_URL is unset", async () => {
    const { providers, warnings } = await loadConfig({ env: { INFERENCE_GATEWAY_API_KEY: "k" }, home: HOME, readText: file("https://gw.example.com") });
    assert.deepEqual(providers, []);
    assert.match(warnings[0], /\(unset\)/);
  });

  it("refuses Basic variables the same way", async () => {
    const { providers } = await loadConfig({
      env: { INFERENCE_GATEWAY_BASE_URL: "https://gw.example.com" },
      home: HOME,
      readText: async () =>
        JSON.stringify({ providers: { other: { baseUrl: "https://elsewhere.example.com", passwordEnv: "INFERENCE_GATEWAY_BASIC_PASSWORD" } } }),
    });
    assert.deepEqual(
      providers.map((provider) => provider.id),
      ["gateway"],
    );
  });

  it("allows it for the same URL, ignoring a trailing slash and /v1", async () => {
    for (const [envUrl, fileUrl] of [
      ["https://gw.example.com", "https://gw.example.com"],
      ["https://gw.example.com/v1/", "https://gw.example.com"],
      ["https://GW.example.com:443/", "https://gw.example.com/v1"],
      ["http://127.0.0.1:4000/proxy", "http://127.0.0.1:4000/proxy/v1/"],
    ]) {
      const { providers, warnings } = await loadConfig({ env: { INFERENCE_GATEWAY_BASE_URL: envUrl }, home: HOME, readText: file(fileUrl) });
      assert.deepEqual(warnings, [], `${envUrl} vs ${fileUrl}`);
      assert.ok(providers.some((provider) => provider.id === "other"), `${envUrl} vs ${fileUrl}`);
    }
  });

  it("does not match a different path, port or scheme", async () => {
    for (const fileUrl of ["https://gw.example.com/other", "https://gw.example.com:8443", "http://gw.example.com"]) {
      const { providers } = await loadConfig({ env: { INFERENCE_GATEWAY_BASE_URL: "https://gw.example.com" }, home: HOME, readText: file(fileUrl) });
      assert.equal(providers.some((provider) => provider.id === "other"), false, fileUrl);
    }
  });

  it("leaves providers with their own variables alone", async () => {
    const { providers, warnings } = await loadConfig({
      env: {},
      home: HOME,
      readText: async () => JSON.stringify({ providers: { mine: { baseUrl: "https://elsewhere.example.com", apiKeyEnv: "MY_KEY" } } }),
    });
    assert.deepEqual(warnings, []);
    assert.equal(providers[0].id, "mine");
  });

  it("is a pure function over the merged providers", () => {
    const { providers } = bindEnvCredentials(
      [
        { ...envProvider({ INFERENCE_GATEWAY_BASE_URL: "https://gw.example.com" }, HOME).providers[0] },
      ],
      { INFERENCE_GATEWAY_BASE_URL: "https://gw.example.com/" },
    );
    assert.equal(providers.length, 1);
  });
});

describe("extra models", () => {
  it("reads INFERENCE_GATEWAY_EXTRA_MODELS id=api pairs, ids verbatim", () => {
    const warnings: string[] = [];
    assert.deepEqual(parseExtraModelsEnv("gpt-6-luna=openai-responses, oss/zai-org/glm-5-3=openai-completions,", warnings), {
      "gpt-6-luna": { api: "openai-responses" },
      "oss/zai-org/glm-5-3": { api: "openai-completions" },
    });
    assert.deepEqual(warnings, []);
  });

  it("warns on malformed pairs", () => {
    const warnings: string[] = [];
    assert.deepEqual(parseExtraModelsEnv("no-api,=openai-responses,x=google-vertex,a b=openai-responses", warnings), {});
    assert.equal(warnings.length, 4);
  });

  it("feeds the env provider", () => {
    const { providers } = envProvider(
      { INFERENCE_GATEWAY_BASE_URL: "https://gw.example.com", INFERENCE_GATEWAY_EXTRA_MODELS: "gpt-6-luna=openai-responses" },
      HOME,
    );
    assert.deepEqual(providers[0].models, { "gpt-6-luna": { api: "openai-responses" } });
  });
});

describe("mergeProviders", () => {
  it("lets the environment supply the connection and the file everything else", () => {
    const env = envProvider(
      { INFERENCE_GATEWAY_BASE_URL: "https://env.example.com", INFERENCE_GATEWAY_DEFAULT_API: "anthropic-messages" },
      HOME,
    );
    assert.equal(env.defaultApiSet, true);
    const fromEnv = env.providers;
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
    const merged = mergeProviders(fromEnv, fromFile, { envDefaultApiSet: env.defaultApiSet });
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

  it("merges auth-header overrides and models per key, file fields winning per model", () => {
    const fromEnv = envProvider(
      {
        INFERENCE_GATEWAY_BASE_URL: "https://env.example.com",
        INFERENCE_GATEWAY_AUTH_HEADER: "discovery=x-api-key",
        INFERENCE_GATEWAY_EXTRA_MODELS: "a=openai-responses,b=openai-completions",
      },
      HOME,
    ).providers;
    const fromFile = parseConfigFile(
      {
        providers: {
          gateway: {
            baseUrl: "https://file.example.com",
            authHeader: { "anthropic-messages": "authorization", discovery: "authorization" },
            models: { b: { api: "anthropic-messages", contextWindow: 9 }, c: { api: "openai-responses" } },
          },
        },
      },
      HOME,
    ).providers;
    const [gateway] = mergeProviders(fromEnv, fromFile);
    assert.deepEqual(gateway.authHeaders, { "anthropic-messages": "authorization", discovery: "x-api-key" });
    assert.deepEqual(gateway.models, {
      a: { api: "openai-responses" },
      b: { api: "anthropic-messages", contextWindow: 9 },
      c: { api: "openai-responses" },
    });
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
    assert.deepEqual(seen, [`/tmp/agent/${CONFIG_FILE_NAME}`, `/tmp/agent/${LOCAL_CONFIG_FILE_NAME}`]);
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

  it("does not echo any of a malformed file's content in the invalid-JSON warning", async () => {
    const result = await loadConfig({
      env: {},
      home: HOME,
      readText: async () => '{"providers": {"corp": {"apiKeyEnv": "CORP_KEY" oops',
    });
    // One warning per file: the shared file and the overlay.
    assert.equal(result.warnings.length, 2);
    for (const warning of result.warnings) {
      assert.match(warning, /invalid JSON$/);
      assert.equal(warning.includes("CORP_KEY"), false);
    }
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

describe("baseUrlEnv", () => {
  const entry = (fields: Record<string, unknown>) => ({ providers: { corp: { apiKeyEnv: "CORP_KEY", ...fields } } });

  it("reads the base URL from the named variable, normalised like a literal baseUrl", () => {
    const { providers, warnings } = parseConfigFile(entry({ baseUrlEnv: "CORP_URL" }), HOME, { CORP_URL: " https://gw.example.com/v1/ " });
    assert.deepEqual(warnings, []);
    assert.equal(providers[0].baseUrl, "https://gw.example.com");
    assert.equal(providers[0].apiKeyEnv, "CORP_KEY");
  });

  it("skips the provider with one warning naming the variable when it is unset or empty", () => {
    for (const env of [{}, { CORP_URL: "" }, { CORP_URL: "   " }]) {
      const { providers, warnings } = parseConfigFile(entry({ baseUrlEnv: "CORP_URL" }), HOME, env);
      assert.deepEqual(providers, []);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /providers\.corp: "baseUrlEnv" names CORP_URL, which is unset or empty; skipped/);
    }
  });

  it("treats a name that only exists on the prototype as unset and still loads other providers", () => {
    const config = {
      providers: {
        broken: { apiKeyEnv: "CORP_KEY", baseUrlEnv: "toString" },
        good: { apiKeyEnv: "CORP_KEY", baseUrl: "https://gw.example.com" },
      },
    };
    for (const baseUrlEnv of ["toString", "constructor"]) {
      config.providers.broken.baseUrlEnv = baseUrlEnv;
      const { providers, warnings } = parseConfigFile(config, HOME, {});
      assert.deepEqual(providers.map((p) => p.id), ["good"], baseUrlEnv);
      assert.equal(warnings.length, 1, baseUrlEnv);
      assert.match(warnings[0], new RegExp(`"baseUrlEnv" names ${baseUrlEnv}, which is unset or empty; skipped`));
    }
  });

  it("requires exactly one of baseUrl and baseUrlEnv", () => {
    const both = parseConfigFile(entry({ baseUrl: "https://gw.example.com", baseUrlEnv: "CORP_URL" }), HOME, { CORP_URL: "https://gw.example.com" });
    assert.deepEqual(both.providers, []);
    assert.match(both.warnings[0], /either "baseUrl" or "baseUrlEnv", not both; skipped/);
    const neither = parseConfigFile(entry({}), HOME, {});
    assert.deepEqual(neither.providers, []);
    assert.match(neither.warnings[0], /"baseUrl" or "baseUrlEnv" is required; skipped/);
  });

  it("rejects a value that is not a variable name", () => {
    for (const baseUrlEnv of ["https://gw.example.com", "1URL", "", 5]) {
      const { providers, warnings } = parseConfigFile(entry({ baseUrlEnv }), HOME, {});
      assert.deepEqual(providers, [], String(baseUrlEnv));
      assert.match(warnings[0], /"baseUrlEnv" must be an environment variable name; skipped/);
    }
  });

  it("validates the value like a literal baseUrl and never prints it", () => {
    for (const value of ["sk-not-a-url", "ftp://gw.example.com", "https://u:p@gw.example.com", "https://gw.example.com/?a=b"]) {
      const { providers, warnings } = parseConfigFile(entry({ baseUrlEnv: "CORP_URL" }), HOME, { CORP_URL: value });
      assert.deepEqual(providers, [], value);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /"baseUrlEnv" names CORP_URL, which does not hold an http\(s\) base URL/);
      assert.equal(warnings[0].includes(value), false, value);
      assert.equal(warnings[0].includes("sk-"), false, value);
    }
  });

  it("does not let INFERENCE_GATEWAY_* credentials follow a baseUrlEnv URL elsewhere", async () => {
    const readText = async () =>
      JSON.stringify({ providers: { other: { baseUrlEnv: "OTHER_URL", apiKeyEnv: "INFERENCE_GATEWAY_API_KEY" } } });
    const refused = await loadConfig({
      env: { INFERENCE_GATEWAY_BASE_URL: "https://gw.example.com", INFERENCE_GATEWAY_API_KEY: "k", OTHER_URL: "https://elsewhere.example.com" },
      home: HOME,
      readText,
    });
    assert.deepEqual(
      refused.providers.map((provider) => provider.id),
      ["gateway"],
    );
    assert.match(refused.warnings.join("\n"), /other: refused .*INFERENCE_GATEWAY_API_KEY.*https:\/\/elsewhere\.example\.com/);
    const allowed = await loadConfig({
      env: { INFERENCE_GATEWAY_BASE_URL: "https://gw.example.com", INFERENCE_GATEWAY_API_KEY: "k", OTHER_URL: "https://gw.example.com/v1" },
      home: HOME,
      readText,
    });
    assert.deepEqual(allowed.warnings, []);
    assert.ok(allowed.providers.some((provider) => provider.id === "other"));
  });

  it("lets a file entry for the env provider point at INFERENCE_GATEWAY_BASE_URL without a warning", async () => {
    const { providers, warnings } = await loadConfig({
      env: { INFERENCE_GATEWAY_BASE_URL: "https://gw.example.com" },
      home: HOME,
      readText: async () => JSON.stringify({ providers: { gateway: { baseUrlEnv: "INFERENCE_GATEWAY_BASE_URL", include: ["claude-*"] } } }),
    });
    assert.deepEqual(warnings, []);
    assert.equal(providers[0].baseUrl, "https://gw.example.com");
    assert.deepEqual(providers[0].include, ["claude-*"]);
  });
});

describe("local overlay file", () => {
  const SHARED = `${HOME}/.pi/agent/${CONFIG_FILE_NAME}`;
  const LOCAL = `${HOME}/.pi/agent/${LOCAL_CONFIG_FILE_NAME}`;
  const files =
    (contents: Record<string, string>) =>
    async (path: string): Promise<string | undefined> =>
      Object.hasOwn(contents, path) ? contents[path] : undefined;
  const shared = JSON.stringify({
    providers: {
      corp: {
        baseUrlEnv: "CORP_URL",
        apiKeyEnv: "CORP_KEY",
        headers: { "x-team": "platform" },
        models: {
          "claude-sonnet-5": { contextWindow: 1000000, compat: { supportsMidConvoEffort: false } },
          "gpt-6-luna": { api: "openai-responses" },
        },
      },
    },
  });
  const env = { CORP_URL: "https://gw.example.com" };

  it("merges the overlay per provider and per model", async () => {
    const local = JSON.stringify({
      providers: {
        corp: {
          headers: { "x-site": "lab" },
          models: {
            "claude-sonnet-5": { contextWindow: 200000, maxTokens: 32000, compat: { supportsStrictTools: false } },
            "vendor/org/open-model": { api: "openai-completions", contextWindow: 262144, maxTokens: 65536 },
          },
        },
      },
    });
    const { providers, warnings } = await loadConfig({ env, home: HOME, readText: files({ [SHARED]: shared, [LOCAL]: local }) });
    assert.deepEqual(warnings, []);
    assert.equal(providers.length, 1);
    const [corp] = providers;
    assert.equal(corp.baseUrl, "https://gw.example.com");
    assert.equal(corp.apiKeyEnv, "CORP_KEY");
    assert.deepEqual(corp.headers, { "x-team": "platform", "x-site": "lab" });
    assert.deepEqual(corp.models["claude-sonnet-5"], {
      contextWindow: 200000,
      maxTokens: 32000,
      compat: { supportsMidConvoEffort: false, supportsStrictTools: false },
    });
    assert.deepEqual(corp.models["gpt-6-luna"], { api: "openai-responses" });
    assert.deepEqual(corp.models["vendor/org/open-model"], { api: "openai-completions", contextWindow: 262144, maxTokens: 65536 });
  });

  it("lets the overlay replace baseUrlEnv with a literal baseUrl, add providers, and drop compat with null", async () => {
    const local = JSON.stringify({
      providers: {
        corp: { baseUrl: "http://127.0.0.1:4000", models: { "claude-sonnet-5": { compat: null } } },
        lab: { baseUrl: "http://127.0.0.1:4001" },
      },
    });
    const { providers, warnings } = await loadConfig({ env: {}, home: HOME, readText: files({ [SHARED]: shared, [LOCAL]: local }) });
    assert.deepEqual(warnings, []);
    assert.deepEqual(
      providers.map((provider) => [provider.id, provider.baseUrl]),
      [
        ["corp", "http://127.0.0.1:4000"],
        ["lab", "http://127.0.0.1:4001"],
      ],
    );
    assert.equal(providers[0].models["claude-sonnet-5"].compat, null);
    assert.equal(providers[0].models["claude-sonnet-5"].contextWindow, 1000000);
  });

  it("is silent when the overlay is missing, and works without the shared file", async () => {
    const missing = await loadConfig({ env, home: HOME, readText: files({ [SHARED]: shared }) });
    assert.deepEqual(missing.warnings, []);
    assert.equal(missing.providers[0].id, "corp");
    const onlyLocal = await loadConfig({ env: {}, home: HOME, readText: files({ [LOCAL]: JSON.stringify({ providers: { lab: { baseUrl: "http://127.0.0.1:4001" } } }) }) });
    assert.deepEqual(onlyLocal.warnings, []);
    assert.equal(onlyLocal.providers[0].id, "lab");
  });

  it("warns naming the overlay when it is malformed, and keeps the shared file", async () => {
    for (const local of ["{ not json", "[]", JSON.stringify({ corp: {} })]) {
      const { providers, warnings } = await loadConfig({ env, home: HOME, readText: files({ [SHARED]: shared, [LOCAL]: local }) });
      assert.equal(warnings.length, 1, local);
      assert.ok(warnings[0].startsWith(`${LOCAL}: `), warnings[0]);
      assert.equal(providers[0].id, "corp");
      assert.equal(providers[0].models["claude-sonnet-5"].contextWindow, 1000000);
    }
  });

  it("names both files in a warning about a merged entry", async () => {
    const local = JSON.stringify({ providers: { corp: { defaultApi: "nope" } } });
    const { warnings } = await loadConfig({ env, home: HOME, readText: files({ [SHARED]: shared, [LOCAL]: local }) });
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].startsWith(`${SHARED} + ${LOCAL}: providers.corp: "defaultApi"`), warnings[0]);
  });

  it("reads the overlay from PI_CODING_AGENT_DIR and keeps __proto__ an ordinary key", async () => {
    const local = '{"providers":{"corp":{"models":{"__proto__":{"api":"openai-completions"}}}}}';
    const { providers } = await loadConfig({
      env: { ...env, PI_CODING_AGENT_DIR: "/tmp/agent" },
      home: HOME,
      readText: files({ [`/tmp/agent/${CONFIG_FILE_NAME}`]: shared, [`/tmp/agent/${LOCAL_CONFIG_FILE_NAME}`]: local }),
    });
    const { models } = providers[0];
    assert.equal(Object.getPrototypeOf(models), Object.prototype);
    assert.ok(Object.hasOwn(models, "__proto__"));
    assert.deepEqual(Object.keys(models).sort(), ["__proto__", "claude-sonnet-5", "gpt-6-luna"]);
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
