# Contributing

## Setup

```bash
npm ci          # installs pi 0.99.2 as a devDependency — tsc and the tests need its types
npm run ci      # lint + test; must pass before any commit
```

Point your local pi at a checkout while developing:

```bash
ln -s "$PWD" ~/.pi/agent/extensions/pi-inference-gateway
```

Symlink the **directory**, not a file: pi resolves an extension's imports from the path it loaded it
by.

## Layout

```
├── package.json            # "pi": { "extensions": ["./src/index.ts"] }; zero runtime dependencies
├── src/
│   ├── config.ts           # env + inference-gateway.json → GatewayConfig[]; token resolution
│   ├── discovery.ts        # fetch /v1/models, parse + sanitise, pick a transport, fill metadata
│   ├── provider.ts         # createProvider wiring, auth, header override, refresh, registration
│   ├── index.ts            # thin default export + /gateway-refresh
│   ├── test-fixtures.ts    # canned SSE per transport, shared with the mock gateway
│   └── *.test.ts           # node --test; no network, no pi process
├── scripts/mock-gateway.mjs  # local path-routed gateway for end-to-end runs
└── .github/workflows/      # ci.yml (pi matrix), release.yml (tag → release with tarball digest)
```

Everything is a pure export taking its ambient inputs (env, file reader, `fetch`) as parameters, so
the suite runs with no network and no credentials.

## How it works

```
extension factory (awaited by pi before startup)
  loadConfig()            env INFERENCE_GATEWAY_* + ~/.pi/agent/inference-gateway.json
  initialModels()         GET {baseUrl}/v1/models, 5 s, redirect: "error", 1 MiB cap
    parseModelList()      {data:[...]} | {models:[...]} | [...]; sanitise; cap 1000
    buildModel()          selectApi() + metadata merge; id kept verbatim
    + config-added models (models[id] with an api the list lacks)
  createProvider({ models, fetchModels, auth.apiKey, api: { anthropic-messages, openai-responses,
                   openai-completions } })
  registerProvider()
```

### Why discovery runs in the factory

pi refreshes dynamic model lists from the network only in interactive and RPC sessions. `pi -p` and
`pi --list-models` refresh with `allowNetwork: false` (cache only), so a provider that relied on
`fetchModels` alone would have **no models** in a fresh sandbox running `pi -p`. pi awaits async
extension factories, so the factory discovers with a short timeout and passes the result as static
`models`. `fetchModels` is still set, for interactive refreshes and `/gateway-refresh`.

createProvider restores pi's persisted snapshot over the static list on every refresh, offline ones
included, which would bring back models the gateway has dropped. After a successful load-time
discovery `createGatewayProvider()` withholds that snapshot; after a failed one it is the fallback.

### One provider, three transports

`createProvider`'s `api` may be a map keyed by `model.api`. Each entry is pi's own lazy transport
from `@earendil-works/pi-ai/compat` (`anthropicMessagesApi`, `openAIResponsesApi`,
`openAICompletionsApi` — note the casing). Base URLs come from one root: the OpenAI transports get
`{root}/v1` (they append `/responses` or `/chat/completions`), the Anthropic SDK gets `{root}` (it
appends `/v1/messages`).

### Auth headers

Each transport keeps its native header: `x-api-key` for Messages, `authorization: Bearer` for the
OpenAI transports, Bearer for discovery. Gateways disagree about this per path — a path-routing
front proxy in front of a Claude backend accepts only `x-api-key` on `/v1/messages`, while other
gateways want Bearer everywhere — so the header is an optional per-target override. Only an
overridden transport is wrapped by `withAuthHeader()`, which composes a `fetch` *underneath* pi's
(`options.fetch` stays the transport that dials), removes both auth headers and sets the configured
one.

### Transport selection and metadata

See README, "How each model gets its API", for the order. Two points behind it:

- **Hosting owners are no signal.** A proxy reports `owned_by: "vertex"` for Claude and Gemini
  alike, so `AMBIGUOUS_OWNERS` are skipped.
- **The `claude-` rule runs before "any other catalog provider → completions".** pi's aggregator
  catalogs (`github-copilot`, `opencode`, `openrouter`, `vercel-ai-gateway`) list Claude ids too, and
  the lookup normalises `-`/`.`; without this order a Claude id missing from pi's `anthropic` catalog
  would go to `/v1/chat/completions`.

Metadata is merged per field: config → gateway fields → pi's built-in model → defaults. `compat` and
`thinkingLevelMap` are copied only from a catalog entry on the **same** transport (they describe how
that transport shapes a request), and `allowedFallbackModels` never: pi turns it into a `fallbacks`
body field, which non-Anthropic Claude hosts reject with a 400.

## The CI matrix replaces a compat file

`ci.yml` runs the suite against each supported pi version (`0.99.2`, fullsend's sandbox pin, and
`1.1.0`) by installing it over the lockfile's:

```bash
npm install --no-save --ignore-scripts @earendil-works/pi-ai@$V @earendil-works/pi-coding-agent@$V
npm run ci
```

Because nothing here mirrors pi internals, a pi release can break it only through the public
surface the tests call. Add the new version when pi releases; move the older one when fullsend moves
its pin.

## Gotchas

**Import only from pi's allowlisted specifiers**: `@earendil-works/pi-ai`, `.../compat`, `.../oauth`,
`.../providers/all`, `@earendil-works/pi-coding-agent`. Anything else falls through to filesystem
resolution and the extension fails to load — silently.

**Check which entry point declares a name, in the `.d.ts`.** The transports are on `/compat`,
`getBuiltinModels` / `getBuiltinProviders` on `/providers/all`, `createProvider` and `hasApi` on the
root. `ProviderModel` is not exported; `Model<GatewayApi>` is what the lists use.

**Relative imports carry `.ts`.** pi runs Node in strip-only mode, which resolves no extensionless
specifiers.

**Use `import type` for `ExtensionAPI`.** A value import drags in pi-coding-agent's server code and
fails under `node --test`.

**`auth.apiKey` with no `login`, never `auth.oauth`.** `oauth` makes pi wait for a persisted
interactive credential and fails on every fresh machine.

**One malformed model breaks every provider.** pi's model resolution iterates all providers' models.
After any change, run `pi --list-models` and check the *other* providers still list.

**A failed extension is silent.** Finish every change with `pi -ne -e . --list-models`.

## Testing

`npm test` runs `node --test src/*.test.ts`. The tests that check this code against **pi's**
expectations rather than ours:

1. `end to end through pi's transports` (provider.test.ts) drives the real provider from
   `createProvider(gatewayProviderOptions(...))` with a recording `fetch` and canned SSE, and asserts
   path, method, the single auth header and the verbatim id per transport. Revert the `api` map to
   bare transports and the override cases fail.
2. `one open-weight model routed through every API, with reasoning` checks that raw reasoning in
   each protocol comes back as a pi thinking block.
3. Catalog tests run against the **real** `getBuiltinModels()` output, so they keep asserting
   something true after a pi bump.

## Local end-to-end

```bash
node scripts/mock-gateway.mjs 47811 &
export PI_CODING_AGENT_DIR=$(mktemp -d)       # throwaway: never touch your real ~/.pi
export INFERENCE_GATEWAY_BASE_URL=http://127.0.0.1:47811 INFERENCE_GATEWAY_API_KEY=test-token
cat > "$PI_CODING_AGENT_DIR/inference-gateway.json" <<'EOF'
{ "providers": { "gateway": { "baseUrl": "http://127.0.0.1:47811",
  "models": { "gpt-6-luna": { "api": "openai-responses" },
              "oss/zai-org/glm-5-3": { "api": "openai-completions" } } } } }
EOF
pi -ne -e . --list-models
pi -ne -e . --no-session -p --model gateway/claude-sonnet-5 "say hi"
pi -ne -e . --no-session -p --model gateway/gemini-3.5-flash "say hi"
pi -ne -e . --no-session -p --model gateway/gpt-6-luna "say hi"
pi -ne -e . --no-session -p --model gateway/oss/zai-org/glm-5-3 "say hi"
```

The mock logs `<method> <path> auth=<header names> model=<id>` per request. Run the same against the
oldest pi in the matrix:

```bash
mkdir -p /tmp/pi0992 && npm --prefix /tmp/pi0992 install --ignore-scripts @earendil-works/pi-coding-agent@0.99.2
node /tmp/pi0992/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js -ne -e . --list-models
```

## Before you commit

- `npm run ci` passes on **every** matrix version, and the local end-to-end above still works.
- Claims about pi or a gateway need a source: the shipped `.d.ts`, a live call, or vendor docs.
- Commit format `{feat,fix,docs,test,chore}: <message>`, no emojis, signed off (`git commit -s`).

## Releasing

Set `version` in `package.json` in a PR (refresh the lockfile with
`npm install --package-lock-only --ignore-scripts`), merge it, then tag that merge commit:

```bash
git switch main && git pull
VERSION="v$(node -p 'require("./package.json").version')"
git tag -a "$VERSION" -m "$VERSION"
git push origin "$VERSION"
```

`release.yml` re-runs lint and tests, computes the SHA256 of the tag tarball and publishes a release
whose notes carry the tarball URL and digest. There is no npm publish step: consumers use
`pi install git:...`, so the git tag is the artifact.

## Prior art

[fullsend-ai/pi-anthropic-vertex](https://github.com/fullsend-ai/pi-anthropic-vertex) is the
sibling this layout, CI matrix and rule set come from: one protocol (Anthropic Messages) on one host,
with a request rewrite. This extension rewrites nothing but, optionally, the auth header.
