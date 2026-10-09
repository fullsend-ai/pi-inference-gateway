# pi-inference-gateway — implementation plan

Target repo: `fullsend-ai/pi-inference-gateway` (public; not created yet — local only until the user OKs it).
Package: `@fullsend-ai/pi-inference-gateway`. Sibling of `fullsend-ai/pi-anthropic-vertex` and
`fullsend-ai/pi-xai-vertex`; same layout, CI matrix, release flow and rules.

## Goal

One pi provider extension for any vendor-neutral inference gateway (LiteLLM, agentgateway, Bifrost,
Portkey, NewAPI, Cloudflare/Vercel AI Gateway, an in-house proxy …) that:

1. discovers its models from `GET {baseUrl}/v1/models` (OpenAI list shape `{data:[{id,…}]}`, also
   `{models:[…]}` and a bare array);
2. routes **each model** to the right pi transport — `anthropic-messages` (`/v1/messages`),
   `openai-responses` (`/v1/responses`) or `openai-completions` (`/v1/chat/completions`) — from a
   single provider entry;
3. fills model metadata (context window, max output, reasoning, image input, cost) from the
   gateway's own fields first, then pi's **built-in catalog** (no third-party catalog fetch);
4. never re-implements a protocol: pi's own lazy transports from `@earendil-works/pi-ai/compat`
   do the streaming.

Non-goals (v0.1): OAuth/`/login` flows, image/embedding models, Ollama native API, Gemini API,
quota/cost dashboards, model routing/fallback across gateways.

## Name

`pi-inference-gateway` — neutral (no product name), says what it talks to, free on npm, and the
`pi-<thing>` form matches the siblings. Default provider id `gateway`, so a model spec reads
`gateway/claude-sonnet-5` or `gateway/gpt-6-luna`.

## Configuration

Two sources, env first so a sandbox needs no file (fullsend runtime is env-driven):

| Env | Meaning |
|---|---|
| `INFERENCE_GATEWAY_BASE_URL` | Gateway root, with or without trailing `/v1`. Unset ⇒ env provider disabled. |
| `INFERENCE_GATEWAY_API_KEY` | Static bearer token. |
| `INFERENCE_GATEWAY_TOKEN_FILE` | Path re-read on each request (rotating OIDC/WIF tokens). Wins over `API_KEY`. |
| `INFERENCE_GATEWAY_PROVIDER_ID` | Provider id, default `gateway`. |
| `INFERENCE_GATEWAY_DEFAULT_API` | Fallback transport, default `openai-responses`. |

Optional file `~/.pi/agent/inference-gateway.json` (honours `PI_CODING_AGENT_DIR`) for several
gateways or per-model overrides:

```json
{
  "providers": {
    "gateway": {
      "baseUrl": "https://gw.example.com",
      "apiKeyEnv": "GW_KEY",            // or "tokenFile": "~/.config/gw/token"; never a literal key in examples
      "authHeader": "authorization",    // superseded: per-API native default, see "Live gateway findings"
      "defaultApi": "openai-responses",
      "headers": { "x-team": "fullsend" },
      "modelsPath": "/v1/models",
      "include": ["claude-*", "gpt-*"], "exclude": ["*embed*"],
      "models": { "claude-sonnet-5": { "api": "anthropic-messages", "contextWindow": 1000000 } }
    }
  }
}
```

No `!command` keys, no shell-out (sibling rule). No literal secrets in docs/tests.

## Per-model API selection (first match wins)

> Superseded in part by "Live gateway findings (2026-10-09)" below (ambiguous owners, catalog
> mapping, `claude-` rule, config-added models).

1. Config `models[id].api`.
2. Gateway hint on the model object: `api`, `endpoint`/`inference_endpoint`, or
   `supported_endpoints`/`endpoints` containing `/v1/messages` | `/v1/responses` | `/v1/chat/completions`
   (prefer messages for Anthropic owners, else responses, else chat).
3. Owner: `owned_by` / `provider` / `litellm_provider` ∈ {anthropic, vertex_ai-anthropic…} ⇒
   `anthropic-messages`; `openai`/`azure` ⇒ `openai-responses`.
4. pi built-in catalog: same id (or id after stripping a `vendor/` prefix) found under pi's
   `anthropic` provider ⇒ `anthropic-messages`; under `openai` ⇒ `openai-responses`.
5. `defaultApi`.

Base URL per transport is derived from one `baseUrl`: OpenAI transports get `…/v1`, Anthropic gets
the root (its SDK appends `/v1/messages`).

## Metadata resolution (per field, first defined wins)

config override → gateway fields (`context_window`, `context_length`, `max_input_tokens`,
`max_output_tokens`, `max_tokens`, `supports_reasoning`, `supports_vision`, `input_modalities`,
LiteLLM-style `input_cost_per_token`…) → pi built-in model with the same id (copy
`contextWindow`, `maxTokens`, `reasoning`, `thinkingLevelMap`, `input`, `cost`, `compat`) →
safe defaults (128k / 16k, text only, no reasoning, zero cost).

Sanitise everything from the wire: id length ≤ 256, no control chars, positive bounded integers,
cap list at 1000 models, response body ≤ 1 MiB, 10 s timeout, `redirect: "error"`.

## Spike findings (2026-10-09)

- fullsend sandbox pins **pi 0.99.2** (fullsend main `images/sandbox/Containerfile`); latest is 1.1.0
  (local dev pi is 1.0.2). Sibling repo's 0.87.1 matrix is stale. Target peers `>=0.99.2`, CI
  matrix `["0.99.2", "1.1.0"]`.
- `CreateProviderOptions` is identical on 0.99.2 and 1.1.0: `api` may be a **map keyed by
  `model.api`** (mixed-API provider in one registration), `models` = static baseline,
  `fetchModels(ctx)` = dynamic overlay that createProvider restores/persists itself.
- Transport factories on `@earendil-works/pi-ai/compat`: `anthropicMessagesApi`,
  `openAIResponsesApi`, `openAICompletionsApi` (note the casing).
- pi only refreshes catalogs **from the network** in interactive (after TUI start) and RPC modes;
  `--list-models` and `-p` refresh with `allowNetwork: false` (cache only). fullsend runs `pi -p`, so
  relying on `fetchModels` alone leaves a fresh sandbox with **no models**. Therefore: do discovery
  inside the async extension factory (pi awaits async factories before startup) with a short
  timeout, pass the result as static `models`, and keep `fetchModels` for interactive refreshes.
  On factory-time failure fall back to the last persisted snapshot, then to config `fallbackModels`.
- `auth.apiKey` = `ApiKeyAuth { name, resolve({ctx, credential, signal}) → AuthResult | undefined,
  check? }`; no `login` ⇒ ambient-only. A spike with an ill-typed auth was silently skipped — type
  it properly, never `as any`.
- (Superseded by "Live gateway findings": native header per API, swap only on override.)
  pi's Anthropic transport sends `x-api-key`; a Bearer-only gateway would 401 Claude while GPT
  works. Inject a `fetch`/header transform for `anthropic-messages` models that moves the token to
  `authorization: Bearer` when `authHeader` is `authorization` (pattern: sibling
  `createVertexFetch`). Unit-test it explicitly.
- `vendor/model` ids from the gateway are sent back **verbatim**; only the pi-catalog lookup strips
  the prefix.

## Live gateway findings (2026-10-09)

A probe of a real deployment — a path-routing front proxy — changed five design points. What it
showed: `GET /v1/models` returns the OpenAI shape with `owned_by: "vertex"` on every model and no
other metadata (Claude and Gemini ids). The proxy picks the backend from the request path:
`/v1/messages` serves Claude and accepts **only** `x-api-key` (Bearer is a 401); `/v1/responses`
serves GPT / o-series ids that are **not listed**; `/v1/chat/completions` serves Gemini (tool calls
carry `message.extra_content.google.thought_signature`); Claude is a 404 on the other two paths. A
vendor-prefixed open-weight id (`vendor/org/glm-5-3` style) works on all three paths but is unlisted.

1. **Auth header: native per API.** `anthropic-messages` sends `x-api-key`, the OpenAI transports
   `authorization: Bearer`, discovery Bearer. `authHeader` is now an optional override — one header
   name for every target, or an object keyed by `anthropic-messages` / `openai-responses` /
   `openai-completions` / `discovery` — and `INFERENCE_GATEWAY_AUTH_HEADER` (`x-api-key`, or
   `anthropic-messages=authorization,discovery=x-api-key`). A transport is wrapped with the header
   rewrite only when its header is overridden. (Was: Bearer for all, swap on Messages.)
2. **Ambiguous owners are no signal**: `vertex`, `vertex_ai`, `bedrock`, `bedrock_converse`,
   `azure_ai`, `openrouter`, `system`, `library`, empty. `azure` (Azure OpenAI) still means
   responses.
3. **Catalog mapping**: a pi built-in hit under `anthropic` → messages, under `openai` → responses,
   under **any other provider** → chat completions (never a native API such as
   google-generative-ai). Lookups try the id, the id without its `vendor/` prefix, and both with
   `-`↔`.` swapped between digits (`glm-5-3` ↔ `glm-5.3`). Requests always send the gateway's id.
4. **`claude-` id fallback** → messages (also after a `vendor/` prefix). Implementation note: it runs
   *between* the anthropic/openai catalog step and the other-provider step, not after the whole
   catalog step. pi's aggregator catalogs (`github-copilot`, `opencode`, `openrouter`,
   `vercel-ai-gateway`, ...) list Claude ids too, so a Claude id missing from pi's `anthropic`
   catalog would otherwise go to chat completions — a 404 on this proxy. A unit test pins it.
5. **Config-added models**: a config `models[id]` entry with an `api` adds a model the gateway does
   not list (metadata: the entry, then pi's catalog, then defaults), regardless of include/exclude;
   without an `api` it only overrides a listed model. Env form:
   `INFERENCE_GATEWAY_EXTRA_MODELS=gpt-6-luna=openai-responses,vendor/org/glm-5-3=openai-completions`.
   Config-added models are also offered when discovery fails.

Resulting selection order (revised 2026-10-09 for agentgateway, see "agentgateway support"):
config `api` → gateway `api`/endpoint hints → pi catalog under `anthropic`/`openai` → `claude-` id →
non-ambiguous owner → pi catalog under any other provider (chat completions) → `defaultApi`.

Open phase-5 risks recorded from the probe (no workaround yet): pi's openai-completions transport
neither reads nor replays Gemini's `extra_content.google.thought_signature` (no occurrence in pi-ai
0.99.2 or 1.1.0), so multi-turn Gemini tool calls through `/v1/chat/completions` may be rejected.

## Implementation notes (phases 1–4)

Decisions made while implementing, beyond the text above:

- **compat** and **thinkingLevelMap** are copied from a pi catalog entry only when it uses the same
  transport as the selected one, and `allowedFallbackModels` is never copied: pi turns it into a
  `fallbacks` body field that non-Anthropic Claude hosts reject with a 400 (seen in the
  pi-anthropic-vertex sibling).
- **Stale snapshot**: createProvider restores pi's persisted snapshot over the static `models` on
  every refresh, including offline ones. After a *successful* load-time discovery the provider
  withholds that snapshot, so models the gateway dropped do not reappear; after a failed one it is
  restored as the fallback.
- **Discovery timeouts**: 5 s inside the extension factory (pi awaits it before every `-p` run),
  10 s for interactive refreshes. A `/gateway-refresh` command forces a network refresh.
- **fallbackModels** use the same entry shapes as the gateway list (`"id"` or `{ id, owned_by, ... }`).
- **Config/env merge**: a file provider with the env provider's id is merged; the env supplies the
  base URL, credentials and default API, and auth-header overrides and models merge per key.
- **Metadata cost**: per sub-field (`input`, `output`, `cacheRead`, `cacheWrite`); catalog pricing
  tiers are kept only when no rate came from the config or the gateway.

## Review fixes (2026-10-09)

A code review found eight issues; each was reproduced with a failing test first
(`src/regressions.test.ts`) and fixed:

1. Inference requests followed redirects, and fetch strips only `authorization` cross-origin, so
   `x-api-key` could reach a redirect target. Every transport is now wrapped and forces
   `redirect: "error"` (pi exposes no other hook than `options.fetch`).
2. After a failed startup discovery pi's snapshot was restored with its *old* base URL and headers.
   Restored models are now rebuilt against the current config (`rebindModels`).
3. createProvider's static baseline could not shrink: a refresh could not remove startup models.
   `createGatewayProvider` now owns the list (`getModels()` returns it; a successful refresh
   replaces it and persists it through `context.publish`). Verified through pi's real `createModels`.
4. release.yml hashed partial/empty downloads and carried on after the last retry. Fixed.
5. Config model ids skipped validation; now the shared `isValidModelId` rule.
6. An explicit `INFERENCE_GATEWAY_DEFAULT_API=openai-responses` could not override the file.
7. README documents the Gemini `thought_signature` limitation.
8. A `__proto__` model id corrupted config dicts, and `constructor` picked up an inherited
   override. Dicts are built with `Object.fromEntries`; lookups are own-property only.

Plus the follow-up from phase 4: `models[id].compat` merges over the inherited catalog compat, and
`"compat": null` drops it.

## Praxis support (2026-10-09)

Praxis (github.com/praxis-proxy/praxis, AI gateway in `praxis-proxy/ai`, Apache-2.0) is the main
target gateway. Facts from its docs that shaped the design:

- Client auth is per deployment. The documented setups use `Authorization: Basic
  base64(<user>:<password>)` (default user `gateway`); Praxis injects the backend token itself.
  The deployment probed earlier wants `x-api-key` on `/v1/messages` and Bearer elsewhere.
- `GET /v1/models` is passed through to one backend without merging: the list is partial by design,
  so config-added models are a core feature, not a workaround.
- Its documented clients are each pinned to one API (Codex → Responses, Claude Code → Messages,
  OpenCode → Chat Completions); there is no pi integration. Its OpenCode plugin attaches credentials
  only when the configured base URL equals `PRAXIS_BASE_URL`.

What changed:

1. **Auth schemes per target** (`anthropic-messages`, `openai-responses`, `openai-completions`,
   `discovery`): `bearer` (alias `authorization`), `x-api-key` / any header name (raw token), and
   `basic`. Defaults stay native per transport. Basic: username from `INFERENCE_GATEWAY_BASIC_USER`
   / `usernameEnv` / `username` (default `gateway`, `:` rejected); password from
   `INFERENCE_GATEWAY_BASIC_PASSWORD` / `passwordEnv`, or `INFERENCE_GATEWAY_BASIC_PASSWORD_FILE` /
   `passwordFile` (re-read per request). Literal passwords are refused; credentials are never logged.
   Every request's header now comes from the configured credentials for its scheme; pi's `apiKey`
   (a placeholder under Basic) never reaches the wire.
2. **Trusted-URL binding**: credentials from `INFERENCE_GATEWAY_*` variables attach only to the
   provider whose base URL equals `INFERENCE_GATEWAY_BASE_URL` (normalised; trailing slash and `/v1`
   ignored). A file provider naming one of them for another URL is refused with a warning and
   never registered. Only the user-level config file is read, never a project `.pi/`.
3. **Mock**: `--auth basic` requires `Basic gateway:test-pass` on every path and on `/v1/models`;
   the default `--auth live` keeps the per-path x-api-key/Bearer behaviour.
4. **README**: a Praxis walkthrough (both auth setups, why `/v1/models` is partial and how to add
   models, `INFERENCE_GATEWAY_PROVIDER_ID=praxis`, known limits) and a Security section. The package
   name and default provider id stay generic.

## pi integration

- `createProvider()` from `@earendil-works/pi-ai` with `auth.apiKey` (ambient, **no** `login`,
  never `oauth`); `resolve()` returns the token (file re-read each call) or reports unconfigured.
- Dynamic provider: `getModels()` returns the last list; `refreshModels(ctx)` restores
  `ctx.stored`, fetches when `ctx.allowNetwork`, publishes `{ persist, update }` so startup works
  offline from the last snapshot, keeps the old list on failure, honours `ctx.signal`.
- Streams: dispatch on `model.api` to `anthropicMessagesApi()`, `openaiResponsesApi()`,
  `openaiCompletionsApi()` from `/compat` (check the exact names in the installed `.d.ts`).
- Import only allowlisted specifiers; `import type` for `ExtensionAPI`; erasable TS only; no `any`,
  no casts at `createProvider()`; zero runtime dependencies.
- Command `/gateway-refresh` (force refresh) if the ExtensionAPI exposes a refresh hook; otherwise
  rely on pi's own refresh.

## Layout (mirrors pi-anthropic-vertex)

```
package.json  tsconfig.json  .gitignore  LICENSE (MIT)  README.md  CONTRIBUTING.md  AGENTS.md  CLAUDE.md
src/config.ts      env + file parsing, validation
src/discovery.ts   fetch /v1/models, parse + sanitise, metadata merge, API selection
src/provider.ts    createProvider wiring, auth, refresh/publish, stream dispatch
src/index.ts       thin default export
src/*.test.ts      node --test, no network (stub fetch), no pi process
.github/workflows/ci.yml       matrix pi 0.99.2 + 1.1.0, stable `ci` aggregate job
.github/workflows/release.yml  tag → GitHub release with tarball sha256 (copy sibling)
```

## Phases

1. **Scaffold** — repo files, package.json (peers `>=0.99.2`), tsconfig, CI copied from sibling.
2. **Config + discovery** — pure functions + unit tests (shapes: OpenAI, LiteLLM, agentgateway,
   bare array; auth headers; redirects/oversize/timeouts rejected).
3. **Provider** — createProvider, auth resolve, refresh/publish/persist, stream dispatch; tests
   with a stub fetch asserting each transport hits the right URL with the right auth header.
4. **Local end-to-end** — tiny local mock gateway (node http) serving `/v1/models`,
   `/v1/messages`, `/v1/responses` SSE; `pi -ne -e . --list-models` and one `pi -p` per API on
   pi 0.99.2 and 1.x.
5. **Live gateway** — user-provided instance: list models, one prompt per transport, tool call,
   thinking. Record results (no host names or tokens in the repo).
6. **Publish** — on user OK: create `fullsend-ai/pi-inference-gateway`, push, tag `v0.1.0`.
