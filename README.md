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
| `INFERENCE_GATEWAY_DEFAULT_API` | Transport for models nothing else identifies: `openai-responses`, `openai-completions` or `anthropic-messages`. | `openai-responses` |
| `INFERENCE_GATEWAY_AUTH_HEADER` | Override the auth header — see [Auth headers](#auth). | native per API |
| `INFERENCE_GATEWAY_BASIC_USER` | Basic-auth username — see [Auth](#auth). | `gateway` |
| `INFERENCE_GATEWAY_BASIC_PASSWORD` / `_PASSWORD_FILE` | Basic-auth password, or a file holding it (re-read per request). | — |
| `INFERENCE_GATEWAY_EXTRA_MODELS` | Models the gateway serves but does not list: `id=api,id=api`. | — |

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
| `defaultApi` | As `INFERENCE_GATEWAY_DEFAULT_API`. |
| `headers` | Extra headers on every request, discovery included. A header named like an auth header (`authorization`, `x-api-key`, or any header used in `authHeader`) is refused: credentials only come from the configured key, token or password. |
| `modelsPath` | Model-list path, default `/v1/models`. |
| `include` / `exclude` | `*` globs over listed model ids. |
| `models` | Per-id overrides: `api`, `name`, `contextWindow`, `maxTokens`, `reasoning`, `input` (`["text","image"]`), `cost` (USD per million tokens), `compat` (see [Request features (`compat`)](#request-features-compat)). **An entry with an `api` whose id the gateway does not list adds that model.** |
| `fallbackModels` | Offered when discovery fails: ids or `{ "id": ..., "owned_by": ... }` objects. |

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
format, ...). Those flags describe the vendor's own API. A gateway that translates the request
for another backend may reject some of them with a 400 naming an unknown field. Switch them off per
model:

```json
"models": {
  "gpt-6-luna": { "api": "openai-responses", "compat": { "supportsToolSearch": false } },
  "oss/zai-org/glm-5-3": { "api": "openai-completions", "compat": null }
}
```

An object is merged over the inherited flags (set a flag to `false` to turn a feature off); `null`
drops the inherited flags entirely, so pi falls back to its plain defaults for that transport.
Values must be booleans, strings or numbers. Flags pi declares for the model's API are checked
against pi's own types (booleans, numbers, and enums such as `maxTokensField` or `thinkingFormat`);
a wrong-typed value is dropped with a warning. Flag names pi does not declare pass through
unchanged. `allowedFallbackModels` is never inherited and cannot be set: pi turns it into a
`fallbacks` body field that only api.anthropic.com accepts.

## When the model list changes

`pi -p` and `pi --list-models` never refresh model lists from the network, so the extension asks the
gateway itself while pi starts (5 s timeout). In an interactive session pi also refreshes in the
background, and `/gateway-refresh` forces it. If the gateway cannot be reached at startup you get
the config's `fallbackModels`, config-added models, and the list pi saved from its last interactive
refresh.

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
- **Credentials are never logged.** Warnings name variables and files, never their values.

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
`Basic gateway:test-pass` on every path instead (see [Praxis](#praxis)).

## Requirements

- pi ≥ 0.99.2 (CI runs 0.99.2 and 1.1.0 on every commit)
- A gateway exposing an OpenAI-style model list and at least one of `/v1/messages`,
  `/v1/responses`, `/v1/chat/completions`

## Known limitations

- **Gemini tool calls over `/v1/chat/completions` may fail after the first turn.** Gemini attaches a
  `thought_signature` to each tool call (`message.extra_content.google.thought_signature` on an
  OpenAI-compatible endpoint) and expects it back on the next request. pi's chat-completions
  transport (pi-ai 0.99.2 through 1.1.0) neither reads nor replays that field, so a gateway that
  passes it through can reject the follow-up turn. Single-turn prompts and text replies work.
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

---

Contributing, architecture, and the pi-specific gotchas behind the design:
[CONTRIBUTING.md](CONTRIBUTING.md). Rules for AI agents working in this repo: [AGENTS.md](AGENTS.md).

MIT licensed.
