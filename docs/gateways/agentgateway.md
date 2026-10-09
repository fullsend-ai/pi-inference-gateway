# agentgateway

For anyone pointing the extension at agentgateway. Back to the [README](../../README.md).

[agentgateway](https://github.com/agentgateway/agentgateway) (Apache-2.0, Linux Foundation) is the
second gateway this extension is tested against, in its `llm:` config mode. Notes below are from
agentgateway at commit `9d36620d` (one week after v1.6.0); the walkthrough runs against the mock
gateway in this repo, started in its agentgateway mode.

## What you get

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

## Gateway side: must-haves

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

## Extension side

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

## Walkthrough (pi 1.0.2, mock gateway in agentgateway mode)

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

## Troubleshooting agentgateway

| Symptom | Cause | Fix |
|---|---|---|
| `401 authentication failure: no bearer token found` on Claude only | pi's native `x-api-key` on `/v1/messages` | `INFERENCE_GATEWAY_AUTH_HEADER=bearer` |
| `model discovery failed (model list request returned HTTP 401: ...)` | no token, a wrong or expired token, or a wrong audience | check the token file and the token's `aud` |
| `400 ... unsupported conversion: from Responses to provider anthropic (supported: [AnthropicMessages])` | a Claude model on `openai-responses` (an `api` in your config, or an old snapshot) | remove the `api`, or set `"anthropic-messages"` |
| `403` with a JSON "model authorization denied" error | a claim rule on that model refuses your token | the gateway's per-model `authorization` rules |
| `404 ... model_not_found` | an id the gateway does not serve, or a wildcard id | use an id from `--list-models`, or add a concrete one via `models` |
| `400 ... unknown variant ..., expected one of none, minimal, low, medium, high, xhigh, max` | a `reasoning_effort` value from a copied `thinkingLevelMap` | set it per model, see [Thinking levels](../compat.md#thinking-levels-thinkinglevelmap) |

These errors are `text/plain`; the extension shows the start of such a body in discovery errors
(credentials redacted, or `(body omitted)` when a credential is under 8 characters; see
[Security](../security.md)), and pi shows it for model requests (the walkthrough's two failure cases,
pasted from the mock):

```console
$ INFERENCE_GATEWAY_AUTH_HEADER= pi -ne -e . --no-session -p --model gateway/claude-sonnet-5 "say hi" </dev/null
401 authentication failure: no bearer token found
$ INFERENCE_GATEWAY_API_KEY=wrong-token-value pi -ne -e . --list-models
[pi-inference-gateway] gateway: model discovery failed (model list request returned HTTP 401: authentication failure: no bearer token found); using 2 fallback model(s) plus pi's last saved list
```

## Known incompatibilities

- Claude cannot be served on `/v1/responses` through agentgateway (a 400; the extension never sends
  it there unless you configure it).
- Claude over `/v1/chat/completions` works but loses signed-thinking replay.
- Non-streaming `/v1/responses` returns a 502 on an output item type agentgateway does not know. pi
  always streams, so it is not affected.
- `x-api-key` is never accepted for JWT auth; use Bearer.
- The classic `routes:` mode does not serve `/v1/models` (501); use the `llm:` mode.
- Gemini behind an agentgateway Vertex/Gemini provider is expected **not** to hit the
  [`thought_signature` limitation](../troubleshooting.md#known-limitations): agentgateway carries the signature inside
  the tool-call id (`<id>__thought__<signature>`), which pi replays verbatim. This is from
  agentgateway's source and has not been verified against a live Gemini model.
