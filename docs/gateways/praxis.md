# Praxis

For anyone pointing the extension at a Praxis deployment. Back to the [README](../../README.md).

[Praxis](https://github.com/praxis-proxy/praxis) (its AI gateway lives in `praxis-proxy/ai`) is the
main gateway this extension is built for. Praxis's own documented clients are each pinned to one
API: Codex to Responses, Claude Code to Messages, OpenCode to Chat Completions. Through this
extension, one pi provider reaches all three. The walkthrough below runs against the mock gateway in
this repo, started in its Praxis-style Basic mode; swap the base URL for your deployment's.

## Pick your auth setup

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

## Name the provider `praxis`

The package and the default provider id stay generic (`gateway`). Locally you can call it what you
like:

```bash
export INFERENCE_GATEWAY_PROVIDER_ID=praxis      # model specs become praxis/<model>, e.g. praxis/claude-sonnet-5-5
```

## Add the models `/v1/models` does not list

Praxis passes `GET /v1/models` through to **one** backend without merging, so the list is partial by
design. Add the rest in `~/.pi/agent/inference-gateway.json` with the API each one is served on:
Claude on Messages, GPT on Responses, Gemini and open-weight models on Chat Completions. Ids are sent
to Praxis verbatim, `vendor/org/model` included.

## Walkthrough (pi 1.0.2, mock gateway in Basic mode)

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

## Known limits with Praxis

- Gemini tool calls on `/v1/chat/completions` may fail after the first turn: pi does not replay
  Gemini's `thought_signature` (see [Known limitations](../troubleshooting.md#known-limitations)).
- Models inherit pi's catalog `compat` flags; if Praxis or its backend rejects a request field, turn
  the flag off per model ([Request features (`compat`)](../compat.md#request-features-compat)).
