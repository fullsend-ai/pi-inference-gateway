// Configuration: environment variables first (a sandbox needs no file), then an optional JSON file
// for several gateways or per-model overrides. Everything here is a pure function of its inputs
// (env record, parsed JSON, a file reader) so the tests need no filesystem and no pi process.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { validateCompat } from "./compat.ts";

/** The three pi transports a gateway model can be routed to. */
export type GatewayApi = "anthropic-messages" | "openai-responses" | "openai-completions";

export const GATEWAY_APIS: readonly GatewayApi[] = [
  "anthropic-messages",
  "openai-responses",
  "openai-completions",
];

export function isGatewayApi(value: unknown): value is GatewayApi {
  return typeof value === "string" && (GATEWAY_APIS as readonly string[]).includes(value);
}

export const DEFAULT_PROVIDER_ID = "gateway";
export const DEFAULT_API: GatewayApi = "openai-responses";
export const DEFAULT_MODELS_PATH = "/v1/models";
export const CONFIG_FILE_NAME = "inference-gateway.json";
/** Machine-local overlay next to CONFIG_FILE_NAME, merged over it per provider and per model. */
export const LOCAL_CONFIG_FILE_NAME = "inference-gateway.local.json";

/** Where a token is sent: one of the three transports, or the model-list request. */
export type AuthTarget = GatewayApi | "discovery";

export const AUTH_TARGETS: readonly AuthTarget[] = [...GATEWAY_APIS, "discovery"];

function isAuthTarget(value: string): value is AuthTarget {
  return (AUTH_TARGETS as readonly string[]).includes(value);
}

/**
 * The header each request carries the token in when nothing overrides it: whatever the transport
 * sends natively. pi's Anthropic transport sends `x-api-key`, the OpenAI ones
 * `authorization: Bearer`, and discovery uses Bearer. A path-routing front proxy that forwards
 * `/v1/messages` to a Claude backend accepts only `x-api-key` there, so a blanket Bearer default
 * would 401 every Claude model.
 */
export const NATIVE_AUTH_HEADERS: Readonly<Record<AuthTarget, string>> = {
  "anthropic-messages": "x-api-key",
  "openai-responses": "authorization",
  "openai-completions": "authorization",
  discovery: "authorization",
};

/**
 * How a request to `target` authenticates — an *auth scheme*:
 *   - `authorization`  → `authorization: Bearer <token>`
 *   - `basic`          → `authorization: Basic base64(<username>:<password>)`
 *   - any other header → that header carrying the raw token (`x-api-key: <token>`)
 * Configured as `bearer` (alias of `authorization`), `basic`, or a header name.
 */
export function authHeaderFor(config: Pick<GatewayConfig, "authHeaders">, target: AuthTarget): string {
  return config.authHeaders[target] ?? NATIVE_AUTH_HEADERS[target];
}

/** Basic auth's username when nothing sets one (Praxis's documented default). */
export const DEFAULT_BASIC_USERNAME = "gateway";

/** The environment contract. Unset base URL means the env provider is disabled. */
export const ENV = {
  baseUrl: "INFERENCE_GATEWAY_BASE_URL",
  apiKey: "INFERENCE_GATEWAY_API_KEY",
  tokenFile: "INFERENCE_GATEWAY_TOKEN_FILE",
  basicUser: "INFERENCE_GATEWAY_BASIC_USER",
  basicPassword: "INFERENCE_GATEWAY_BASIC_PASSWORD", // gitleaks:allow (env var name, not a secret)
  basicPasswordFile: "INFERENCE_GATEWAY_BASIC_PASSWORD_FILE",
  providerId: "INFERENCE_GATEWAY_PROVIDER_ID",
  defaultApi: "INFERENCE_GATEWAY_DEFAULT_API",
  authHeader: "INFERENCE_GATEWAY_AUTH_HEADER",
  extraModels: "INFERENCE_GATEWAY_EXTRA_MODELS",
  discoveryTimeoutMs: "INFERENCE_GATEWAY_DISCOVERY_TIMEOUT_MS",
  sessionAffinity: "INFERENCE_GATEWAY_SESSION_AFFINITY",
} as const;

/** `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`, case-insensitive; anything else is undefined. */
export function parseBooleanFlag(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}

/** Per-model overrides from the config file. Every field wins over the gateway and pi's catalog. */
export interface ModelOverride {
  api?: GatewayApi;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: Partial<CostFields>;
  /**
   * pi `compat` flags for this model. An object is merged over whatever was copied from pi's
   * catalog (set a flag to `false` to switch off a request feature the gateway rejects); `null`
   * drops the copied compat entirely. Passed to pi as written: keys pi does not know are ignored.
   */
  compat?: CompatOverride | null;
  /**
   * pi `thinkingLevelMap`: what each thinking level is sent as (a string), or `null` to hide that
   * level. Merged over the map copied from pi's catalog; `null` for the whole field drops the copy.
   */
  thinkingLevelMap?: ThinkingLevelMap | null;
}

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function isThinkingLevel(value: string): value is ModelThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/** JSON-primitive compat flags from the config file. */
export type CompatOverride = Record<string, boolean | string | number>;

const COMPAT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface CostFields {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface GatewayConfig {
  /** pi provider id: model specs read `<id>/<model>`. */
  id: string;
  /** Gateway root: no trailing slash, no trailing `/v1`. */
  baseUrl: string;
  /**
   * The variable `baseUrl` was read from (`baseUrlEnv` in the file); undefined for a literal
   * `baseUrl`. Lets a warning name the variable instead of printing its value.
   */
  baseUrlEnv?: string;
  /** Environment variable holding a static key. Never a literal key. */
  apiKeyEnv?: string;
  /** File holding the token, re-read on every request. Wins over `apiKeyEnv`. */
  tokenFile?: string;
  /** Basic auth: a literal username (not a secret), overridden by `usernameEnv`'s value. */
  username?: string;
  /** Basic auth: environment variable holding the username. */
  usernameEnv?: string;
  /** Basic auth: environment variable holding the password. Never a literal password. */
  passwordEnv?: string;
  /** Basic auth: file holding the password, re-read on every request. Wins over `passwordEnv`. */
  passwordFile?: string;
  /**
   * Per-target header overrides (lower-case); a missing target uses NATIVE_AUTH_HEADERS.
   * `authorization` means `Bearer <token>`; any other header carries the raw token.
   */
  authHeaders: Partial<Record<AuthTarget, string>>;
  defaultApi: GatewayApi;
  /** Extra static request headers, sent on discovery and on every model request. */
  headers: Record<string, string>;
  /** Path of the model list, relative to `baseUrl`. */
  modelsPath: string;
  include: string[];
  exclude: string[];
  /**
   * Overrides for discovered models, keyed by id. An entry with an `api` whose id the gateway does
   * not list is added as an extra model: path-routing proxies serve models they never list.
   */
  models: Record<string, ModelOverride>;
  /** Raw model entries (same shapes the gateway returns) used when discovery fails. */
  fallbackModels: unknown[];
  /**
   * Opt-in: send pi's session id, hashed, as a session-affinity header on every transport and as
   * `prompt_cache_key` on Chat Completions, so a gateway can pin a session to one backend and cache.
   */
  sessionAffinity?: boolean;
}

export interface ParseResult {
  providers: GatewayConfig[];
  warnings: string[];
}

const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// Control characters (C0, DEL, C1). Used for ids, names and header values from any source.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

export function hasControlChars(value: string): boolean {
  return CONTROL_RE.test(value);
}

export const MAX_MODEL_ID_LENGTH = 256;

/**
 * The one rule for a model id from any source (gateway list, config file, environment): 1–256
 * characters, no whitespace, no control characters. Ids are sent back to the gateway verbatim.
 */
export function isValidModelId(id: string | undefined): boolean {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= MAX_MODEL_ID_LENGTH &&
    !/\s/.test(id) &&
    !hasControlChars(id)
  );
}

/**
 * The config override for a model id — an *own* property only. Config dicts are plain objects
 * built with Object.fromEntries (so a `__proto__` key stays an ordinary key), and a lookup must not
 * pick up `constructor` or `toString` from Object.prototype.
 */
export function modelOverride(config: Pick<GatewayConfig, "models">, id: string): ModelOverride | undefined {
  return Object.hasOwn(config.models, id) ? config.models[id] : undefined;
}

/**
 * Normalise a gateway root. Accepts it with or without a trailing `/v1` and trailing slashes,
 * because both forms are common in gateway docs; the transports re-add `/v1` where they need it.
 * Rejects non-http(s) schemes, embedded credentials, query strings and fragments.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`base URL is not a valid URL: ${JSON.stringify(trimmed)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`base URL must be http or https, got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("base URL must not embed credentials; use an API key variable or token file");
  }
  if (url.search || url.hash) {
    throw new Error("base URL must not carry a query string or fragment");
  }
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${url.origin}${path}`;
}

/** Expand a leading `~/` against the home directory. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/** `$PI_CODING_AGENT_DIR`, else `~/.pi/agent` — the same directory pi itself uses. */
export function agentDir(env: Record<string, string | undefined>, home: string): string {
  const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
  return fromEnv ? expandHome(fromEnv, home) : join(home, ".pi", "agent");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, field: string, warnings: string[], where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    warnings.push(`${where}: "${field}" must be an array of strings; ignored`);
    return [];
  }
  return value;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseModelOverride(raw: unknown, where: string, warnings: string[]): ModelOverride | undefined {
  if (!isRecord(raw)) {
    warnings.push(`${where}: must be an object; ignored`);
    return undefined;
  }
  const override: ModelOverride = {};
  if (raw.api !== undefined) {
    if (isGatewayApi(raw.api)) override.api = raw.api;
    else warnings.push(`${where}: "api" must be one of ${GATEWAY_APIS.join(", ")}; ignored`);
  }
  if (typeof raw.name === "string" && raw.name.length <= 256 && !hasControlChars(raw.name)) override.name = raw.name;
  const contextWindow = positiveInt(raw.contextWindow);
  if (contextWindow !== undefined) override.contextWindow = contextWindow;
  const maxTokens = positiveInt(raw.maxTokens);
  if (maxTokens !== undefined) override.maxTokens = maxTokens;
  if (typeof raw.reasoning === "boolean") override.reasoning = raw.reasoning;
  if (Array.isArray(raw.input) && raw.input.every((entry) => entry === "text" || entry === "image")) {
    override.input = raw.input.includes("text") ? [...raw.input] : ["text", ...raw.input];
  }
  if (isRecord(raw.cost)) {
    const cost: Partial<CostFields> = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const value = nonNegativeNumber(raw.cost[key]);
      if (value !== undefined) cost[key] = value;
    }
    override.cost = cost;
  }
  if (raw.compat === null) {
    override.compat = null;
  } else if (raw.compat !== undefined) {
    if (isRecord(raw.compat)) {
      const flags: Array<[string, boolean | string | number]> = [];
      for (const [key, value] of Object.entries(raw.compat)) {
        const primitive =
          typeof value === "boolean" ||
          (typeof value === "string" && value.length <= 256 && !hasControlChars(value)) ||
          (typeof value === "number" && Number.isFinite(value));
        if (!COMPAT_KEY_RE.test(key) || !primitive) {
          warnings.push(`${where}: compat.${key.slice(0, 64)} must be a flag name with a boolean, string or number value; ignored`);
          continue;
        }
        flags.push([key, value]);
      }
      const checked = validateCompat(Object.fromEntries(flags), override.api);
      for (const problem of checked.problems) warnings.push(`${where}: ${problem}`);
      override.compat = checked.kept;
    } else {
      warnings.push(`${where}: "compat" must be an object of flags, or null to drop pi's catalog compat; ignored`);
    }
  }
  if (raw.thinkingLevelMap === null) {
    override.thinkingLevelMap = null;
  } else if (raw.thinkingLevelMap !== undefined) {
    if (isRecord(raw.thinkingLevelMap)) {
      const levels: Array<[ModelThinkingLevel, string | null]> = [];
      for (const [level, value] of Object.entries(raw.thinkingLevelMap)) {
        const valid = value === null || (typeof value === "string" && value.length > 0 && value.length <= 64 && !hasControlChars(value));
        if (!isThinkingLevel(level) || !valid) {
          warnings.push(
            `${where}: thinkingLevelMap.${level.slice(0, 64)} must be one of ${THINKING_LEVELS.join(", ")} mapped to a string or null; ignored`,
          );
          continue;
        }
        levels.push([level, value]);
      }
      override.thinkingLevelMap = Object.fromEntries(levels);
    } else {
      warnings.push(`${where}: "thinkingLevelMap" must be an object keyed by thinking level, or null to drop pi's catalog map; ignored`);
    }
  }
  return override;
}

/**
 * Header names that carry a credential for this provider: `authorization`, `x-api-key`, and every
 * header named as an auth scheme in `authHeaders`. They are stripped from every outgoing request
 * before the selected scheme's header is set, and refused as static `headers`.
 */
export function credentialHeaderNames(authHeaders: Partial<Record<AuthTarget, string>>): Set<string> {
  const names = new Set(["authorization", "x-api-key"]);
  for (const scheme of Object.values(authHeaders)) {
    if (scheme !== undefined && scheme !== "basic") names.add(scheme);
  }
  return names;
}

function parseHeaders(
  raw: unknown,
  where: string,
  warnings: string[],
  reserved: ReadonlySet<string> = credentialHeaderNames({}),
): Record<string, string> {
  const headers: Array<[string, string]> = [];
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    warnings.push(`${where}: "headers" must be an object of strings; ignored`);
    return {};
  }
  for (const [name, value] of Object.entries(raw)) {
    if (!HEADER_NAME_RE.test(name) || typeof value !== "string" || hasControlChars(value)) {
      warnings.push(`${where}: header ${JSON.stringify(name)} is invalid; ignored`);
      continue;
    }
    const lower = name.toLowerCase();
    if (reserved.has(lower)) {
      // A literal credential in a config file is exactly what apiKeyEnv/tokenFile exist to avoid,
      // and a static value under an auth header's name would ride along as a second credential.
      warnings.push(`${where}: header ${JSON.stringify(name)} is an auth header and must not be set here; use apiKeyEnv, tokenFile or passwordEnv`);
      continue;
    }
    headers.push([lower, value]);
  }
  return Object.fromEntries(headers);
}

/** `bearer` → `authorization`, `basic` stays `basic`, otherwise a valid lower-cased header name. */
function authScheme(value: unknown): string | undefined {
  if (typeof value !== "string" || !HEADER_NAME_RE.test(value)) return undefined;
  const lower = value.toLowerCase();
  return lower === "bearer" ? "authorization" : lower;
}

/**
 * `authHeader` in the file: one header name for every target, or an object keyed by target
 * (`anthropic-messages`, `openai-responses`, `openai-completions`, `discovery`).
 */
export function parseAuthHeaders(raw: unknown, where: string, warnings: string[]): Partial<Record<AuthTarget, string>> {
  const overrides: Partial<Record<AuthTarget, string>> = {};
  if (raw === undefined) return overrides;
  const single = authScheme(raw);
  if (single !== undefined) {
    for (const target of AUTH_TARGETS) overrides[target] = single;
    return overrides;
  }
  if (!isRecord(raw)) {
    warnings.push(`${where}: "authHeader" must be bearer, basic, a header name, or an object keyed by ${AUTH_TARGETS.join(", ")}; ignored`);
    return overrides;
  }
  for (const [target, value] of Object.entries(raw)) {
    const name = authScheme(value);
    if (!isAuthTarget(target) || name === undefined) {
      warnings.push(`${where}: "authHeader.${target}" must be bearer, basic or a header name, for one of ${AUTH_TARGETS.join(", ")}; ignored`);
      continue;
    }
    overrides[target] = name;
  }
  return overrides;
}

/**
 * `INFERENCE_GATEWAY_AUTH_HEADER`: a header name for every target (`x-api-key`), or
 * comma-separated `target=header` pairs (`anthropic-messages=authorization,discovery=x-api-key`).
 */
export function parseAuthHeaderEnv(raw: string, warnings: string[]): Partial<Record<AuthTarget, string>> {
  if (!raw.includes("=")) return parseAuthHeaders(raw, ENV.authHeader, warnings);
  const pairs: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const [target = "", header = ""] = part.split("=").map((piece) => piece.trim());
    pairs[target] = header;
  }
  return parseAuthHeaders(pairs, ENV.authHeader, warnings);
}

/**
 * `INFERENCE_GATEWAY_EXTRA_MODELS`: comma-separated `id=api` pairs for models the gateway serves
 * but does not list (`gpt-6-luna=openai-responses,acme/glm-5-3=openai-completions`).
 */
export function parseExtraModelsEnv(raw: string, warnings: string[]): Record<string, ModelOverride> {
  const models: Array<[string, ModelOverride]> = [];
  for (const part of raw.split(",")) {
    if (!part.trim()) continue;
    const separator = part.lastIndexOf("=");
    const id = part.slice(0, Math.max(separator, 0)).trim();
    const api = part.slice(separator + 1).trim();
    if (separator <= 0 || !isValidModelId(id) || !isGatewayApi(api)) {
      warnings.push(`${ENV.extraModels}: ${JSON.stringify(part.trim())} must be <model-id>=<${GATEWAY_APIS.join("|")}>; ignored`);
      continue;
    }
    models.push([id, { api }]);
  }
  return Object.fromEntries(models);
}

/**
 * Parse one `providers.<id>` entry. Returns undefined (with a warning) when it cannot be used.
 * `env` is only read for `baseUrlEnv`, the variable holding the base URL.
 */
export function parseProviderEntry(
  id: string,
  raw: unknown,
  warnings: string[],
  home: string,
  env: Record<string, string | undefined> = process.env,
): GatewayConfig | undefined {
  const where = `providers.${id}`;
  if (!PROVIDER_ID_RE.test(id)) {
    warnings.push(`${where}: provider id must match ${PROVIDER_ID_RE.source}; skipped`);
    return undefined;
  }
  if (!isRecord(raw)) {
    warnings.push(`${where}: must be an object; skipped`);
    return undefined;
  }
  if (raw.apiKey !== undefined) {
    warnings.push(`${where}: literal "apiKey" is not supported; use "apiKeyEnv" or "tokenFile"; skipped`);
    return undefined;
  }
  if (raw.password !== undefined) {
    warnings.push(`${where}: literal "password" is not supported; use "passwordEnv" or "passwordFile"; skipped`);
    return undefined;
  }
  if (raw.baseUrl !== undefined && raw.baseUrlEnv !== undefined) {
    warnings.push(`${where}: set either "baseUrl" or "baseUrlEnv", not both; skipped`);
    return undefined;
  }
  let baseUrl: string;
  if (raw.baseUrlEnv !== undefined) {
    if (typeof raw.baseUrlEnv !== "string" || !ENV_NAME_RE.test(raw.baseUrlEnv)) {
      warnings.push(`${where}: "baseUrlEnv" must be an environment variable name; skipped`);
      return undefined;
    }
    // Own properties only: a name like "toString" would otherwise resolve to an inherited function.
    const rawValue = Object.hasOwn(env, raw.baseUrlEnv) ? env[raw.baseUrlEnv] : undefined;
    const value = typeof rawValue === "string" ? rawValue.trim() : undefined;
    if (!value) {
      warnings.push(`${where}: "baseUrlEnv" names ${raw.baseUrlEnv}, which is unset or empty; skipped`);
      return undefined;
    }
    try {
      baseUrl = normalizeBaseUrl(value);
    } catch {
      // Never echo the value: a mistyped baseUrlEnv may name a variable holding a credential.
      warnings.push(
        `${where}: "baseUrlEnv" names ${raw.baseUrlEnv}, which does not hold an http(s) base URL without credentials, query or fragment; skipped`,
      );
      return undefined;
    }
  } else {
    if (typeof raw.baseUrl !== "string") {
      warnings.push(`${where}: "baseUrl" or "baseUrlEnv" is required; skipped`);
      return undefined;
    }
    try {
      baseUrl = normalizeBaseUrl(raw.baseUrl);
    } catch (error) {
      warnings.push(`${where}: ${error instanceof Error ? error.message : String(error)}; skipped`);
      return undefined;
    }
  }

  const authHeaders = parseAuthHeaders(raw.authHeader, where, warnings);
  const config: GatewayConfig = {
    id,
    baseUrl,
    ...(typeof raw.baseUrlEnv === "string" ? { baseUrlEnv: raw.baseUrlEnv } : {}),
    authHeaders,
    defaultApi: DEFAULT_API,
    headers: parseHeaders(raw.headers, where, warnings, credentialHeaderNames(authHeaders)),
    modelsPath: DEFAULT_MODELS_PATH,
    include: stringList(raw.include, "include", warnings, where),
    exclude: stringList(raw.exclude, "exclude", warnings, where),
    models: {},
    fallbackModels: [],
  };

  if (raw.apiKeyEnv !== undefined) {
    if (typeof raw.apiKeyEnv === "string" && ENV_NAME_RE.test(raw.apiKeyEnv)) config.apiKeyEnv = raw.apiKeyEnv;
    else warnings.push(`${where}: "apiKeyEnv" must be an environment variable name; ignored`);
  }
  if (raw.username !== undefined) {
    if (isValidUsername(raw.username)) config.username = raw.username;
    else warnings.push(`${where}: "username" must be 1-256 characters without ':' or control characters; ignored`);
  }
  for (const key of ["usernameEnv", "passwordEnv"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value === "string" && ENV_NAME_RE.test(value)) config[key] = value;
    else warnings.push(`${where}: "${key}" must be an environment variable name; ignored`);
  }
  if (raw.passwordFile !== undefined) {
    if (typeof raw.passwordFile === "string" && raw.passwordFile.trim() && !hasControlChars(raw.passwordFile)) {
      config.passwordFile = expandHome(raw.passwordFile.trim(), home);
    } else {
      warnings.push(`${where}: "passwordFile" must be a path; ignored`);
    }
  }
  if (raw.tokenFile !== undefined) {
    if (typeof raw.tokenFile === "string" && raw.tokenFile.trim() && !hasControlChars(raw.tokenFile)) {
      config.tokenFile = expandHome(raw.tokenFile.trim(), home);
    } else {
      warnings.push(`${where}: "tokenFile" must be a path; ignored`);
    }
  }
  if (raw.defaultApi !== undefined) {
    if (isGatewayApi(raw.defaultApi)) config.defaultApi = raw.defaultApi;
    else warnings.push(`${where}: "defaultApi" must be one of ${GATEWAY_APIS.join(", ")}; using ${DEFAULT_API}`);
  }
  if (raw.modelsPath !== undefined) {
    if (typeof raw.modelsPath === "string" && /^\/[^\s?#]*$/.test(raw.modelsPath)) config.modelsPath = raw.modelsPath;
    else warnings.push(`${where}: "modelsPath" must be an absolute path such as /v1/models; using ${DEFAULT_MODELS_PATH}`);
  }
  if (raw.models !== undefined) {
    if (isRecord(raw.models)) {
      const models: Array<[string, ModelOverride]> = [];
      for (const [modelId, override] of Object.entries(raw.models)) {
        if (!isValidModelId(modelId)) {
          warnings.push(`${where}.models: model id ${JSON.stringify(modelId.slice(0, 64))} is invalid (1-${MAX_MODEL_ID_LENGTH} characters, no whitespace or control characters); skipped`);
          continue;
        }
        const parsed = parseModelOverride(override, `${where}.models.${modelId}`, warnings);
        if (parsed) models.push([modelId, parsed]);
      }
      config.models = Object.fromEntries(models);
    } else {
      warnings.push(`${where}: "models" must be an object keyed by model id; ignored`);
    }
  }
  if (raw.fallbackModels !== undefined) {
    if (Array.isArray(raw.fallbackModels)) config.fallbackModels = [...raw.fallbackModels];
    else warnings.push(`${where}: "fallbackModels" must be an array; ignored`);
  }
  if (raw.sessionAffinity !== undefined) {
    if (typeof raw.sessionAffinity === "boolean") config.sessionAffinity = raw.sessionAffinity;
    else warnings.push(`${where}: "sessionAffinity" must be true or false; ignored`);
  }
  return config;
}

/** Parse the whole config file (already JSON-decoded). */
export function parseConfigFile(
  json: unknown,
  home: string,
  env: Record<string, string | undefined> = process.env,
): ParseResult {
  const warnings: string[] = [];
  const providers: GatewayConfig[] = [];
  if (!isRecord(json) || !isRecord(json.providers)) {
    warnings.push(`expected an object with a "providers" object`);
    return { providers, warnings };
  }
  for (const [id, raw] of Object.entries(json.providers)) {
    const parsed = parseProviderEntry(id, raw, warnings, home, env);
    if (parsed) providers.push(parsed);
  }
  return { providers, warnings };
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Two objects merge one level deep (the overlay's keys win); anything else is replaced. */
function mergeShallow(base: unknown, over: unknown): unknown {
  return isRecord(base) && isRecord(over) ? { ...base, ...over } : over;
}

function mergeEach(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
  mergeOne: (base: unknown, over: unknown) => unknown,
): Record<string, unknown> {
  return { ...base, ...Object.fromEntries(Object.entries(over).map(([key, value]) => [key, mergeOne(ownValue(base, key), value)])) };
}

function mergeModelEntry(base: unknown, over: unknown): unknown {
  return isRecord(base) && isRecord(over) ? mergeEach(base, over, mergeShallow) : over;
}

const BASE_URL_KEYS: readonly string[] = ["baseUrl", "baseUrlEnv"];

function mergeProviderEntry(base: unknown, over: unknown): unknown {
  if (!isRecord(base) || !isRecord(over)) return over;
  // baseUrl and baseUrlEnv are one setting: the overlay naming either replaces both.
  const replacesBaseUrl = BASE_URL_KEYS.some((key) => Object.hasOwn(over, key));
  const kept = Object.entries(base).filter(([key]) => !(replacesBaseUrl && BASE_URL_KEYS.includes(key)));
  const merged = Object.entries(over).map(([key, value]): [string, unknown] => {
    const prior = ownValue(base, key);
    if (key === "models" && isRecord(prior) && isRecord(value)) return [key, mergeEach(prior, value, mergeModelEntry)];
    return [key, mergeShallow(prior, value)];
  });
  return { ...Object.fromEntries(kept), ...Object.fromEntries(merged) };
}

/**
 * Merge the local overlay's `providers` over the shared file's, before either is parsed: per
 * provider, then per model id. A key set to an object in both (`headers`, `authHeader`, a model's
 * `compat`, `thinkingLevelMap` or `cost`) is merged one level deep; any other overlay value
 * replaces the shared one. `baseUrl` and `baseUrlEnv` count as one key.
 */
export function mergeConfigOverlay(shared: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  return mergeEach(shared, overlay, mergeProviderEntry);
}

/**
 * The provider described by the environment, or undefined when `INFERENCE_GATEWAY_BASE_URL` is
 * unset. The API key is referenced by variable name, never copied, so it is read at request time.
 */
export interface EnvParseResult extends ParseResult {
  /** INFERENCE_GATEWAY_DEFAULT_API was set (and valid) — even to the built-in default value. */
  defaultApiSet: boolean;
}

export function envProvider(env: Record<string, string | undefined>, home: string): EnvParseResult {
  const warnings: string[] = [];
  const rawBase = env[ENV.baseUrl]?.trim();
  if (!rawBase) return { providers: [], warnings, defaultApiSet: false };

  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(rawBase);
  } catch (error) {
    warnings.push(`${ENV.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
    return { providers: [], warnings, defaultApiSet: false };
  }

  let id = DEFAULT_PROVIDER_ID;
  const rawId = env[ENV.providerId]?.trim();
  if (rawId) {
    if (PROVIDER_ID_RE.test(rawId)) id = rawId;
    else warnings.push(`${ENV.providerId}: must match ${PROVIDER_ID_RE.source}; using ${DEFAULT_PROVIDER_ID}`);
  }

  let defaultApi = DEFAULT_API;
  let defaultApiSet = false;
  const rawApi = env[ENV.defaultApi]?.trim();
  if (rawApi) {
    if (isGatewayApi(rawApi)) {
      defaultApi = rawApi;
      defaultApiSet = true;
    }
    else warnings.push(`${ENV.defaultApi}: must be one of ${GATEWAY_APIS.join(", ")}; using ${DEFAULT_API}`);
  }

  const rawAuthHeader = env[ENV.authHeader]?.trim();
  const authHeaders = rawAuthHeader ? parseAuthHeaderEnv(rawAuthHeader, warnings) : {};
  const rawExtra = env[ENV.extraModels]?.trim();
  const models = rawExtra ? parseExtraModelsEnv(rawExtra, warnings) : {};

  let sessionAffinity: boolean | undefined;
  const rawAffinity = env[ENV.sessionAffinity]?.trim();
  if (rawAffinity) {
    sessionAffinity = parseBooleanFlag(rawAffinity);
    if (sessionAffinity === undefined) warnings.push(`${ENV.sessionAffinity}: must be 1/true/yes or 0/false/no; ignored`);
  }

  const tokenFile = env[ENV.tokenFile]?.trim();
  const passwordFile = env[ENV.basicPasswordFile]?.trim();
  return {
    providers: [
      {
        id,
        baseUrl,
        apiKeyEnv: ENV.apiKey,
        ...(tokenFile ? { tokenFile: expandHome(tokenFile, home) } : {}),
        usernameEnv: ENV.basicUser,
        passwordEnv: ENV.basicPassword,
        ...(passwordFile ? { passwordFile: expandHome(passwordFile, home) } : {}),
        authHeaders,
        defaultApi,
        headers: {},
        modelsPath: DEFAULT_MODELS_PATH,
        include: [],
        exclude: [],
        models,
        fallbackModels: [],
        ...(sessionAffinity !== undefined ? { sessionAffinity } : {}),
      },
    ],
    warnings,
    defaultApiSet,
  };
}

/**
 * Combine the env provider with the file's providers. A file entry with the env provider's id is
 * merged: the environment supplies the connection (base URL, credentials, default API) and the file
 * keeps everything else (headers, filters, fallback models). Auth-header overrides and models are
 * merged per key; for a model both name, the file's fields win over the env's bare `id=api`.
 * `sources` maps a provider id to the file(s) its entry came from; a warning about that entry is
 * prefixed with it.
 */
export function mergeProviders(
  fromEnv: GatewayConfig[],
  fromFile: GatewayConfig[],
  {
    envDefaultApiSet = false,
    warnings = [],
    sources,
  }: { envDefaultApiSet?: boolean; warnings?: string[]; sources?: ReadonlyMap<string, string> } = {},
): GatewayConfig[] {
  const merged = new Map<string, GatewayConfig>();
  for (const provider of fromFile) merged.set(provider.id, provider);
  for (const provider of fromEnv) {
    const file = merged.get(provider.id);
    if (!file) {
      merged.set(provider.id, provider);
      continue;
    }
    if (file.baseUrl !== provider.baseUrl) {
      const source = sources?.get(file.id);
      // Name the key the user wrote; for baseUrlEnv, the variable only, never its value.
      const fileSetting =
        file.baseUrlEnv !== undefined
          ? `providers.${file.id}.baseUrlEnv (${file.baseUrlEnv})`
          : `providers.${file.id}.baseUrl (${file.baseUrl})`;
      warnings.push(
        `${source ? `${source}: ` : ""}${fileSetting} is ignored: ${ENV.baseUrl} (${provider.baseUrl}) configures this provider; ` +
          `remove one of them, or give the file entry another id`,
      );
    }
    // The base URL now comes from the environment, so the file's baseUrlEnv no longer describes it.
    const { baseUrlEnv: _fileBaseUrlEnv, ...fileRest } = file;
    merged.set(provider.id, {
      ...fileRest,
      baseUrl: provider.baseUrl,
      apiKeyEnv: provider.apiKeyEnv,
      tokenFile: provider.tokenFile ?? file.tokenFile,
      usernameEnv: provider.usernameEnv,
      passwordEnv: provider.passwordEnv,
      passwordFile: provider.passwordFile ?? file.passwordFile,
      // Whether the variable was *supplied* decides, not its value: an explicit
      // INFERENCE_GATEWAY_DEFAULT_API=openai-responses must beat a file's openai-completions.
      defaultApi: envDefaultApiSet ? provider.defaultApi : file.defaultApi,
      ...(provider.sessionAffinity !== undefined ? { sessionAffinity: provider.sessionAffinity } : {}),
      authHeaders: { ...file.authHeaders, ...provider.authHeaders },
      models: Object.fromEntries(
        [...new Set([...Object.keys(provider.models), ...Object.keys(file.models)])].map((modelId) => [
          modelId,
          { ...modelOverride(provider, modelId), ...modelOverride(file, modelId) },
        ]),
      ),
    });
  }
  return [...merged.values()];
}

export interface LoadConfigDeps {
  env?: Record<string, string | undefined>;
  home?: string;
  /** Resolves to the file text, or undefined when the file does not exist. */
  readText?: (path: string) => Promise<string | undefined>;
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** A config file's `providers` object; undefined (with a warning naming the file unless it is missing). */
async function readProviders(
  path: string,
  readText: (path: string) => Promise<string | undefined>,
  warnings: string[],
): Promise<Record<string, unknown> | undefined> {
  let text: string | undefined;
  try {
    text = await readText(path);
  } catch (error) {
    warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // Not the parser's message: recent V8 versions quote an excerpt of the input in it.
    warnings.push(`${path}: invalid JSON`);
    return undefined;
  }
  if (!isRecord(json) || !isRecord(json.providers)) {
    warnings.push(`${path}: expected an object with a "providers" object`);
    return undefined;
  }
  return json.providers;
}

/**
 * Everything the extension needs to decide what to register. No providers and no warnings means
 * "not configured": the extension stays silent.
 */
export async function loadConfig(deps: LoadConfigDeps = {}): Promise<ParseResult & { path: string }> {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const readText = deps.readText ?? readTextIfExists;
  const dir = agentDir(env, home);
  const path = join(dir, CONFIG_FILE_NAME);
  const localPath = join(dir, LOCAL_CONFIG_FILE_NAME);

  const fromEnv = envProvider(env, home);
  const fromFile: ParseResult = { providers: [], warnings: [] };
  const sources = new Map<string, string>();
  const shared = await readProviders(path, readText, fromFile.warnings);
  const local = await readProviders(localPath, readText, fromFile.warnings);
  for (const [id, raw] of Object.entries(mergeConfigOverlay(shared ?? {}, local ?? {}))) {
    // A warning names every file the (merged) entry came from.
    const where = [shared && Object.hasOwn(shared, id) ? path : "", local && Object.hasOwn(local, id) ? localPath : ""]
      .filter(Boolean)
      .join(" + ");
    sources.set(id, where);
    const warnings: string[] = [];
    const parsed = parseProviderEntry(id, raw, warnings, home, env);
    if (parsed) fromFile.providers.push(parsed);
    fromFile.warnings.push(...warnings.map((warning) => `${where}: ${warning}`));
  }
  const mergeWarnings: string[] = [];
  const merged = mergeProviders(fromEnv.providers, fromFile.providers, {
    envDefaultApiSet: fromEnv.defaultApiSet,
    warnings: mergeWarnings,
    sources,
  });
  const bound = bindEnvCredentials(merged, env);
  const cleaned = dropCredentialHeaders(bound.providers);
  return {
    path,
    providers: cleaned.providers,
    warnings: [
      ...fromEnv.warnings,
      ...fromFile.warnings,
      ...mergeWarnings,
      ...bound.warnings,
      ...cleaned.warnings,
    ],
  };
}

/**
 * After the env/file merge an auth header can come from INFERENCE_GATEWAY_AUTH_HEADER while a static
 * header of the same name came from the file; drop such static headers (the value is never logged).
 */
export function dropCredentialHeaders(providers: GatewayConfig[]): ParseResult {
  const warnings: string[] = [];
  const cleaned = providers.map((provider) => {
    const reserved = credentialHeaderNames(provider.authHeaders);
    const kept = Object.entries(provider.headers).filter(([name]) => {
      if (!reserved.has(name)) return true;
      warnings.push(`${provider.id}: static header ${JSON.stringify(name)} is an auth header for this provider; ignored`);
      return false;
    });
    return kept.length === Object.keys(provider.headers).length ? provider : { ...provider, headers: Object.fromEntries(kept) };
  });
  return { providers: cleaned, warnings };
}

/** The `INFERENCE_GATEWAY_*` variables that carry credentials. */
export const ENV_CREDENTIAL_VARS: readonly string[] = [ENV.apiKey, ENV.basicUser, ENV.basicPassword];

/**
 * Trusted-URL binding: credentials from `INFERENCE_GATEWAY_*` variables are meant for the gateway at
 * `INFERENCE_GATEWAY_BASE_URL` and nowhere else. A provider that names one of those variables
 * (`apiKeyEnv`, `usernameEnv`, `passwordEnv`) is kept only when its base URL equals that variable's
 * (both normalised: scheme, host, port and path; trailing slash and `/v1` ignored). Anything else is
 * refused with a warning and never registered, so no request carrying the credential is sent.
 * The env provider itself always passes: its base URL *is* the variable.
 */
export function bindEnvCredentials(
  providers: GatewayConfig[],
  env: Record<string, string | undefined>,
): ParseResult {
  let trusted: string | undefined;
  const rawBase = env[ENV.baseUrl]?.trim();
  if (rawBase) {
    try {
      trusted = normalizeBaseUrl(rawBase);
    } catch {
      trusted = undefined;
    }
  }
  const warnings: string[] = [];
  const kept = providers.filter((provider) => {
    const named = [provider.apiKeyEnv, provider.usernameEnv, provider.passwordEnv].filter(
      (name): name is string => name !== undefined && ENV_CREDENTIAL_VARS.includes(name),
    );
    if (named.length === 0 || provider.baseUrl === trusted) return true;
    warnings.push(
      `${provider.id}: refused — it uses ${[...new Set(named)].join(", ")}, which only authenticate to ` +
        `${ENV.baseUrl}${trusted ? ` (${trusted})` : " (unset)"}, but its baseUrl is ${provider.baseUrl}. ` +
        `Use a variable of your own (apiKeyEnv/passwordEnv) for this gateway.`,
    );
    return false;
  });
  return { providers: kept, warnings };
}

/**
 * The token to send, read fresh: the token file (re-read every call, so rotated OIDC/WIF tokens are
 * picked up) wins over the API key variable. Undefined means "not configured".
 */
function isValidUsername(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes(":") && !hasControlChars(value);
}

/** Which credential a scheme needs: the token (Bearer / raw header) or the Basic pair. */
export type CredentialKind = "token" | "basic";

export function credentialKind(scheme: string): CredentialKind {
  return scheme === "basic" ? "basic" : "token";
}

export interface GatewayCredentials {
  token?: string;
  basic?: { username: string; password: string };
  /** Why a configured credential is unusable — never the credential itself. */
  problems: string[];
}

/**
 * Every credential the config can produce, read fresh (files are re-read each call): the token for
 * Bearer / raw-header schemes, and the username/password pair for Basic. Undefined members are
 * simply not configured.
 */
export async function resolveCredentials(
  config: Pick<GatewayConfig, "apiKeyEnv" | "tokenFile" | "username" | "usernameEnv" | "passwordEnv" | "passwordFile">,
  env: Record<string, string | undefined> = process.env,
  readText: (path: string) => Promise<string | undefined> = readTextIfExists,
  want: CredentialKind | "all" = "all",
): Promise<GatewayCredentials> {
  const credentials: GatewayCredentials = { problems: [] };
  if (want !== "basic") {
    const token = await resolveToken(config, env, readText);
    if (token) credentials.token = token;
  }
  if (want === "token") return credentials;

  let password: string | undefined;
  if (config.passwordFile) {
    const text = (await readText(config.passwordFile))?.replace(/\r?\n$/, "");
    if (text && !hasControlChars(text)) password = text;
  } else if (config.passwordEnv) {
    const value = env[config.passwordEnv];
    if (value && !hasControlChars(value)) password = value;
  }
  if (password !== undefined) {
    const fromEnv = config.usernameEnv ? env[config.usernameEnv]?.trim() : undefined;
    const username = fromEnv || config.username || DEFAULT_BASIC_USERNAME;
    if (isValidUsername(username)) credentials.basic = { username, password };
    else credentials.problems.push("the Basic-auth username must not contain ':' or control characters");
  }
  return credentials;
}

/**
 * The single auth header for `scheme`, or undefined when the credential it needs is not
 * configured. `authorization` = Bearer token, `basic` = Basic user:password, else raw token.
 */
export function authHeaderEntry(scheme: string, credentials: GatewayCredentials): [string, string] | undefined {
  if (scheme === "basic") {
    if (!credentials.basic) return undefined;
    const { username, password } = credentials.basic;
    return ["authorization", `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`];
  }
  if (!credentials.token) return undefined;
  return scheme === "authorization" ? ["authorization", `Bearer ${credentials.token}`] : [scheme, credentials.token];
}

export async function resolveToken(
  config: Pick<GatewayConfig, "apiKeyEnv" | "tokenFile">,
  env: Record<string, string | undefined> = process.env,
  readText: (path: string) => Promise<string | undefined> = readTextIfExists,
): Promise<string | undefined> {
  if (config.tokenFile) {
    const text = await readText(config.tokenFile);
    const token = text?.trim();
    if (token && !hasControlChars(token)) return token;
    return undefined;
  }
  if (config.apiKeyEnv) {
    const token = env[config.apiKeyEnv]?.trim();
    if (token && !hasControlChars(token)) return token;
  }
  return undefined;
}
