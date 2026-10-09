// Model discovery: fetch the gateway's model list, parse every shape gateways actually return,
// sanitise it, pick a pi transport per model, and fill metadata from (in order) the config, the
// gateway's own fields, pi's built-in catalog and safe defaults. Pure exports throughout; the only
// I/O is the injected `fetch`.

import { hasApi } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { validateCompat } from "./compat.ts";
import type {
  AnthropicMessagesCompat,
  AnyModel,
  Api,
  FetchFunction,
  Model,
  ModelCost,
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { authHeaderEntry, authHeaderFor, credentialHeaderNames, ENV, type CompatOverride, type GatewayCredentials, type ModelOverride, hasControlChars, isValidModelId, modelOverride, type CostFields, type GatewayApi, type GatewayConfig, isGatewayApi } from "./config.ts";

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

const ERROR_DETAIL_BYTES = 512;
const ERROR_DETAIL_CHARS = 200;

/**
 * Every string a credential in `headers` could appear as in an error body: each header value, each
 * of its space-separated parts (`Bearer <token>` → `<token>`), and for Basic the decoded
 * `user:password` and the password alone. Only the scheme words and fragments under 3 characters
 * are left alone.
 */
function secretsIn(headers: Record<string, string>): string[] {
  const secrets = new Set<string>();
  for (const value of Object.values(headers)) {
    const parts = value.split(/\s+/);
    for (const part of [value, ...parts]) secrets.add(part);
    if (parts[0]?.toLowerCase() === "basic" && parts[1]) {
      const decoded = Buffer.from(parts[1], "base64").toString("utf8");
      secrets.add(decoded);
      secrets.add(decoded.slice(decoded.indexOf(":") + 1));
    }
  }
  return [...secrets]
    .filter((secret) => secret.length >= 3 && !/^(bearer|basic)$/i.test(secret))
    .sort((a, b) => b.length - a.length);
}

/**
 * The start of a `text/plain` error body, for the error message: at most ERROR_DETAIL_BYTES read,
 * control characters flattened, ERROR_DETAIL_CHARS shown, credentials from the request redacted.
 * JSON, HTML and anything else is not echoed. Never throws.
 */
async function plainTextDetail(response: Response, headers: Record<string, string>): Promise<string> {
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!type.startsWith("text/plain") || !response.body) {
    await response.body?.cancel().catch(() => {});
    return "";
  }
  let text = "";
  try {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < ERROR_DETAIL_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    await reader.cancel().catch(() => {});
    text = new TextDecoder().decode(Buffer.concat(chunks).subarray(0, ERROR_DETAIL_BYTES));
  } catch {
    return "";
  }
  // Whole occurrences only (not inside a longer alphanumeric run), so a 3-letter token does not
  // mangle every word that contains it; a secret glued to `=`, `:`, quotes or spaces is caught.
  for (const secret of secretsIn(headers)) {
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "g"), "[redacted]");
  }
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > ERROR_DETAIL_CHARS ? `${flat.slice(0, ERROR_DETAIL_CHARS)}…` : flat;
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
    // Covers `redirect: "manual"` style opaque redirects from fetch implementations that do not
    // throw, and every gateway error. Only a short text/plain body is shown (gateways answer auth
    // and conversion failures that way), with every credential the request carried redacted.
    const detail = await plainTextDetail(response, options.headers);
    throw new Error(`model list request returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
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
    return id !== undefined && isValidModelId(id) ? { id, endpoints: [], owners: [] } : undefined;
  }
  if (!isRecord(raw)) return undefined;
  const info = isRecord(raw.model_info) ? { ...raw.model_info, ...raw } : raw;

  const id = cleanString(firstDefined(info.id, info.model_name, info.model, info.name), LIMITS.maxIdLength);
  if (id === undefined || !isValidModelId(id)) return undefined;

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
  /** Ids containing `*`: a gateway listing a routing pattern (agentgateway `openai/*`), not a model. */
  wildcards: string[];
  /** Entries dropped as embedding, image, audio, rerank, ... models (see isNonChatEntry). */
  nonChat: number;
}

/**
 * LiteLLM `mode` / generic `type` values of models that are not chat models: embeddings, image,
 * audio, video, rerank, moderation, OCR. Matched as a prefix, lower-cased. `chat`, `completion`,
 * `responses` and anything unknown stay.
 */
const NON_CHAT_KIND_RE = /^(embed|image|audio|video|rerank|moderation|speech|transcri|tts|stt|ocr)/;

/**
 * Whether a raw list entry describes a model pi cannot chat with: a LiteLLM `mode` or a `type`
 * naming a non-chat kind, or OpenRouter-style `architecture.output_modalities` without `text`.
 * The OpenAI list's `object: "model"` says nothing and is ignored.
 */
export function isNonChatEntry(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const info = isRecord(raw.model_info) ? { ...raw.model_info, ...raw } : raw;
  for (const key of ["mode", "type"]) {
    const kind = info[key];
    if (typeof kind === "string" && NON_CHAT_KIND_RE.test(kind.trim().toLowerCase())) return true;
  }
  const outputs = isRecord(info.architecture) ? info.architecture.output_modalities : undefined;
  return Array.isArray(outputs) && outputs.length > 0 && !outputs.includes("text");
}

/**
 * Parse a model-list body: OpenAI `{data:[...]}`, `{models:[...]}`, or a bare array.
 * Non-chat entries and wildcard ids are set aside first, so they never count against the cap;
 * duplicates keep the first occurrence; the list is capped at `LIMITS.maxModels`.
 */
export function parseModelList(body: unknown): ParsedModelList {
  let list: unknown[];
  if (Array.isArray(body)) list = body;
  else if (isRecord(body) && Array.isArray(body.data)) list = body.data;
  else if (isRecord(body) && Array.isArray(body.models)) list = body.models;
  else throw new Error("model list has no `data` or `models` array");

  const entries: GatewayModelEntry[] = [];
  const wildcards: string[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let nonChat = 0;
  for (const raw of list) {
    if (isNonChatEntry(raw)) {
      nonChat++;
      continue;
    }
    const entry = parseModelEntry(raw);
    if (entry?.id.includes("*")) {
      if (!wildcards.includes(entry.id)) wildcards.push(entry.id);
      continue;
    }
    if (!entry || seen.has(entry.id) || entries.length >= LIMITS.maxModels) {
      dropped++;
      continue;
    }
    seen.add(entry.id);
    entries.push(entry);
  }
  return { entries, dropped, wildcards, nonChat };
}

/** The one warning for wildcard ids, or none. */
function wildcardWarning(wildcards: readonly string[]): string[] {
  if (wildcards.length === 0) return [];
  const shown = wildcards.slice(0, 5).join(", ") + (wildcards.length > 5 ? ` (+${wildcards.length - 5} more)` : "");
  return [
    `ignored wildcard model id(s) ${shown}: the gateway lists a routing pattern, not a model; ` +
      `add concrete ids via "models" in the config file (or ${ENV.extraModels})`,
  ];
}

/**
 * Throws when a successfully fetched list has no usable model: an empty list, or one whose every
 * entry was malformed, a wildcard or a non-chat model. Treated like a failed fetch, so the last
 * good list (or pi's snapshot and the fallbacks) stays instead of an empty catalog.
 */
function assertUsable(parsed: ParsedModelList): void {
  if (parsed.entries.length > 0) return;
  const total = parsed.dropped + parsed.wildcards.length + parsed.nonChat;
  if (total === 0) throw new Error("model list is empty");
  const parts = [
    parsed.wildcards.length > 0 ? `${parsed.wildcards.length} wildcard` : "",
    parsed.nonChat > 0 ? `${parsed.nonChat} non-chat` : "",
    parsed.dropped > 0 ? `${parsed.dropped} malformed` : "",
  ].filter(Boolean);
  throw new Error(`model list has no usable model (${parts.join(", ")})`);
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

/**
 * Owner values that say who *hosts* a model, not which protocol it speaks: a cloud
 * (`vertex`, `bedrock`, `azure_ai`), an aggregator (`openrouter`), or a placeholder (`system`,
 * `library`, empty). A path-routing front proxy reports `owned_by: "vertex"` for Claude and Gemini
 * alike, so these are no signal and the next rule decides.
 */
export const AMBIGUOUS_OWNERS: ReadonlySet<string> = new Set([
  "",
  "vertex",
  "vertex_ai",
  "bedrock",
  "bedrock_converse",
  "azure_ai",
  "openrouter",
  "system",
  "library",
]);

function isAnthropicOwner(owner: string): boolean {
  return !AMBIGUOUS_OWNERS.has(owner) && owner.includes("anthropic");
}

function isOpenAIOwner(owner: string): boolean {
  return !AMBIGUOUS_OWNERS.has(owner) && (owner === "openai" || owner.startsWith("openai-") || owner === "azure");
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

/** A pi built-in model matching a gateway id, and the built-in provider it was found under. */
export interface CatalogMatch {
  /** pi's built-in provider id: `anthropic`, `openai`, `zai`, `google`, ... */
  source: string;
  model: Model<Api>;
}

/**
 * The order built-in providers are searched in. `anthropic` and `openai` first (they decide the
 * transport), then first-party vendors, then everything else — aggregators such as `openrouter` or
 * `github-copilot` re-list other vendors' models and are only a last resort for metadata.
 */
const CATALOG_PRIORITY = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "zai",
  "zai-coding-cn",
  "deepseek",
  "mistral",
  "moonshotai",
  "minimax",
  "meta",
  "xiaomi",
  "qwen-token-plan",
];

let catalogIndex: Map<string, CatalogMatch> | undefined;

/** id → first match in CATALOG_PRIORITY order, built once. */
function catalog(): Map<string, CatalogMatch> {
  if (catalogIndex) return catalogIndex;
  const rank = (provider: string) => {
    const index = CATALOG_PRIORITY.indexOf(provider);
    return index >= 0 ? index : CATALOG_PRIORITY.length;
  };
  const providers = [...getBuiltinProviders()].sort((a, b) => rank(a) - rank(b));
  const index = new Map<string, CatalogMatch>();
  for (const source of providers) {
    for (const model of getBuiltinModels(source)) {
      if (!index.has(model.id)) index.set(model.id, { source, model });
    }
  }
  catalogIndex = index;
  return index;
}

/** `glm-5-3` ↔ `glm-5.3`: gateways and pi's catalog disagree on version separators. */
export function separatorVariants(id: string): string[] {
  const dotted = id.replace(/(\d)-(?=\d)/g, "$1.");
  const dashed = id.replace(/(\d)\.(?=\d)/g, "$1-");
  return [...new Set([id, dotted, dashed])];
}

/** The ids tried against pi's catalog, most specific first. Requests always use the original. */
export function catalogCandidates(id: string): string[] {
  const stripped = stripVendorPrefix(id);
  const bases = stripped === id ? [id] : [id, stripped];
  return [...new Set(bases.flatMap(separatorVariants))];
}

/**
 * A pi built-in model for this id: exact id first, then without its `vendor/` prefix, then with
 * `-`/`.` swapped between digits — `anthropic`/`openai` hits win over any other provider's.
 */
export function findCatalogModel(id: string): CatalogMatch | undefined {
  const index = catalog();
  const candidates = catalogCandidates(id);
  let fallback: CatalogMatch | undefined;
  for (const candidate of candidates) {
    const match = index.get(candidate);
    if (!match) continue;
    if (match.source === "anthropic" || match.source === "openai") return match;
    fallback ??= match;
  }
  return fallback;
}

function isClaudeId(id: string): boolean {
  return id.startsWith("claude-") || stripVendorPrefix(id).startsWith("claude-");
}

/**
 * Pick the transport for one model. First match wins:
 *   1. config `models[id].api`
 *   2. gateway hint: `api`, then `endpoint`/`inference_endpoint`/`supported_endpoints`/`endpoints`
 *      (messages for Anthropic owners, else responses, else chat)
 *   3. pi's built-in catalog under `anthropic` → messages, under `openai` → responses
 *   4. a `claude-` id (also after a `vendor/` prefix) → messages
 *   5. owner: anthropic → messages; openai/azure → responses; AMBIGUOUS_OWNERS say nothing
 *   6. pi's built-in catalog under any other provider → chat completions (never a native API such
 *      as google-generative-ai: a gateway speaks the three OpenAI/Anthropic protocols only)
 *   7. the provider's `defaultApi`
 *
 * The model's own identity (3, 4) beats the owner (5): agentgateway synthesises its list with
 * `owned_by: "openai"` on every entry, Claude included, and Claude on /v1/responses is a 400 there.
 * 4 runs before 6 because aggregator catalogs (github-copilot, opencode, openrouter, ...) list
 * Claude ids too; a Claude id missing from pi's `anthropic` catalog must still go to /v1/messages.
 */
export function selectApi(
  entry: GatewayModelEntry,
  config: Pick<GatewayConfig, "models" | "defaultApi">,
  match: CatalogMatch | undefined = findCatalogModel(entry.id),
): GatewayApi {
  const override = modelOverride(config, entry.id)?.api;
  if (override) return override;

  if (entry.api) return entry.api;
  const anthropicOwned = entry.owners.some(isAnthropicOwner);
  const fromEndpoints = apiFromEndpoints(entry.endpoints, anthropicOwned);
  if (fromEndpoints) return fromEndpoints;

  if (match?.source === "anthropic") return "anthropic-messages";
  if (match?.source === "openai") return "openai-responses";
  if (isClaudeId(entry.id)) return "anthropic-messages";

  if (anthropicOwned) return "anthropic-messages";
  if (entry.owners.some(isOpenAIOwner)) return "openai-responses";

  if (match) return "openai-completions";

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

/**
 * The compat a model gets: the catalog's (already filtered), then the config override. `null` drops
 * everything; an object is merged over the catalog's flags. `empty` is the typed `{}` to merge
 * into — the override's keys are the user's to choose, and pi ignores keys it does not know.
 */
function compatFor<T extends object>(
  empty: T,
  catalog: T | undefined,
  override: CompatOverride | null | undefined,
  api: GatewayApi,
): T | undefined {
  if (override === null) return undefined;
  if (override === undefined) return catalog;
  // Re-checked against the final transport: the config may not have named the API, and a value
  // valid on one transport (sessionAffinityFormat "openai") can be wrong on another.
  return Object.assign(empty, catalog, validateCompat(override, api).kept);
}

function withApi(
  api: GatewayApi,
  core: ModelCore,
  catalog: Model<Api> | undefined,
  override: Pick<ModelOverride, "compat" | "thinkingLevelMap">,
  sessionAffinity = false,
): GatewayModel {
  // Opt-in affinity: pi's own switch for the affinity headers on the two transports that do not
  // send them by default (Responses always does). The config's compat still wins per model.
  const affinity = sessionAffinity ? { sendSessionAffinityHeaders: true } : {};
  // thinkingLevelMap and compat describe how a *transport* shapes a request, so they are only
  // copied from a catalog entry on the same transport. The config's map is merged over the copy
  // (`null` drops it): what a level is sent as is the user's call, not a per-gateway table here.
  const thinking = (copied: ThinkingLevelMap | undefined) => {
    const map = override.thinkingLevelMap === null ? undefined : { ...copied, ...override.thinkingLevelMap };
    return map && Object.keys(map).length > 0 ? { thinkingLevelMap: map } : {};
  };
  switch (api) {
    case "anthropic-messages": {
      const same = catalog && hasApi(catalog, "anthropic-messages") ? catalog : undefined;
      const copied = anthropicCompat(same?.compat);
      const base = sessionAffinity ? { ...copied, ...affinity } : copied;
      const compat = compatFor<AnthropicMessagesCompat>({}, base, override.compat, api);
      return { ...core, api, ...thinking(same?.thinkingLevelMap), ...(compat ? { compat } : {}) };
    }
    case "openai-responses": {
      const same = catalog && hasApi(catalog, "openai-responses") ? catalog : undefined;
      const compat = compatFor<OpenAIResponsesCompat>({}, same?.compat, override.compat, api);
      return { ...core, api, ...thinking(same?.thinkingLevelMap), ...(compat ? { compat } : {}) };
    }
    case "openai-completions": {
      const same = catalog && hasApi(catalog, "openai-completions") ? catalog : undefined;
      const base = sessionAffinity ? { ...same?.compat, ...affinity } : same?.compat;
      const compat = compatFor<OpenAICompletionsCompat>({}, base, override.compat, api);
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
  const override = modelOverride(config, entry.id) ?? {};
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

  const contextWindow =
    firstDefined(override.contextWindow, entry.contextWindow, catalog?.contextWindow) ?? DEFAULTS.contextWindow;
  const core: ModelCore = {
    id: entry.id,
    name: firstDefined(override.name, entry.name, catalog?.name) ?? entry.id,
    provider: config.id,
    baseUrl: baseUrlFor(api, config.baseUrl),
    reasoning: firstDefined(override.reasoning, entry.reasoning, catalog?.reasoning) ?? false,
    input: vision ? ["text", "image"] : ["text"],
    cost,
    contextWindow,
    // A reply cannot be longer than the window it shares with the prompt.
    maxTokens: Math.min(firstDefined(override.maxTokens, entry.maxTokens, catalog?.maxTokens) ?? DEFAULTS.maxTokens, contextWindow),
    ...(Object.keys(config.headers).length > 0 ? { headers: { ...config.headers } } : {}),
  };
  return withApi(api, core, catalog, override, config.sessionAffinity === true);
}

/**
 * Config `models` entries with an `api` that the list does not contain: models a gateway serves but
 * does not list (a path-routing proxy lists only what one backend reports). Added regardless of
 * include/exclude, since they were named explicitly; metadata comes from the override, then pi's
 * catalog, then defaults.
 */
export function extraModels(config: GatewayConfig, listedIds: ReadonlySet<string>): GatewayModel[] {
  return Object.entries(config.models)
    .filter(([id, override]) => override.api !== undefined && !listedIds.has(id))
    .map(([id]) => buildModel({ id, endpoints: [], owners: [] }, config));
}

export interface ModelsFromList {
  models: GatewayModel[];
  dropped: number;
  /** Things the user should hear about once (wildcard ids, ...); never a credential. */
  warnings: string[];
}

/**
 * One warning when gateway-reported context windows are 4x or more off pi's catalog for the same
 * model: relays commonly stamp one placeholder window on every model, and the gateway's value wins
 * over the catalog. Models whose window the config sets are not checked.
 */
function placeholderWindowWarning(entries: readonly GatewayModelEntry[], config: GatewayConfig): string[] {
  const shared = new Map<number, number>();
  for (const entry of entries) {
    if (entry.contextWindow !== undefined) shared.set(entry.contextWindow, (shared.get(entry.contextWindow) ?? 0) + 1);
  }
  const suspicious: string[] = [];
  const repeated = new Set<number>();
  for (const entry of entries) {
    const reported = entry.contextWindow;
    if (reported === undefined || modelOverride(config, entry.id)?.contextWindow !== undefined) continue;
    const known = findCatalogModel(entry.id)?.model.contextWindow;
    if (!known || Math.max(reported, known) < 4 * Math.min(reported, known)) continue;
    suspicious.push(`${entry.id} (gateway ${reported}, pi's catalog ${known})`);
    if ((shared.get(reported) ?? 0) >= 3) repeated.add(reported);
  }
  if (suspicious.length === 0) return [];
  const shown = suspicious.slice(0, 3).join(", ") + (suspicious.length > 3 ? ` (+${suspicious.length - 3} more)` : "");
  const same = [...repeated].map((value) => `${shared.get(value)} listed models report the same ${value}`).join("; ");
  return [
    `context window 4x or more off pi's catalog: ${shown}${same ? `; ${same}` : ""}. ` +
      `The gateway may report a placeholder; its value is used. Set models[id].contextWindow (and maxTokens) if it is wrong`,
  ];
}

function buildFromParsed(parsed: ParsedModelList, config: GatewayConfig): ModelsFromList {
  const { entries, dropped, wildcards } = parsed;
  const included = entries.filter((entry) => isIncluded(entry.id, config));
  const listed = included.map((entry) => buildModel(entry, config));
  const listedIds = new Set(entries.map((entry) => entry.id));
  return {
    models: [...listed, ...extraModels(config, listedIds)],
    dropped,
    warnings: [...wildcardWarning(wildcards), ...placeholderWindowWarning(included, config)],
  };
}

/** Parse, filter, build, and append config-added models. Throws only on an unusable body shape. */
export function modelsFromList(body: unknown, config: GatewayConfig): ModelsFromList {
  return buildFromParsed(parseModelList(body), config);
}

/** The request headers for discovery: static config headers plus the token in the configured header. */
/** The request headers for discovery: static config headers plus the `discovery` auth scheme's header. */
export function discoveryHeaders(
  config: Pick<GatewayConfig, "headers" | "authHeaders">,
  credentials: GatewayCredentials | string | undefined,
): Record<string, string> {
  const resolved = typeof credentials === "string" ? { token: credentials, problems: [] } : (credentials ?? { problems: [] });
  const entry = authHeaderEntry(authHeaderFor(config, "discovery"), resolved);
  const reserved = credentialHeaderNames(config.authHeaders);
  const statics = Object.entries(config.headers).filter(([name]) => !reserved.has(name.toLowerCase()));
  return Object.fromEntries([...statics, ...(entry ? [entry] : [])]);
}

export function modelsUrl(config: Pick<GatewayConfig, "baseUrl" | "modelsPath">): string {
  return `${config.baseUrl}${config.modelsPath}`;
}

export interface DiscoverOptions {
  /** Resolved credentials, or a bare token (Bearer / raw-header schemes only). */
  credentials?: GatewayCredentials;
  token?: string;
  fetch?: FetchFunction;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Receives each non-fatal finding about the list (wildcard ids, ...), unprefixed. */
  warn?: (message: string) => void;
}

/**
 * Fetch and build the gateway's models. Rejects on any network, HTTP, size or shape failure, and on
 * a list with no usable model (see assertUsable): an empty catalog is never published.
 */
export async function discoverModels(config: GatewayConfig, options: DiscoverOptions): Promise<GatewayModel[]> {
  const body = await fetchModelList({
    url: modelsUrl(config),
    headers: discoveryHeaders(config, options.credentials ?? options.token),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  const parsed = parseModelList(body);
  const built = buildFromParsed(parsed, config);
  for (const warning of built.warnings) options.warn?.(warning);
  assertUsable(parsed);
  return built.models;
}

/**
 * A cached pi model as if the gateway had described it: its metadata become hints, and so does its
 * transport when `keepApi` (the snapshot was saved by the current selection rules).
 */
function entryFromModel(model: Model<GatewayApi>, keepApi: boolean): GatewayModelEntry {
  return {
    id: model.id,
    name: model.name,
    ...(keepApi ? { api: model.api } : {}),
    endpoints: [],
    owners: [],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    vision: model.input.includes("image"),
    cost: { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite },
  };
}

function asGatewayModel(model: AnyModel): Model<GatewayApi> | undefined {
  if (hasApi(model, "anthropic-messages")) return model;
  if (hasApi(model, "openai-responses")) return model;
  if (hasApi(model, "openai-completions")) return model;
  return undefined;
}

/**
 * Rebuild models from pi's persisted snapshot against the *current* config. A snapshot carries the
 * base URL and headers it was saved with; restoring it as-is after the config changed would send
 * the new credential to the old host. So only the model's identity and metadata are kept: base
 * URL, headers, provider id, overrides, compat and include/exclude all come from the current config.
 * Entries from another provider id, non-chat entries, foreign APIs and invalid ids are dropped.
 *
 * `keepApi: false` (a snapshot from an older version of the selection rules) re-derives each
 * model's transport through selectApi instead of trusting the saved one.
 */
export function rebindModels(
  stored: readonly AnyModel[],
  config: GatewayConfig,
  { keepApi = true }: { keepApi?: boolean } = {},
): GatewayModel[] {
  const rebound: GatewayModel[] = [];
  const seen = new Set<string>();
  for (const cached of stored) {
    if (cached.provider !== config.id || seen.has(cached.id) || !isValidModelId(cached.id)) continue;
    const model = asGatewayModel(cached);
    if (!model) continue;
    const configured = modelOverride(config, model.id)?.api !== undefined;
    if (!configured && !isIncluded(model.id, config)) continue;
    seen.add(model.id);
    rebound.push(buildModel(entryFromModel(model, keepApi), config));
  }
  return rebound;
}

/** Models from the config's `fallbackModels` (same entry shapes as the gateway list), plus config-added models. */
export function fallbackModels(config: GatewayConfig): GatewayModel[] {
  return modelsFromList(config.fallbackModels, config).models;
}
