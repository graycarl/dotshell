# qwen-tokens provider 维护手册

配套 [`index.ts`](./index.ts)。改模型、改价、加图像能力前先看这里。
链接最后校验：2026-10-25（全部 200）。

## 1. 这个 provider 到底是什么

| key 前缀 | 产品 | Base URL | 谁在用 |
|---|---|---|---|
| `sk-ws-` | 千问AI平台（workspace key），按 token / 按张计费 | `https://maas.qianwenaiapi.com/compatible-mode/v1` | **本扩展** |
| `sk-sp-` | Token Plan 订阅（Credits） | `https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1`（Anthropic 兼容：`/apps/anthropic`） | pi 内置 `qwen-token-plan*`，**不要**在扩展里重复配 |

- `dashscope.aliyuncs.com/compatible-mode/v1` 是旧域名，同一后端（实测 `/models` 返回同一份列表）。文档统一用 `maas.qianwenaiapi.com`。
- 拿 `sk-ws-` 的 key 打 Token Plan 的 `token-plan.*` 端点会直接 401，反之亦然。

## 2. 平台文档（改模型 / 改参数必看）

| 用途 | 链接 |
|---|---|
| 文档首页 | https://platform.qianwenai.com/docs/developer-guides/getting-started/introduction |
| 首次调用：base_url、key 前缀、SDK 示例 | https://platform.qianwenai.com/docs/developer-guides/getting-started/first-api-call |
| **选择模型**：按场景挑（文本 / 视觉 / 图像 / 语音…） | https://platform.qianwenai.com/docs/developer-guides/getting-started/model-selection |
| **最新模型**：单个旗舰的规格 + `reasoning_effort` 档位说明 | https://platform.qianwenai.com/docs/developer-guides/getting-started/latest-model |
| **模型价格**：元/百万 token、元/张、缓存价 | https://platform.qianwenai.com/docs/developer-guides/getting-started/model-prices |
| **图像模型总览**：是否支持编辑、最大分辨率、最大出图数 | https://platform.qianwenai.com/docs/developer-guides/getting-started/image-models |
| **思考模式**：`enable_thinking`、`reasoning_effort` 可选值、`preserve_thinking`、`thinking_budget` | https://platform.qianwenai.com/docs/developer-guides/text-generation/thinking |
| 文生图 + **OpenAI 兼容模式**（本扩展走的这条路） | https://platform.qianwenai.com/docs/developer-guides/image-generation/text-to-image |
| 图像编辑：`image` 字段传 URL / base64，3.0 系列 ≤3 张、2.1 系列 ≤10 张 | https://platform.qianwenai.com/docs/developer-guides/image-generation/image-editing |
| 限流 / 429 | https://platform.qianwenai.com/docs/developer-guides/administration/rate-limits |
| 异步任务约定（提交、轮询、超时） | https://platform.qianwenai.com/docs/developer-guides/run-and-scale/async-task-management |
| 错误信息（`DataInspectionFailed` 等） | https://platform.qianwenai.com/docs/api-reference/preparation/error-messages |
| API Key 管理 | https://platform.qianwenai.com/docs/api-reference/preparation/api-key |
| 模型变更 / 下线公告（例：`qwen3.8-max-preview` 已下线） | https://platform.qianwenai.com/docs/changelog/models |

Token Plan 相关（判断「该不该用内置 provider」时看）：

- 概述（各套餐支持哪些模型）：https://platform.qianwenai.com/docs/token-plan/overview
- 个人版快速开始（`sk-sp-` key + 两个 base URL）：https://platform.qianwenai.com/docs/token-plan/personal/token-plan-personal-quickstart

## 3. 接口清单（已接 / 以后可能要接）

| 用途 | 端点 | 状态 |
|---|---|---|
| 对话 | `POST {baseUrl}/chat/completions`（OpenAI 兼容） | ✅ 已接 |
| 图像（OpenAI 兼容，同步） | `POST {baseUrl}/images/generations`，**只认** `qwen-image-3.0-pro / 3.0 / 2.1-pro / 2.1-turbo` | ✅ 已接 |
| 图像 `z-image-turbo`（DashScope 原生，**同步**） | `POST https://maas.qianwenaiapi.com/api/v1/services/aigc/multimodal-generation/generation`；实测 3.6s、¥0.1、不支持编辑、prompt ≤800 字、n 固定 1 | ❌ 未接 |
| 图像 `wan2.7-image(-pro)`（异步） | `POST .../api/v1/services/aigc/image-generation/generation` + 头 `X-DashScope-Async: enable` → 轮询 `GET .../api/v1/tasks/{task_id}`；实测同步接口对本账号返回 403 `does not support synchronous calls`，异步 1K 约 15s | ❌ 未接 |

API 参考页：

- Qwen 图像同步：https://platform.qianwenai.com/docs/api-reference/image-generation/qwen-text-to-image
- Qwen 3.0 异步：https://platform.qianwenai.com/docs/api-reference/image-generation/qwen-text-to-image-30-async
- Z-Image（同步）：https://platform.qianwenai.com/docs/api-reference/image-generation/z-image
- Wan 2.7 建任务：https://platform.qianwenai.com/docs/api-reference/image-generation/wan27-image-gen-edit/create-task
- 任务查询：https://platform.qianwenai.com/docs/api-reference/image-generation/qwen-text-to-image-task-query ・ https://platform.qianwenai.com/docs/api-reference/more/manage-asynchronous-tasks

## 4. pi 侧文档（写扩展必看）

| 内容 | 位置 |
|---|---|
| `registerProvider` 两种形式、`images` 按 api 字符串绑实现 | `docs/custom-provider.md` |
| 模型字段语义：`cost` 是 **USD/百万 token**、`thinkingLevelMap`、`inputLimits` | `docs/models-configuration.md` |
| 图像模型的唯一调用入口（codemode 的 `models.generateImages`） | `docs/codemode.md` 的 “Generate images” |
| 图像模型对 agent 的可见性（不出现在 `/model`） | `docs/models.md` 的 “Use image models” |
| **compat / thinkingLevelMap 的权威取值参考** | `node_modules/@earendil-works/pi-ai/dist/providers/data/qwen-token-plan-cn.json` |
| 可用的 compat 字段全集 | `node_modules/@earendil-works/pi-ai/dist/providers/compat-schema.d.ts` |

后两条在 pi 安装目录下（`brew --prefix pi-coding-agent`），路径含版本号，升级后重新定位：

```bash
PI_ROOT="$(brew --prefix pi-coding-agent)/libexec/lib/node_modules/@earendil-works/pi-coding-agent"
ls "$PI_ROOT/node_modules/@earendil-works/pi-ai/dist/providers/data/" | grep qwen
```

## 5. 迭代手册

### 5.1 加 / 改对话模型

1. 拉当前模型清单（见 §6），确认 id 还在。
2. 价格页抄人民币单价，`/7.2` 换成 USD；`cacheRead` 用「隐式缓存命中」那列。
3. 思考档位：查「思考模式」页 + 对照内置 `qwen-token-plan-cn.json` 的 `thinkingLevelMap`。缺 `thinkingLevelMap` 时 pi 会把 `/thinking` 档位名原样当 `reasoning_effort` 发出去。
4. 图片能力：文档标「视觉理解」才写 `input: ["text","image"]`，否则 pi 会拦掉用户贴图。
5. 改完实测三条（§6.2）：strict 工具、`reasoning_effort`、图片输入。

### 5.2 加图像模型

先判断协议：

- 能走 `/compatible-mode/v1/images/generations` → 直接加到 `IMAGE_MODELS` + `IMAGE_SIZE`，零新代码。
- 其他协议 → 新起一个 api 字符串（如 `dashscope-images`），在 `images` 里注册第二个 `generateImages`：
  - `z-image-turbo`：一次同步 POST，响应取 `output.choices[0].message.content[].image`。
  - `wan2.7`：建任务（带 `X-DashScope-Async: enable`）→ 每 3s 轮询 `/api/v1/tasks/{id}`，`task_status` 到 `SUCCEEDED` 取 `output.choices[0].message.content[].image`；必须响应 `options.signal` 中断，并把 `size` 用 `1K/2K/4K` 简写。
  - 两条协议都是先拿 URL，再复用现有的「下载 → base64」逻辑（URL 24 小时过期）。

## 6. 实测命令

### 6.1 端点存活 + 模型清单

```bash
KEY=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.pi/agent/auth.json')))['qwen-tokens']['key'])")
# 401 = 地址还在（不带 key 也应是 401，404 说明端点变了）
curl -s -o /dev/null -w '%{http_code}\n' https://maas.qianwenaiapi.com/compatible-mode/v1/models
# 全部可用模型 id
curl -s -H "Authorization: Bearer $KEY" https://maas.qianwenaiapi.com/compatible-mode/v1/models \
  | python3 -c 'import json,sys; [print(m["id"]) for m in json.load(sys.stdin)["data"]]'
```

### 6.2 新模型的三个探测

```bash
KEY=...   # 同上
# ① 工具 schema 能否带 strict（返回 tool_calls 即 OK）
curl -s -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"MODEL","messages":[{"role":"user","content":"北京天气"}],"tools":[{"type":"function","function":{"name":"f","strict":true,"parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"],"additionalProperties":false}}}],"max_tokens":60}' \
  https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions

# ② reasoning_effort 档位（不报错且 reasoning_tokens>0 才算真的生效）
curl -s -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"MODEL","messages":[{"role":"user","content":"1+1=?"}],"enable_thinking":true,"reasoning_effort":"medium","max_tokens":16}' \
  https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions

# ③ 图片输入（看 usage.prompt_tokens_details.image_tokens 是否 > 0）
#    把 base64 塞进 content 的 image_url，格式同 OpenAI
```

## 7. 已知坑

- **`/cost` 不含出图费用**：pi 的 `cost` 只能表达 USD/百万 token，按张计费的模型只能填 0，以平台用量统计为准。
- **`prompt_extend` 默认 true**：短提示词自动扩写，质量更好但多 3-5 秒；要快就在请求里显式 `prompt_extend: false`。
- **图像 URL 只有 24 小时**：所以实现里拿到就立刻下载转 base64。
- **`watermark` 默认会打「AI 生成」水印**：实现里显式 `watermark: false`。
- **只有 codemode 能调图像模型**：`/model` 列表里不会出现，`--no-tools` 时也调不到。
- **平台会下线模型**（如 `qwen3.8-max-preview` 自动路由到 `qwen3.8-max`）：长期不用会失效，price/思考档位也可能变，按 §5.1 复查。
