# AGENTS.md

A [pi](https://github.com/earendil-works/pi) provider extension for any vendor-neutral inference
gateway (LiteLLM, agentgateway, an in-house proxy, ...). Registers provider `gateway` by default,
discovers the gateway's models from `GET /v1/models`, and routes each model to pi's own
`anthropic-messages`, `openai-responses` or `openai-completions` transport.
**This repo is public.**

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing anything — it covers the layout, how
discovery and per-model routing work, and the pi-specific gotchas behind each decision. The rules
below are the short form.

## Commands

```bash
npm ci          # installs pi as a devDependency; tsc and the tests need its types
npm run ci      # lint + test — must pass before any commit
```

`npm ci` installs the lockfile's pi (0.99.2). CI runs against each pi version in its matrix
(0.99.2, which is what fullsend's sandbox runs, and 1.1.0); check both explicitly before pushing:

```bash
npm install --no-save --ignore-scripts @earendil-works/pi-ai@1.1.0 @earendil-works/pi-coding-agent@1.1.0
npm run ci
npm ci   # back to the lockfile's 0.99.2
npm run ci
```

## Rules

- **Zero runtime dependencies.** Node built-ins and pi's own peers only. Never add an
  `@anthropic-ai/*` or `openai` package — pi's transports already contain those SDKs.
- **Never re-implement a protocol or mirror pi internals.** Streaming, tool calls, thinking and
  usage stay in pi's lazy transports from `@earendil-works/pi-ai/compat`. If a change starts
  requiring a copy of pi's source, stop and reconsider.
- **Never cast at `createProvider()`.** `Model`, `AuthResult`, `ApiKeyAuth`, `ProviderStreams`
  and `RefreshModelsContext` come from `@earendil-works/pi-ai`. Fix type errors; never silence
  them with `as never`, `as any` or `@ts-ignore`.
- **Import only from pi's allowlisted specifiers**: `@earendil-works/pi-ai`, `.../compat`,
  `.../oauth`, `.../providers/all`, `@earendil-works/pi-coding-agent`. Any other subpath fails to
  load — silently, since pi drops a failed extension from `--list-models` without printing anything.
  Use `import type` for `ExtensionAPI`; nothing here needs a runtime value from the coding agent.
- **Relative imports carry `.ts`** (`./config.ts`). pi runs Node in strip-only mode, which does not
  resolve extensionless specifiers.
- **Trust `node_modules/@earendil-works/pi-ai/dist/**/*.d.ts`, not pi's prose docs**, including for
  which entry point declares a name (`getBuiltinModels` is on `/providers/all`, the transports on
  `/compat`, `createProvider` on the root).
- **Auth is ambient: `auth.apiKey` with no `login`, never `auth.oauth`.** Credentials come from
  environment variables or files re-read on every request; `resolve()` returns `undefined` when
  none is set. The wire header always comes from `createGatewayFetch` (per-target scheme: bearer,
  raw header, or basic), never from pi's `apiKey`.
- **Never log a credential**, not even a username. Warnings name variables and files only.
- **`INFERENCE_GATEWAY_*` credentials are bound to `INFERENCE_GATEWAY_BASE_URL`**
  (`bindEnvCredentials`). Do not weaken that, and never read a project-level `.pi/` config.
- **Every transport stays wrapped** so inference requests use `redirect: "error"`.
- **No shell-out, no `!command` keys, no literal secrets** in code, config examples, docs or tests.
  A config file references keys by variable name (`apiKeyEnv`) or path (`tokenFile`) only.
- **No third-party catalog fetch** (no models.dev or similar). Metadata comes from the gateway, then
  pi's built-in catalog.
- **Model ids are the gateway's ids, verbatim** — `vendor/model` included. Only the pi-catalog lookup
  strips a vendor prefix.
- **No dependency-specific workarounds in code.** A gateway, backend or pi-transport problem is
  handled by config the user sets (`compat`, `thinkingLevelMap`, `contextWindow`, `maxTokens`,
  `authHeader` per model or API), a README troubleshooting entry, and an upstream issue to the
  dependency that owns the bug. No branch keyed on a vendor, model id or backend unless it routes or
  describes models; record every such branch in PLAN.md, "Generality audit".
- **Sanitise everything from the wire** — see `LIMITS` in `src/discovery.ts`. Never follow a redirect
  on discovery (`redirect: "error"`): it would carry the token to another origin.
- **Silence when unconfigured.** No base URL in the environment and no config file means no output
  and no provider. Warn only about configuration the user actually wrote.
- **Re-test other providers after any provider/model change** with `pi --list-models`: one bad entry
  breaks every registered provider, not just this one.
- **No host names, tokens, project ids or employer names** in code, tests or docs — tests use
  `example.com` and `127.0.0.1`.
- **Erasable TypeScript only** (pi uses Node strip-only mode): no `enum`, `namespace`, or parameter
  properties (`erasableSyntaxOnly` enforces it). Top-level imports only. No `any`.
- **Direct dependencies are pinned to exact versions.** Refresh the lockfile with
  `npm install --package-lock-only --ignore-scripts`.

## Before you commit

- `npm run ci` passes on every pi version in the CI matrix.
- `node scripts/mock-gateway.mjs` (and `--auth basic`) plus `pi -ne -e . --list-models` and one
  `pi -p` per transport (see CONTRIBUTING.md, "Local end-to-end") after any change to discovery,
  routing or auth. Use a throwaway `PI_CODING_AGENT_DIR`.
- The global secret scanner flags test fixtures such as `password: "test-pass"`. Mark a reviewed
  false positive with an inline `// gitleaks:allow (...)` comment; never skip the hook.
- Claims about pi or a gateway need a source: the shipped `.d.ts`, a live call, or vendor docs.
- Commit format `{feat,fix,docs,test,chore}: <message>`, no emojis, and
  `Signed-off-by: <name> <email>` (`git commit -s`).
