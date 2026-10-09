# Troubleshooting

For anyone whose models are missing or whose requests fail, plus the known limitations. Back to the
[README](../README.md).

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
`INFERENCE_GATEWAY_BASE_URL`. Give it a variable of its own, or fix the URL (see [Security](security.md)).

**`providers.<id>: "baseUrlEnv" names <VAR>, which is unset or empty; skipped`.** The provider takes
its base URL from that variable (see [Sharing the config file](configuration.md#sharing-the-config-file)).
Export it in the shell that starts pi, or set a literal `baseUrl` for this provider in
`inference-gateway.local.json`. When the variable is set but invalid, the warning says so without
printing its value.

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

For agentgateway-specific errors, see
[Troubleshooting agentgateway](gateways/agentgateway.md#troubleshooting-agentgateway).

## Known limitations

- **Gemini tool calls over `/v1/chat/completions` fail after the first turn** on a gateway that
  passes Gemini's OpenAI-compatible responses through. Gemini attaches a `thought_signature` to each
  tool call (`message.extra_content.google.thought_signature`) and requires it back on the next
  request. pi's chat-completions transport (pi-ai 0.99.2 through 1.1.0) neither reads nor replays
  that field, so turn 2 is rejected with `400 Function call is missing a thought_signature in
  functionCall parts` (confirmed live on a path-routed gateway, pi 0.99.2 and 1.1.0). Single-turn
  prompts and text replies work. The fix belongs in pi's transport; gateways that carry the
  signature in the tool-call id, such as [agentgateway](gateways/agentgateway.md), are expected to be
  unaffected.
- **Inherited `compat` flags may not suit your gateway** — see
  [Request features (`compat`)](compat.md#request-features-compat).
