import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "aihubmix";
const PROVIDER_NAME = "AIHubMix";
const BASE_URL = "https://aihubmix.com/v1";
const API_KEY_ENV = "AIHUBMIX_API_KEY";

/**
 * Static model config to avoid remote API calls on every /reload.
 *
 * How to add/update models next time:
 * 1) Fetch source data from AIHubMix model API:
 *    - curl 'https://aihubmix.com/api/v1/models?type=llm&modalities=text'
 *
 * 2) Extract a specific model (replace MODEL_ID):
 *    - python3 - <<'PY'
 *      import json, urllib.request
 *      model_id = 'MODEL_ID'
 *      data = json.load(urllib.request.urlopen('https://aihubmix.com/api/v1/models?type=llm&modalities=text'))['data']
 *      print(next(m for m in data if m['model_id'] == model_id))
 *      PY
 *
 * 3) Mapping rules into pi model fields:
 *    - id            <- model_id
 *    - name          <- model_name
 *    - reasoning     <- features contains "thinking"
 *    - input         <- input_modalities contains "image" ? ["text", "image"] : ["text"]
 *    - contextWindow <- context_length (fallback: 128000)
 *    - maxTokens     <- max_output (fallback: 16384)
 *    - cost.input    <- pricing.input
 *    - cost.output   <- pricing.output
 *    - cost.cacheRead  <- pricing.cache_read
 *    - cost.cacheWrite <- pricing.cache_write (usually absent => 0)
 */
const MODELS = [
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: {
      input: 0.154,
      output: 0.308,
      cacheRead: 0.00308,
      cacheWrite: 0,
    },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: {
      input: 0.478,
      output: 0.956,
      cacheRead: 0.004302,
      cacheWrite: 0,
    },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
  },
];

export default function (pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: BASE_URL,
    api: "openai-completions",
    apiKey: API_KEY_ENV,
    models: MODELS,
  });
}
