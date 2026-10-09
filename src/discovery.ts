// Model discovery: fetch the gateway's model list, parse every shape gateways actually return,
// sanitise it, pick a pi transport per model, and fill metadata from (in order) the config, the
// gateway's own fields, pi's built-in catalog and safe defaults. Pure exports throughout; the only
// I/O is the injected `fetch`.

import { hasApi } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  AnthropicMessagesCompat,
  Api,
  FetchFunction,
  Model,
  ModelCost,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { hasControlChars, type CostFields, type GatewayApi, type GatewayConfig, isGatewayApi } from "./config.ts";

export const LIMITS = {
  maxIdLength: 256,
  maxNameLength: 256,
  maxModels: 1000,
  maxBodyBytes: 1024 * 1024,
  /** Interactive / refresh-time discovery. */
  timeoutMs: 10_000,
  /** Upper bound for any token count read from the wire. */
  maxTokenCount: 100_000_000,
  /** Upper bound for a per-million-token price read from the wire, in USD. */
  maxCostPerMillion: 100_000,
} as const;

export const DEFAULTS = {
  contextWindow: 128_000,
  maxTokens: 16_384,
} as const;

/** A pi chat model on one of the three gateway transports. */
export type GatewayModel =
  | Model<"anthropic-messages">
  | Model<"openai-responses">
  | Model<"openai-completions">;

/** One model as the gateway described it, sanitised. Every field but `id` is optional. */
export interface GatewayModelEntry {
  id: string;
  name?: string;
  /** Explicit transport hint (`api` field). */
  api?: GatewayApi;
  /** Endpoint paths the gateway says this model serves. */
  endpoints: string[];
  /** Lower-cased owner/provider hints: owned_by, provider, litellm_provider. */
  owners: string[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  vision?: boolean;
  cost?: Partial<CostFields>;
}

// --- fetching -------------------------------------------------------------------------------

export interface FetchModelListOptions {
  url: string;
  headers: Record<string, string>;
  fetch?: FetchFunction;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Read a response body as text, failing as soon as it exceeds `limit` bytes. */
async function readLimited(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new Error(`model list is ${declared} bytes, over the ${limit}-byte limit`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`model list exceeds the ${limit}-byte limit`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * GET the model list. Redirects are an error (a gateway that redirects its model list is
 * misconfigured, and following one would send the token to another origin), the body is capped,
 * and the whole exchange is bounded by `timeoutMs` and the caller's signal.
 */
export async function fetchModelList(options: FetchModelListOptions): Promise<unknown> {
  const transport = options.fetch ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? LIMITS.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await transport(options.url, {
      method: "GET",
      headers: { accept: "application/json", ...options.headers },
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (timeout.aborted) throw new Error(`model list request timed out after ${options.timeoutMs ?? LIMITS.timeoutMs} ms`);
    throw new Error(`model list request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel();
    // Covers `redirect: "manual"` style opaque redirects from fetch implementations that do not
    // throw, and every gateway error. The body is not echoed: it may contain the request back.
    throw new Error(`model list request returned HTTP ${response.status}`);
  }
  let text: string;
  try {
    text = await readLimited(response, LIMITS.maxBodyBytes);
  } catch (error) {
    if (timeout.aborted) throw new Error(`model list request timed out after ${options.timeoutMs ?? LIMITS.timeoutMs} ms`);
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("model list is not valid JSON");
  }
}

// --- parsing ----------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInt(value: unknown, max: number = LIMITS.maxTokenCount): number | undefined {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 && number <= max
    ? number
    : undefined;
}

/** A per-token price (LiteLLM's unit) as pi's per-million price. */
function perMillion(value: unknown): number | undefined {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0) return undefined;
  const scaled = Math.round(number * 1_000_000 * 1e6) / 1e6;
  return scaled <= LIMITS.maxCostPerMillion ? scaled : undefined;
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || hasControlChars(trimmed)) return undefined;
  return trimmed;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function firstDefined<T>(...values: (T | undefined)[]): T | undefined {
  for (const value of values) if (value !== undefined) return value;
  return undefined;
}

/**
 * Parse one model object. Accepts the OpenAI list entry (`id`, `owned_by`), LiteLLM's
 * model-info fields (`litellm_provider`, `max_input_tokens`, `input_cost_per_token`,
 * `supports_vision`, ...) whether flat or under `model_info`, and the common
 * `context_window`/`context_length`/`input_modalities` spellings. A bare string is an id.
 */
export function parseModelEntry(raw: unknown): GatewayModelEntry | undefined {
  if (typeof raw === "string") {
    const id = cleanString(raw, LIMITS.maxIdLength);
    return id === undefined || /\s/.test(id) ? undefined : { id, endpoints: [], owners: [] };
  }
  if (!isRecord(raw)) return undefined;
  const info = isRecord(raw.model_info) ? { ...raw.model_info, ...raw } : raw;

  const id = cleanString(firstDefined(info.id, info.model_name, info.model, info.name), LIMITS.maxIdLength);
  if (id === undefined || /\s/.test(id)) return undefined;

  const entry: GatewayModelEntry = { id, endpoints: [], owners: [] };
  const name = cleanString(firstDefined(info.display_name, info.displayName), LIMITS.maxNameLength);
  if (name !== undefined) entry.name = name;

  if (isGatewayApi(info.api)) entry.api = info.api;
  for (const key of ["endpoint", "inference_endpoint"]) {
    const value = cleanString(info[key], 256);
    if (value !== undefined) entry.endpoints.push(value);
  }
  for (const key of ["supported_endpoints", "endpoints"]) entry.endpoints.push(...stringArray(info[key]));

  for (const key of ["owned_by", "provider", "litellm_provider"]) {
    const value = cleanString(info[key], 128);
    if (value !== undefined) entry.owners.push(value.toLowerCase());
  }

  const contextWindow = firstDefined(
    boundedInt(info.context_window),
    boundedInt(info.context_length),
    boundedInt(info.max_input_tokens),
    boundedInt(info.max_context_length),
  );
  if (contextWindow !== undefined) entry.contextWindow = contextWindow;
  const maxTokens = firstDefined(boundedInt(info.max_output_tokens), boundedInt(info.max_tokens));
  if (maxTokens !== undefined) entry.maxTokens = maxTokens;

  if (typeof info.supports_reasoning === "boolean") entry.reasoning = info.supports_reasoning;
  else if (typeof info.reasoning === "boolean") entry.reasoning = info.reasoning;

  const modalities = stringArray(firstDefined(info.input_modalities, info.modalities));
  if (typeof info.supports_vision === "boolean") entry.vision = info.supports_vision;
  else if (modalities.length > 0) entry.vision = modalities.includes("image");

  const cost: Partial<CostFields> = {};
  const input = perMillion(info.input_cost_per_token);
  if (input !== undefined) cost.input = input;
  const output = perMillion(info.output_cost_per_token);
  if (output !== undefined) cost.output = output;
  const cacheRead = perMillion(info.cache_read_input_token_cost);
  if (cacheRead !== undefined) cost.cacheRead = cacheRead;
  const cacheWrite = perMillion(info.cache_creation_input_token_cost);
  if (cacheWrite !== undefined) cost.cacheWrite = cacheWrite;
  if (Object.keys(cost).length > 0) entry.cost = cost;

  return entry;
}

export interface ParsedModelList {
  entries: GatewayModelEntry[];
  /** Entries dropped as malformed, duplicate, or over the list cap. */
  dropped: number;
}

/**
 * Parse a model-list body: OpenAI `{data:[...]}`, `{models:[...]}`, or a bare array.
 * Duplicates keep the first occurrence; the list is capped at `LIMITS.maxModels`.
 */
export function parseModelList(body: unknown): ParsedModelList {
  let list: unknown[];
  if (Array.isArray(body)) list = body;
  else if (isRecord(body) && Array.isArray(body.data)) list = body.data;
  else if (isRecord(body) && Array.isArray(body.models)) list = body.models;
  else throw new Error("model list has no `data` or `models` array");

  const entries: GatewayModelEntry[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of list) {
    const entry = parseModelEntry(raw);
    if (!entry || seen.has(entry.id) || entries.length >= LIMITS.maxModels) {
      dropped++;
      continue;
    }
    seen.add(entry.id);
    entries.push(entry);
  }
  return { entries, dropped };
}

// --- selection --------------------------------------------------------------------------------

/** `*` matches any run of characters; everything else is literal. Case-sensitive. */
export function globMatch(pattern: string, value: string): boolean {
  const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`).test(value);
}

export function isIncluded(id: string, config: Pick<GatewayConfig, "include" | "exclude">): boolean {
  if (config.include.length > 0 && !config.include.some((pattern) => globMatch(pattern, id))) return false;
  return !config.exclude.some((pattern) => globMatch(pattern, id));
}

/** `vendor/model` → `model`. Used for pi-catalog lookups only; requests keep the gateway's id. */
export function stripVendorPrefix(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

function isAnthropicOwner(owner: string): boolean {
  return owner.includes("anthropic");
}

function isOpenAIOwner(owner: string): boolean {
  return owner === "openai" || owner.startsWith("openai-") || owner === "azure" || owner.startsWith("azure_") || owner.startsWith("azure-");
}

function apiFromEndpoints(endpoints: readonly string[], anthropicOwned: boolean): GatewayApi | undefined {
  const has = (suffix: string) =>
    endpoints.some((endpoint) => endpoint.replace(/\/+$/, "").endsWith(suffix));
  const messages = has("/messages");
  const responses = has("/responses");
  const chat = has("/chat/completions");
  if (messages && (anthropicOwned || (!responses && !chat))) return "anthropic-messages";
  if (responses) return "openai-responses";
  if (chat) return "openai-completions";
  return undefined;
}

/** A pi built-in model with this id (or the id after its vendor prefix), if any. */
export interface CatalogMatch {
  /** Which built-in provider it came from. */
  source: "anthropic" | "openai";
  model: Model<Api>;
}

export function findCatalogModel(id: string): CatalogMatch | undefined {
  const candidates = id.includes("/") ? [id, stripVendorPrefix(id)] : [id];
  for (const candidate of candidates) {
    const anthropic = getBuiltinModels("anthropic").find((model) => model.id === candidate);
    if (anthropic) return { source: "anthropic", model: anthropic };
    const openai = getBuiltinModels("openai").find((model) => model.id === candidate);
    if (openai) return { source: "openai", model: openai };
  }
  return undefined;
}

/**
 * Pick the transport for one model. First match wins:
 *   1. config `models[id].api`
 *   2. gateway hint: `api`, then `endpoint`/`inference_endpoint`/`supported_endpoints`/`endpoints`
 *      (messages for Anthropic owners, else responses, else chat)
 *   3. owner: anthropic → messages; openai/azure → responses
 *   4. pi's built-in catalog: found under `anthropic` → messages, under `openai` → responses
 *   5. the provider's `defaultApi`
 */
export function selectApi(
  entry: GatewayModelEntry,
  config: Pick<GatewayConfig, "models" | "defaultApi">,
  catalog: CatalogMatch | undefined = findCatalogModel(entry.id),
): GatewayApi {
  const override = config.models[entry.id]?.api;
  if (override) return override;

  if (entry.api) return entry.api;
  const anthropicOwned = entry.owners.some(isAnthropicOwner);
  const fromEndpoints = apiFromEndpoints(entry.endpoints, anthropicOwned);
  if (fromEndpoints) return fromEndpoints;

  if (anthropicOwned) return "anthropic-messages";
  if (entry.owners.some(isOpenAIOwner)) return "openai-responses";

  if (catalog?.source === "anthropic") return "anthropic-messages";
  if (catalog?.source === "openai") return "openai-responses";

  return config.defaultApi;
}

/**
 * Base URL per transport, from the one gateway root: pi's OpenAI transports append
 * `/responses` or `/chat/completions` to a base that already ends in `/v1`; the Anthropic SDK
 * appends `/v1/messages` itself, so it gets the bare root.
 */
export function baseUrlFor(api: GatewayApi, root: string): string {
  return api === "anthropic-messages" ? root : `${root}/v1`;
}

// --- metadata ---------------------------------------------------------------------------------

/**
 * `allowedFallbackModels` makes pi add a `fallbacks` field to the Anthropic request body. That is
 * an api.anthropic.com feature; a gateway forwarding to any other Claude host (Vertex, Bedrock, a
 * second proxy) answers 400 `fallbacks: Extra inputs are not permitted` — the sibling
 * pi-anthropic-vertex extension hit exactly this. Every other catalog compat key is copied as-is.
 */
function anthropicCompat(compat: AnthropicMessagesCompat | undefined): AnthropicMessagesCompat | undefined {
  if (!compat) return undefined;
  const { allowedFallbackModels: _fallbacksAreAnthropicApiOnly, ...rest } = compat;
  return rest;
}

/** The fields of a pi model that do not depend on the transport. */
interface ModelCore {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
}

function withApi(
  api: GatewayApi,
  core: ModelCore,
  catalog: Model<Api> | undefined,
): GatewayModel {
  // thinkingLevelMap and compat describe how a *transport* shapes a request, so they are only
  // copied from a catalog entry on the same transport.
  const thinking = (map: ThinkingLevelMap | undefined) => (map ? { thinkingLevelMap: map } : {});
  switch (api) {
    case "anthropic-messages": {
      const same = catalog && hasApi(catalog, "anthropic-messages") ? catalog : undefined;
      const compat = anthropicCompat(same?.compat);
      return { ...core, api, ...thinking(same?.thinkingLevelMap), ...(compat ? { compat } : {}) };
    }
    case "openai-responses": {
      const same = catalog && hasApi(catalog, "openai-responses") ? catalog : undefined;
      const compat: OpenAIResponsesCompat | undefined = same?.compat;
      return { ...core, api, ...thinking(same?.thinkingLevelMap), ...(compat ? { compat } : {}) };
    }
    case "openai-completions": {
      const same = catalog && hasApi(catalog, "openai-completions") ? catalog : undefined;
      const compat: OpenAICompletionsCompat | undefined = same?.compat;
      return { ...core, api, ...thinking(same?.thinkingLevelMap), ...(compat ? { compat } : {}) };
    }
  }
}

/**
 * Build the pi model for one gateway entry. Per field, first defined wins:
 * config override → gateway fields → pi built-in model (same id, or id after `vendor/`) →
 * defaults (128k context, 16k output, text only, no reasoning, zero cost).
 * The id is the gateway's, verbatim — it is what the gateway expects back in requests.
 */
export function buildModel(entry: GatewayModelEntry, config: GatewayConfig): GatewayModel {
  const catalogMatch = findCatalogModel(entry.id);
  const catalog = catalogMatch?.model;
  const override = config.models[entry.id] ?? {};
  const api = selectApi(entry, config, catalogMatch);

  const vision = firstDefined(
    override.input ? override.input.includes("image") : undefined,
    entry.vision,
    catalog ? catalog.input.includes("image") : undefined,
  );
  const wireCost = { ...entry.cost, ...override.cost };
  // Pricing tiers only make sense against the catalog's own base rates, so they are kept only
  // when nothing else supplied a rate.
  const tiers = Object.keys(wireCost).length === 0 ? catalog?.cost.tiers : undefined;
  const cost: ModelCost = {
    input: firstDefined(wireCost.input, catalog?.cost.input) ?? 0,
    output: firstDefined(wireCost.output, catalog?.cost.output) ?? 0,
    cacheRead: firstDefined(wireCost.cacheRead, catalog?.cost.cacheRead) ?? 0,
    cacheWrite: firstDefined(wireCost.cacheWrite, catalog?.cost.cacheWrite) ?? 0,
    ...(tiers ? { tiers } : {}),
  };

  const core: ModelCore = {
    id: entry.id,
    name: firstDefined(override.name, entry.name, catalog?.name) ?? entry.id,
    provider: config.id,
    baseUrl: baseUrlFor(api, config.baseUrl),
    reasoning: firstDefined(override.reasoning, entry.reasoning, catalog?.reasoning) ?? false,
    input: vision ? ["text", "image"] : ["text"],
    cost,
    contextWindow:
      firstDefined(override.contextWindow, entry.contextWindow, catalog?.contextWindow) ?? DEFAULTS.contextWindow,
    maxTokens: firstDefined(override.maxTokens, entry.maxTokens, catalog?.maxTokens) ?? DEFAULTS.maxTokens,
    ...(Object.keys(config.headers).length > 0 ? { headers: { ...config.headers } } : {}),
  };
  return withApi(api, core, catalog);
}

/** Parse, filter and build. Throws only on an unusable body shape. */
export function modelsFromList(body: unknown, config: GatewayConfig): { models: GatewayModel[]; dropped: number } {
  const { entries, dropped } = parseModelList(body);
  const models = entries.filter((entry) => isIncluded(entry.id, config)).map((entry) => buildModel(entry, config));
  return { models, dropped };
}

/** The request headers for discovery: static config headers plus the token in the configured header. */
export function discoveryHeaders(config: Pick<GatewayConfig, "headers" | "authHeader">, token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { ...config.headers };
  if (token) headers[config.authHeader] = config.authHeader === "authorization" ? `Bearer ${token}` : token;
  return headers;
}

export function modelsUrl(config: Pick<GatewayConfig, "baseUrl" | "modelsPath">): string {
  return `${config.baseUrl}${config.modelsPath}`;
}

export interface DiscoverOptions {
  token: string | undefined;
  fetch?: FetchFunction;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Fetch and build the gateway's models. Rejects on any network, HTTP, size or shape failure. */
export async function discoverModels(config: GatewayConfig, options: DiscoverOptions): Promise<GatewayModel[]> {
  const body = await fetchModelList({
    url: modelsUrl(config),
    headers: discoveryHeaders(config, options.token),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  return modelsFromList(body, config).models;
}

/** Models from the config's `fallbackModels` (same entry shapes as the gateway list). */
export function fallbackModels(config: GatewayConfig): GatewayModel[] {
  if (config.fallbackModels.length === 0) return [];
  return modelsFromList(config.fallbackModels, config).models;
}
