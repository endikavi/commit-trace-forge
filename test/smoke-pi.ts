import { PiModelProvider } from "../src/harness/pi.ts";
import { createLogger } from "../src/util/logger.ts";

const provider = new PiModelProvider({ logger: createLogger("smoke") });
const model = {
  provider: process.env.FORGE_SMOKE_PROVIDER ?? "anthropic",
  model: process.env.FORGE_SMOKE_MODEL ?? "claude-sonnet-4-5",
  thinking: "off",
};

const availability = await provider.available(model);
console.log("available:", availability);
if (!availability.ok) process.exit(2);

const response = await provider.complete({
  role: "grader",
  systemPrompt:
    "You return only a single JSON object and nothing else. No prose, no code fences.",
  userPrompt: 'Return exactly {"ok":true,"adapter":"pi"}',
  model,
  timeoutMs: 180_000,
});
console.log("text:", JSON.stringify(response.text));
console.log("usage:", response.usage);
console.log("model:", response.model, "mode:", response.executionMode);
