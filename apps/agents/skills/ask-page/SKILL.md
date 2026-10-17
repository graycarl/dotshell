---
name: ask-page
description: >
  把内容做成一份本机 HTML 页面给用户审阅：逐条批注，点「复制结果」粘回对话继续。
  用户要求"上网页确认 / 评审 / 批注 / 用 ask-page 问一下"时使用。
---

# ask-page：把内容搬到网页上，让用户批注后粘回来

agent 写正文 → 脚本拼成一份**自包含 HTML** → 打开浏览器 → 用户逐条批注 →
点「复制结果」（按钮上方弹出预览）→ 粘回对话 → agent 解析继续。

**没有服务进程、没有端口、没有后台任务、没有需要清理的东西。** 产物就是一份
单文件 HTML，可以随便拷贝、邮件、归档。

## 1 什么时候用

| 场景 | 用什么 |
|---|---|
| 方案 / 计划 / 文档 / diff / 报告要用户拍板 | **ask-page** |
| 用户要逐条写批注、圈重点 | **ask-page** |
| 内容长、有代码块 / 表格，TUI 里塞不下 | **ask-page** |
| "要么 A 要么 B，选一个" | `ask_user` |
| 需要用户提供一小段文字 / 一个文件名 | 直接问，或 `ask_user` |

不要为了用而用：一句话能问清楚，就别开网页。

## 2 四步流程

```bash
SKILL=~/.pi/agent/skills/ask-page     # 本 SKILL.md 所在目录
mkdir -p .pi/ask-page
```

**① 写正文**（不是整页 HTML，只写要展示的内容）→ `.pi/ask-page/plan.body.html`

**② 生成并打开**

```bash
python3 "$SKILL/scripts/ask_page.py" new plan --title "方案确认" --open
# → {"status":"built","pageId":"plan","path":"…/plan.html","url":"file://…","bytes":27431,"opened":true}
```

stdout 只有一行 JSON；stderr 是进度。

**③ 结束本轮**，告诉用户：

> 页面已经打开了。看完点右下角「复制结果」，确认预览内容后粘回来说一声。

**④ 用户粘回来** → 按 §4 解析 → 继续干活。

> ⚠️ 不要试图等待或轮询：这里没有任何进程在跑，"等"就是结束本轮。

## 3 正文怎么写

只写 `<main>` 里的内容（样式和脚本由脚本负责注入），推荐用 `<section>` 分块。

| 想要的效果 | 写法 |
|---|---|
| 让某块内容可被点击批注 | `<h2 data-pi-anchor="plan-3">…</h2>`（**anchor 唯一、英文短横线、跨轮次稳定**） |
| 让用户从几个选项里选一个 | `<div data-pi-option="priority" data-pi-prompt="发布优先级" data-pi-options="low,medium,high" data-pi-labels="低 \| 中 \| 高"></div>` |
| 多选 | 同上加 `data-pi-multiple="true"`；默认值 `data-pi-default="low,high"` |
| 卡片式选项（能放标题、说明、代码） | 自己写内容，给每一项加 `data-pi-value`：`<div data-pi-option="plan" data-pi-prompt="选一个方案"><div class="card" data-pi-value="a"><b>方案 A</b>只加索引</div>…</div>` |
| 不想写 HTML | `<script type="text/markdown">…</script>`，会被就地渲染（标题、列表、代码块、表格、引用） |

现成的例子：`assets/example.html` 覆盖了全部预置组件，直接

```bash
python3 "$SKILL/scripts/ask_page.py" new demo --title "组件清单" --body "$SKILL/assets/example.html" --open
```

可用的样式类（已内置，直接用）：

- `.callout` / `.callout.warn` / `.callout.ok` —— 提示块
- `.diff` + `.add` / `.del` / `.hunk` —— diff 着色
- `.card-grid` + `.card` —— 卡片（也可以直接当选项用）
- 普通 `<pre><code>`、`<table>`、`<img>` 都有统一观感

关于卡片式选项：导出时的名称取该项**第一个子元素**的文字（比如 `<b>方案 A</b>`），太长会截断；
想自己定就用 `data-pi-label="方案 A"`。卡片里的链接/按钮不会被选项的点击吃掉。

约定：

- **离线**：页面在 `file://` 下打开，不要引用 CDN、外部字体或远程图片。
  图片和 `plan.html` 放同一目录，用相对路径引用。
- 页面标题用 `--title`，不要在正文里重复写 `<h1>`。
- 正文只管内容，不要写 `<style>` / `<script>`（会被当成内容渲染）。

## 4 解析用户粘回来的结果

用户粘回来的是一段带哨兵的 Markdown：

```text
<!-- ask-page-result · pageId=plan · 2026-05-01T12:00Z -->

## 选择

- 发布优先级（priority）：中（medium）

## 批注（2 条）

### [plan-3] 方案要点 3 · 回滚
这里要加回滚步骤

> 圈选原文：提交后直接切流量

### [summary] 摘要
这段没问题，但建议补一句适用范围

<!-- /ask-page-result -->
```

解析规则只有三条：

1. 取 `<!-- ask-page-result` 与 `<!-- /ask-page-result -->` 之间的内容
2. `## 选择` 小节：每行 `- 名称（id）：标签（值）` 是一道题的答案；**没有这一小节 = 用户没选**
3. 每个 `### [锚点] 标签` 起一条批注：**下一行到下一个 `>` 行 / 下一个 `### [` / 哨兵** 之间是批注正文，
   `> 圈选原文：` 是用户圈中的原文（可能没有）

补充：

- 选项的 `（值）` 部分可能省略（当标签和值相同时）；多选的值用 `, ` 分隔、标签用 `、` 分隔。
- 选项可以**不回答**：点了又点一下就能取消。只导出用户真正选了的题。
- 标题里出现 `⚠ 位置已失效` 表示这一轮的页面里已经没有该 anchor（用户批注时的那段被删了），
  按标签推断指的是哪里，不确定就问一句。
- 批注是**增量反馈**，不是全量清单：用户可能保留了上一轮未解决的批注，按内容判断，
  已改好的不用重复处理。

拿到结果后**必须继续干活**，不要只把结果复述一遍。

## 5 多轮迭代

用户提了修改意见、你改完之后，想让他在**同一个页面**上再看一遍：

```bash
# 只改 .pi/ask-page/plan.body.html，然后：
python3 "$SKILL/scripts/ask_page.py" new plan --title "方案确认（v2）" --open
```

然后告诉用户：**「点页面右上角的 ↻ 载入最新内容」**（或者重新打开也行）。

两条硬约束：

1. **`<id>` 跨轮次不变**：不要生成 `plan-v2.html`。pageId 变了，用户上一轮的草稿就丢了。
2. **anchor 命名跨轮次稳定**：`plan-3` 永远是同一段话。改了 anchor，用户的旧批注会变成「位置已失效」。

## 6 草稿存在哪

- 存在浏览器的 localStorage 里，key 是 `ask-page:<pageId>`。
- **`file://` 下所有本地页面共用一个 origin**，所以必须靠 pageId 隔离 —— 这也是不要让 id 乱变的另一个原因。
- 草稿**跨轮次保留**：用户改好的自己删，没改好的留着再提交一次。页面上有「清空草稿」。
- 选择题的答案和批注存在同一份草稿里；页面里已经不存在的那道题，它的旧答案不会被导出。
- 提交过的批注会打上「已提交」标记，但**仍然会被再次导出** —— 提醒用户删掉已解决的。
- 浏览器禁用本地存储时（隐私模式等），页面会提示「草稿无法保存」，导出仍然可用。

## 7 收尾

页面会留在 `.pi/ask-page/`，方便用户事后回看：

```
.pi/ask-page/
├── plan.body.html   你写的正文（下一轮改这个）
└── plan.html        生成的页面（单文件，可直接打开 / 拷贝）
```

任务彻底结束后可以删掉，也可以留着。不要把它加进 git（除非用户要求）。

## 8 坑

- **stdout 只有一行 JSON**，解析它；别把 stderr 当结果。
- 图片/截图**不在页面上传**：请用户在对话里直接贴图。
- 页面不会自动刷新（没有服务端），改完必须让用户点「↻ 载入最新内容」。
- `new` 会覆盖旧的 `plan.html`，但**不会**动 localStorage 里的草稿。
- 用户可能一条批注都没写就关掉页面 —— 那说明他没意见或不想说，别追问。
- `list` 可以看目录里有哪些页面：`python3 "$SKILL/scripts/ask_page.py" list`。
- 页面 URL 是普通 `file://` 路径，不含 token，但仍不建议提交进仓库。
