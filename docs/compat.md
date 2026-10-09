# Request features and thinking levels

For anyone whose gateway rejects a request field or a thinking level that pi sends. Back to the
[README](../README.md).

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
[Troubleshooting](troubleshooting.md).
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
