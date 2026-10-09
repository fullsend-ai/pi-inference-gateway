// Configuration: environment variables first (a sandbox needs no file), then an optional JSON file
// for several gateways or per-model overrides. Everything here is a pure function of its inputs
// (env record, parsed JSON, a file reader) so the tests need no filesystem and no pi process.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
export const DEFAULT_AUTH_HEADER = "authorization";
export const CONFIG_FILE_NAME = "inference-gateway.json";

/** The environment contract. Unset base URL means the env provider is disabled. */
export const ENV = {
  baseUrl: "INFERENCE_GATEWAY_BASE_URL",
  apiKey: "INFERENCE_GATEWAY_API_KEY",
  tokenFile: "INFERENCE_GATEWAY_TOKEN_FILE",
  providerId: "INFERENCE_GATEWAY_PROVIDER_ID",
  defaultApi: "INFERENCE_GATEWAY_DEFAULT_API",
} as const;

/** Per-model overrides from the config file. Every field wins over the gateway and pi's catalog. */
export interface ModelOverride {
  api?: GatewayApi;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: Partial<CostFields>;
}

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
  /** Environment variable holding a static key. Never a literal key. */
  apiKeyEnv?: string;
  /** File holding the token, re-read on every request. Wins over `apiKeyEnv`. */
  tokenFile?: string;
  /** Lower-case header name the token is sent in; `authorization` means `Bearer <token>`. */
  authHeader: string;
  defaultApi: GatewayApi;
  /** Extra static request headers, sent on discovery and on every model request. */
  headers: Record<string, string>;
  /** Path of the model list, relative to `baseUrl`. */
  modelsPath: string;
  include: string[];
  exclude: string[];
  models: Record<string, ModelOverride>;
  /** Raw model entries (same shapes the gateway returns) used when discovery fails. */
  fallbackModels: unknown[];
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
  return override;
}

function parseHeaders(raw: unknown, where: string, warnings: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  if (raw === undefined) return headers;
  if (!isRecord(raw)) {
    warnings.push(`${where}: "headers" must be an object of strings; ignored`);
    return headers;
  }
  for (const [name, value] of Object.entries(raw)) {
    if (!HEADER_NAME_RE.test(name) || typeof value !== "string" || hasControlChars(value)) {
      warnings.push(`${where}: header ${JSON.stringify(name)} is invalid; ignored`);
      continue;
    }
    const lower = name.toLowerCase();
    if (lower === "authorization" || lower === "x-api-key") {
      // A literal credential in a config file is exactly what apiKeyEnv/tokenFile exist to avoid.
      warnings.push(`${where}: header ${JSON.stringify(name)} must not be set here; use apiKeyEnv or tokenFile`);
      continue;
    }
    headers[lower] = value;
  }
  return headers;
}

/** Parse one `providers.<id>` entry. Returns undefined (with a warning) when it cannot be used. */
export function parseProviderEntry(
  id: string,
  raw: unknown,
  warnings: string[],
  home: string,
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
  if (typeof raw.baseUrl !== "string") {
    warnings.push(`${where}: "baseUrl" is required; skipped`);
    return undefined;
  }
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(raw.baseUrl);
  } catch (error) {
    warnings.push(`${where}: ${error instanceof Error ? error.message : String(error)}; skipped`);
    return undefined;
  }

  const config: GatewayConfig = {
    id,
    baseUrl,
    authHeader: DEFAULT_AUTH_HEADER,
    defaultApi: DEFAULT_API,
    headers: parseHeaders(raw.headers, where, warnings),
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
  if (raw.tokenFile !== undefined) {
    if (typeof raw.tokenFile === "string" && raw.tokenFile.trim() && !hasControlChars(raw.tokenFile)) {
      config.tokenFile = expandHome(raw.tokenFile.trim(), home);
    } else {
      warnings.push(`${where}: "tokenFile" must be a path; ignored`);
    }
  }
  if (raw.authHeader !== undefined) {
    if (typeof raw.authHeader === "string" && HEADER_NAME_RE.test(raw.authHeader)) {
      config.authHeader = raw.authHeader.toLowerCase();
    } else {
      warnings.push(`${where}: "authHeader" must be a header name; using ${DEFAULT_AUTH_HEADER}`);
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
      for (const [modelId, override] of Object.entries(raw.models)) {
        const parsed = parseModelOverride(override, `${where}.models.${modelId}`, warnings);
        if (parsed) config.models[modelId] = parsed;
      }
    } else {
      warnings.push(`${where}: "models" must be an object keyed by model id; ignored`);
    }
  }
  if (raw.fallbackModels !== undefined) {
    if (Array.isArray(raw.fallbackModels)) config.fallbackModels = [...raw.fallbackModels];
    else warnings.push(`${where}: "fallbackModels" must be an array; ignored`);
  }
  return config;
}

/** Parse the whole config file (already JSON-decoded). */
export function parseConfigFile(json: unknown, home: string): ParseResult {
  const warnings: string[] = [];
  const providers: GatewayConfig[] = [];
  if (!isRecord(json) || !isRecord(json.providers)) {
    warnings.push(`expected an object with a "providers" object`);
    return { providers, warnings };
  }
  for (const [id, raw] of Object.entries(json.providers)) {
    const parsed = parseProviderEntry(id, raw, warnings, home);
    if (parsed) providers.push(parsed);
  }
  return { providers, warnings };
}

/**
 * The provider described by the environment, or undefined when `INFERENCE_GATEWAY_BASE_URL` is
 * unset. The API key is referenced by variable name, never copied, so it is read at request time.
 */
export function envProvider(env: Record<string, string | undefined>, home: string): ParseResult {
  const warnings: string[] = [];
  const rawBase = env[ENV.baseUrl]?.trim();
  if (!rawBase) return { providers: [], warnings };

  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(rawBase);
  } catch (error) {
    warnings.push(`${ENV.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
    return { providers: [], warnings };
  }

  let id = DEFAULT_PROVIDER_ID;
  const rawId = env[ENV.providerId]?.trim();
  if (rawId) {
    if (PROVIDER_ID_RE.test(rawId)) id = rawId;
    else warnings.push(`${ENV.providerId}: must match ${PROVIDER_ID_RE.source}; using ${DEFAULT_PROVIDER_ID}`);
  }

  let defaultApi = DEFAULT_API;
  const rawApi = env[ENV.defaultApi]?.trim();
  if (rawApi) {
    if (isGatewayApi(rawApi)) defaultApi = rawApi;
    else warnings.push(`${ENV.defaultApi}: must be one of ${GATEWAY_APIS.join(", ")}; using ${DEFAULT_API}`);
  }

  const tokenFile = env[ENV.tokenFile]?.trim();
  return {
    providers: [
      {
        id,
        baseUrl,
        apiKeyEnv: ENV.apiKey,
        ...(tokenFile ? { tokenFile: expandHome(tokenFile, home) } : {}),
        authHeader: DEFAULT_AUTH_HEADER,
        defaultApi,
        headers: {},
        modelsPath: DEFAULT_MODELS_PATH,
        include: [],
        exclude: [],
        models: {},
        fallbackModels: [],
      },
    ],
    warnings,
  };
}

/**
 * Combine the env provider with the file's providers. A file entry with the env provider's id is
 * merged: the environment supplies the connection (base URL, credentials, default API) and the file
 * keeps everything else (headers, filters, per-model overrides, fallback models).
 */
export function mergeProviders(fromEnv: GatewayConfig[], fromFile: GatewayConfig[]): GatewayConfig[] {
  const merged = new Map<string, GatewayConfig>();
  for (const provider of fromFile) merged.set(provider.id, provider);
  for (const provider of fromEnv) {
    const file = merged.get(provider.id);
    if (!file) {
      merged.set(provider.id, provider);
      continue;
    }
    merged.set(provider.id, {
      ...file,
      baseUrl: provider.baseUrl,
      apiKeyEnv: provider.apiKeyEnv,
      tokenFile: provider.tokenFile ?? file.tokenFile,
      defaultApi: provider.defaultApi === DEFAULT_API ? file.defaultApi : provider.defaultApi,
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

/**
 * Everything the extension needs to decide what to register. No providers and no warnings means
 * "not configured": the extension stays silent.
 */
export async function loadConfig(deps: LoadConfigDeps = {}): Promise<ParseResult & { path: string }> {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const readText = deps.readText ?? readTextIfExists;
  const path = join(agentDir(env, home), CONFIG_FILE_NAME);

  const fromEnv = envProvider(env, home);
  let fromFile: ParseResult = { providers: [], warnings: [] };
  let text: string | undefined;
  try {
    text = await readText(path);
  } catch (error) {
    fromFile.warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (text !== undefined) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      fromFile.warnings.push(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    if (json !== undefined) {
      const parsed = parseConfigFile(json, home);
      fromFile = { providers: parsed.providers, warnings: parsed.warnings.map((warning) => `${path}: ${warning}`) };
    }
  }
  return {
    path,
    providers: mergeProviders(fromEnv.providers, fromFile.providers),
    warnings: [...fromEnv.warnings, ...fromFile.warnings],
  };
}

/**
 * The token to send, read fresh: the token file (re-read every call, so rotated OIDC/WIF tokens are
 * picked up) wins over the API key variable. Undefined means "not configured".
 */
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
