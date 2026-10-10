# Security

For anyone who needs to know where credentials go and what the extension never reads, follows or
logs. Back to the [README](../README.md).

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

  Give any other gateway a variable of its own (`apiKeyEnv`, `passwordEnv`). An overlay that changes
  a provider's URL keeps the `apiKeyEnv`, `passwordEnv` and `usernameEnv` it inherits from the
  shared file, so if the new gateway needs a different credential, set its own variable in the
  overlay.
- **Only your user-level config is read**: `~/.pi/agent/inference-gateway.json` and its local
  overlay `inference-gateway.local.json`, or the same files under `$PI_CODING_AGENT_DIR`, merged
  over the same two files in the extension's own install directory (see
  [Shipping a config with the extension](configuration.md#shipping-a-config-with-the-extension)).
  When `INFERENCE_GATEWAY_CONFIG_FILE` is set, only the file it names is read, none of those (see
  [One exact config file](configuration.md#one-exact-config-file)). The host that starts pi sets it
  in the process environment. A project's `.pi/` directory is still never consulted, so a cloned
  repository cannot point your credentials at its own host. An agent that can already change pi's
  process environment can already change every `INFERENCE_GATEWAY_*` variable, so this variable
  adds no new way in. Its purpose is to let a host point pi at a file the agent cannot write, which
  closes the gap between the host's check of the file and pi's read of it. A provider whose
  `baseUrlEnv` resolves to another URL than `INFERENCE_GATEWAY_BASE_URL` is refused
  `INFERENCE_GATEWAY_*` credentials exactly like a literal `baseUrl`.
- **No secrets in the file.** Keys and passwords are referenced by variable name or file path; a
  literal `apiKey` or `password`, or an `authorization`/`x-api-key` entry in `headers`, is refused.
  No `!command` keys, no shell-out.
- **Redirects are never followed**, on model requests or on discovery: a redirect is an error, so a
  key cannot be forwarded to another origin.
- **Credentials are never logged.** Warnings name variables and files, never their values. A
  discovery error shows the start of a `text/plain` error body (or of a UTF-8 body sent without a
  content-type) only after replacing the credentials it sent: the token, the Basic username,
  password, `user:password` pair and its base64, and the auth header value, each in its literal,
  JSON-escaped and percent-encoded form. If any credential is shorter than 8 characters (Basic's
  default username `gateway` is 7), the body is replaced by `(body omitted)`. A body that has
  control characters other than tab, line feed and carriage return (as UTF-16 text has) is not
  shown at all, so a credential in such an encoding is dropped rather than shown. Other
  encodings of a credential are not recognised.
- **Model-request error bodies are printed by pi, not by this extension**, and are not redacted:
  a gateway or backend that echoes the request's credentials in an error can expose them there.
