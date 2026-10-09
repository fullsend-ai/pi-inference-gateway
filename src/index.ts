// pi provider extension: any OpenAI- or Anthropic-compatible inference gateway as one provider.
//
// Configure with INFERENCE_GATEWAY_BASE_URL (+ INFERENCE_GATEWAY_API_KEY or
// INFERENCE_GATEWAY_TOKEN_FILE), or ~/.pi/agent/inference-gateway.json. Unconfigured, it registers
// nothing and prints nothing. See README.md and CONTRIBUTING.md.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGateways } from "./provider.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
  const ids = await registerGateways(pi);
  if (ids.length === 0) return;
  // Force a network refresh from an interactive session; `-p` runs never refresh from the network.
  pi.registerCommand("gateway-refresh", {
    description: "Re-discover models from the configured inference gateway(s)",
    handler: async (_args, ctx) => {
      const result = await ctx.modelRegistry.refresh({ providers: ids, allowNetwork: true, force: true });
      const failed = [...result.errors].map(([id, error]) => `${id}: ${error.message}`);
      if (failed.length > 0) ctx.ui.notify(`Gateway refresh failed: ${failed.join("; ")}`, "error");
      else ctx.ui.notify(`Gateway models refreshed (${ids.join(", ")})`, "info");
    },
  });
}
