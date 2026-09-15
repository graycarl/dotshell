import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "qwen-tokens";
const PROVIDER_NAME = "Qwen Tokens (DashScope)";
const BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

// API key 从 ~/.pi/agent/auth.json 的 "qwen-tokens" 条目读取（/login 管理），
// 因此这里不设置 apiKey 字段。

/**
 * DashScope compatible-mode 模型元数据。
 *
 * 兼容性参照 pi 内置 qwen-token-plan-* 目录：DashScope OpenAI 兼容端点
 * 使用 thinkingFormat: "qwen"（顶层 enable_thinking），不支持 developer
 * role / store 字段。
 *
 * cost 全部为 0（token-plan 计费模式，不按 token 计价）。
 */
const QWEN_COMPAT = {
  thinkingFormat: "qwen",
  supportsDeveloperRole: false,
  supportsStore: false,
  supportsReasoningEffort: true,
} as const;

const MODELS = [
  {
    id: "qwen3.8-max",
    name: "Qwen3.8 Max",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    compat: QWEN_COMPAT,
  },
  {
    id: "qwen3.8-flash",
    name: "Qwen3.8 Flash",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    compat: QWEN_COMPAT,
  },
  {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    compat: QWEN_COMPAT,
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    reasoning: true,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    compat: QWEN_COMPAT,
  },
];

export default function (pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: BASE_URL,
    api: "openai-completions",
    models: MODELS,
  });
}
