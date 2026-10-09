#!/usr/bin/env node
// A tiny local mock of a path-routed gateway, for end-to-end checks. No dependencies; it serves the
// same canned SSE the unit tests parse (src/test-fixtures.ts, loaded through Node's type stripping,
// Node >= 22.18).
//
//   node scripts/mock-gateway.mjs [port]        # default: a free port, printed on start
//
// It behaves like a front proxy that picks the backend from the request path:
//   GET  /v1/models            Bearer; lists only a Claude and a Gemini model, both owned_by "vertex"
//   POST /v1/messages          x-api-key ONLY (Bearer is a 401); Claude models
//   POST /v1/responses         Bearer; GPT / o-series models, none of them listed
//   POST /v1/chat/completions  Bearer; Gemini models
// plus one open-weight model, `oss/zai-org/glm-5-3`, that is unlisted, served on all three paths
// under the same id, and returns reasoning on each. Any other model/path pair is a 404.
// Each request is logged as `<method> <path> auth=<header names> model=<id>`.

import { createServer } from "node:http";
import { sseFor } from "../src/test-fixtures.ts";

const TOKEN = process.env.MOCK_GATEWAY_TOKEN || "test-token";
const port = Number(process.argv[2] ?? 0);
const OPEN_WEIGHT = "oss/zai-org/glm-5-3";

const LISTED = {
  object: "list",
  data: [
    { id: "claude-sonnet-5", object: "model", created: 0, owned_by: "vertex" },
    { id: "gemini-3.5-flash", object: "model", created: 0, owned_by: "vertex" },
  ],
};

const ROUTES = {
  "/v1/messages": { auth: "x-api-key", serves: (model) => model.startsWith("claude-") },
  "/v1/responses": { auth: "bearer", serves: (model) => /^(gpt-|o\d)/.test(model) },
  "/v1/chat/completions": { auth: "bearer", serves: (model) => model.startsWith("gemini-") },
};

function authorized(headers, kind) {
  return kind === "x-api-key" ? headers["x-api-key"] === TOKEN : headers.authorization === `Bearer ${TOKEN}`;
}

function authHeaderNames(headers) {
  return ["authorization", "x-api-key"].filter((name) => headers[name] !== undefined).join(",") || "none";
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
  console.log(`${request.method} ${pathname} auth=${authHeaderNames(request.headers)}${model ? ` model=${model}` : ""}`);

  if (request.method === "GET" && pathname === "/v1/models") {
    if (!authorized(request.headers, "bearer")) return send(response, 401, { error: { message: "bearer token required" } });
    return send(response, 200, LISTED);
  }

  const route = request.method === "POST" ? ROUTES[pathname] : undefined;
  if (!route) return send(response, 404, { error: { message: `no route for ${request.method} ${pathname}` } });
  if (!authorized(request.headers, route.auth)) {
    return send(response, 401, { error: { message: `${pathname} requires ${route.auth === "x-api-key" ? "x-api-key" : "a bearer token"}` } });
  }
  const openWeight = model === OPEN_WEIGHT;
  if (!openWeight && !route.serves(model)) {
    return send(response, 404, { error: { message: `${model} is not served on ${pathname}` } });
  }
  const reasoning = openWeight ? `thinking about ${pathname}` : undefined;
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.end(sseFor(pathname, model, `hi from ${pathname} as ${model}`, reasoning));
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  console.log(`mock gateway listening on http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`);
});
