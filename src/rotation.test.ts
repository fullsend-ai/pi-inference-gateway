// A long run on short-lived tokens: one provider keeps sending requests while a refresher rotates
// its tokenFile, against the mock gateway (scripts/mock-gateway.mjs) in token TTL mode on loopback.
// Exercises the refresher recipe in docs/configuration.md and createGatewayFetch's single 401 retry.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeContext } from "@earendil-works/pi-ai";
import type { Context, FetchFunction } from "@earendil-works/pi-ai";
import type { GatewayConfig } from "./config.ts";
import { buildModel, parseModelEntry } from "./discovery.ts";
import { gatewayStreams } from "./provider.ts";

const MOCK = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "mock-gateway.mjs");
/** Token lifetime the mock enforces; the refresher rotates well inside it, like 4 min for 5 min. */
const TTL_MS = 1_000;
const REFRESH_MS = 300;
/** Requests spaced so the run spans several rotations (and several token lifetimes). */
const REQUESTS = 20;
const SPACING_MS = 150;
const MODEL_ID = "gemini-3.5-flash";
const CONTEXT = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] } satisfies Context);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts the mock gateway in TTL mode and resolves with its base URL; every output line is kept. */
async function startMock(lines: string[]): Promise<{ child: ChildProcess; baseUrl: string }> {
  const env: Record<string, string | undefined> = { ...process.env, MOCK_GATEWAY_TOKEN_TTL_MS: String(TTL_MS) };
  delete env.MOCK_GATEWAY_TOKEN;
  const child = spawn(process.execPath, [MOCK, "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const collect = (stream: NodeJS.ReadableStream | null) => {
    let pending = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      pending += chunk;
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      lines.push(...parts);
    });
  };
  collect(child.stdout);
  collect(child.stderr);
  const baseUrl = await new Promise<string>((resolveUrl, reject) => {
    // Every failure path stops both timers and the child, so a mock that never starts cannot keep
    // the test process alive.
    const fail = (error: Error) => {
      clearInterval(poll);
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`mock gateway did not start: ${lines.join(" | ")}`)), 10_000);
    const poll = setInterval(() => {
      const url = lines.map((line) => /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(line)?.[1]).find(Boolean);
      if (!url) return;
      clearInterval(poll);
      clearTimeout(timer);
      resolveUrl(url);
    }, 20);
    child.once("exit", (code) => fail(new Error(`mock gateway exited (${code}): ${lines.join(" | ")}`)));
    child.once("error", (error) => fail(new Error(`mock gateway failed to start: ${error.message}`)));
  });
  child.removeAllListeners("exit");
  child.removeAllListeners("error");
  return { child, baseUrl };
}

/**
 * The recipe's refresher: mint a `ttl-<expiresAtMs>-<random>` token, write it to a temp file in the
 * token file's directory (mode 0600), then rename it over the token file. Every token is kept so
 * the test can check none leaked.
 */
function refresher(tokenFile: string) {
  const minted: string[] = [];
  let timer: NodeJS.Timeout | undefined;
  let rotating: Promise<void> = Promise.resolve();
  let failure: unknown;
  let writes = 0;
  const rotate = async () => {
    const token = `ttl-${Date.now() + TTL_MS}-${randomBytes(12).toString("hex")}`;
    minted.push(token);
    const temp = join(dirname(tokenFile), `.gateway-token.${process.pid}.${writes++}`);
    await writeFile(temp, `${token}\n`, { mode: 0o600 });
    await rename(temp, tokenFile);
    return token;
  };
  return {
    minted,
    rotate,
    start: () => {
      // Rotations are chained, so a slow write cannot rename an older token over a newer one, and
      // a failed write fails the test at stop() instead of surfacing as an unhandled rejection.
      timer = setInterval(() => {
        rotating = rotating.then(rotate).then(
          () => undefined,
          (error: unknown) => {
            failure ??= error;
          },
        );
      }, REFRESH_MS);
    },
    /** Stops the interval, waits for any rotation still in flight, and rethrows the first failure. */
    stop: async () => {
      clearInterval(timer);
      await rotating;
      if (failure !== undefined) throw failure;
    },
    latestExpiry: () => Number(/^ttl-(\d+)-/.exec(minted[minted.length - 1] ?? "")?.[1] ?? 0),
  };
}

describe("tokenFile rotation over a long run (mock gateway, token TTL mode)", () => {
  const mockLines: string[] = [];
  const warnings: string[] = [];
  let child: ChildProcess | undefined;
  let baseUrl = "";
  let dir = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "gw-rotation-"));
    ({ child, baseUrl } = await startMock(mockLines));
  });

  after(async () => {
    child?.kill();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("every request succeeds, an expired token is rescued by one retry, and no token is logged", async () => {
    const tokenFile = join(dir, "gateway-token");
    const refresh = refresher(tokenFile);
    const config: GatewayConfig = {
      id: "gateway",
      baseUrl,
      tokenFile,
      authHeaders: {},
      defaultApi: "openai-completions",
      headers: {},
      modelsPath: "/v1/models",
      include: [],
      exclude: [],
      models: {},
      fallbackModels: [],
    };
    const entry = parseModelEntry({ id: MODEL_ID, api: "openai-completions" });
    assert.ok(entry);
    const model = buildModel(entry, config);
    const streams = gatewayStreams(config, { env: {}, warn: (message) => warnings.push(message) });

    // Every wire request of one logical request: the status and whether its token had expired.
    // Tokens are compared in memory only; nothing here prints one.
    type Sent = { status: number; expired: boolean };
    const send = async (beforeDial?: () => Promise<void>): Promise<{ sent: Sent[]; stopReason: string; error?: string }> => {
      const sent: Sent[] = [];
      let hooked = false;
      const fetch: FetchFunction = async (input, init) => {
        const header = new Headers(init?.headers).get("authorization") ?? "";
        const expiresAt = Number(/^Bearer ttl-(\d+)-/.exec(header)?.[1] ?? 0);
        const expired = expiresAt <= Date.now();
        if (beforeDial && !hooked) {
          hooked = true;
          await beforeDial();
        }
        const response = await globalThis.fetch(input, init);
        sent.push({ status: response.status, expired });
        return response;
      };
      const message = await streams["openai-completions"].streamSimple(model, CONTEXT, { apiKey: "unused", fetch, maxRetries: 0 }).result();
      return { sent, stopReason: message.stopReason, ...(message.errorMessage ? { error: message.errorMessage } : {}) };
    };

    // The first token is written before anything is sent, as the recipe does before starting pi.
    await refresh.rotate();
    refresh.start();
    const results: Array<Awaited<ReturnType<typeof send>>> = [];
    const started = Date.now();
    try {
      for (let index = 0; index < REQUESTS; index++) {
        if (index === REQUESTS / 2) {
          // Forced boundary case: the refresher pauses until the current token has expired, the
          // request reads that expired token, and the refresher writes the next one before the
          // request reaches the gateway — the 401 then has a fresh token to retry with.
          await refresh.stop();
          await sleep(Math.max(0, refresh.latestExpiry() - Date.now()) + 50);
          results.push(await send(async () => void (await refresh.rotate())));
          refresh.start();
        } else {
          results.push(await send());
        }
        await sleep(SPACING_MS);
      }
    } finally {
      await refresh.stop();
    }
    const elapsed = Date.now() - started;

    assert.ok(elapsed >= 3 * TTL_MS, `the run spans several token lifetimes (${elapsed} ms)`);
    assert.ok(refresh.minted.length >= 8, `the token rotated several times (${refresh.minted.length} tokens)`);
    for (const [index, result] of results.entries()) {
      assert.equal(result.stopReason, "stop", `request ${index} failed: ${result.error ?? "no reason given"}`);
      assert.ok(result.sent.length >= 1 && result.sent.length <= 2, `request ${index} was sent ${result.sent.length} times`);
      assert.equal(result.sent[result.sent.length - 1].status, 200, `request ${index} ends in 200`);
      if (result.sent.length === 2) {
        assert.deepEqual(
          result.sent.map((entry) => entry.status),
          [401, 200],
          `request ${index} is retried only after a 401`,
        );
      }
    }
    const rescued = results.filter((result) => result.sent.length === 2 && result.sent[0].expired && !result.sent[1].expired);
    assert.ok(rescued.length >= 1, "at least one request went out with an expired token and was rescued by the retry");
    assert.deepEqual(
      results[REQUESTS / 2].sent,
      [
        { status: 401, expired: true },
        { status: 200, expired: false },
      ],
      "the forced boundary request: expired token → 401, one retry with the new token → 200",
    );

    // The mock saw exactly the wire requests counted above (its log can trail the responses
    // through the pipe), and nobody logged a token.
    const wire = results.reduce((sum, result) => sum + result.sent.length, 0);
    const posts = () => mockLines.filter((line) => line.startsWith("POST /v1/chat/completions ")).length;
    for (let waited = 0; posts() < wire && waited < 2_000; waited += 20) await sleep(20);
    assert.equal(posts(), wire);
    for (const line of [...warnings, ...mockLines]) {
      assert.ok(!/ttl-\d/.test(line), `a log line carries token text: ${line.replace(/ttl-\S+/g, "<redacted>")}`);
      for (const token of refresh.minted) assert.ok(!line.includes(token), "a log line carries a minted token");
    }
  });
});
