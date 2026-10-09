# @fullsend-ai/pi-inference-gateway

Any vendor-neutral **inference gateway** — LiteLLM, agentgateway, Bifrost, Portkey, an in-house
proxy — as one [pi](https://github.com/earendil-works/pi) provider.

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
| `INFERENCE_GATEWAY_AUTH_HEADER` | Override the auth header — see [Auth headers](#auth-headers). | native per API |
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
| `authHeader` | See [Auth headers](#auth-headers). |
| `defaultApi` | As `INFERENCE_GATEWAY_DEFAULT_API`. |
| `headers` | Extra headers on every request, discovery included. |
| `modelsPath` | Model-list path, default `/v1/models`. |
| `include` / `exclude` | `*` globs over listed model ids. |
| `models` | Per-id overrides: `api`, `name`, `contextWindow`, `maxTokens`, `reasoning`, `input` (`["text","image"]`), `cost` (USD per million tokens). **An entry with an `api` whose id the gateway does not list adds that model.** |
| `fallbackModels` | Offered when discovery fails: ids or `{ "id": ..., "owned_by": ... }` objects. |

When `INFERENCE_GATEWAY_BASE_URL` is also set, it configures the provider with the same id
(`gateway` by default): the environment supplies the base URL, key and default API; the file adds the
rest. No `!command` keys and no shell-out, by design.

## How each model gets its API

First match wins:

1. Config `models[id].api`.
2. A hint from the gateway: an `api` field, or `endpoint` / `supported_endpoints` naming
   `/v1/messages`, `/v1/responses` or `/v1/chat/completions`.
3. The owner (`owned_by`, `provider`, `litellm_provider`): anything Anthropic → Messages;
   `openai`, `azure` → Responses. Hosting and aggregator owners — `vertex`, `bedrock`, `azure_ai`,
   `openrouter`, `system`, `library` — say nothing about the protocol and are skipped.
4. pi's built-in catalog has the id under `anthropic` → Messages, under `openai` → Responses.
5. The id starts with `claude-` → Messages.
6. pi's built-in catalog has the id under any other provider (Google, xAI, Z.ai, ...) → Chat
   Completions.
7. `defaultApi`.

Catalog lookups also try the id without a `vendor/` prefix and with `-`/`.` swapped between digits,
so `oss/zai-org/glm-5-3` finds pi's `glm-5.3`. The gateway's id is always what is sent back.

Model metadata (context window, max output, reasoning, image input, cost) comes from the config,
then the gateway's own fields (`context_window`, `max_input_tokens`, `max_output_tokens`,
`supports_vision`, `supports_reasoning`, LiteLLM-style `input_cost_per_token`, ...), then pi's
built-in catalog, then defaults (128K context, 16K output, text only, no reasoning, zero cost).

### Auth headers

By default each transport sends the token the way its protocol does:

| Request | Header |
|---|---|
| `/v1/messages` (Anthropic) | `x-api-key: <token>` |
| `/v1/responses`, `/v1/chat/completions` | `authorization: Bearer <token>` |
| `GET /v1/models` | `authorization: Bearer <token>` |

If your gateway wants something else, override per target or for all of them:

```json
"authHeader": { "anthropic-messages": "authorization" }
```

```bash
export INFERENCE_GATEWAY_AUTH_HEADER=x-api-key                                # every request
export INFERENCE_GATEWAY_AUTH_HEADER=anthropic-messages=authorization         # Claude only
```

`authorization` always means `Bearer <token>`; any other header carries the raw token. Exactly one
auth header is sent.

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

## When the model list changes

`pi -p` and `pi --list-models` never refresh model lists from the network, so the extension asks the
gateway itself while pi starts (5 s timeout). In an interactive session pi also refreshes in the
background, and `/gateway-refresh` forces it. If the gateway cannot be reached at startup you get
the config's `fallbackModels`, config-added models, and the list pi saved from its last interactive
refresh.

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
`gpt-*` and `oss/zai-org/glm-5-3` models described above.

## Requirements

- pi ≥ 0.99.2 (CI runs 0.99.2 and 1.1.0 on every commit)
- A gateway exposing an OpenAI-style model list and at least one of `/v1/messages`,
  `/v1/responses`, `/v1/chat/completions`

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
