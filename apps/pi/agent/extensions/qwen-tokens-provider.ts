import type { AssistantImages, ImageApi, ImageModel, ImagesContext, ImagesOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "qwen-tokens";
const IMAGE_API = "qwen-images";
const PROVIDER_NAME = "Qwen AI Platform (千问AI平台)";
const BASE_URL = "https://maas.qianwenaiapi.com/compatible-mode/v1";

// API key 从 ~/.pi/agent/auth.json 的 "qwen-tokens" 条目读取（/login 管理），
// 因此这里不设置 apiKey 字段。
//
// 两种 key 不要混用：
//   sk-ws-… 千问AI平台 workspace key  → 本扩展（按 token 计费，见下方单价注释）
//   sk-sp-… Token Plan 订阅 key       → https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1
//                                       pi 已内置 qwen-token-plan* provider，不需要本扩展

/**
 * 千问AI平台 OpenAI 兼容端点（compatible-mode）的兼容性设置，
 * 对照 pi 内置目录 qwen-token-plan-cn 的取值：
 *
 * - thinkingFormat: "qwen"        → 走顶层 enable_thinking，思考内容读 reasoning_content
 * - supportsDeveloperRole: false  → 不支持 developer role
 * - supportsStore: false          → 不支持 store 字段
 * - supportsReasoningEffort: true  → reasoning_effort 由模型上的 thinkingLevelMap 映射
 * - supportsStrictMode: true      → 工具 schema 可带 strict: true（已实测四个模型均接受）
 */
const QWEN_COMPAT = {
  thinkingFormat: "qwen",
  supportsDeveloperRole: false,
  supportsStore: false,
  supportsReasoningEffort: true,
  supportsStrictMode: true,
} as const;

type LevelMap = Record<
  "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  string | null
>;

/**
 * pi 的 thinking level → reasoning_effort 映射，null 表示该档位不可用（/thinking 不提供）。
 * 依据
 * https://platform.qianwenai.com/docs/developer-guides/text-generation/thinking
 * - qwen3.8-max / flash：可选 low / medium / xhigh（默认 xhigh）
 * - deepseek-v4.1-flash：low / medium / high / max
 * - deepseek-v4-pro：low / high / max
 */
const QWEN_LEVELS: LevelMap = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: null,
  xhigh: "xhigh",
  max: null,
};

const DEEPSEEK_FLASH_LEVELS: LevelMap = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: "max",
};

const DEEPSEEK_PRO_LEVELS: LevelMap = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
};

/**
 * 对话模型元数据。cost 单位是 USD / 百万 token（pi 的约定），
 * 由人民币价目表按 ¥7.2 = $1 换算；价格变动时同步更新：
 * https://platform.qianwenai.com/docs/developer-guides/getting-started/model-prices
 *
 * 人民币单价（输入 / 输出 / 隐式缓存命中，元/百万 token）：
 *   qwen3.8-max            12 / 36 / 1.5
 *   qwen3.8-flash          0.8 / 2.7 / 0.1
 *   deepseek-v4-pro        12 / 24 / 1
 *   deepseek-v4.1-flash    忙时 2 / 8 / 0.2（闲时 1 / 4 / 0.1，这里按忙时填，宁高勿低）
 *
 * 维护方式（不要在运行时拉 /models：每次 /reload 都会多一次网络请求）：
 *   KEY=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.pi/agent/auth.json')))['qwen-tokens']['key'])")
 *   curl -s -H "Authorization: Bearer $KEY" \
 *     https://maas.qianwenaiapi.com/compatible-mode/v1/models \
 *     | python3 -c 'import json,sys; [print(m["id"]) for m in json.load(sys.stdin)["data"]]'
 * 再从价目页 / 思考模式页补上 cost 与 reasoning、thinkingLevelMap。
 */
const CHAT_MODELS = [
  {
    id: "qwen3.8-max",
    name: "Qwen3.8 Max",
    reasoning: true,
    thinkingLevelMap: QWEN_LEVELS,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 1.667, output: 5, cacheRead: 0.208, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    compat: QWEN_COMPAT,
  },
  {
    id: "qwen3.8-flash",
    name: "Qwen3.8 Flash",
    reasoning: true,
    thinkingLevelMap: QWEN_LEVELS,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0.111, output: 0.375, cacheRead: 0.014, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    compat: QWEN_COMPAT,
  },
  {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    reasoning: true,
    thinkingLevelMap: DEEPSEEK_FLASH_LEVELS,
    // 平台标注「推理模型、视觉理解、文本生成」，实测可读图（image_tokens > 0）
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0.278, output: 1.111, cacheRead: 0.028, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    compat: QWEN_COMPAT,
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    reasoning: true,
    thinkingLevelMap: DEEPSEEK_PRO_LEVELS,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 1.667, output: 3.333, cacheRead: 0.139, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    compat: QWEN_COMPAT,
  },
];

/**
 * 图像生成模型（type: "image"）。它们不出现在 /model 里，只能从 codemode 的
 * models.generateImages() 调用，结果用 image(block) 展示。
 *
 * 只有走 OpenAI 兼容的 /images/generations 的模型能挂在这里：qwen-image-3.0 系列、
 * qwen-image-2.1 系列。wan2.7 / z-image-turbo 只有 DashScope 异步或专用接口，需要另写实现。
 *
 * 人民币单价（按成功出图数计费，元/张）：
 *   qwen-image-3.0-pro    1K 0.25 / 2K 0.5
 *   qwen-image-3.0        1K 0.18 / 2K 0.18（同价，需要 2K 时改 IMAGE_SIZE）
 *   qwen-image-2.1-turbo  1K 0.1
 * pi 的 cost 字段只能表达「USD / 百万 token」，写不出按张计费，因此这里填 0：
 * 出图花费不会进 /cost，以平台用量统计为准。
 */
const IMAGE_MODELS = [
  {
    type: "image" as const,
    id: "qwen-image-3.0-pro",
    name: "Qwen Image 3.0 Pro",
    api: IMAGE_API,
    input: ["text", "image"] as ("text" | "image")[],
    output: ["image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    type: "image" as const,
    id: "qwen-image-3.0",
    name: "Qwen Image 3.0",
    api: IMAGE_API,
    input: ["text", "image"] as ("text" | "image")[],
    output: ["image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    type: "image" as const,
    id: "qwen-image-2.1-turbo",
    name: "Qwen Image 2.1 Turbo",
    api: IMAGE_API,
    input: ["text", "image"] as ("text" | "image")[],
    output: ["image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
];

/**
 * 出图尺寸写死在这里：codemode 调 generateImages 只传 prompt 和参考图，没有 size 参数。
 * 可选范围 512x512 – 2048x2048，宽高比 1:8 – 8:1。
 *
 * 请求里没显式传 prompt_extend，走平台默认值 true（短提示词会自动扩写，质量更好，但多 3-5 秒）；
 * 想把延迟压下来，就在 generateQwenImages 的 request 里加 prompt_extend: false。
 */
const IMAGE_SIZE: Record<string, string> = {
  "qwen-image-3.0-pro": "1024x1024",
  "qwen-image-3.0": "1024x1024",
  "qwen-image-2.1-turbo": "1024x1024",
};

function sniffMime(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return "image/webp";
  return "image/png";
}

/** 平台返回的是 24 小时有效的 OSS URL，拿到后立刻转成 base64，避免过期。 */
async function downloadImage(url: string, doFetch: typeof fetch, signal?: AbortSignal) {
  const response = await doFetch(url, { signal });
  if (!response.ok) throw new Error(`image download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
  return {
    type: "image" as const,
    data: bytes.toString("base64"),
    mimeType: contentType?.startsWith("image/") ? contentType : sniffMime(bytes),
  };
}

interface ImagesRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  watermark?: boolean;
  image?: string | string[];
}

/**
 * OpenAI 兼容的 /images/generations：同步接口，文生图与图生图共用，
 * 传 image（URL 或 data URL，单张传字符串、多张传数组）即为图生图。
 * 文档：https://platform.qianwenai.com/docs/developer-guides/image-generation/text-to-image
 */
async function generateQwenImages(
  model: ImageModel<ImageApi>,
  context: ImagesContext,
  options?: ImagesOptions,
): Promise<AssistantImages> {
  const result: AssistantImages = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: "stop",
    timestamp: Date.now(),
  };

  try {
    const apiKey = options?.apiKey;
    if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);

    const prompt = context.input
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (!prompt) throw new Error("images/generations needs a text prompt");

    const refs = context.input
      .filter((block) => block.type === "image")
      .map((block) => `data:${block.mimeType};base64,${block.data}`);

    const request: ImagesRequest = {
      model: model.id,
      prompt,
      n: 1,
      size: IMAGE_SIZE[model.id] ?? "1024x1024",
      // 默认会打「AI 生成」水印，agent 产出的图不需要
      watermark: false,
    };
    if (refs.length === 1) request.image = refs[0];
    else if (refs.length > 1) request.image = refs;

    const doFetch = options?.fetch ?? fetch;
    const response = await doFetch(`${model.baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...options?.headers,
      },
      body: JSON.stringify(request),
      signal: options?.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`images/generations ${response.status}: ${body.slice(0, 300)}`);
    }

    const payload = (await response.json()) as { data?: { url?: string }[] };
    const urls = (payload.data ?? [])
      .map((item) => item.url)
      .filter((url): url is string => Boolean(url));
    if (urls.length === 0) throw new Error("images/generations returned no image url");

    for (const url of urls) {
      result.output.push(await downloadImage(url, doFetch, options?.signal));
    }
    return result;
  } catch (error) {
    result.stopReason = options?.signal?.aborted ? "aborted" : "error";
    result.errorMessage = error instanceof Error ? error.message : String(error);
    return result;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: BASE_URL,
    api: "openai-completions",
    models: [...CHAT_MODELS, ...IMAGE_MODELS],
    images: { [IMAGE_API]: { generateImages: generateQwenImages } },
  });
}
