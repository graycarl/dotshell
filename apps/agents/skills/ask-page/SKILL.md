---
name: ask-page
description: >
  把内容做成可交互网页给用户确认、批注、选择、传图；用户提交后 agent 立刻拿到结果继续。
  用户要求"上网页确认 / 评审 / 批注 / 用 ask-page 问一下"时使用。
---

# ask-page：把内容展示到网页上，收集用户的确认与批注

agent 写一个 HTML 页面 → 脚本在 `127.0.0.1` 上起服务并打开浏览器 → 用户在页面上
确认/批注/传图 → 点提交 → agent 收到 JSON 继续干活。

**只用 Python 标准库，不需要任何扩展，pi 和 opencode 都能用。**

## 1 什么时候用

| 场景 | 用什么 |
|---|---|
| 方案/计划/文档/diff/报告要用户拍板 | **ask-page** |
| 用户要逐条写批注、圈重点、贴截图 | **ask-page** |
| 内容长、有代码块/表格/图片，TUI 里塞不下 | **ask-page** |
| "要么 A 要么 B，选一个" | `ask_user` |
| 需要用户提供一小段文字/一个文件名 | 直接问，或 `ask_user` |
| 页面要挂几个小时、期间还想跟 agent 聊别的 | `start` + 稍后 `collect`（见 §4） |

不要为了用而用：如果一句话就能问清楚，别起网页。

## 2 前置

- `python3` 可用即可（脚本只用标准库）。
- 产物写在 `<cwd>/.pi/ask-page/`。默认**不进 git 忽略**（本 skill 不改 `.gitignore`）；
  需要的话提醒用户自行加 `.pi/ask-page/`。
- 浏览器默认自动打开（macOS `open` / Linux `xdg-open`）。打不开会把 URL 打到 stderr。
  非图形环境用 `--no-open`，或设 `ASK_PAGE_NO_OPEN=1`。

## 3 快速开始

```bash
SKILL=<本 SKILL.md 所在目录，pi 下通常是 ~/.pi/agent/skills/ask-page>

# ① 复制脚手架模板，然后在里面填内容
mkdir -p .pi/ask-page
cp "$SKILL/assets/template.html" .pi/ask-page/plan.html

# ② 前台起页面并阻塞等待（提交 / 放弃 / 超时 / 终端 Esc 才返回）
python3 "$SKILL/scripts/ask_page.py" ask --html-file .pi/ask-page/plan.html --id plan
```

stdout 只有**一行 JSON**，stderr 是进度和 URL。退出码：`0` 已提交 · `2` 放弃 ·
`3` 超时 · `4` 未提交（仅 collect）· `5` 被中止。

拿到结果后**必须**继续处理，不要只把 JSON 贴给用户：

```json
{"status":"submitted","pageId":"plan","payload":{
  "decision":"revise",
  "comments":[{"anchor":"plan-3","text":"这里要加回滚步骤"}],
  "choices":{"decision":"revise"},
  "uploads":[{"name":"shot.png","relPath":"uploads/shot.png"}]}}
```

- `decision` = `approve` / `revise` / `reject`（模板默认三个按钮；用户也可能不选）。
- `comments[].anchor` 对应你写的 `data-pi-anchor`，按它定位要改的地方。
- `uploads[].path` 是本地绝对路径，**可以直接 read / 查看**用户贴的图。

## 4 三种用法

### 4.1 一次确认（默认）

`ask` 前台阻塞，提交后同一轮继续。适合"改完这次就往下走"。

### 4.2 长时间审阅：先后台挂上，下一轮再取

用户可能要看很久，不希望 agent 干等：

```bash
python3 "$SKILL/scripts/ask_page.py" start --html-file .pi/ask-page/plan.html --id plan
# → {"status":"started","url":"http://127.0.0.1:51234/?t=...","pageId":"plan",...}
```

然后**结束本轮**，告诉用户"页面已打开，看完提交后回到终端说一声"。用户回来说一声后：

```bash
python3 "$SKILL/scripts/ask_page.py" collect plan   # 未提交 → status=pending, exit 4
python3 "$SKILL/scripts/ask_page.py" wait plan      # 还没看够？阻塞等着
```

> ask-page 无法主动唤醒 agent（外部脚本没法往运行中的 pi 注入消息），所以"用户
> 回来喊一声 → `collect`"就是异步的替代方案：拿到结果是即时的。

`collect` 拿到结果之后**顺手收尾**：这一轮结束了就用 `cleanup --keep-files` 关掉
服务、保留 `page.html`/`result.json` 供用户回看；确定不再翻了就直接 `cleanup`。
别把 daemon 一直挂着（虽然它到 `--idle-timeout` 会自己退出）。

### 4.3 多轮迭代：原地刷新

用户提了修改意见，改完要让他在**同一个页面上**再看一遍：

```bash
cp "$SKILL/assets/template.html" .pi/ask-page/plan-v2.html   # 用新内容重写
python3 "$SKILL/scripts/ask_page.py" update plan --html-file .pi/ask-page/plan-v2.html
```

`update` 需要 `start` 起的 daemon 还在跑。同一个 `pageId` 会**复用端口和 token**，
所以用户已经打开的那个标签页会自动刷新到新版本（页面每 1.5s 轮询 `/pi/state`）。
上一轮的结果会被归档到 `<pageId>/results/round-*.json`，`collect` 拿到的是新的一轮。

如果用的是前台 `ask`：直接再跑一次 `ask --id plan` 即可——同样复用端口，旧标签页刷新。

## 5 页面怎么写

**默认从 `assets/template.html` 复制**（亮/暗主题、批注抽屉、提交栏、上传区都有），
再替换 `<main>` 里的内容。也可以完全手写 HTML —— 服务器会自动注入 `pi.js` 和
`window.__PI__`，你只需要用下面的标记。

| 想要的效果 | 写法 |
|---|---|
| 让某块内容可被点击批注 | `<h2 data-pi-anchor="plan-3">…</h2>`（anchor 名唯一、用英文短横线） |
| 结论按钮（通过/修改/否决） | `<div data-pi-choice="decision" data-pi-options="approve,revise,reject" data-pi-labels="通过 \| 需要修改 \| 否决">` |
| 多选 | 同上加 `data-pi-multiple="true"` |
| 上传区 | `<div data-pi-upload>点击添加文件</div><div data-pi-uploads-list></div>` |
| 批注列表 | `<div data-pi-comments></div>`（数量用 `<span data-pi-comments-count>0</span>`） |
| 提交 / 放弃按钮 | `<button data-pi-submit>` / `<button data-pi-cancel>` |
| 不想手写 HTML | `<script type="text/markdown">…</script>`，文本会被极简 markdown 渲染（标题、列表、代码块、表格、引用） |

其它约定：

- **离线**：不要引用 CDN，字体/图标/JS 都会加载失败（页面在 `127.0.0.1` 上，没有外网假设）。
- **图片**：把图片放在 `--assets DIR` 里，用 `/assets/foo.png` 引用；或直接和
  `page.html` 放同一目录，用相对路径 `foo.png`。小图也可以 inline 成 data URI。
- **代码/diff**：用 `<pre>`、`.diff`、`.callout` 这些模板里的类名，观感会统一。
- 页面里可以自己调 `pi.submit()` / `pi.comment()` / `pi.upload()` 做更复杂的交互；
  完整 API 见 `references/protocol.md`。
- 需要动态渲染内容时，渲染完调用 `pi.rescan()` 让 SDK 重新扫描 `data-pi-*` 标记。

## 6 收尾

页面目录会留在 `.pi/ask-page/`，方便用户事后回看。任务彻底结束后：

```bash
python3 "$SKILL/scripts/ask_page.py" cleanup plan            # 关服务 + 删目录
python3 "$SKILL/scripts/ask_page.py" cleanup plan --keep-files  # 只关服务，留 page.html/result.json
python3 "$SKILL/scripts/ask_page.py" cleanup --all
```

- `start` 起的 daemon 默认 12 小时无活动后自动退出（`--idle-timeout` 可调）。
- `list` 可以看到所有页面、状态和 daemon 是否还活着。

## 7 坑

- **stdout 只有一行 JSON**。解析它；别把 stderr 的内容当结果。
- `ask` 阻塞期间用户可以在终端按 Esc 中止 → 退出码 5、`status=aborted`，页面会失效。
- 提交是幂等的：第一次生效，之后的提交返回 `accepted:false`。
- 用户可能只写批注不点结论，也可能直接放弃（`status=cancelled`）——三种情况都要处理。
- 别忘了 `--id`：不给的话会从 html 文件名推导，太随意时（比如 `index.html`）会互相覆盖。
- 每次 `ask`/`update` 都会把版本 +1 并归档上一轮结果；`collect` 拿的永远是最新一轮。
- 页面 URL 带 token，不要把它写进要在仓库里提交的文件。
