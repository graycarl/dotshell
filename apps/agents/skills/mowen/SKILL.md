---
name: mowen
description: 墨问（MoWen）笔记社区操作，通过官方 mocli CLI 完成。当用户提到墨问、mocli、mowen，或要求：查看/搜索/创建/编辑/发布墨问笔记、查看笔记详情与评论引用、查看我的笔记或某人主页笔记、按标签筛选笔记、管理笔记标签与隐私设置、查看我的标签、搜索墨问用户、查看用户资料与创作者画像、给墨问 UID 设置或查询备注名（如“老池”“二爷”）、查看墨问动态（被关注/点赞/评论/收藏/关注的人发布新笔记）、上传图片音频 PDF 到墨问获取 file_id、配置或查看墨问 API Key 认证时触发。
metadata:
  requires:
    bins: ["mocli"]
  cliHelp: "mocli help"
  upstream: "https://github.com/mowenxd/cli"
---

# mowen - 墨问（MoWen）

所有墨问能力都通过官方 CLI `mocli` 完成。本 skill 是它的**规则手册 + 命令路由**：SKILL.md 只放跨领域通用规则和路由表，具体命令细节按需 read `references/` 下的分域文档。

> 上游仓库：[mowenxd/cli](https://github.com/mowenxd/cli)。`references/` 由 `scripts/sync-upstream.sh` 从上游生成，不要手工编辑。

## 前置依赖

- **二进制**：`npm install -g @mowenxd/cli`（postinstall 会下载对应平台二进制）。先确认可用：`mocli help`。
- **认证**：首次使用需要用户提供 API Key，执行 `mocli auth init --apik <api-key>`。
- **获取 API Key**：`墨问`小程序 → 右下角`我的` → `开发者` → `我的 API Key`。详见 [references/api-key.md](references/api-key.md)。

## 命令路由表

| 用户意图 | 命令 | 详细规则 |
|---|---|---|
| 初始化 / 更换 API Key | `mocli auth init --apik <key> [--force]` | [auth.md](references/auth.md) |
| 查看认证状态 / 账号资料 | `mocli auth info [--profile]` | [auth.md](references/auth.md) |
| 创建 / 发布笔记 | `mocli note create [--file] [--publish] [--tags]` | [note.md](references/note.md) |
| 编辑笔记正文（整体覆盖） | `mocli note edit --note-id <id> [--file]` | [note.md](references/note.md) |
| 设置公开 / 私有 / 部分公开 | `mocli note set --note-id <id> --privacy <public\|private\|rule> [--disable-share] [--expire-at]` | [note.md](references/note.md) |
| 查看 / 增删改某篇笔记的标签 | `mocli note tag --note-id <id> [--reset\|--append\|--remove]` | [note.md](references/note.md) |
| 笔记详情 / 评论 / 引用 | `mocli note info --note-id <id> --show-comment --show-refer` | [note.md](references/note.md) |
| 读取正文语法树（编辑前准备） | `mocli note info --note-id <id> --show-atom` | [note.md](references/note.md) |
| 按关键词搜笔记 | `mocli notes search --keyword <kw> [--count] [--focus <uid>]` | [note.md](references/note.md) |
| 看某人主页笔记（全部/合集/付费/热门） | `mocli notes homepage [--uid] [--filter] [--count] [--recent]` | [note.md](references/note.md) |
| 看我的笔记（含私有/未公开） | `mocli notes mine [--filter] [--count] [--recent]` | [note.md](references/note.md) |
| 按标签筛选我的笔记 | `mocli notes tagged [--tag-id] [--tag-name] [--count]` | [note.md](references/note.md) |
| 我的标签 / 我的笔记标签 | `mocli tag mine [--filter note]` | [tag.md](references/tag.md) |
| 用户资料 / 创作者画像 | `mocli user info --uid <uid> [--note]` | [user.md](references/user.md) |
| 搜索用户 | `mocli user search --keyword <kw> [--count] [--filter]` | [user.md](references/user.md) |
| 设置 / 删除 / 查询备注名 | `mocli remark set\|remove\|list ...` | [remark.md](references/remark.md) |
| 我的动态（点赞/评论/关注/收藏/关注的人新笔记） | `mocli disco activity [--recent]` | [discover.md](references/discover.md) |
| 上传图片 / 音频 / PDF 拿 `file_id` | `mocli misc upload --file <path> \| --url <url>` | [misc.md](references/misc.md) |

## 通用执行流程

1. 先判断用户意图对应的具体 `mocli` 子命令；不要用搜索类命令替代更精确的列表类命令。
2. 如果命令需要 UID，而用户给的是人名、昵称或备注名，优先用 `mocli remark list --keyword <name>` 查 UID；未命中再用 `mocli user search`，或询问用户补充 UID。
3. 执行 `mocli` 后先读取顶层 `code`、`status`、`reason`，确认成功后再解析 `reply`。
4. 列表类结果优先按 `reply` 里的有序 ID 列表（`note_ids`、`uids`、`events`）遍历；再到对应 Map（`notes`、`users`）取详情，**不要直接遍历 Map**，否则顺序会乱。
5. 写入 / 删除类操作（`create`、`edit`、`set`、`tag` 写操作、`remark set/remove`、`auth init`、`misc upload`）执行前必须复述目标对象与改动内容，得到用户确认。

## 响应解析规则

- `code=0` 且 `status=OK` 表示成功；业务数据通常在 `reply` 中。
- `meta.alerts` 表示重要提示，成功或失败时都可能出现；应优先关注。CLI 新版本提醒通常附在业务结果之后。
- `status=FAIL` 或 `code!=0` 表示失败，应优先展示 `reason`、`msg` 和 `meta.hints` 中的可执行建议。
- `reason=AUTH`：提醒用户重新提供 API Key，并用 `mocli auth init --apik <api-key> --force` 更新配置；**不要输出旧 API Key**。
- `reason=VALIDATE`：参数不合法，按当前命令的参数范围给出可选修正。
- `reason=NETWORK`：网络或代理失败；受限环境可提示需要网络/代理权限。
- `reason=API` 且存在 `api_error.trace_id`：展示 `trace_id` 便于反馈问题，但不要泄露认证信息。
- 如果返回空列表或空 Map，明确说明“没有找到符合条件的数据”，不要编造结果。

完整的输出协议、`code/status/reason` 枚举与共用字段定义见 [references/output-proto.md](references/output-proto.md) 和 [references/output-schema.md](references/output-schema.md)。

## 响应展示规则
<a id="reply-display-rules"></a>

**总则：根据用户的要求，基于数据条目的多少，尽量清晰、明确、格式优美地展示给用户。**

细则：

- 避免数据枯燥，适当增加一些 emoji 增加趣味性。
- 时间戳格式化为可读时间。
- Bool 值尽量用 emoji 展示。
- 数据比较少时，尽量详细地展示信息。
- 数据比较多时，通过表格/列表等形式清晰展示。表格字段选择上：
  - 首先根据用户要求，选择用户关心的字段；
  - 用户未指定字段时，展示大多数条目都具备的字段，最大化利用展示空间，同时尽量避免某一列只有少数数据。
- 展示 `UserInfo.name` 时，如果客户端支持 Markdown/HTML 链接且同一 `UserInfo` 的 `home_url` 非空，用链接包裹名称（如 `[name](home_url)`）；否则只展示名称，不编造或输出空链接。
- 展示 `NoteInfo.title` 时，如果客户端支持 Markdown/HTML 链接且同一 `NoteInfo` 的 `url` 非空，用链接包裹标题（如 `[title](url)`）；否则按原有标题规则展示，不编造或输出空链接。
- 以上细则与用户要求不一致时，以用户要求为准。

**笔记列表展示建议：**

- 数据较少时，逐条展示核心信息：时间、作者、标题、摘要；用户关注某个字段（阅读数、是否付费、公开状态）时优先补充。
- 数据较多时，先给简短概览（数量、时间范围、主要作者或主题），再列出若干条最相关或最新的重点笔记；不要只做概括而省略具体条目。
- 标题优先用 `note.title`，若标题本身不含「」或『』就用『』包裹；作者优先用 `users[note.uid].name`；摘要优先用 `note.brief`。
- 字段缺失时不要编造：可省略，或用“无标题”“未知作者”“无摘要”等明确占位。

## 跨领域工作流

- **UID 解析链**：人名/昵称/备注名 → `mocli remark list --keyword <name>`（命中唯一即可直接用）→ 命中多个则展示候选让用户确认 → 未命中再用 `mocli user search --keyword <name>` → 仍无结果则询问用户补充 UID。
- **标签候选**：需要“从已有标签里挑几个”时，先 `mocli tag mine` 拿候选；用户确认后再用 `mocli note tag`（追加用 `--append`，覆盖用 `--reset`）。`mocli tag mine` 只读，不做写入。
- **正文资源引用**：创建/编辑笔记时若正文含图片、音频、PDF 引用，先问用户是“上传到墨问并引用 `file_id`”还是“保留原始 URL/路径文本”，不要擅自上传；确定上传后走 `mocli misc upload`，再把结果转成正文树资源节点。完整流程见 [note.md](references/note.md) 的“正文资源引用处理流程”。
- **笔记正文**：`mocli note create` / `note edit` 接收的是墨问笔记正文语法树 JSON，**不能直接传 Markdown / HTML / 纯文本**。格式规范见 [references/note-content-schema.md](references/note-content-schema.md)。

## 安全规则

- **禁止输出密钥**（`user_key`、`api_key`）到终端明文；即使 CLI 返回的是脱敏值，也不要额外复述完整密钥。
- **写入 / 删除操作前必须确认用户意图**（`note create/edit/set/tag` 写操作、`remark set/remove`、`auth init`、`misc upload` 等）。
- 上传本地文件或远端 URL 会向墨问服务端提交文件内容；文件可能含隐私信息时先确认。

## 更新提醒

`mocli` 检测到新版本时会通过 `meta.alerts` 返回更新提醒，属于重要信息，应**明确、显式**地展示给用户，同时避免反复打扰：

- 保留当前版本、最新版本、构建时间和更新命令等关键信息。
- 用醒目的 **emoji + 简短文字** 说明这是 CLI 更新提醒，但不要改写或省略具体更新命令。
- 若本会话已明确展示过同一提醒（按当前版本+构建时间、最新版本+构建时间判断），后续响应中仍可提醒，但**弱化**为简短尾注、不占用主要内容区域。
- 不要自动执行更新命令，除非用户明确要求。
- 响应中同时存在业务数据和更新提醒时，先展示业务结果，再附更新提醒。

## references 索引

按需 read，不要一次性全读。

| 文件 | 内容 |
|---|---|
| [auth.md](references/auth.md) | `mocli auth` — API Key 初始化 / 更新 / 认证状态 / Profile |
| [note.md](references/note.md) | `mocli note` + `mocli notes` — 创建、编辑、隐私、标签、详情、搜索、主页、我的、按标签筛选；含正文资源引用流程与编辑覆盖风险门禁 |
| [tag.md](references/tag.md) | `mocli tag` — 我的标签列表 |
| [user.md](references/user.md) | `mocli user` — 用户资料 / 画像 / 搜索 |
| [remark.md](references/remark.md) | `mocli remark` — 本地备注名（remark → UID） |
| [discover.md](references/discover.md) | `mocli disco` — 我的动态与事件解析 |
| [misc.md](references/misc.md) | `mocli misc` — 文件上传获取 `file_id` |
| [note-content-schema.md](references/note-content-schema.md) | 笔记正文语法树（NoteAtom）规范，创建/编辑笔记必读 |
| [output-proto.md](references/output-proto.md) | 输出协议、`code/status/reason` 枚举、`api_error` / `meta` |
| [output-schema.md](references/output-schema.md) | 共用输出字段：UserInfo / NoteInfo / CommentInfo / NoteStat / NoteEmbed 等 |
| [api-key.md](references/api-key.md) | 墨问 API Key 获取方式与更换说明 |

## 维护

```bash
bash scripts/sync-upstream.sh          # 从上游重建 references/ 与 .upstream-state
bash scripts/sync-upstream.sh --check  # 检测上游是否有更新（有更新时退出码为 1）
```

`SKILL.md` 为手工维护，同步脚本不会覆盖。上游 `skills/mo-shared/SKILL.md` 变化时，`--check` 会提示人工复核本文件中的共享规则。
