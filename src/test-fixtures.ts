// Canned SSE bodies for the three transports, shared by the unit tests and
// scripts/mock-gateway.mjs so the end-to-end check serves exactly the bytes the tests parse.
// Not imported by the extension itself. `reasoning`, when given, is emitted the way each protocol
// carries raw reasoning: a signed `thinking` block (Messages), a `reasoning` output item with raw
// `reasoning_text` events (Responses), `delta.reasoning_content` chunks (Chat Completions).

function frames(events: Array<[string | undefined, unknown]>): string {
  return events
    .map(([event, data]) => `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`)
    .join("");
}

/** Anthropic Messages stream (`POST /v1/messages`). */
export function anthropicMessagesSse(model: string, text: string, reasoning?: string): string {
  const thinking: Array<[string, unknown]> =
    reasoning === undefined
      ? []
      : [
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: reasoning } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "c2lnLXRlc3Q=" } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ];
  const textIndex = thinking.length > 0 ? 1 : 0;
  return frames([
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 7, output_tokens: 0 },
        },
      },
    ],
    ...thinking,
    ["content_block_start", { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: textIndex }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 7, output_tokens: 2 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}

/** OpenAI Responses stream (`POST /v1/responses`). */
export function openAIResponsesSse(model: string, text: string, reasoning?: string): string {
  let sequence = 0;
  const event = (type: string, fields: Record<string, unknown>): [string, unknown] => [type, { type, sequence_number: sequence++, ...fields }];

  const reasoningEvents: Array<[string, unknown]> = [];
  if (reasoning !== undefined) {
    const item = { type: "reasoning", id: "rs_test", summary: [], content: [], status: "in_progress" };
    const part = { item_id: "rs_test", output_index: 0, content_index: 0 };
    reasoningEvents.push(
      event("response.output_item.added", { output_index: 0, item }),
      event("response.reasoning_part.added", { ...part, part: { type: "reasoning_text", text: "" } }),
      event("response.reasoning_text.delta", { ...part, delta: reasoning }),
      event("response.reasoning_text.done", { ...part, text: reasoning }),
      event("response.reasoning_part.done", { ...part, part: { type: "reasoning_text", text: reasoning } }),
      event("response.output_item.done", {
        output_index: 0,
        item: { ...item, status: "completed", content: [{ type: "reasoning_text", text: reasoning }] },
      }),
    );
  }
  const outputIndex = reasoning === undefined ? 0 : 1;
  const message = { type: "message", id: "msg_test", role: "assistant", status: "in_progress", content: [] };
  const textPart = { output_index: outputIndex, content_index: 0, item_id: "msg_test" };

  return frames([
    event("response.created", { response: { id: "resp_test", object: "response", status: "in_progress", model, output: [] } }),
    ...reasoningEvents,
    event("response.output_item.added", { output_index: outputIndex, item: message }),
    event("response.content_part.added", { ...textPart, part: { type: "output_text", text: "", annotations: [] } }),
    event("response.output_text.delta", { ...textPart, delta: text }),
    event("response.output_text.done", { ...textPart, text }),
    event("response.output_item.done", {
      output_index: outputIndex,
      item: { ...message, status: "completed", content: [{ type: "output_text", text, annotations: [] }] },
    }),
    event("response.completed", {
      response: {
        id: "resp_test",
        object: "response",
        status: "completed",
        model,
        output: [],
        usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
      },
    }),
  ]);
}

/** OpenAI Chat Completions stream (`POST /v1/chat/completions`). */
export function openAICompletionsSse(model: string, text: string, reasoning?: string): string {
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => ({
    id: "chatcmpl_test",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices,
    ...extra,
  });
  const reasoningChunks: Array<[undefined, unknown]> =
    reasoning === undefined
      ? []
      : [[undefined, chunk([{ index: 0, delta: { role: "assistant", content: null, reasoning_content: reasoning }, finish_reason: null }])]];
  return frames([
    ...reasoningChunks,
    [undefined, chunk([{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }])],
    [undefined, chunk([{ index: 0, delta: {}, finish_reason: "stop" }])],
    [undefined, chunk([], { usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } })],
    [undefined, "[DONE]"],
  ]);
}

/** The SSE body for a request path, or undefined for anything else. */
export function sseFor(pathname: string, model: string, text: string, reasoning?: string): string | undefined {
  if (pathname.endsWith("/v1/messages")) return anthropicMessagesSse(model, text, reasoning);
  if (pathname.endsWith("/v1/responses")) return openAIResponsesSse(model, text, reasoning);
  if (pathname.endsWith("/v1/chat/completions")) return openAICompletionsSse(model, text, reasoning);
  return undefined;
}
