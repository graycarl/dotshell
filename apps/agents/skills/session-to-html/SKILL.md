---
name: session-to-html
description: >
  把一个 pi session（对话记录）渲染成一份展示「对话过程」的单文件 HTML 报告：
  只取 active branch、用户输入原文保留、agent 输出做简短抽象、包含每一次 ask_user
  反问与用户选择、带 SVG 图形与亮暗主题切换。当用户说「把这个 session 转成
  html」「把刚才的对话导出成网页」「复盘这次对话」「生成对话过程报告」，或要求把
  某次 pi 会话整理成可视化页面时使用。
---

# session → 对话过程 HTML

把一个 pi session 变成一份可分享的单文件 HTML 报告。

**产出视角是固定的：对话过程。** 不追问用户要什么视角，不做其他报告类型（不做
技术结构图、不做工作量统计图、不做多视角对比）。报告回答一个问题：**这场对话是
怎么一步步发生的。**

## 1 事实基础（写报告前必须知道）

| 事项 | 结论 |
|---|---|
| session 位置 | `~/.pi/agent/sessions/--<cwd 变形>--/<时间戳>_<id>.jsonl`。目录名 = cwd 去掉开头 `/`、把 `/` `\` `:` 换成 `-`，两侧包 `--` |
| 文件格式 | JSONL，`id`/`parentId` 构树；`type` 有 `session` / `message` / `model_change` / `thinking_level_change` / `usage` |
| active branch | **文件顺序里最后一个 `type == "message"` 的条目**就是叶子，沿 `parentId` 回溯即是主线 |
| 回退 | 被 rewind 的支线仍留在文件里（本次实测：345 条消息里 33 条是两条被回退的旁枝）。不回溯就会把支线当主线 |
| 时间戳 | 条目里是 ISO 8601 UTC；`message.timestamp` 是 Unix 毫秒。**报告统一按 UTC 呈现并在脚注注明** |
| 正在进行的会话 | JSONL 可增量读，所以「把这次对话转成 html」也成立 |

## 2 文件清单

```
scripts/extract.py   # session → 事实（digest / --turn / --json）
scripts/svgkit.py    # SVG 排版：混排折行、卡片高度、转义、常用图形
scripts/verify.py    # 校验报告里引用的用户原文与 session 是否一字不差
templates/report.html# 骨架 + CSS（亮/暗双主题）+ 主题切换 JS
```

路径按本 skill 目录解析。脚本只用 Python 标准库。

## 3 流程

### Step 1 定位 session，读 digest

```bash
python3 <skill>/scripts/extract.py                      # 当前 cwd 最近一条
python3 <skill>/scripts/extract.py --session .shell     # 按项目
python3 <skill>/scripts/extract.py --session 01a120ea   # 按 session id 前缀
python3 <skill>/scripts/extract.py --session /path/x.jsonl
python3 <skill>/scripts/extract.py --list               # 列候选
```

匹配不到、或 id 前缀命中多条时，脚本会打印候选清单——**拿着清单问用户，不要猜**。

**只读 digest，不要一上来读 `--json`**：3 MB 的 session 序列化后足以吃掉大量上下文。
digest 已包含每轮的完整用户原文、工具计数、写改文件、`ask_user` 问答与收尾摘要。
需要 agent 原话时再下钻：

```bash
python3 <skill>/scripts/extract.py --turn 3,7           # 指定轮次的全文细节
```

### Step 2 逐条澄清「非主线交互」的剔除 ⚠️ 不要跳过

digest 末尾给了两份**证据**（`signals` 与 `支线清单`）：

- 每轮一行 `写改 N · 提交 N`：两者都是 0 的轮次，就是**零产出**候选
- `支线清单`：被 rewind 的旁枝，含 fork 时间、消息数、首条用户输入

**逐条**列给用户确认是否剔除：一条一行，写清「它是什么」「证据」「你的建议」，
然后请用户逐条给结论。用户可以一次性回复（例如「全部去掉」「3 和 5 去掉」），
但你**必须先把候选逐条摆出来**——只问一句「要不要剔除脏交互」而不给依据是不合格的。

三条纪律：

1. **事实归脚本，结论归用户。** 脚本标的是「零产出」，不等于「脏交互」——例如
   「你为什么要从根目录搜索 pi-tui」没改任何文件，却改掉了错误的检索路径、直接
   催生了后面的实现。删不删由用户拍板。
2. **这一步必须在渲染之前做完**，否则整个 SVG 白重做一遍。
3. 剔除结果要落到报告脚注里：`已按确认剔除 N 处与主线无关的交互`。但**报告正文
   里不出现「脏交互 / 非主线」任何字样**，支线只体现为脚注里的一个总数。

### Step 3 逐轮抽象 agent 内容，并判定反问

**用户输入原文保留**（含引号、换行、报错堆栈），一字不改。**agent 的动作与回复
抽象成 1–2 行**。

反问的判定单位不是「一条 agent 输出」，而是「**agent 输出 + 下一轮用户输入**」这
一对。digest 的「反问候选」区块已把这两半摆在一起：

| 形态 | 判定依据 | 报告里怎么呈现 |
|---|---|---|
| **真反问** | 下一轮用户输入就是它的回答（做选择、给约束、延续该话题） | 反问卡；并在下一轮用户节点上标「↳ 上一轮的回答」 |
| **预告** | 该轮末段的问题后面紧跟 `ask_user` 调用 | 不单独成卡，问题本身在 ask_user 卡里 |
| **附带问句** | 下一轮换了话题、提了新需求、或直接 `commit and push` | 不渲染为反问卡，只作为该轮 agent 回复的一部分 |

`ask_user` 与文字反问都要**把答案显式连出来**，否则读者看不出哪句是对谁的回答：
`ask_user` 的答案在 toolResult 里，文字反问的答案在下一轮用户输入里。

> 脚本的 `signals` 只能看见「写改」和「提交」。**「改动了又回滚」这种净效果为零的
> 轮次抓不到**（它在两轮里各写了两个文件），需要你读 digest 时自己留意。

### Step 4 生成 SVG，套模板写 HTML

用 `svgkit.py` 排版（不要手写折行——中英混排的宽度计算和卡片高度是最容易翻车的
地方）：

```python
import sys; sys.path.insert(0, "<skill>/scripts")
import svgkit as k

lines = k.wrap(text, width_px=700, font=12.5)      # CJK 1.0em / ASCII ~0.55em
h = k.card_height(len(lines), line_h=19)
body.append(k.card(x, y, 760, h, cls="box-soft"))
markup, next_y = k.lines_at(x + 14, y + 26, lines, 19, "tq")
```

结构固定三段：

1. **概览** —— 主线节点图，一屏看完全程（时间 / 用户做了什么 / 结果）
2. **对话过程** —— 主体：用户原文卡 + agent 抽象卡 + 反问卡（含选项与选择）
3. **脚注** —— 数据来源、口径（UTC、已剔除项、active branch 范围）、产物

标题、副标题、chips（如「我的输入 6 条 / ask_user 反问 10 次 / 主线 28 个节点」）
从 `--json` 的 `totals` 里取真实数字，不要手写。

写完后套 `templates/report.html`：替换 `{{TITLE}}` `{{SUBTITLE}}` `{{CHIPS}}`
`{{OVERVIEW}}` `{{TRANSCRIPT}}` `{{FOOTER}}`，以及 `{{VERBATIM_JSON}}`。

**`{{VERBATIM_JSON}}` 的写法**（verify.py 依赖它）：

```json
{"turns": [{"i": 1, "text": "<第 1 轮用户输入，原样，不要转义换行以外的任何东西>"}]}
```

它必须**包含报告里引用到的每一轮用户原文**，内容直接来自 `--json` 的
`turns[].user`，不要手打、不要"顺手润色"。

### Step 5 校验原文

```bash
python3 <skill>/scripts/verify.py output/<task>/<name>.html --session <同一个 session>
```

不一致就退出码 1 并指出第几个字符不同。「用户原文一字不差」是这份报告唯一的硬不
变量，而它恰恰是肉眼最难查的（丢一个引号、把 `"pi -ne"` 写成 `pi -ne`，没人会发
现）。**建议每份报告都跑一次。**

### Step 6 交付

按仓库惯例输出到 `output/<task_name>/<filename>.html`；用户显式给了路径就用用户的。

交付说明里写清楚：文件路径、scope（active branch、UTC）、跑了哪些检查、以及**跳过
了什么**（没做视觉验证、没剔除任何交互等）。

## 4 常见坑

- **不回溯树** → 把 rewind 掉的支线当成主线渲染。先确认 `支线 N 条` 这个数字，再
  动手；有支线时不要凭文件名顺序假设对话是线性的。
- **一上来 `--json`** → 大 session 撑爆上下文。先 digest。
- **手写折行** → 英文单词被从中间劈开（`setEditorCompone|nt`），或卡片高度算错导致
  文字溢出边框。用 `svgkit.wrap` + `svgkit.card_height`。
- **SVG 多写一个 `<svg>` 开标签** → 浏览器按嵌套 SVG 缩放，页面出现大片空白。
- **`thinkingLevel` 在 message 上，不在条目上** → 取字段时容易取错层级。
- **改了用户原文** → verify.py 会拦，但最好一开始就别碰。
