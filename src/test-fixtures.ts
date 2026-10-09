// Canned SSE bodies for the three transports, shared by the unit tests and
// scripts/mock-gateway.mjs so the end-to-end check serves exactly the bytes the tests parse.
// Not imported by the extension itself.

function frames(events: Array<[string | undefined, unknown]>): string {
  return events
    .map(([event, data]) => `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`)
    .join("");
}

/** Anthropic Messages stream (`POST /v1/messages`). */
export function anthropicMessagesSse(model: string, text: string): string {
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
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 7, output_tokens: 2 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}

/** OpenAI Responses stream (`POST /v1/responses`). */
export function openAIResponsesSse(model: string, text: string): string {
  const item = { type: "message", id: "msg_test", role: "assistant", status: "in_progress", content: [] };
  return frames([
    ["response.created", { type: "response.created", sequence_number: 0, response: { id: "resp_test", object: "response", status: "in_progress", model, output: [] } }],
    ["response.output_item.added", { type: "response.output_item.added", sequence_number: 1, output_index: 0, item }],
    [
      "response.content_part.added",
      { type: "response.content_part.added", sequence_number: 2, output_index: 0, content_index: 0, item_id: "msg_test", part: { type: "output_text", text: "", annotations: [] } },
    ],
    ["response.output_text.delta", { type: "response.output_text.delta", sequence_number: 3, output_index: 0, content_index: 0, item_id: "msg_test", delta: text }],
    ["response.output_text.done", { type: "response.output_text.done", sequence_number: 4, output_index: 0, content_index: 0, item_id: "msg_test", text }],
    [
      "response.output_item.done",
      {
        type: "response.output_item.done",
        sequence_number: 5,
        output_index: 0,
        item: { ...item, status: "completed", content: [{ type: "output_text", text, annotations: [] }] },
      },
    ],
    [
      "response.completed",
      {
        type: "response.completed",
        sequence_number: 6,
        response: {
          id: "resp_test",
          object: "response",
          status: "completed",
          model,
          output: [],
          usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
        },
      },
    ],
  ]);
}

/** OpenAI Chat Completions stream (`POST /v1/chat/completions`). */
export function openAICompletionsSse(model: string, text: string): string {
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => ({
    id: "chatcmpl_test",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices,
    ...extra,
  });
  return frames([
    [undefined, chunk([{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }])],
    [undefined, chunk([{ index: 0, delta: {}, finish_reason: "stop" }])],
    [undefined, chunk([], { usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } })],
    [undefined, "[DONE]"],
  ]);
}

/** The SSE body for a request path, or undefined for anything else. */
export function sseFor(pathname: string, model: string, text: string): string | undefined {
  if (pathname.endsWith("/v1/messages")) return anthropicMessagesSse(model, text);
  if (pathname.endsWith("/v1/responses")) return openAIResponsesSse(model, text);
  if (pathname.endsWith("/v1/chat/completions")) return openAICompletionsSse(model, text);
  return undefined;
}
