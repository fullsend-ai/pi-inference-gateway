#!/usr/bin/env node
// A tiny local mock gateway, for end-to-end checks. No dependencies; it serves the same canned SSE
// the unit tests parse (src/test-fixtures.ts, loaded through Node's type stripping, Node >= 22.18).
//
//   node scripts/mock-gateway.mjs [port] [--auth live|basic|agentgateway]   # default port: a free one
//   node scripts/mock-gateway.mjs [port] --mode agentgateway                 # same as --auth agentgateway
//
// --auth live (default) and --auth basic behave like a front proxy that picks the backend from the
// request path:
//   GET  /v1/models            one list per format, like a gateway with a catalog per dialect:
//                              the OpenAI-format list (no `anthropic-version`) has only a Gemini
//                              model, owned_by "vertex"; the Anthropic-format list (with
//                              `anthropic-version`, the /v1/messages auth) only a Claude model
//   POST /v1/messages          Claude models
//   POST /v1/responses         GPT / o-series models, none of them listed
//   POST /v1/chat/completions  Gemini models
// plus one open-weight model, `oss/zai-org/glm-5-3`, that is unlisted, served on all three paths
// under the same id, and returns reasoning on each. Any other model/path pair is a 404.
//   live:  x-api-key ONLY on /v1/messages and the Anthropic-format list (Bearer is a 401), Bearer
//          everywhere else; the token is $MOCK_GATEWAY_TOKEN (default `test-token`)
//   basic: `Authorization: Basic base64(gateway:<password>)` on every path, /v1/models included; the
//          password is $MOCK_GATEWAY_PASSWORD (default `test-pass`) — the setup Praxis documents
//
// --auth agentgateway mimics agentgateway's `llm:` mode (github.com/agentgateway/agentgateway):
//   GET /v1/models, /v1/models/<anything>  a synthesised list, every entry owned_by "openai", plus a
//                                          literal `openai/*` wildcard entry
//                                          (one list, whatever the `anthropic-version` header)
//   Bearer only, on every path: x-api-key or no token → 401 text/plain
//                                          `authentication failure: no bearer token found`
//   routing by the body `model`; the path only picks the input format:
//     Claude on /v1/responses              → 400 text/plain `... unsupported conversion: from
//                                            Responses to provider anthropic (supported: [AnthropicMessages])`
//     Claude on /v1/chat/completions       → accepted (agentgateway translates it)
//     any other listed model, any path     → accepted; `openai/<name>` matches the wildcard
//     an unknown model                     → 404 JSON `model_not_found`
//
// Each request is logged as `<method> <path> auth=<header names> [anthropic-version] model=<id>`
// (auth shows header names and the authorization scheme only, never a value).

import { createServer } from "node:http";
import { sseFor } from "../src/test-fixtures.ts";

const TOKEN = process.env.MOCK_GATEWAY_TOKEN || "test-token";
const PASSWORD = process.env.MOCK_GATEWAY_PASSWORD || "test-pass"; // gitleaks:allow (mock default)
const args = process.argv.slice(2);
const flagValue = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const MODE = flagValue("--mode") ?? flagValue("--auth") ?? "live";
if (!["live", "basic", "agentgateway"].includes(MODE)) {
  console.error(`--auth/--mode must be live, basic or agentgateway, got ${MODE}`);
  process.exit(2);
}
const positional = args.filter((arg, index) => !arg.startsWith("--") && !["--auth", "--mode"].includes(args[index - 1]));
const port = Number(positional[0] ?? 0);
const BASIC = `Basic ${Buffer.from(`gateway:${PASSWORD}`, "utf8").toString("base64")}`;
const OPEN_WEIGHT = "oss/zai-org/glm-5-3";

/** The OpenAI-format list (`GET /v1/models` without `anthropic-version`). */
const LISTED = {
  object: "list",
  data: [{ id: "gemini-3.5-flash", object: "model", created: 0, owned_by: "vertex" }],
};

/** The Anthropic-format list (`GET /v1/models` with `anthropic-version`), Anthropic's list shape. */
const ANTHROPIC_LISTED = {
  data: [{ type: "model", id: "claude-sonnet-5", display_name: "Claude Sonnet 5", created_at: "2026-01-01T00:00:00Z" }],
  has_more: false,
  first_id: "claude-sonnet-5",
  last_id: "claude-sonnet-5",
};

const AGW_MODELS = ["claude-sonnet-5", "gpt-6-luna", "gemini-3.5-flash", OPEN_WEIGHT, "openai/*"];
const AGW_LISTED = {
  data: AGW_MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "openai" })),
  object: "list",
};

const ROUTES = {
  "/v1/messages": { auth: "x-api-key", serves: (model) => model.startsWith("claude-") },
  "/v1/responses": { auth: "bearer", serves: (model) => /^(gpt-|o\d)/.test(model) },
  "/v1/chat/completions": { auth: "bearer", serves: (model) => model.startsWith("gemini-") },
};

function authorized(headers, kind) {
  if (MODE === "basic") return headers.authorization === BASIC;
  if (MODE === "agentgateway") return headers.authorization === `Bearer ${TOKEN}`;
  return kind === "x-api-key" ? headers["x-api-key"] === TOKEN : headers.authorization === `Bearer ${TOKEN}`;
}

function describeAuth(kind) {
  if (MODE === "basic") return "Basic gateway:<password>";
  return kind === "x-api-key" ? "x-api-key" : "a bearer token";
}

/** The auth header names a request carried, plus the scheme of `authorization` (never its value). */
function authSummary(headers) {
  const names = ["authorization", "x-api-key"].filter((name) => headers[name] !== undefined);
  if (names.length === 0) return "none";
  return names.map((name) => (name === "authorization" ? `authorization(${authScheme(headers.authorization)})` : name)).join(",");
}

/** `Basic`, `Bearer` or `unknown` — never any part of the value itself. */
function authScheme(value) {
  const scheme = /^(\S+)\s/.exec(String(value))?.[1]?.toLowerCase();
  if (scheme === "basic") return "Basic";
  if (scheme === "bearer") return "Bearer";
  return "unknown";
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function sendText(response, status, text) {
  response.writeHead(status, { "content-type": "text/plain" });
  response.end(text);
}

function stream(response, pathname, model) {
  const reasoning = model === OPEN_WEIGHT ? `thinking about ${pathname}` : undefined;
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.end(sseFor(pathname, model, `hi from ${pathname} as ${model}`, reasoning));
}

/** agentgateway: one listener, the body's model picks the backend, the path only the input format. */
function agentgateway(request, response, pathname, model) {
  if (!authorized(request.headers)) return sendText(response, 401, "authentication failure: no bearer token found");
  if (request.method === "GET" && (pathname === "/v1/models" || pathname.startsWith("/v1/models/"))) {
    return send(response, 200, AGW_LISTED);
  }
  if (request.method !== "POST" || !ROUTES[pathname]) {
    return send(response, 404, { error: { message: `no route for ${request.method} ${pathname}` } });
  }
  const known = AGW_MODELS.includes(model) || (model.startsWith("openai/") && model.length > "openai/".length);
  if (!known || model.includes("*")) {
    return send(response, 404, { error: { message: "Model not found", code: "model_not_found" } });
  }
  if (model.startsWith("claude-") && pathname === "/v1/responses") {
    return sendText(
      response,
      400,
      "failed to process LLM request: unsupported conversion: from Responses to provider anthropic (supported: [AnthropicMessages])",
    );
  }
  return stream(response, pathname, model);
}

const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url ?? "/", "http://localhost");
  let model = "";
  if (request.method === "POST") {
    try {
      model = String(JSON.parse(await readBody(request)).model ?? "");
    } catch {
      model = "";
    }
  }
  const version = request.headers["anthropic-version"] !== undefined ? " anthropic-version" : "";
  console.log(`${request.method} ${pathname} auth=${authSummary(request.headers)}${version}${model ? ` model=${model}` : ""}`);

  if (MODE === "agentgateway") return agentgateway(request, response, pathname, model);

  if (request.method === "GET" && pathname === "/v1/models") {
    // The Anthropic-format list takes the same auth as /v1/messages.
    const anthropic = request.headers["anthropic-version"] !== undefined;
    const kind = anthropic ? ROUTES["/v1/messages"].auth : "bearer";
    if (!authorized(request.headers, kind)) return send(response, 401, { error: { message: `${describeAuth(kind)} required` } });
    return send(response, 200, anthropic ? ANTHROPIC_LISTED : LISTED);
  }

  const route = request.method === "POST" ? ROUTES[pathname] : undefined;
  if (!route) return send(response, 404, { error: { message: `no route for ${request.method} ${pathname}` } });
  if (!authorized(request.headers, route.auth)) {
    return send(response, 401, { error: { message: `${pathname} requires ${describeAuth(route.auth)}` } });
  }
  if (model !== OPEN_WEIGHT && !route.serves(model)) {
    return send(response, 404, { error: { message: `${model} is not served on ${pathname}` } });
  }
  return stream(response, pathname, model);
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  console.log(`mock gateway (mode: ${MODE}) listening on http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`);
});
