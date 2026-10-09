// Provider wiring: one pi provider per configured gateway, built by pi's own createProvider with an
// `api` map keyed by `model.api`, so a single registration serves Claude over /v1/messages and GPT
// over /v1/responses or /v1/chat/completions. pi's lazy transports do all the streaming; this file
// only decides which one a model uses, which token it carries and in which header.

import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi, openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type {
  ApiKeyAuth,
  AuthResult,
  CreateProviderOptions,
  FetchFunction,
  Provider,
  ProviderStreams,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import {
  authHeaderEntry,
  authHeaderFor,
  credentialHeaderNames,
  credentialKind,
  ENV,
  loadConfig,
  resolveCredentials,
  type CredentialKind,
  type GatewayApi,
  type GatewayConfig,
  type GatewayCredentials,
  type LoadConfigDeps,
} from "./config.ts";
import { discoverModels, fallbackModels, rebindModels, type GatewayModel } from "./discovery.ts";

export const LOG_PREFIX = "[pi-inference-gateway]";

/**
 * Discovery at extension load is bounded tighter than an interactive refresh: pi awaits the
 * factory before it starts, so a dead gateway must not stall every `pi -p` for long.
 */
export const FACTORY_DISCOVERY_TIMEOUT_MS = 5_000;

/**
 * Version stamp of a persisted model snapshot. Bump the suffix whenever selectApi's rules change:
 * a restored model then has its transport re-derived instead of keeping the one it was saved with.
 *
 * It travels in the snapshot's `etag`: `ModelsStoreEntry` has no other free-form field, and pi reads
 * `etag` only in the remote-catalog wrapper it puts around its *built-in* providers
 * (pi-coding-agent `core/remote-catalog-provider.js`), never for a provider that owns its own
 * `refreshModels` like this one. A snapshot without it predates the stamp.
 */
export const SNAPSHOT_STAMP = "pi-inference-gateway/2";

/** Ambient environment the provider reads at request time; injectable for tests. */
export interface RuntimeDeps {
  env?: Record<string, string | undefined>;
  readText?: (path: string) => Promise<string | undefined>;
  /** Transport for discovery requests. Model requests use whatever pi passes as `options.fetch`. */
  fetch?: FetchFunction;
  warn?: (message: string) => void;
}

// --- request fetch --------------------------------------------------------------------------

/**
 * Resolves the credential a scheme needs; called per request so token and password files are
 * re-read. Only that credential is read: an unreadable password file must not break a Bearer
 * target, nor an unreadable token file a Basic one.
 */
export type CredentialSource = (scheme: string) => Promise<GatewayCredentials>;

/**
 * The `fetch` every inference request goes through. Two jobs:
 *
 * 1. **Never follow a redirect** (`redirect: "error"`). Fetch strips only `authorization` on a
 *    cross-origin redirect, so following one would hand `x-api-key` (or any custom credential
 *    header) to whatever host the gateway redirects to. pi's SDK clients use the default `"follow"`,
 *    and pi exposes no per-request redirect option, so the only hook is `options.fetch`.
 * 2. **Send exactly one auth header, chosen by `scheme`** (see `authHeaderFor`): both native auth
 *    headers pi's SDKs set are removed, then the scheme's header is set from the configured
 *    credentials — Bearer token, raw token in a named header, or Basic user:password. The key pi
 *    passes as `apiKey` is therefore never what goes on the wire; with Basic it is a placeholder.
 *
 * `baseFetch` is resolved per call, not captured: `globalThis.fetch` is routinely replaced after
 * module load (proxy agents, test doubles, pi's own instrumentation).
 */
export function createGatewayFetch({
  scheme,
  credentials,
  strip = ["authorization", "x-api-key"],
  baseFetch,
}: {
  scheme: string;
  credentials: CredentialSource;
  /** Every header name that carries a credential for this provider (see credentialHeaderNames). */
  strip?: Iterable<string>;
  baseFetch?: FetchFunction;
}): FetchFunction {
  return async (input, init) => {
    const transport = baseFetch ?? globalThis.fetch;
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    for (const name of strip) headers.delete(name);
    const entry = authHeaderEntry(scheme, await credentials(scheme));
    if (entry) headers.set(entry[0], entry[1]);
    return transport(input, { ...init, headers, redirect: "error" });
  };
}

/**
 * One of pi's transports with every request — streaming and deferred — routed through
 * {@link createGatewayFetch}. Built per call so a caller-supplied `options.fetch` is composed
 * *underneath*: it stays the transport that dials, and the rewrite runs first. The spread keeps
 * optional members a pi release may add to the lazy wrapper.
 */
export function withGatewayFetch(
  base: ProviderStreams,
  scheme: string,
  credentials: CredentialSource,
  strip: Iterable<string> = ["authorization", "x-api-key"],
): ProviderStreams {
  const fetchFor = (fetch: FetchFunction | undefined) =>
    createGatewayFetch({ scheme, credentials, strip, ...(fetch ? { baseFetch: fetch } : {}) });
  const wrapped: ProviderStreams = {
    ...base,
    stream: (model, context, options) => base.stream(model, context, { ...options, fetch: fetchFor(options?.fetch) }),
    streamSimple: (model, context, options) =>
      base.streamSimple(model, context, { ...options, fetch: fetchFor(options?.fetch) }),
  };
  const { fetchDeferred, cancelDeferred } = base;
  if (fetchDeferred) {
    wrapped.fetchDeferred = (model, handle, options) => fetchDeferred(model, handle, { ...options, fetch: fetchFor(options?.fetch) });
  }
  if (cancelDeferred) {
    wrapped.cancelDeferred = (model, handle, options) => cancelDeferred(model, handle, { ...options, fetch: fetchFor(options?.fetch) });
  }
  return wrapped;
}

/** Credentials for one gateway, resolved fresh from its config on every call. */
export function credentialSource(config: GatewayConfig, deps: RuntimeDeps = {}): CredentialSource {
  return (scheme) => resolveCredentials(config, deps.env ?? process.env, deps.readText, credentialKind(scheme));
}

/**
 * The `api` map: pi dispatches each model to the entry keyed by its `model.api`. Every transport is
 * wrapped: redirects are refused, and the auth header follows that transport's scheme — native
 * (`x-api-key` for Messages, Bearer for the OpenAI ones) unless the config overrides it.
 */
export function gatewayStreams(config: GatewayConfig, deps: RuntimeDeps = {}): Record<GatewayApi, ProviderStreams> {
  const credentials = credentialSource(config, deps);
  const strip = [...credentialHeaderNames(config.authHeaders)];
  const transport = (api: GatewayApi, base: ProviderStreams) =>
    withGatewayFetch(base, authHeaderFor(config, api), credentials, strip);
  return {
    "anthropic-messages": transport("anthropic-messages", anthropicMessagesApi()),
    "openai-responses": transport("openai-responses", openAIResponsesApi()),
    "openai-completions": transport("openai-completions", openAICompletionsApi()),
  };
}

// --- auth -------------------------------------------------------------------------------------

/**
 * Ambient-only auth: no `login`, because there is nothing interactive to do, and never `oauth`,
 * which makes pi wait for a persisted interactive credential and fails on every fresh machine.
 * pi calls `resolve()` per request, so a token file is re-read every time.
 */
export function gatewayAuth(config: GatewayConfig, deps: RuntimeDeps = {}): ApiKeyAuth {
  const warned = new Set<string>();
  const warnOnce = (message: string) => {
    if (warned.has(message)) return;
    warned.add(message);
    (deps.warn ?? console.warn)(`${LOG_PREFIX} ${config.id}: ${message}`);
  };
  return {
    name: `Inference gateway (${config.id})`,
    async resolve(): Promise<AuthResult | undefined> {
      // Each kind is resolved on its own: an unreadable password file must not hide a working
      // token (or the reverse) — every request only needs one of them.
      const settle = async (kind: CredentialKind) => {
        try {
          return { value: await resolveCredentials(config, deps.env ?? process.env, deps.readText, kind) };
        } catch (error) {
          return { error: error instanceof Error ? error : new Error(String(error)) };
        }
      };
      const [tokenResult, basicResult] = await Promise.all([settle("token"), settle("basic")]);
      const credentials: GatewayCredentials = {
        ...(tokenResult.value?.token ? { token: tokenResult.value.token } : {}),
        ...(basicResult.value?.basic ? { basic: basicResult.value.basic } : {}),
        problems: [...(tokenResult.value?.problems ?? []), ...(basicResult.value?.problems ?? [])],
      };
      for (const problem of credentials.problems) warnOnce(problem);
      if (!credentials.token && !credentials.basic) {
        const failure = tokenResult.error ?? basicResult.error;
        if (failure) throw failure;
        if (config.tokenFile) warnOnce(`token file ${config.tokenFile} is missing or empty`);
        return undefined;
      }
      for (const failure of [tokenResult.error, basicResult.error]) {
        if (failure) warnOnce(`could not read a credential: ${failure.message}`);
      }
      if (!credentials.token && config.tokenFile && !tokenResult.error) warnOnce(`token file ${config.tokenFile} is missing or empty`);
      // pi needs a non-empty apiKey to dispatch a request; the request fetch replaces whatever the
      // SDK makes of it with the configured scheme's header, so with Basic only a placeholder is passed.
      return credentials.token
        ? { auth: { apiKey: credentials.token }, source: config.tokenFile ?? config.apiKeyEnv }
        : { auth: { apiKey: "basic-auth" }, source: config.passwordFile ?? config.passwordEnv };
    },
  };
}

// --- provider ---------------------------------------------------------------------------------

/** `deps.warn` (or console.warn) with this provider's log prefix. */
function providerWarn(config: GatewayConfig, deps: RuntimeDeps): (message: string) => void {
  return (message) => (deps.warn ?? console.warn)(`${LOG_PREFIX} ${config.id}: ${message}`);
}

/**
 * A warn function that prints each distinct message once per process: load-time discovery and
 * every later refresh report the same list findings, and the user needs to read them once.
 */
export function onceWarn(warn: (message: string) => void = console.warn): (message: string) => void {
  const seen = new Set<string>();
  return (message) => {
    if (seen.has(message)) return;
    seen.add(message);
    warn(message);
  };
}

/** The credential discovery's own scheme needs (and only that). */
function discoveryCredentials(config: GatewayConfig, deps: RuntimeDeps): Promise<GatewayCredentials> {
  return resolveCredentials(config, deps.env ?? process.env, deps.readText, credentialKind(authHeaderFor(config, "discovery")));
}

/**
 * What createProvider gets: auth, the transport map and a static model list. No `fetchModels` —
 * {@link createGatewayProvider} owns refresh itself (see there).
 */
export function gatewayProviderOptions(
  config: GatewayConfig,
  models: readonly GatewayModel[],
  deps: RuntimeDeps = {},
): CreateProviderOptions<GatewayApi> {
  return {
    id: config.id,
    name: `Inference gateway (${config.id})`,
    baseUrl: config.baseUrl,
    auth: { apiKey: gatewayAuth(config, deps) },
    models,
    api: gatewayStreams(config, deps),
  };
}

/** `overlay` entries replace same-id `base` entries; the rest are appended. */
function mergeById(base: readonly GatewayModel[], overlay: readonly GatewayModel[]): GatewayModel[] {
  const ids = new Set(overlay.map((model) => model.id));
  return [...base.filter((model) => !ids.has(model.id)), ...overlay];
}

/**
 * pi's provider for one gateway: createProvider for auth and stream dispatch, with the model list
 * owned here.
 *
 * createProvider keeps `models` as an immutable baseline and merges refreshed models *over* it, so a
 * refresh could never remove a startup model, and an empty list could never clear them. Instead
 * this provider answers `getModels()` from its own list, which a successful network refresh
 * replaces outright (and persists through `context.publish`, pi's public refresh contract).
 *
 * The persisted snapshot is restored only while the list is not fresh — after a failed load-time
 * discovery — and always through {@link rebindModels}, so it picks up the current base URL,
 * headers and overrides. After a fresh discovery the snapshot can only be staler, so it is ignored.
 * `pi -p` and `--list-models` refresh offline, so they see the startup list (or the rebound
 * snapshot); interactive sessions also fetch.
 */
export function createGatewayProvider(
  config: GatewayConfig,
  initial: { models: readonly GatewayModel[]; fresh: boolean },
  deps: RuntimeDeps = {},
): Provider<GatewayApi> {
  const inner = createProvider(gatewayProviderOptions(config, [], deps));
  let fresh = initial.fresh;
  let current: readonly GatewayModel[] = initial.models;

  const refreshModels = async (context: RefreshModelsContext): Promise<void> => {
    if (!fresh && context.stored) {
      const keepApi = context.stored.etag === SNAPSHOT_STAMP;
      const restored = mergeById(initial.models, rebindModels(context.stored.models, config, { keepApi }));
      const published = await context.publish({
        update: () => {
          current = restored;
        },
      });
      if (!published) return;
    }
    if (!context.allowNetwork || context.signal.aborted) return;
    const fetched = await discoverModels(config, {
      credentials: await discoveryCredentials(config, deps),
      signal: context.signal,
      warn: providerWarn(config, deps),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    if (context.signal.aborted) return;
    await context.publish({
      // Static headers are config, not catalog: they stay out of pi's models-store file and are
      // rebuilt from the current config on restore (rebindModels).
      persist: {
        models: fetched.map((model) => ({ ...model, headers: undefined })),
        checkedAt: Date.now(),
        etag: SNAPSHOT_STAMP,
      },
      update: () => {
        current = fetched;
        fresh = true;
      },
    });
  };

  return {
    ...inner,
    getModels: () => current,
    getAllModels: () => current,
    refreshModels,
  };
}

/**
 * Whether and how long the extension factory may ask the gateway for models before pi starts.
 * Skipped when pi runs offline: `--offline` sets `PI_OFFLINE=1` before extensions load, and pi's
 * model runtime treats any set `PI_OFFLINE` as offline, so this does too. Skipped as well when
 * `INFERENCE_GATEWAY_DISCOVERY_TIMEOUT_MS=0`; a positive value replaces the 5 s default. A skipped
 * discovery is silent: fallbacks now, pi's saved snapshot on its offline refresh.
 */
export function factoryDiscovery(env: Record<string, string | undefined>): { skip: boolean; timeoutMs: number; warnings: string[] } {
  const warnings: string[] = [];
  let timeoutMs: number = FACTORY_DISCOVERY_TIMEOUT_MS;
  const raw = env[ENV.discoveryTimeoutMs]?.trim();
  if (raw) {
    const value = /^\d{1,7}$/.test(raw) ? Number(raw) : Number.NaN;
    if (Number.isSafeInteger(value)) timeoutMs = value;
    else warnings.push(`${ENV.discoveryTimeoutMs}: must be a whole number of milliseconds (0 skips load-time discovery); using ${FACTORY_DISCOVERY_TIMEOUT_MS}`);
  }
  return { skip: env.PI_OFFLINE !== undefined || timeoutMs === 0, timeoutMs, warnings };
}

/** Discover at load time; on failure fall back to config `fallbackModels` (pi adds its snapshot). */
export async function initialModels(
  config: GatewayConfig,
  deps: RuntimeDeps = {},
  timeoutMs: number = FACTORY_DISCOVERY_TIMEOUT_MS,
): Promise<{ models: GatewayModel[]; fresh: boolean }> {
  try {
    const credentials = await discoveryCredentials(config, deps);
    const models = await discoverModels(config, {
      credentials,
      timeoutMs,
      warn: providerWarn(config, deps),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    return { models, fresh: true };
  } catch (error) {
    const models = fallbackModels(config);
    (deps.warn ?? console.warn)(
      `${LOG_PREFIX} ${config.id}: model discovery failed (${error instanceof Error ? error.message : String(error)}); ` +
        `using ${models.length} fallback model(s) plus pi's last saved list`,
    );
    return { models, fresh: false };
  }
}

// --- registration -----------------------------------------------------------------------------

/**
 * What the extension asks of pi. `ExtensionAPI.registerProvider` is overloaded, and an overloaded
 * method is not satisfiable by a test double without a cast, so this single-signature view is the
 * seam; the default export still passes a real `ExtensionAPI`, which keeps the two in step.
 */
export interface ProviderRegistry {
  registerProvider(provider: Provider<GatewayApi>): void;
}

/**
 * Load config, discover each gateway's models in parallel, register one provider per gateway.
 * Returns the registered provider ids; empty and silent when nothing is configured.
 */
export async function registerGateways(
  pi: ProviderRegistry,
  input: RuntimeDeps & Pick<LoadConfigDeps, "home"> = {},
): Promise<string[]> {
  const warn = onceWarn(input.warn);
  const deps = { ...input, warn };
  const { providers, warnings } = await loadConfig({
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.home ? { home: deps.home } : {}),
    ...(deps.readText ? { readText: deps.readText } : {}),
  });
  for (const warning of warnings) warn(`${LOG_PREFIX} ${warning}`);
  if (providers.length === 0) return [];
  const discovery = factoryDiscovery(deps.env ?? process.env);
  for (const warning of discovery.warnings) warn(`${LOG_PREFIX} ${warning}`);
  const initial = await Promise.all(
    providers.map((config) =>
      discovery.skip ? { models: fallbackModels(config), fresh: false } : initialModels(config, deps, discovery.timeoutMs),
    ),
  );
  providers.forEach((config, index) => {
    pi.registerProvider(createGatewayProvider(config, initial[index], deps));
  });
  return providers.map((config) => config.id);
}
