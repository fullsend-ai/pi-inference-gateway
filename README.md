# @fullsend-ai/pi-inference-gateway

Any vendor-neutral **inference gateway** — [Praxis](#praxis), LiteLLM, agentgateway, Bifrost,
Portkey, an in-house proxy — as one [pi](https://github.com/earendil-works/pi) provider.

It asks the gateway which models it serves (`GET /v1/models`), then sends **each model** over the
protocol it needs: Claude over Anthropic Messages (`/v1/messages`), GPT over OpenAI Responses
(`/v1/responses`), everything else over Chat Completions (`/v1/chat/completions`). One provider,
`gateway` by default, so a model spec reads `gateway/claude-sonnet-5` or `gateway/gpt-6-luna`.

Streaming, tool calls and thinking are pi's own transports; this extension only decides which one a
model uses and which header carries your token. No runtime dependencies.

## 1. Install

```bash
pi install git:github.com/fullsend-ai/pi-inference-gateway
```

## 2. Configure

Two environment variables are enough:

```bash
export INFERENCE_GATEWAY_BASE_URL=https://gateway.example.com   # with or without a trailing /v1
export INFERENCE_GATEWAY_API_KEY=...                             # your gateway key
```

| Variable | Meaning | Default |
|---|---|---|
| `INFERENCE_GATEWAY_BASE_URL` | Gateway root. Unset (and no config file) ⇒ the extension does nothing and prints nothing. | — |
| `INFERENCE_GATEWAY_API_KEY` | Static key. | — |
| `INFERENCE_GATEWAY_TOKEN_FILE` | File holding the token, **re-read on every request** (rotating OIDC/WIF tokens). Wins over `API_KEY`. | — |
| `INFERENCE_GATEWAY_PROVIDER_ID` | Provider id, i.e. the part before `/` in a model spec. | `gateway` |
| `INFERENCE_GATEWAY_DEFAULT_API` | Transport for models nothing else identifies: `openai-responses`, `openai-completions` or `anthropic-messages`. See [Which API to pick](#which-api-to-pick). | `openai-responses` |
| `INFERENCE_GATEWAY_AUTH_HEADER` | Override the auth header — see [Auth headers](#auth). | native per API |
| `INFERENCE_GATEWAY_BASIC_USER` | Basic-auth username — see [Auth](#auth). | `gateway` |
| `INFERENCE_GATEWAY_BASIC_PASSWORD` / `_PASSWORD_FILE` | Basic-auth password, or a file holding it (re-read per request). | — |
| `INFERENCE_GATEWAY_EXTRA_MODELS` | Models the gateway serves but does not list: `id=api,id=api`. | — |
| `INFERENCE_GATEWAY_DISCOVERY_TIMEOUT_MS` | How long pi's startup waits for the model list; `0` skips it (see [When the model list changes](#when-the-model-list-changes)). | `5000` |
| `INFERENCE_GATEWAY_SESSION_AFFINITY` | `1` sends a hashed session id for gateway affinity and caching (see [Session affinity](#session-affinity)). | off |

No `pi login`: auth is ambient. Without a key or token file the gateway's models are registered but
not offered.

## 3. Check that it loaded

A pi extension that fails to load is dropped **silently**, so list the models first. Against the
mock gateway in this repo (see [Try it locally](#try-it-locally)), with one extra model added in the
config file shown in [Config file](#config-file), pi 1.0.2:

```console
$ pi --list-models | grep -E '^(provider|gateway)'
provider  model                     context  max-out  thinking  images
gateway   claude-sonnet-5           1M       128K     yes       yes
gateway   gemini-3.5-flash          1.0M     65.5K    yes       yes
gateway   gpt-6-luna                272K     128K     yes       yes
gateway   oss/zai-org/glm-5-3       1M       131.1K   yes       no
```

That gateway lists only `claude-sonnet-5` and `gemini-3.5-flash`, both as `owned_by: "vertex"` with
no other metadata. The context windows and thinking support come from pi's own built-in catalog;
`gpt-6-luna` and `oss/zai-org/glm-5-3` come from the config file.

## 4. Run it

```console
$ pi --no-session -p --model gateway/claude-sonnet-5 "say hi"
hi from /v1/messages as claude-sonnet-5
$ pi --no-session -p --model gateway/gemini-3.5-flash "say hi"
hi from /v1/chat/completions as gemini-3.5-flash
$ pi --no-session -p --model gateway/gpt-6-luna "say hi"
hi from /v1/responses as gpt-6-luna
```

(The mock answers with the path and model it saw, so you can tell which transport each model used.)

**Use the fully qualified `gateway/<model>` in scripts.** A bare `claude-sonnet-5` resolves to pi's
built-in `anthropic` provider, which wants its own key.

## Config file

For several gateways, per-model overrides or models the gateway does not list, add
`~/.pi/agent/inference-gateway.json` (or `$PI_CODING_AGENT_DIR/inference-gateway.json`):

```json
{
  "providers": {
    "gateway": {
      "baseUrl": "https://gateway.example.com",
      "apiKeyEnv": "GATEWAY_KEY",
      "headers": { "x-team": "platform" },
      "include": ["claude-*", "gemini-*", "gpt-*"],
      "exclude": ["*embed*"],
      "models": {
        "gpt-6-luna": { "api": "openai-responses" },
        "oss/zai-org/glm-5-3": { "api": "openai-completions" },
        "claude-sonnet-5": { "contextWindow": 200000 }
      },
      "fallbackModels": ["claude-sonnet-5"]
    }
  }
}
```

| Key | Meaning |
|---|---|
| `baseUrl` | Gateway root (required). |
| `apiKeyEnv` / `tokenFile` | *Name* of the variable holding the key, or a path (`~/` allowed) re-read per request. A literal `apiKey`, or an `authorization`/`x-api-key` entry in `headers`, is refused. |
| `username` / `usernameEnv`, `passwordEnv` / `passwordFile` | Basic-auth credentials (a literal `password` is refused). |
| `authHeader` | See [Auth headers](#auth). |
| `defaultApi` | As `INFERENCE_GATEWAY_DEFAULT_API`; see [Which API to pick](#which-api-to-pick). |
| `headers` | Extra headers on every request, discovery included. A header named like an auth header (`authorization`, `x-api-key`, or any header used in `authHeader`) is refused: credentials only come from the configured key, token or password. |
| `modelsPath` | Model-list path, default `/v1/models`. |
| `include` / `exclude` | `*` globs over listed model ids. |
| `models` | Per-id overrides: `api`, `name`, `contextWindow`, `maxTokens`, `reasoning`, `input` (`["text","image"]`), `cost` (USD per million tokens), `compat` (see [Request features (`compat`)](#request-features-compat)), `thinkingLevelMap` (what each thinking level is sent as, see [Thinking levels](#thinking-levels-thinkinglevelmap)). **An entry with an `api` whose id the gateway does not list adds that model.** |
| `fallbackModels` | Offered when discovery fails: ids or `{ "id": ..., "owned_by": ... }` objects. |
| `sessionAffinity` | `true` as `INFERENCE_GATEWAY_SESSION_AFFINITY=1`. |

When `INFERENCE_GATEWAY_BASE_URL` is also set, it configures the provider with the same id
(`gateway` by default): the environment supplies the base URL, key and default API; the file adds the
rest. No `!command` keys and no shell-out, by design.

## How each model gets its API

First match wins:

1. Config `models[id].api`.
2. A hint from the gateway: an `api` field, or `endpoint` / `supported_endpoints` naming
   `/v1/messages`, `/v1/responses` or `/v1/chat/completions`.
3. pi's built-in catalog has the id under `anthropic` → Messages, under `openai` → Responses.
4. The id starts with `claude-` (also after a `vendor/` prefix) → Messages.
5. The owner (`owned_by`, `provider`, `litellm_provider`): anything Anthropic → Messages;
   `openai`, `azure` → Responses. Hosting and aggregator owners (`vertex`, `bedrock`, `azure_ai`,
   `openrouter`, `system`, `library`) say nothing about the protocol and are skipped.
6. pi's built-in catalog has the id under any other provider (Google, xAI, Z.ai, ...) → Chat
   Completions.
7. `defaultApi`.

The model's own id (3, 4) comes before the owner (5) because some gateways report one owner for
everything: [agentgateway](#agentgateway) lists every model, Claude included, as
`owned_by: "openai"`.

Catalog lookups also try the id without a `vendor/` prefix and with `-`/`.` swapped between digits,
so `oss/zai-org/glm-5-3` finds pi's `glm-5.3`. The gateway's id is always what is sent back.

Model metadata (context window, max output, reasoning, image input, cost) comes from the config,
then the gateway's own fields (`context_window`, `max_input_tokens`, `max_output_tokens`,
`supports_vision`, `supports_reasoning`, LiteLLM-style `input_cost_per_token`, ...), then pi's
built-in catalog, then defaults (128K context, 16K output, text only, no reasoning, zero cost).

### Which API to pick

The rules above pick an API that works. The table below is the one each vendor recommends for its
model family. When the rules pick a different API, set `models[id].api`:

| Model family | API | Why |
|---|---|---|
| GPT and other OpenAI reasoning models | `openai-responses` | OpenAI reports better results and cache use on Responses than on Chat Completions, and from GPT-5.4 on, Chat Completions has no tool calls with a `reasoning_effort` other than `none` ([Migrate to Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses)). |
| Claude | `anthropic-messages` | Its native API. |
| GLM (Z.ai) | `openai-completions` | Thinking mode wants `reasoning_content` sent back unmodified and `clear_thinking: false` ([Z.ai thinking mode](https://docs.z.ai/guides/capabilities/thinking-mode)). |
| Kimi (Moonshot) | `openai-completions` | Thinking models want `reasoning_content` sent back ([Kimi thinking model guide](https://platform.kimi.ai/docs/guide/use-kimi-k2-thinking-model)). |
| MiniMax | `anthropic-messages` | Its docs recommend the Anthropic-compatible API for interleaved thinking ([MiniMax function calling](https://platform.minimax.io/docs/guides/text-m2-function-call)). |
| DeepSeek | `openai-completions` | Its Anthropic-compatible API exists for Claude Code and ignores several fields ([DeepSeek Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api)). |
| Any other open-weight model (vLLM, SGLang, llama.cpp) | `openai-completions` | The one API every open-weight server implements. vLLM serves all three, but Responses and Messages are newer there. |

For most models the rules already pick these APIs: GPT goes to Responses, Claude to Messages, and
open-weight models in pi's catalog to Chat Completions. Set `api` yourself in two cases. MiniMax is
one: pi's catalog knows it, so rule 6 sends it to Chat Completions. The other is open-weight models
that a gateway lists as `owned_by: "openai"`, which rule 5 sends to Responses (see
[agentgateway](#agentgateway)).

**If the gateway mostly serves open-weight or custom models**, set
`INFERENCE_GATEWAY_DEFAULT_API=openai-completions` (or `"defaultApi": "openai-completions"` in the
config file). Models that nothing identifies fall through to `defaultApi` (rule 7). That covers most
custom and fine-tuned models. The default, `openai-responses`, suits GPT, but Chat Completions is
the API that open-weight servers implement most widely.

**Sending reasoning back each turn matters more than the endpoint.** In multi-turn agent work, a
thinking model needs its own reasoning back every turn. pi does this on Chat Completions: it replays
a thinking block in the field it arrived in (`reasoning_content`, `reasoning` or `reasoning_text`),
or as `reasoning_details` when the response included them (pi-ai 0.99.2 and 1.1.0). So open-weight
models lose nothing there. GLM models in pi's catalog also inherit pi's `zai` thinking format, which
sends `clear_thinking: false`.

On one open-weight deployment (a GLM model served by vLLM, pi 1.1.0), the same three-step tool task
with thinking at `medium` ran three times per API. All nine runs answered correctly. Mean wall time
was 12.7 s on Chat Completions, 15.8 s on Responses, and 18.8 s on Messages (with
`forceAdaptiveThinking`). With three runs per API, these numbers only hint at speed. They do not
show any difference in quality.

### Auth

Each request carries exactly one auth header, chosen per target by an **auth scheme**:

| Scheme | Header sent | Credential |
|---|---|---|
| `bearer` (or `authorization`) | `authorization: Bearer <token>` | key / token file |
| `x-api-key`, or any header name | `<header>: <token>` | key / token file |
| `basic` | `authorization: Basic base64(<username>:<password>)` | username + password |

By default each transport uses its protocol's native scheme:

| Target | Request | Default scheme |
|---|---|---|
| `anthropic-messages` | `POST /v1/messages` | `x-api-key` |
| `openai-responses` | `POST /v1/responses` | `bearer` |
| `openai-completions` | `POST /v1/chat/completions` | `bearer` |
| `discovery` | `GET /v1/models` | `bearer` |

Override one target, or all of them with a single value:

```json
"authHeader": { "anthropic-messages": "bearer" }
```

```bash
export INFERENCE_GATEWAY_AUTH_HEADER=basic                              # every request
export INFERENCE_GATEWAY_AUTH_HEADER=anthropic-messages=bearer          # Claude only
```

Basic auth reads its username from `INFERENCE_GATEWAY_BASIC_USER` (config: `usernameEnv`, or a literal
`username`), defaulting to `gateway`. It reads its password from `INFERENCE_GATEWAY_BASIC_PASSWORD` or
`INFERENCE_GATEWAY_BASIC_PASSWORD_FILE` (config: `passwordEnv` / `passwordFile`, re-read per request). A
username containing `:` is refused. The key pi itself passes around is never sent: the header always
comes from the configured credentials.

## Models the gateway does not list

Gateways that route by path often list only some of what they serve. Add the rest with an `api`:

```bash
export INFERENCE_GATEWAY_EXTRA_MODELS=gpt-6-luna=openai-responses,oss/zai-org/glm-5-3=openai-completions
```

or as `models` entries in the config file. The same open-weight model can be routed through any of
the three APIs by changing its `api`; with the mock gateway, pi 0.99.2 and 1.0.2 both answer on each:

```console
$ pi --no-session -p --model gateway/oss/zai-org/glm-5-3 "say hi"     # "api": "anthropic-messages"
hi from /v1/messages as oss/zai-org/glm-5-3
$ pi --no-session -p --model gateway/oss/zai-org/glm-5-3 "say hi"     # "api": "openai-responses"
hi from /v1/responses as oss/zai-org/glm-5-3
$ pi --no-session -p --model gateway/oss/zai-org/glm-5-3 "say hi"     # "api": "openai-completions"
hi from /v1/chat/completions as oss/zai-org/glm-5-3
```

## Request features (`compat`)

When a model is in pi's built-in catalog on the same transport, it inherits pi's `compat` flags for
it: which optional request features pi uses (strict tools, extra tool kinds, a vendor's thinking
format, mid-conversation effort changes, ...). Those flags describe pi's transport to the vendor's
**own** API. A gateway, or the backend behind it (a cloud-hosted Claude, a self-hosted open-weight
server), may not support all of them and answers with a 400 naming a field. The extension does not
guess which; switch off what your gateway rejects, per model:

```json
"models": {
  "gpt-6-luna": { "api": "openai-responses", "compat": { "supportsToolSearch": false } },
  "oss/zai-org/glm-5-3": { "api": "openai-completions", "compat": null }
}
```

An object is merged over the inherited flags (set a flag to `false` to turn a feature off, or
`true` to turn one on); `null` drops the inherited flags entirely, so pi falls back to its plain
defaults for that transport. Recipes for errors seen through gateways are in
[Troubleshooting](#troubleshooting).
Values must be booleans, strings or numbers. Flags pi declares for the model's API are checked
against pi's own types (booleans, numbers, and enums such as `maxTokensField` or `thinkingFormat`);
a wrong-typed value is dropped with a warning. Flag names pi does not declare pass through
unchanged. `allowedFallbackModels` is never inherited and cannot be set: it is a list of pi-catalog
model ids that pi sends as a `fallbacks` body field, while the gateway has its own ids and does its
own routing.

## Thinking levels (`thinkingLevelMap`)

pi's thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`. On Chat
Completions pi sends a level as `reasoning_effort`, translated through the model's `thinkingLevelMap`
when it has one (copied from pi's catalog on the same transport, like `compat`). Some catalog maps
use values a gateway may not accept, such as `off: "off"`, and a gateway that validates
`reasoning_effort` answers them with a 400 naming the value. Set what each level is sent as:

```json
"models": {
  "oss/zai-org/glm-5-3": {
    "api": "openai-completions",
    "thinkingLevelMap": { "off": "none", "xhigh": null }
  }
}
```

A string is what the level is sent as; `null` hides that level in pi. The object is merged over the
copied map; `"thinkingLevelMap": null` drops the copied map, so pi sends its own level names.
`xhigh` and `max` are offered only when the map names them.

## When the model list changes

`pi -p` and `pi --list-models` never refresh model lists from the network, so the extension asks the
gateway itself while pi starts (5 s timeout, `INFERENCE_GATEWAY_DISCOVERY_TIMEOUT_MS` to change it).
In an interactive session pi also refreshes in the background, and `/gateway-refresh` forces it. If
the gateway cannot be reached at startup you get the config's `fallbackModels`, config-added models,
and the list pi saved from its last interactive refresh.

- **Offline:** with `pi --offline` or `PI_OFFLINE` set (any value, as pi itself treats it), or
  `INFERENCE_GATEWAY_DISCOVERY_TIMEOUT_MS=0`, the startup request is skipped silently and you get the
  same fallback set.
- **A list with no usable model is a failure**, not an empty catalog: an empty list, or one whose
  every entry is malformed, a wildcard or a non-chat model, keeps the last good list. So when a
  gateway that filters its list per caller (such as [agentgateway](#agentgateway)) authorises zero
  models for you, the previous models stay listed and requests for them fail authorisation at the
  gateway. The gateway's authorisation is never bypassed; only the list shown is stale.
- **Dropped entries:** ids containing `*` (a routing pattern, not a model; one warning names them)
  and non-chat models (LiteLLM `mode` or a `type` such as `embedding`, `image_generation`,
  `audio_transcription`, `rerank`, `moderation`; or `architecture.output_modalities` without text).
- **Context windows:** `maxTokens` never exceeds `contextWindow`. A gateway window 4x or more off
  pi's catalog for the same model is used, with one warning: relays sometimes report a placeholder.
- **Saved lists are stamped**, so a model restored from a list saved by an older version of this
  extension has its API re-chosen by the current rules, from the gateway's owner and endpoint hints
  saved with it. A model nothing identifies keeps the API it was saved with. With a current stamp,
  a restored model keeps its saved API even after you change `defaultApi`, until the next successful
  discovery; a per-model `models[id].api` always wins.

## Session affinity

Off by default. With `"sessionAffinity": true` (or `INFERENCE_GATEWAY_SESSION_AFFINITY=1`), every
request carries pi's session id **hashed** (`pi-` + 32 hex characters of SHA-256; the raw id never
leaves the process): as pi's affinity headers (`x-session-affinity` and friends) on Messages and
Chat Completions, as `prompt_cache_key` on Chat Completions, and in place of the raw id that pi's
Responses transport sends natively. A gateway can then keep a session on one backend and hit its
prompt cache. Turn the headers off for one model with
`"compat": { "sendSessionAffinityHeaders": false }`.

## Gateway limits below pi's catalog

Context window and output limits come from the gateway's list, then pi's catalog. A gateway often
caps them lower than the vendor does, and most lists carry no limits at all. Set them per model:

```json
"models": {
  "claude-sonnet-5": { "contextWindow": 200000, "maxTokens": 32000 },
  "gpt-6-luna": { "api": "openai-responses", "contextWindow": 128000, "maxTokens": 16384 }
}
```

An entry without `api` only overrides a model the gateway lists: when discovery fails it is not
offered as a fallback, and `pi --model gateway/<id>` then warns `Model not found ... using custom
model id`. Add its `api` to keep it available.

## Praxis

[Praxis](https://github.com/praxis-proxy/praxis) (its AI gateway lives in `praxis-proxy/ai`) is the
main gateway this extension is built for. Praxis's own documented clients are each pinned to one
API: Codex to Responses, Claude Code to Messages, OpenCode to Chat Completions. Through this
extension, one pi provider reaches all three. The walkthrough below runs against the mock gateway in
this repo, started in its Praxis-style Basic mode; swap the base URL for your deployment's.

### Pick your auth setup

Praxis lets each deployment choose client auth. Both common setups work:

- **Basic (the documented setup).** Clients send `Authorization: Basic base64(<user>:<password>)`
  (default user `gateway`), and Praxis injects the backend token itself:

  ```bash
  export INFERENCE_GATEWAY_AUTH_HEADER=basic
  export INFERENCE_GATEWAY_BASIC_PASSWORD=...          # or INFERENCE_GATEWAY_BASIC_PASSWORD_FILE
  # export INFERENCE_GATEWAY_BASIC_USER=gateway        # only if your deployment changed it
  ```

- **Per-API keys.** Some deployments want `x-api-key` on `/v1/messages` and `Bearer` elsewhere.
  That is the default, so only the key is needed:

  ```bash
  export INFERENCE_GATEWAY_API_KEY=...
  ```

### Name the provider `praxis`

The package and the default provider id stay generic (`gateway`). Locally you can call it what you
like:

```bash
export INFERENCE_GATEWAY_PROVIDER_ID=praxis      # model specs become praxis/<model>, e.g. praxis/claude-sonnet-5-5
```

### Add the models `/v1/models` does not list

Praxis passes `GET /v1/models` through to **one** backend without merging, so the list is partial by
design. Add the rest in `~/.pi/agent/inference-gateway.json` with the API each one is served on:
Claude on Messages, GPT on Responses, Gemini and open-weight models on Chat Completions. Ids are sent
to Praxis verbatim, `vendor/org/model` included.

### Walkthrough (pi 1.0.2, mock gateway in Basic mode)

```bash
node scripts/mock-gateway.mjs 47812 --auth basic &      # requires Basic gateway:test-pass everywhere
export PI_CODING_AGENT_DIR=$(mktemp -d)                 # keep your real ~/.pi untouched
export INFERENCE_GATEWAY_BASE_URL=http://127.0.0.1:47812
export INFERENCE_GATEWAY_PROVIDER_ID=praxis
export INFERENCE_GATEWAY_AUTH_HEADER=basic
export INFERENCE_GATEWAY_BASIC_PASSWORD=test-pass                # gitleaks:allow (mock password)
cat > "$PI_CODING_AGENT_DIR/inference-gateway.json" <<'EOF'
{ "providers": { "praxis": { "baseUrl": "http://127.0.0.1:47812",
  "models": { "gpt-6-luna": { "api": "openai-responses" },
              "oss/zai-org/glm-5-3": { "api": "openai-completions" } } } } }
EOF
```

```console
$ pi -ne -e . --list-models | grep -E '^(provider|praxis)'
provider  model                     context  max-out  thinking  images
praxis    claude-sonnet-5           1M       128K     yes       yes
praxis    gemini-3.5-flash          1.0M     65.5K    yes       yes
praxis    gpt-6-luna                272K     128K     yes       yes
praxis    oss/zai-org/glm-5-3       1M       131.1K   yes       no
$ pi -ne -e . --no-session -p --model praxis/claude-sonnet-5 "say hi"
hi from /v1/messages as claude-sonnet-5
$ pi -ne -e . --no-session -p --model praxis/gemini-3.5-flash "say hi"
hi from /v1/chat/completions as gemini-3.5-flash
$ pi -ne -e . --no-session -p --model praxis/gpt-6-luna "say hi"
hi from /v1/responses as gpt-6-luna
$ pi -ne -e . --no-session -p --model praxis/oss/zai-org/glm-5-3 "say hi"
hi from /v1/chat/completions as oss/zai-org/glm-5-3
```

The mock lists only `claude-sonnet-5` and `gemini-3.5-flash` (both `owned_by: "vertex"`, as a
single-backend pass-through would). The other two come from the config file. Its request log shows
`authorization(Basic)` on every path, `/v1/models` included. The same run passes on pi 0.99.2, and
in the per-API mode (`node scripts/mock-gateway.mjs 47811`, `INFERENCE_GATEWAY_API_KEY=test-token`).

### Known limits with Praxis

- Gemini tool calls on `/v1/chat/completions` may fail after the first turn: pi does not replay
  Gemini's `thought_signature` (see [Known limitations](#known-limitations)).
- Models inherit pi's catalog `compat` flags; if Praxis or its backend rejects a request field, turn
  the flag off per model ([Request features (`compat`)](#request-features-compat)).

## agentgateway

[agentgateway](https://github.com/agentgateway/agentgateway) (Apache-2.0, Linux Foundation) is the
second gateway this extension is tested against, in its `llm:` config mode. Notes below are from
agentgateway at commit `9d36620d` (one week after v1.6.0); the walkthrough runs against the mock
gateway in this repo, started in its agentgateway mode.

### What you get

- **One listener, three paths.** agentgateway picks the backend from the request body's `model`;
  the path (`/v1/messages`, `/v1/responses`, `/v1/chat/completions`) only says which format the
  request is in, and agentgateway translates between formats where it can. The extension still
  sends each model over its native protocol: Claude to Messages, GPT to Responses, everything else
  to Chat Completions.
- **A per-caller model list.** `GET /v1/models` is synthesised by agentgateway from its config,
  filtered by each model's authorization rules. A model missing for one caller means that caller is
  not authorised for it (the same model is a 403 on request).
- **No metadata in the list.** Every entry is `owned_by: "openai"` with no context window, modalities
  or endpoints. The extension routes Claude by pi's catalog and the `claude-` id before it looks at
  the owner, and fills metadata from pi's catalog or your config.

### Gateway side: must-haves

A CI OIDC token as the client's Bearer token (the WIF shape), with placeholder issuer and audience:

```yaml
llm:
  policies:
    jwtAuth:
      mode: strict                       # the default, optional, lets requests without a token through
      providers:
      - issuer: https://token.actions.example.com
        audiences: [https://gateway.example.com]
        jwks: { url: https://token.actions.example.com/.well-known/jwks }   # remote JWKS
  models:
  - name: claude-sonnet-5
    provider: anthropic
    authorization:
      rules:
      - allow: 'jwt.repository == "example-org/example-repo"'
  - name: gpt-6-luna
    provider: openAI
```

- `jwtAuth.mode: strict`, a remote JWKS URL and `audiences` are the minimum; per-model
  authorization rules also filter `/v1/models`, so each caller lists only what it may use.
- **Never use a CEL `location.expression` for the token** (for example to also accept `x-api-key`).
  agentgateway does not strip a token read that way, so the caller's JWT would be forwarded to the
  model provider. Send Bearer from the client instead (below).
- `discovery: disabled` lists wildcard models such as `openai/*` literally; the extension drops them
  with a warning. Add the concrete ids you use with `models` in the config file.

### Extension side

agentgateway reads the JWT from `Authorization: Bearer` only, **on every path**, including
`/v1/messages`, where pi natively sends `x-api-key`. Switch every API to Bearer, and point the
token file at the token your CI runner rewrites (it is re-read on every request, so rotation needs no
restart):

```bash
export INFERENCE_GATEWAY_BASE_URL=https://gateway.example.com   # the root, or root + llm.pathPrefix; no /v1
export INFERENCE_GATEWAY_TOKEN_FILE=/path/to/oidc-token         # minted with the gateway's audience
export INFERENCE_GATEWAY_AUTH_HEADER=bearer                     # Bearer on all three APIs and discovery
```

or, in the config file, `"authHeader": "bearer"` (or only `{ "anthropic-messages": "bearer" }`,
since the other targets already default to Bearer). This is the inverse of the per-API Praxis setup.

Models nothing identifies (no pi catalog entry under `anthropic`/`openai`, no `claude-` id) take the
`owned_by: "openai"` hint and go to Responses, which agentgateway translates for a chat backend. To
use Chat Completions directly, give them an `api`:

```json
{ "providers": { "gateway": { "baseUrl": "https://gateway.example.com", "authHeader": "bearer",
  "models": { "gemini-3.5-flash": { "api": "openai-completions" },
              "oss/zai-org/glm-5-3": { "api": "openai-completions" } } } } }
```

### Walkthrough (pi 1.0.2, mock gateway in agentgateway mode)

```bash
node scripts/mock-gateway.mjs 47813 --mode agentgateway &   # Bearer only, owned_by "openai", an openai/* entry
export PI_CODING_AGENT_DIR=$(mktemp -d)
export INFERENCE_GATEWAY_BASE_URL=http://127.0.0.1:47813
export INFERENCE_GATEWAY_API_KEY=test-token                 # a token file in CI, as above
export INFERENCE_GATEWAY_AUTH_HEADER=bearer
cat > "$PI_CODING_AGENT_DIR/inference-gateway.json" <<'EOF'
{ "providers": { "gateway": { "baseUrl": "http://127.0.0.1:47813",
  "models": { "gemini-3.5-flash": { "api": "openai-completions" },
              "oss/zai-org/glm-5-3": { "api": "openai-completions" } } } } }
EOF
```

```console
$ pi -ne -e . --list-models | grep -E '^(provider|gateway) |pi-inference-gateway'
[pi-inference-gateway] gateway: ignored wildcard model id(s) openai/*: the gateway lists a routing pattern, not a model; add concrete ids via "models" in the config file (or INFERENCE_GATEWAY_EXTRA_MODELS)
provider  model                     context  max-out  thinking  images
gateway   claude-sonnet-5           1M       128K     yes       yes
gateway   gemini-3.5-flash          1.0M     65.5K    yes       yes
gateway   gpt-6-luna                272K     128K     yes       yes
gateway   oss/zai-org/glm-5-3       1M       131.1K   yes       no
$ pi -ne -e . --no-session -p --model gateway/claude-sonnet-5 "say hi" </dev/null
hi from /v1/messages as claude-sonnet-5
$ pi -ne -e . --no-session -p --model gateway/gemini-3.5-flash "say hi" </dev/null
hi from /v1/chat/completions as gemini-3.5-flash
$ pi -ne -e . --no-session -p --model gateway/gpt-6-luna "say hi" </dev/null
hi from /v1/responses as gpt-6-luna
$ pi -ne -e . --no-session -p --model gateway/oss/zai-org/glm-5-3 "say hi" </dev/null
hi from /v1/chat/completions as oss/zai-org/glm-5-3
```

All four models are listed `owned_by: "openai"`; Claude still goes to `/v1/messages`. The mock's
log shows `authorization(Bearer)` on every request, `/v1/models` included. The same run passes on
pi 0.99.2.

### Troubleshooting agentgateway

| Symptom | Cause | Fix |
|---|---|---|
| `401 authentication failure: no bearer token found` on Claude only | pi's native `x-api-key` on `/v1/messages` | `INFERENCE_GATEWAY_AUTH_HEADER=bearer` |
| `model discovery failed (model list request returned HTTP 401: ...)` | no token, a wrong or expired token, or a wrong audience | check the token file and the token's `aud` |
| `400 ... unsupported conversion: from Responses to provider anthropic (supported: [AnthropicMessages])` | a Claude model on `openai-responses` (an `api` in your config, or an old snapshot) | remove the `api`, or set `"anthropic-messages"` |
| `403` with a JSON "model authorization denied" error | a claim rule on that model refuses your token | the gateway's per-model `authorization` rules |
| `404 ... model_not_found` | an id the gateway does not serve, or a wildcard id | use an id from `--list-models`, or add a concrete one via `models` |
| `400 ... unknown variant ..., expected one of none, minimal, low, medium, high, xhigh, max` | a `reasoning_effort` value from a copied `thinkingLevelMap` | set it per model, see [Thinking levels](#thinking-levels-thinkinglevelmap) |

These errors are `text/plain`; the extension shows the start of such a body in discovery errors
(credentials redacted, or `(body omitted)` when a credential is under 8 characters; see
[Security](#security)), and pi shows it for model requests (the walkthrough's two failure cases,
pasted from the mock):

```console
$ INFERENCE_GATEWAY_AUTH_HEADER= pi -ne -e . --no-session -p --model gateway/claude-sonnet-5 "say hi" </dev/null
401 authentication failure: no bearer token found
$ INFERENCE_GATEWAY_API_KEY=wrong-token-value pi -ne -e . --list-models
[pi-inference-gateway] gateway: model discovery failed (model list request returned HTTP 401: authentication failure: no bearer token found); using 2 fallback model(s) plus pi's last saved list
```

### Known incompatibilities

- Claude cannot be served on `/v1/responses` through agentgateway (a 400; the extension never sends
  it there unless you configure it).
- Claude over `/v1/chat/completions` works but loses signed-thinking replay.
- Non-streaming `/v1/responses` returns a 502 on an output item type agentgateway does not know. pi
  always streams, so it is not affected.
- `x-api-key` is never accepted for JWT auth; use Bearer.
- The classic `routes:` mode does not serve `/v1/models` (501); use the `llm:` mode.
- Gemini behind an agentgateway Vertex/Gemini provider is expected **not** to hit the
  [`thought_signature` limitation](#known-limitations): agentgateway carries the signature inside
  the tool-call id (`<id>__thought__<signature>`), which pi replays verbatim. This is from
  agentgateway's source and has not been verified against a live Gemini model.

## Security

- **Credentials go only where you pointed them.** Like Praxis's own OpenCode plugin, which attaches
  credentials only when the base URL equals `PRAXIS_BASE_URL`, credentials from
  `INFERENCE_GATEWAY_*` variables attach only to the provider whose base URL equals
  `INFERENCE_GATEWAY_BASE_URL`. The comparison normalises scheme, host, port and path, and ignores a
  trailing slash or `/v1`. A config-file provider that names one of those variables for another URL
  is refused, and nothing is sent to it:

  ```console
  $ cat $PI_CODING_AGENT_DIR/inference-gateway.json
  { "providers": { "other": { "baseUrl": "http://127.0.0.1:47812", "apiKeyEnv": "INFERENCE_GATEWAY_API_KEY" } } }
  $ pi --list-models | grep -E "^(provider|gateway|other) "
  [pi-inference-gateway] other: refused — it uses INFERENCE_GATEWAY_API_KEY, which only authenticate to INFERENCE_GATEWAY_BASE_URL (http://127.0.0.1:47811), but its baseUrl is http://127.0.0.1:47812. Use a variable of your own (apiKeyEnv/passwordEnv) for this gateway.
  provider  model                     context  max-out  thinking  images
  gateway   claude-sonnet-5           1M       128K     yes       yes
  gateway   gemini-3.5-flash          1.0M     65.5K    yes       yes
  ```

  Give any other gateway a variable of its own (`apiKeyEnv`, `passwordEnv`).
- **Only your user-level config is read**: `~/.pi/agent/inference-gateway.json`, or the same file
  under `$PI_CODING_AGENT_DIR`. A project's `.pi/` directory is never consulted, so a cloned repository
  cannot point your credentials at its own host.
- **No secrets in the file.** Keys and passwords are referenced by variable name or file path; a
  literal `apiKey` or `password`, or an `authorization`/`x-api-key` entry in `headers`, is refused.
  No `!command` keys, no shell-out.
- **Redirects are never followed**, on model requests or on discovery: a redirect is an error, so a
  key cannot be forwarded to another origin.
- **Credentials are never logged.** Warnings name variables and files, never their values. A
  discovery error shows the start of a `text/plain` error body only after replacing every form of
  the credentials it sent; if any credential is shorter than 8 characters (Basic's default username
  `gateway` is 7), the body is replaced by `(body omitted)`.
- **Model-request error bodies are printed by pi, not by this extension**, and are not redacted:
  a gateway or backend that echoes the request's credentials in an error can expose them there.

## Try it locally

```bash
node scripts/mock-gateway.mjs 47811 &
export PI_CODING_AGENT_DIR=$(mktemp -d)          # keep your real ~/.pi untouched
export INFERENCE_GATEWAY_BASE_URL=http://127.0.0.1:47811
export INFERENCE_GATEWAY_API_KEY=test-token
pi -ne -e . --list-models
```

(`-ne -e .` loads only this checkout's extension; a normal `pi install` needs neither flag.) The mock
lists a Claude and a Gemini model, accepts only `x-api-key` on `/v1/messages`, and serves the unlisted
`gpt-*` and `oss/zai-org/glm-5-3` models described above. Start it with `--auth basic` to require
`Basic gateway:test-pass` on every path instead (see [Praxis](#praxis)), or with `--mode agentgateway` for Bearer everywhere
and body-routed models (see [agentgateway](#agentgateway)).

## Requirements

- pi ≥ 0.99.2 (CI runs 0.99.2 and 1.1.0 on every commit)
- A gateway exposing an OpenAI-style model list and at least one of `/v1/messages`,
  `/v1/responses`, `/v1/chat/completions`

## Known limitations

- **Gemini tool calls over `/v1/chat/completions` fail after the first turn** on a gateway that
  passes Gemini's OpenAI-compatible responses through. Gemini attaches a `thought_signature` to each
  tool call (`message.extra_content.google.thought_signature`) and requires it back on the next
  request. pi's chat-completions transport (pi-ai 0.99.2 through 1.1.0) neither reads nor replays
  that field, so turn 2 is rejected with `400 Function call is missing a thought_signature in
  functionCall parts` (confirmed live on a path-routed gateway, pi 0.99.2 and 1.1.0). Single-turn
  prompts and text replies work. The fix belongs in pi's transport; gateways that carry the
  signature in the tool-call id, such as [agentgateway](#agentgateway), are expected to be
  unaffected.
- **Inherited `compat` flags may not suit your gateway** — see
  [Request features (`compat`)](#request-features-compat).

## Troubleshooting

**No `gateway` rows and no message.** Either nothing is configured (the extension is silent by
design), or pi dropped the extension. Load it explicitly to see the error:
`pi -e ~/.pi/agent/git/github.com/fullsend-ai/pi-inference-gateway --list-models`.

**`[pi-inference-gateway] gateway: model discovery failed (...)`.** The model list could not be
fetched at startup. The reason is in the parentheses: a timeout, `HTTP 401`, or a redirect (never
followed, so your token cannot leak to another origin). Check `INFERENCE_GATEWAY_BASE_URL` and the
key. Add `fallbackModels` or config-added models to keep working while the gateway is down.

**401 on Claude models only.** Your gateway wants Bearer on `/v1/messages`: set
`"authHeader": { "anthropic-messages": "authorization" }`. A 401 on everything else but Claude is
the reverse: `"openai-responses": "x-api-key"` and so on.

**A 400 naming a request field** (`tools.0.defer_loading`, `tool_stream`, `thinking`, ...). An
inherited pi `compat` flag turned on a feature your gateway or its backend does not accept. Set that
flag to `false` in `models["<id>"].compat`, or drop them all with `"compat": null`.

**`[pi-inference-gateway] <id>: refused — it uses INFERENCE_GATEWAY_...`.** A config-file provider
names an `INFERENCE_GATEWAY_*` credential but points at a different URL than
`INFERENCE_GATEWAY_BASE_URL`. Give it a variable of its own, or fix the URL (see [Security](#security)).

**401 on every request with Basic auth.** Check `INFERENCE_GATEWAY_AUTH_HEADER=basic` (or the
per-target `authHeader`), the password variable or file, and the username (default `gateway`).

**404 on a model that is listed.** The gateway serves it on a different path than the one picked.
Set `models["<id>"].api` to the right transport.

**A model works with curl but is not in the list.** The gateway does not list it. Add it with an
`api` (config `models` or `INFERENCE_GATEWAY_EXTRA_MODELS`).

**`[pi-inference-gateway] gateway: token file ... is missing or empty`.** The token file configured
by `INFERENCE_GATEWAY_TOKEN_FILE` or `tokenFile` is not there yet; models are not offered until it is.

**`No API key found for anthropic`.** You used a bare model id. Use `gateway/<model>`.

**Claude: `400 ... messages.1.output_config: Extra inputs are not permitted`.** pi's catalog marks
Claude as supporting mid-conversation effort changes, which pi sends as an extra effort-only message.
Anthropic's own API accepts it; a gateway whose Claude backend is not Anthropic's own API (for
example a cloud-hosted Claude) may not. Switch it off for that model:
`"models": { "claude-sonnet-5": { "compat": { "supportsMidConvoEffort": false } } }`. Other Claude
flags such as `supportsMidConvoSystemMessages` do not cause this.

**Claude: `400 ... disallowed feature ...` naming structured output or strict tools.** Some cloud
projects restrict partner-model features (structured outputs) by organisation policy, and pi sends
strict tool schemas when the catalog says the model supports them. This is per cloud project, so
set it only where you see it: `"compat": { "supportsStrictTools": false }`.

**Open-weight model on `/v1/messages`: `400 ... thinking.budget_tokens must be less than max_tokens`
on every thinking request.** Older vLLM servers reject every `thinking.type: "enabled"` request this
way (fixed upstream in vllm-project/vllm#58786, vLLM 0.31.0). Until the server is upgraded, set
`"compat": { "forceAdaptiveThinking": true }` on that model.

**`pi -p` hangs in CI or over ssh.** pi waits on an open, non-terminal stdin. Run
`pi -p ... </dev/null`.

**No thinking shown.** Thinking events only appear when the prompt makes the model reason; "say hi"
usually produces none, even on a reasoning model with thinking on.

---

Contributing, architecture, and the pi-specific gotchas behind the design:
[CONTRIBUTING.md](CONTRIBUTING.md). Rules for AI agents working in this repo: [AGENTS.md](AGENTS.md).

MIT licensed.
