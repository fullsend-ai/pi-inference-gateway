# Configuration

For anyone setting up the extension beyond the two-variable [quick start](../README.md#quick-start):
every variable, the config file, auth and model-list behaviour. Back to the [README](../README.md).

## Environment variables

| Variable | Meaning | Default |
|---|---|---|
| `INFERENCE_GATEWAY_BASE_URL` | Gateway root. Unset (and no config file) ⇒ the extension does nothing and prints nothing. | — |
| `INFERENCE_GATEWAY_API_KEY` | Static key. | — |
| `INFERENCE_GATEWAY_TOKEN_FILE` | File holding the token, **re-read on every request** (rotating OIDC/WIF tokens). Wins over `API_KEY`. | — |
| `INFERENCE_GATEWAY_PROVIDER_ID` | Provider id, i.e. the part before `/` in a model spec. | `gateway` |
| `INFERENCE_GATEWAY_DEFAULT_API` | Transport for models nothing else identifies: `openai-responses`, `openai-completions` or `anthropic-messages`. See [Which API to pick](routing.md#which-api-to-pick). | `openai-responses` |
| `INFERENCE_GATEWAY_AUTH_HEADER` | Override the auth header — see [Auth headers](#auth). | native per API |
| `INFERENCE_GATEWAY_BASIC_USER` | Basic-auth username — see [Auth](#auth). | `gateway` |
| `INFERENCE_GATEWAY_BASIC_PASSWORD` / `_PASSWORD_FILE` | Basic-auth password, or a file holding it (re-read per request). | — |
| `INFERENCE_GATEWAY_EXTRA_MODELS` | Models the gateway serves but does not list: `id=api,id=api`. | — |
| `INFERENCE_GATEWAY_DISCOVERY` | Model-list formats to request, comma-separated: `openai`, `anthropic` (see [Discovery: both list formats](#discovery-both-list-formats)). | `openai,anthropic` |
| `INFERENCE_GATEWAY_DISCOVERY_TIMEOUT_MS` | How long pi's startup waits for the model list; `0` skips it (see [When the model list changes](#when-the-model-list-changes)). | `5000` |
| `INFERENCE_GATEWAY_SESSION_AFFINITY` | `1` sends a hashed session id for gateway affinity and caching (see [Session affinity](#session-affinity)). | off |
| `INFERENCE_GATEWAY_CONFIG_FILE` | Absolute path (`~/` allowed) of the only config file to read, instead of every directory file. For hosts that render and verify the config themselves (see [One exact config file](#one-exact-config-file)). | — |

No `pi login`: auth is ambient. Without a key or token file the gateway's models are registered but
not offered.

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
| `baseUrl` / `baseUrlEnv` | Gateway root, or the *name* of the variable holding it (see [Sharing the config file](#sharing-the-config-file)). Exactly one is required. |
| `apiKeyEnv` / `tokenFile` | *Name* of the variable holding the key, or a path (`~/` allowed) re-read per request. A literal `apiKey`, or an `authorization`/`x-api-key` entry in `headers`, is refused. |
| `username` / `usernameEnv`, `passwordEnv` / `passwordFile` | Basic-auth credentials (a literal `password` is refused). |
| `authHeader` | See [Auth headers](#auth). |
| `defaultApi` | As `INFERENCE_GATEWAY_DEFAULT_API`; see [Which API to pick](routing.md#which-api-to-pick). |
| `headers` | Extra headers on every request, discovery included. A header named like an auth header (`authorization`, `x-api-key`, or any header used in `authHeader`) is refused: credentials only come from the configured key, token or password. |
| `modelsPath` | Model-list path, default `/v1/models`. |
| `discovery` | Model-list formats to request: `["openai", "anthropic"]` (the default), `["openai"]` or `["anthropic"]`. See [Discovery: both list formats](#discovery-both-list-formats). |
| `include` / `exclude` | `*` globs over listed model ids. |
| `models` | Per-id overrides: `api`, `name`, `contextWindow`, `maxTokens`, `reasoning`, `input` (`["text","image"]`), `cost` (USD per million tokens), `compat` (see [Request features (`compat`)](compat.md#request-features-compat)), `thinkingLevelMap` (what each thinking level is sent as, see [Thinking levels](compat.md#thinking-levels-thinkinglevelmap)). **An entry with an `api` whose id the gateway does not list adds that model.** |
| `fallbackModels` | Offered when discovery fails: ids or `{ "id": ..., "owned_by": ... }` objects. |
| `sessionAffinity` | `true` as `INFERENCE_GATEWAY_SESSION_AFFINITY=1`. |

When `INFERENCE_GATEWAY_BASE_URL` is also set, it configures the provider with the same id
(`gateway` by default): the environment supplies the base URL, key and default API; the file adds the
rest. If the file entry's base URL differs from the environment's, its `tokenFile` and `passwordFile`
are dropped too (with a warning naming them), since they belonged to the other URL; when the two
agree, for example a file entry with `"baseUrlEnv": "INFERENCE_GATEWAY_BASE_URL"`, they are kept.
No `!command` keys and no shell-out, by design.

## Sharing the config file

To keep `inference-gateway.json` in a shared or public dotfiles repo (as a symlink, say), leave
everything machine-specific out of it:

- **`baseUrlEnv`** names the variable holding the base URL, as `apiKeyEnv` names the key's. The
  value is validated like a literal `baseUrl`. When the variable is unset or empty, the provider is
  skipped with one warning naming the variable. Credentials from `INFERENCE_GATEWAY_*` variables
  still only go to `INFERENCE_GATEWAY_BASE_URL` (see [Security](security.md)).
- **`inference-gateway.local.json`**, in the same directory (`~/.pi/agent`, or
  `$PI_CODING_AGENT_DIR`), is merged over the shared file per provider and per model. An overlay
  value replaces the shared one, except that two objects (`headers`, `authHeader`, a model's
  `compat`, `thinkingLevelMap` or `cost`) are merged key by key. Four pairs each count as one
  setting: `baseUrl`/`baseUrlEnv`, `apiKeyEnv`/`tokenFile`, `passwordEnv`/`passwordFile` and
  `username`/`usernameEnv`. Setting either key of a pair in the overlay replaces both, so a literal
  local `username` wins over a shared `usernameEnv`. An overlay that sets `baseUrl` or `baseUrlEnv`
  also drops the shared `tokenFile` and `passwordFile` unless it sets them again, so a shared
  credential file never follows a local URL to another gateway. Inherited variable names
  (`apiKeyEnv`, `passwordEnv`, `usernameEnv`) are kept, so an overlay that only swaps the URL and
  uses variables keeps working. A missing overlay is silent; a malformed or unreadable one is
  reported with its own path and then ignored, so the shared file applies alone.

Shared file, safe to publish:

```json
{ "providers": { "corp": {
  "baseUrlEnv": "CORP_GATEWAY_URL",
  "apiKeyEnv": "CORP_GATEWAY_KEY",
  "models": {
    "claude-sonnet-5": { "compat": { "supportsMidConvoEffort": false } },
    "gpt-6-luna": { "api": "openai-responses" }
  } } } }
```

Local overlay, kept on this machine:

```json
{ "providers": { "corp": { "models": {
  "claude-sonnet-5": { "contextWindow": 200000, "maxTokens": 32000 },
  "vendor/org/open-model": { "api": "openai-completions", "contextWindow": 262144, "maxTokens": 65536 }
} } } }
```

## Shipping a config with the extension

`inference-gateway.json` and `inference-gateway.local.json` are also read from the extension's own
directory, next to its `package.json`. These files are the lowest layer: the extension directory's
shared file, then its `.local.json`, then the two files in `~/.pi/agent` (or `$PI_CODING_AGENT_DIR`),
each merged over the ones before it by the rules above (per provider, per model). Your user-level
files always win. A missing file is silent; a malformed or unreadable one is reported with its own
path and then ignored. No variable selects another directory: a file inside the installed extension
is only as writable as the extension itself.

This is for hosts that run pi in a sandbox whose config directory belongs to the runner, so users
cannot put a file there, but can install the extension (vendored as a plugin, say). Only the
environment variables reach such a sandbox, and per-model `compat`, `contextWindow`, `maxTokens` or
`exclude` need a file. Ship them with the extension:

```json
{ "providers": { "gateway": {
  "baseUrlEnv": "INFERENCE_GATEWAY_BASE_URL",
  "exclude": ["*embed*"],
  "models": {
    "claude-sonnet-5": { "api": "anthropic-messages", "contextWindow": 200000,
                         "compat": { "supportsMidConvoEffort": false } }
  } } } }
```

In such a file, leave credentials and the base URL to the environment, as above: give the entry the
env provider's id (`gateway`, or `INFERENCE_GATEWAY_PROVIDER_ID`) and
`"baseUrlEnv": "INFERENCE_GATEWAY_BASE_URL"`, so the environment supplies the base URL and key; for
another gateway, use `baseUrlEnv` and `apiKeyEnv`. The same rules apply as for any config file:
`INFERENCE_GATEWAY_*` credentials still only go to `INFERENCE_GATEWAY_BASE_URL` (see
[Security](security.md)), and warnings name the file they came from.

## One exact config file

A host that renders and verifies the config itself, then starts pi, can name that file with
`INFERENCE_GATEWAY_CONFIG_FILE`:

```bash
export INFERENCE_GATEWAY_CONFIG_FILE=/run/host/inference-gateway.json
```

When it is set, the extension reads **only that file**: not the extension directory's files, not
`~/.pi/agent` or `$PI_CODING_AGENT_DIR`, and no `.local.json` overlay. Point it at a path the agent
cannot write, and pi and every child pi it starts read the same file the host checked. That holds
only while the host ensures three things, none of which the extension checks: the file's parent
directory and every directory above it are not writable by the agent either (otherwise the agent
can replace the file, or a directory containing it, by renaming another over it); neither the file
nor any directory on its path is a symlink to a target the agent can write; and every child pi
inherits the same `INFERENCE_GATEWAY_CONFIG_FILE` value (an agent that can start pi with an
environment of its own can point it at another file, see [Security](security.md)).

- A leading `~/` is expanded. The path must then be absolute; a relative path is reported, naming
  it, and no file is read, since pi's working directory is the agent's repository.
- A missing, unreadable or malformed file is reported with its path and is not used. The extension
  does not fall back to the directory files.
- The file has the same format and validation as any config file, literal credentials refused
  included.
- Only the file layers are replaced. The provider built from `INFERENCE_GATEWAY_BASE_URL` and the
  other variables still loads and merges with the file's providers as described in
  [Config file](#config-file), even when the named file cannot be used, and `INFERENCE_GATEWAY_*`
  credentials still only go to `INFERENCE_GATEWAY_BASE_URL`.

Unset or empty, nothing changes. See [Security](security.md) for the trust model.

## Auth

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
| `discovery` | `GET /v1/models` (OpenAI-format list) | `bearer` |

The Anthropic-format model list (`GET /v1/models` with `anthropic-version`) uses the
`anthropic-messages` scheme, because a gateway that wants Bearer or Basic on Messages wants the same
there.

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

## Discovery: both list formats

Some gateways keep a separate model catalog for each API dialect on the same path, as Anthropic's own
API does for its list. So discovery sends two `GET {baseUrl}{modelsPath}` requests in parallel:

| List | Request | Lists the models for |
|---|---|---|
| OpenAI format (`{object: "list", data}`) | the `discovery` auth scheme (Bearer by default) | `/v1/responses`, `/v1/chat/completions` |
| Anthropic format (`{data, has_more, first_id, last_id}`) | the `anthropic-messages` auth scheme (`x-api-key` by default) plus `anthropic-version: 2023-06-01` | `/v1/messages` |

Each request carries exactly one credential. The lists are merged by id:

- An id on the OpenAI-format list keeps the usual [API selection](routing.md#which-api-to-pick), even
  when the Anthropic-format list has it too.
- An id only on the Anthropic-format list goes to `anthropic-messages`. A `models[id].api` still wins.
- If the Anthropic-format list has more pages (`has_more`), only the first page is used, with one
  warning.

One request failing is not fatal while the other returns a usable model. A 400, 401, 403, 404 or 405
on the Anthropic-format request means the gateway has no such catalog, so there is no warning. Any
other failure of either request gets one warning. When both fail, discovery fails with the
OpenAI-format request's error. When only the Anthropic-format request succeeds, its models alone
are listed and saved as the new snapshot, replacing the previous one. If a gateway rejects one of the two requests in a way that matters,
turn it off with `"discovery": ["openai"]` (or `["anthropic"]`), or
`INFERENCE_GATEWAY_DISCOVERY=openai`.

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

## Session affinity

Off by default. With `"sessionAffinity": true` (or `INFERENCE_GATEWAY_SESSION_AFFINITY=1`), every
request carries pi's session id **hashed** (`pi-` + 32 hex characters of SHA-256; the raw id never
leaves the process): as pi's affinity headers (`x-session-affinity` and friends) on Messages and
Chat Completions, as `prompt_cache_key` on Chat Completions, and in place of the raw id that pi's
Responses transport sends natively. A gateway can then keep a session on one backend and hit its
prompt cache. Turn the headers off for one model with
`"compat": { "sendSessionAffinityHeaders": false }`.

## When the model list changes

`pi -p` and `pi --list-models` never refresh model lists from the network, so the extension asks the
gateway itself while pi starts (5 s timeout, `INFERENCE_GATEWAY_DISCOVERY_TIMEOUT_MS` to change it).
In an interactive session pi also refreshes in the background, and `/gateway-refresh` forces it. If
the gateway cannot be reached at startup you get the config's `fallbackModels`, config-added models,
and the list pi saved from its last interactive refresh.

- **Offline:** with `pi --offline` or `PI_OFFLINE` set (any value, as pi itself treats it), or
  `INFERENCE_GATEWAY_DISCOVERY_TIMEOUT_MS=0`, the startup request is skipped silently and you get the
  same fallback set. On a fresh config directory that set has no saved list: see
  [Sandboxes and CI](#sandboxes-and-ci).
- **A list with no usable model is a failure**, not an empty catalog: an empty list, or one whose
  every entry is malformed, a wildcard or a non-chat model, keeps the last good list. So when a
  gateway that filters its list per caller (such as [agentgateway](gateways/agentgateway.md)) authorises zero
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

## Sandboxes and CI

A sandboxed or CI runner typically sets `PI_OFFLINE=1` and starts from a fresh
`PI_CODING_AGENT_DIR`. Offline, the startup request is skipped (see
[When the model list changes](#when-the-model-list-changes)), and a fresh directory has no list
saved from an interactive refresh, because pi never ran one there. So the provider offers **only**
the config's `fallbackModels` and config-added models: a model the gateway lists is not available
unless the config names it too.

Add every model the run uses, with its `api`:

```bash
export INFERENCE_GATEWAY_EXTRA_MODELS=claude-sonnet-5=anthropic-messages,gpt-6-luna=openai-responses
```

or as `models` entries with an `api` in `inference-gateway.json` in that directory. Per-model
`compat`, `thinkingLevelMap`, `contextWindow` and `maxTokens` need the file. A model left out
fails in one of two ways (see [Troubleshooting](troubleshooting.md)). If the provider offers at
least one other model, pi warns `Model "<id>" not found for provider "<provider>". Using custom
model id.` and uses the id with another gateway model's metadata, which may route it to the wrong
API. If the provider offers no model at all, pi fails with
`Model "<provider>/<id>" not found. Use --list-models to see available models.`
