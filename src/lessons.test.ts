// Lessons from other pi gateway extensions (research doc "pi-inference-gateway: Lessons from
// Third-Party pi Provider Extensions", adopt list). One describe block per lesson.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FetchFunction, ModelsPublication, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { GatewayConfig } from "./config.ts";
import { LIMITS, discoverModels, modelsFromList, parseModelList } from "./discovery.ts";
import { createGatewayProvider, initialModels } from "./provider.ts";

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    id: "gateway",
    baseUrl: "https://gw.example.com",
    apiKeyEnv: "GW_KEY",
    authHeaders: {},
    defaultApi: "openai-responses",
    headers: {},
    modelsPath: "/v1/models",
    include: [],
    exclude: [],
    models: {},
    fallbackModels: [],
    ...overrides,
  };
}

const ENV = { GW_KEY: "tok" };

function listFetch(...bodies: unknown[]): { urls: string[]; fetch: FetchFunction } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify(bodies[Math.min(urls.length - 1, bodies.length - 1)]), { status: 200 });
    },
  };
}

function refreshContext(overrides: Partial<RefreshModelsContext> = {}): { context: RefreshModelsContext; published: ModelsPublication[] } {
  const published: ModelsPublication[] = [];
  return {
    published,
    context: {
      allowNetwork: false,
      signal: new AbortController().signal,
      publish: async (publication) => {
        published.push(publication);
        publication.update?.();
        return true;
      },
      ...overrides,
    },
  };
}

const ids = (models: readonly { id: string }[]) => models.map((model) => model.id);

describe("lesson 1: an all-invalid or empty list is a failure, not an empty catalog", () => {
  for (const [name, body] of [
    ["an empty list", { data: [] }],
    ["a list whose every entry is malformed", { data: [{ id: "" }, { id: "a b" }, null, 42] }],
    ["a list of wildcard entries only", { data: [{ id: "openai/*", owned_by: "openai" }] }],
    ["a list of non-chat models only", { data: [{ id: "text-embed-4", mode: "embedding" }] }],
  ] as const) {
    it(`discoverModels rejects ${name}`, async () => {
      const { fetch } = listFetch(body);
      await assert.rejects(discoverModels(config(), { token: "tok", fetch }), /no usable model|empty/);
    });
  }

  it("names what was dropped", async () => {
    const { fetch } = listFetch({ data: [{ id: "openai/*" }, { id: "a b" }, { id: "embed-x", mode: "embedding" }] });
    await assert.rejects(discoverModels(config(), { token: "tok", fetch }), /1 wildcard, 1 non-chat, 1 malformed/);
  });

  it("initialModels falls back (fresh: false), so pi's saved snapshot is restored", async () => {
    const { fetch } = listFetch({ data: [] });
    const warnings: string[] = [];
    const result = await initialModels(config({ fallbackModels: ["fb"] }), { env: ENV, fetch, warn: (message) => warnings.push(message) });
    assert.equal(result.fresh, false);
    assert.deepEqual(ids(result.models), ["fb"]);
    assert.match(warnings[0], /model discovery failed \(model list is empty\)/);
  });

  it("a refresh that returns an empty list keeps the current models", async () => {
    const { fetch } = listFetch({ data: [{ id: "keep-me" }] }, { data: [] });
    const seeded = createGatewayProvider(config(), await initialModels(config(), { env: ENV, fetch }), { env: ENV, fetch });
    assert.deepEqual(ids(seeded.getModels()), ["keep-me"]);
    assert.ok(seeded.refreshModels);
    const { context, published } = refreshContext({ allowNetwork: true });
    await assert.rejects(seeded.refreshModels(context), /model list is empty/);
    assert.deepEqual(ids(seeded.getModels()), ["keep-me"]);
    assert.equal(published.length, 0, "nothing is persisted over the last good list");
  });

  it("fallbackModels: [] (the config default) is not an error", async () => {
    const { fetch } = listFetch({ data: [{ id: "a" }] });
    const result = await initialModels(config(), { env: ENV, fetch });
    assert.equal(result.fresh, true);
    assert.deepEqual(modelsFromList([], config()).models, []);
  });
});

describe("lesson 3: non-chat models are dropped before the list cap", () => {
  it("drops LiteLLM modes and types that are not chat", () => {
    const { entries, nonChat } = parseModelList({
      data: [
        { id: "embed-a", mode: "embedding" },
        { model_name: "img-a", model_info: { mode: "image_generation" } },
        { id: "whisper-a", mode: "audio_transcription" },
        { id: "tts-a", mode: "audio_speech" },
        { id: "rerank-a", mode: "rerank" },
        { id: "mod-a", mode: "moderation" },
        { id: "video-a", mode: "video_generation" },
        { id: "embed-b", type: "embeddings" },
        { id: "img-b", architecture: { output_modalities: ["image"] } },
        { id: "chat-a", mode: "chat" },
        { id: "resp-a", mode: "responses" },
        { id: "plain-a", object: "model" },
        { id: "multi-a", architecture: { output_modalities: ["text", "image"] } },
      ],
    });
    assert.deepEqual(ids(entries), ["chat-a", "resp-a", "plain-a", "multi-a"]);
    assert.equal(nonChat, 9);
  });

  it("does not let non-chat entries crowd chat models out of the cap", () => {
    const data = [
      ...Array.from({ length: LIMITS.maxModels }, (_, index) => ({ id: `embed-${index}`, mode: "embedding" })),
      { id: "the-chat-model", mode: "chat" },
    ];
    const { entries, dropped } = parseModelList({ data });
    assert.deepEqual(ids(entries), ["the-chat-model"]);
    assert.equal(dropped, 0, "non-chat entries are counted separately");
  });
});
