# Routing

For anyone who wants to know which API a model is sent over, or needs to change it. Back to the
[README](../README.md).

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
everything: [agentgateway](gateways/agentgateway.md) lists every model, Claude included, as
`owned_by: "openai"`.

Catalog lookups also try the id without a `vendor/` prefix and with `-`/`.` swapped between digits,
so `oss/zai-org/glm-5-3` finds pi's `glm-5.3`. The gateway's id is always what is sent back.

Model metadata (context window, max output, reasoning, image input, cost) comes from the config,
then the gateway's own fields (`context_window`, `max_input_tokens`, `max_output_tokens`,
`supports_vision`, `supports_reasoning`, LiteLLM-style `input_cost_per_token`, ...), then pi's
built-in catalog, then defaults (128K context, 16K output, text only, no reasoning, zero cost).

## Which API to pick

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
[agentgateway](gateways/agentgateway.md)).

**If the gateway mostly serves open-weight or custom models**, set
`INFERENCE_GATEWAY_DEFAULT_API=openai-completions` (or `"defaultApi": "openai-completions"` in the
config file). Models that nothing identifies fall through to `defaultApi` (rule 7). That covers most
custom and fine-tuned models. The default, `openai-responses`, suits GPT, but Chat Completions is
the API that open-weight servers implement most widely.

**Sending reasoning back each turn matters more than the endpoint.** In multi-turn agent work, a
thinking model needs its own reasoning back every turn. pi does this on Chat Completions: it replays
a thinking block in the field it arrived in (`reasoning_content`, `reasoning` or `reasoning_text`),
or as `reasoning_details` when the response included them (pi-ai 0.99.2 and 1.1.0). So open-weight
models lose nothing there. GLM ids that match pi's Z.ai catalog entries (for example `glm-5.3`) also
inherit pi's `zai` thinking format, which sends `clear_thinking: false`. For other GLM ids, setting
`compat.thinkingFormat: "zai"` is not enough: pi only shapes the request for Z.ai when the model
has `reasoning: true`, and the gateway's `supports_reasoning` or `reasoning` field, or
`models[id].reasoning: true`, has to supply that. Route the model to `openai-completions` and use a
thinking level other than off, since `clear_thinking: false` is sent only when a reasoning effort is
set. For example:

```json
"models": { "my-glm": { "api": "openai-completions", "reasoning": true, "compat": { "thinkingFormat": "zai" } } }
```

On one open-weight deployment (a GLM model served by vLLM, pi 1.1.0), the same three-step tool task
with thinking at `medium` ran three times per API. All nine runs answered correctly. Mean wall time
was 12.7 s on Chat Completions, 15.8 s on Responses, and 18.8 s on Messages (with
`forceAdaptiveThinking`). With three runs per API, these numbers only hint at speed. They do not
show any difference in quality.
