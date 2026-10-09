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
import { loadConfig, resolveToken, type GatewayApi, type GatewayConfig, type LoadConfigDeps } from "./config.ts";
import { discoverModels, fallbackModels, type GatewayModel } from "./discovery.ts";

export const LOG_PREFIX = "[pi-inference-gateway]";

/**
 * Discovery at extension load is bounded tighter than an interactive refresh: pi awaits the
 * factory before it starts, so a dead gateway must not stall every `pi -p` for long.
 */
export const FACTORY_DISCOVERY_TIMEOUT_MS = 5_000;

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
 * The `fetch` every inference request goes through. Two jobs:
 *
 * 1. **Never follow a redirect** (`redirect: "error"`). Fetch strips only `authorization` on a
 *    cross-origin redirect, so following one would hand `x-api-key` (or any custom credential
 *    header) to whatever host the gateway redirects to. pi's SDK clients use the default `"follow"`,
 *    and pi exposes no per-request redirect option, so the only hook is `options.fetch` — which is
 *    why every transport is wrapped, not just the ones with a header override.
 * 2. **Optionally move the token** to the configured header (`authorization` means
 *    `Bearer <token>`, anything else carries the raw token), removing both native auth headers
 *    first so exactly one leaves. Only when the config overrides that transport's header.
 *
 * `baseFetch` is resolved per call, not captured: `globalThis.fetch` is routinely replaced after
 * module load (proxy agents, test doubles, pi's own instrumentation).
 */
export function createGatewayFetch({
  authHeader,
  token,
  baseFetch,
}: {
  authHeader?: string;
  token: string | undefined;
  baseFetch?: FetchFunction;
}): FetchFunction {
  return async (input, init) => {
    const transport = baseFetch ?? globalThis.fetch;
    if (authHeader === undefined || !token) return transport(input, { ...init, redirect: "error" });
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.delete("authorization");
    headers.delete("x-api-key");
    headers.set(authHeader, authHeader === "authorization" ? `Bearer ${token}` : token);
    return transport(input, { ...init, headers, redirect: "error" });
  };
}

/**
 * One of pi's transports with every request — streaming and deferred — routed through
 * {@link createGatewayFetch}. Built per call so a caller-supplied `options.fetch` is composed
 * *underneath*: it stays the transport that dials, and the rewrite runs first. The spread keeps
 * optional members a pi release may add to the lazy wrapper.
 */
export function withGatewayFetch(base: ProviderStreams, authHeader: string | undefined): ProviderStreams {
  const fetchFor = (apiKey: string | undefined, fetch: FetchFunction | undefined) =>
    createGatewayFetch({ ...(authHeader !== undefined ? { authHeader } : {}), token: apiKey, ...(fetch ? { baseFetch: fetch } : {}) });
  const wrapped: ProviderStreams = {
    ...base,
    stream: (model, context, options) =>
      base.stream(model, context, { ...options, fetch: fetchFor(options?.apiKey, options?.fetch) }),
    streamSimple: (model, context, options) =>
      base.streamSimple(model, context, { ...options, fetch: fetchFor(options?.apiKey, options?.fetch) }),
  };
  const { fetchDeferred, cancelDeferred } = base;
  if (fetchDeferred) {
    wrapped.fetchDeferred = (model, handle, options) =>
      fetchDeferred(model, handle, { ...options, fetch: fetchFor(options?.apiKey, options?.fetch) });
  }
  if (cancelDeferred) {
    wrapped.cancelDeferred = (model, handle, options) =>
      cancelDeferred(model, handle, { ...options, fetch: fetchFor(options?.apiKey, options?.fetch) });
  }
  return wrapped;
}

/**
 * The `api` map: pi dispatches each model to the entry keyed by its `model.api`. Every transport is
 * wrapped (redirects are always refused); each keeps its native auth header (`x-api-key` for
 * Messages, Bearer for the OpenAI ones) unless the config overrides that transport's header.
 */
export function gatewayStreams(config: Pick<GatewayConfig, "authHeaders">): Record<GatewayApi, ProviderStreams> {
  const transport = (api: GatewayApi, base: ProviderStreams) => withGatewayFetch(base, config.authHeaders[api]);
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
  let warnedMissing = false;
  return {
    name: `Inference gateway (${config.id})`,
    async resolve(): Promise<AuthResult | undefined> {
      const token = await resolveToken(config, deps.env ?? process.env, deps.readText);
      if (!token) {
        if (config.tokenFile && !warnedMissing) {
          warnedMissing = true;
          (deps.warn ?? console.warn)(`${LOG_PREFIX} ${config.id}: token file ${config.tokenFile} is missing or empty`);
        }
        return undefined;
      }
      return { auth: { apiKey: token }, source: config.tokenFile ?? config.apiKeyEnv };
    },
  };
}

// --- provider ---------------------------------------------------------------------------------

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
    // Interactive and RPC sessions refresh from the network; `-p` and `--list-models` never do
    // (they refresh with allowNetwork: false), which is why discovery also runs in the factory.
    fetchModels: async (context: RefreshModelsContext) =>
      discoverModels(config, {
        token: await resolveToken(config, deps.env ?? process.env, deps.readText),
        signal: context.signal,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      }),
    api: gatewayStreams(config),
  };
}

/**
 * pi's provider for one gateway.
 *
 * `fresh` says the static `models` came from a discovery that just succeeded. createProvider
 * restores pi's persisted snapshot over the static list on every refresh — including offline ones —
 * replacing same-id entries and re-adding models the gateway has since dropped. With a fresh list
 * that snapshot can only be staler, so it is withheld; after a failed discovery it is exactly the
 * fallback we want, so it is left alone.
 */
export function createGatewayProvider(
  config: GatewayConfig,
  initial: { models: readonly GatewayModel[]; fresh: boolean },
  deps: RuntimeDeps = {},
): Provider<GatewayApi> {
  const provider = createProvider(gatewayProviderOptions(config, initial.models, deps));
  const refresh = provider.refreshModels;
  if (!initial.fresh || !refresh) return provider;
  return {
    ...provider,
    refreshModels: (context: RefreshModelsContext) =>
      refresh({
        publish: (publication) => context.publish(publication),
        allowNetwork: context.allowNetwork,
        signal: context.signal,
        ...(context.force !== undefined ? { force: context.force } : {}),
        ...(context.credential !== undefined ? { credential: context.credential } : {}),
      }),
  };
}

/** Discover at load time; on failure fall back to config `fallbackModels` (pi adds its snapshot). */
export async function initialModels(
  config: GatewayConfig,
  deps: RuntimeDeps = {},
  timeoutMs: number = FACTORY_DISCOVERY_TIMEOUT_MS,
): Promise<{ models: GatewayModel[]; fresh: boolean }> {
  try {
    const token = await resolveToken(config, deps.env ?? process.env, deps.readText);
    const models = await discoverModels(config, {
      token,
      timeoutMs,
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
  deps: RuntimeDeps & Pick<LoadConfigDeps, "home"> = {},
): Promise<string[]> {
  const warn = deps.warn ?? console.warn;
  const { providers, warnings } = await loadConfig({
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.home ? { home: deps.home } : {}),
    ...(deps.readText ? { readText: deps.readText } : {}),
  });
  for (const warning of warnings) warn(`${LOG_PREFIX} ${warning}`);
  const initial = await Promise.all(providers.map((config) => initialModels(config, deps)));
  providers.forEach((config, index) => {
    pi.registerProvider(createGatewayProvider(config, initial[index], deps));
  });
  return providers.map((config) => config.id);
}
