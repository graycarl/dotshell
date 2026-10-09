---
name: session-to-html
description: >
  把一个 pi session（对话记录）渲染成一份展示「对话过程」的单文件 HTML 报告：
  只取 active branch、用户输入原文保留、agent 输出做简短抽象、包含每一次 ask_user
  反问与用户选择、带 SVG 图形与亮暗主题切换。当用户说「把这个 session 转成
  html」「把刚才的对话导出成网页」「复盘这次对话」「生成对话过程报告」，或要求把
  某次 pi 会话整理成可视化页面时使用。会话可以用 session id 前缀、项目路径，或用
  `/name` 设的 session 名来指定。
---

# session → 对话过程 HTML

把一个 pi session 变成一份可分享的单文件 HTML 报告。

**产出视角是固定的：对话过程。** 不追问用户要什么视角，不做其他报告类型（不做
技术结构图、不做工作量统计图、不做多视角对比）。报告回答一个问题：**这场对话是
怎么一步步发生的。**

**形心默认要有图形。** 时间轴、分叉/合流、流水线、色板、大数字仪表盘都是 spec 里的
普通块类型（见 §4），不用写 Python，所以「整篇都是文字卡」不算交付完成。

## 1 事实基础（写报告前必须知道）

| 事项 | 结论 |
|---|---|
| session 位置 | `~/.pi/agent/sessions/--<cwd 变形>--/<时间戳>_<id>.jsonl`。目录名 = cwd 去掉开头 `/`、把 `/` `\` `:` 换成 `-`，两侧包 `--` |
| session 名称 | 存在 session 文件里的 `session_info` 条目（`{"type":"session_info","name":"..."}`，由 `/name`、`--name`、`pi.setSessionName()` 设置）。最后一个 `session_info` 是当前名称；名称为空表示已清除 |
| 文件格式 | JSONL，`id`/`parentId` 构树；`type` 有 `session` / `message` / `model_change` / `thinking_level_change` / `usage` / `session_info` |
| active branch | **文件顺序里最后一个 `type == "message"` 的条目**就是叶子，沿 `parentId` 回溯即是主线 |
| 回退 | 被 rewind 的支线仍留在文件里（本次实测：345 条消息里 33 条是两条被回退的旁枝）。不回溯就会把支线当主线 |
| 时间戳 | 条目里是 ISO 8601 UTC；`message.timestamp` 是 Unix 毫秒。**报告统一按 UTC 呈现并在脚注注明** |
| 正在进行的会话 | JSONL 可增量读，所以「把这次对话转成 html」也成立 |

## 2 文件清单

```
scripts/extract.py   # session → 事实（digest / --turn / --json / --timeline）
scripts/reportkit.py # 高层排版 + spec 渲染器：轮卡、面板、多列、两栏汇总、脚注、套模板
scripts/artkit.py    # 图形层：时间轴条形图 / 分叉合流 / 流水线 / 色板 / 大数字仪表盘
scripts/svgkit.py    # 底层 SVG 原语：折行（含安全系数）、卡片高度、转义、图形
scripts/preview.py   # 把报告里的 SVG 出成 PNG（内联亮/暗主题色），目视检查版式
scripts/verify.py    # 校验报告里引用的用户原文与 session 是否一字不差
templates/report.html# 骨架 + CSS（亮/暗双主题）+ 主题切换 JS
```

路径按本 skill 目录解析。脚本只用 Python 标准库。产物默认写到 `~/Inbox/`（见
Step 2），不在仓库里建 `output/` 目录。

## 3 流程

### Step 1 定位 session，读 digest

```bash
python3 <skill>/scripts/extract.py                      # 当前 cwd 最近一条
python3 <skill>/scripts/extract.py --session .shell     # 按项目
python3 <skill>/scripts/extract.py --session 01a120ea   # 按 session id 前缀
python3 <skill>/scripts/extract.py --session report-demo # 按 session 名（/name 设的名字）
python3 <skill>/scripts/extract.py --name report-demo   # 只按 session 名（名字与项目名可能撞车时用）
python3 <skill>/scripts/extract.py --session /path/x.jsonl
python3 <skill>/scripts/extract.py --list               # 列候选（带 id 与 name）
```

名称是**大小写不敏感**的模糊匹配：精确命中优先，其次匹配历史上用过的名字（会提示
`former session name`），最后才取子串。`--session` 会把名称当**最后一道回退**（会先试
项目目录名，避免改变原有行为）；想完全按名称定位（名字可能和项目名撞车）就用 `--name`。
**session 名可以重复**（`init`、`dev` 这类尤其常见）：命中多条时脚本打印候选清单并
退出码 2——**拿着清单问用户，不要猜**。

匹配不到、或 id 前缀命中多条时，脚本同样会打印候选清单——同样不要猜。

digest 头部会给出 `name`（若有）、`file` 与建议的 `outfile`，后续步骤和交付说明里引用
这个 session 时用它们指代，不要写「刚才那个会话」。

**只读 digest，不要一上来读 `--json`**：3 MB 的 session 序列化后足以吃掉大量上下文。
digest 已包含每轮的完整用户原文、工具计数、写改文件、`ask_user` 问答与收尾摘要。
**但 digest 会把 agent 的收尾文字截到 ~200 字**——要写详细的 agent 卡片时下钻：

```bash
python3 <skill>/scripts/extract.py --turn 3,7           # 指定轮次的全文细节
python3 <skill>/scripts/extract.py --timeline          # 直接吐出 spec 的 timeline 段
```

`--turn N` 每轮给出：用户输入原文 + agent 的全部文字段落 + 工具调用 brief + 提交
命令。写「工作脉络 / 关键点」这类子结构时材料同样来自这里：`todo` 的 create（任务
清单）、`subagent` 的 task（分工与并行约束）、`bash` 里的 commit 与测试/冒烟输出，
都是可溯源的原始事实。

`--json` 的字段（写脚本时用，别照文档里的示例猜）：
`turns[].index`（轮号）、`.user`、`.assistant_texts`、`.assistant_final`、
`.tool_calls`（**列表**，计数用 `len()`）、`.commits`（同样是列表）、`.pushes`；
顶层还有 `session` / `model` / `span` / `branch` / `totals` / `branches` / `turns`。

### Step 2 先问导出位置（默认 `~/Inbox/xxx.html`）

digest 头部的 `outfile` 行就是**建议的默认路径**。**在渲染之前**用「问题 + 默认项」
的形式跟用户确认一次：

> 报告写到 `~/Inbox/init-sdd.html` 可以吗，还是换个位置？

规则：

- 默认目录是 `~/Inbox/`（可用 `SESSION_TO_HTML_OUTDIR` 改）；文件名取 session 名，
  空格、`->` 这类字符压成 `-`（`message max -> 200` → `message-max-200`），没名字就
  用 cwd 末段。脚本已经把整条路径算在 `outfile` 里，直接用，不要另起名字
- **同名报告已存在时把三个选项一次问清**：覆盖 / 顺延成 `-2` / 换位置。脚本的建议路
  径默认顺延，用户说覆盖就按原路径写（`reportkit.py --out <原路径>`）
- 相对路径按当前 cwd 解析；目录不存在就 `mkdir -p`
- 这一步可以和 Step 3 的剔除确认**合并成同一次询问**，但两件事都必须在渲染前定下来

### Step 3 逐条澄清「非主线交互」的剔除 ⚠️ 不要跳过

digest 末尾给了两份**证据**（`signals` 与 `支线清单`）：

- 每轮一行 `写改 N · 提交 N`：两者都是 0 的轮次，就是**零产出**候选
- `支线清单`：被 rewind 的旁枝，含 fork 时间、消息数、首条用户输入

**逐条**列给用户确认是否剔除：一条一行，写清「它是什么」「证据」「你的建议（剔除 /
保留）」，然后请用户逐条给结论。用户可以一次性回复（例如「全部去掉」「3 和 5 去
掉」），但你**必须先把候选逐条摆出来**——只问一句「要不要剔除脏交互」而不给依据是
不合格的。

**用户的总括回复可能和你的建议冲突**（你建议保留、用户回「都去掉」）：这时的「都」
指哪些，要当场确认一句再动手，别自行按最宽或最窄的口径理解——它决定报告有没有结尾。

三条纪律：

1. **事实归脚本，结论归用户。** 脚本标的是「零产出」，不等于「脏交互」——例如
   「你为什么要从根目录搜索 pi-tui」没改任何文件，却改掉了错误的检索路径、直接
   催生了后面的实现。删不删由用户拍板。
2. **这一步必须在渲染之前做完**，否则整个 SVG 白重做一遍。
3. 剔除结果要落到报告脚注里：`已按确认剔除 N 处与主线无关的交互`。但**报告正文
   里不出现「脏交互 / 非主线」任何字样**，支线只体现为脚注里的一个总数。

### Step 4 逐轮抽象 agent 内容，并判定反问

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

### Step 4.5 深度分层：轮 → 子结构 → 图形

报告的最小单位是「轮」，但需要时可以把某一轮展开成子结构——波次、阶段、子任务、
验收项。这是**逐轮各自的深度**，不必全篇统一：常见的组合是「只保留前两轮，但把第
一轮展开到子任务级」。

能画成图的优先画图（并行 → `fork`、阶段 → `pipeline`、前后对比 → `swatches`、数字
→ `tiles`，见 §4）；图说不清的才用 `columns` / `kv` / `panel` 文字块。

- 和 Step 2/3 一起问清：要哪几轮、哪一轮要展开、展开到什么粒度。**渲染完再改等于
  重做一遍 SVG**（有了 `reportkit` 只是重跑一条命令，但用户的等待仍要避免）
- 子结构必须可溯源：任务清单来自 `todo create`，分工与并行约束来自 `subagent` 的
  task，数字来自测试 / 冒烟 / commit 的原始输出，全部读自 `--turn N`。**禁止凭印象
  编造子任务**，也禁止把某一轮的成果记到另一轮名下
- 展开不等于把 agent 输出堆上去：重组成「谁负责什么 → 做到哪 → 验证数字 → 产出」
  的骨架，让推进顺序一眼可见（多列用 `reportkit` 的 `columns` 块）
- 报告的结尾要交代产出：汇总数字（提交数、测试数、冒烟项数、打包产物）通常只在某
  一轮的收尾文字里出现一次，值得单独落一块「交付物与验证」面板（`kv` 块）

### Step 5 写 spec，用 reportkit 渲染

**不要手写几何。** 报告 = 一份 spec（JSON 文件或 Python 调用）+ `reportkit.py`，
这样 Step 2 / 3 / 4.5 的取舍变起来只是改数据、重跑一条命令：

**图形也是 spec 的一部分**：`timeline`（顶层）/ `fork` / `pipeline` / `swatches` /
`tiles` 都是块类型，写 spec 就够，不必写 Python（字段见 §4）。

```bash
python3 <skill>/scripts/reportkit.py spec.json --out ~/Inbox/init-sdd.html
```

spec 的字段与块类型（`turn` / `panel` / `columns` / `kv` / `gap` / `timeline` /
`fork` / `pipeline` / `swatches` / `tiles`）见 `reportkit.py`
的模块文档；等价的 Python API 是
`Doc(...).turn(...) / .columns(...) / .fork(...) / .write(path)`。
两类子结构有现成块：`columns` 是分波次/分阶段的多列面板（每列：头部 / 负责人 /
事项 / 底部对齐的结论），`kv` 是两栏汇总面板（左栏标题留空时沿用面板标题）。这两块
现在主要用于图说不清的场合（见 §4 的选型表）。

结构固定三段：

1. **概览** —— 主线节点图，一屏看完全程（时间 / 用户做了什么 / 结果）；某一轮的
   子结构可以挂在它的节点下面
2. **对话过程** —— 主体：用户原文卡 + agent 抽象卡 + 反问卡（含选项与选择）+ 子结构面板
3. **脚注** —— 数据来源、口径（UTC、已剔除项、active branch 范围）、产物

**chips 按报告口径写，不要照抄 `--json` 的 `totals`**：Step 3 剔除轮次之后 totals 已
经不代表这份报告（会出现「我的输入 5 条」而正文只有 2 轮）。写「本报告呈现 T1–T2
（会话共 5 轮）」这类口径说明，数字取自**保留下来的轮**。

需要底层控制时才直接用 `svgkit`（`wrap` / `wrap_items` / `draw` / `text_card` /
`card` / `node` / `sep`）。`text_card()` 把折行、量高、画卡一次做完，避免出现「内层
宽度和内边距不匹配」那类贴边 bug；`wrap()` 默认带 `SAFETY` 余量，别自己手算字宽贴边。

**`{{VERBATIM_JSON}}`**（verify.py 依赖它）由 `reportkit` 从 `turn` 块自动生成：turn
块里给了 `index` 就会被收进去，也可显式传 `verbatim`。形状是：

```json
{"turns": [{"i": 1, "text": "<第 1 轮用户输入，原样，不要转义换行以外的任何东西>"}]}
```

它必须**包含报告里引用到的每一轮用户原文**，内容直接来自 `--json` 的
`turns[].user`，不要手打、不要"顺手润色"。

### Step 6 校验原文

```bash
python3 <skill>/scripts/verify.py ~/Inbox/init-sdd.html --session <同一个 session>
python3 <skill>/scripts/verify.py ~/Inbox/init-sdd.html --name init-sdd
```

不一致就退出码 1 并指出第几个字符不同。「用户原文一字不差」是这份报告唯一的硬不
变量，而它恰恰是肉眼最难查的（丢一个引号、把 `"pi -ne"` 写成 `pi -ne`，没人会发
现）。**建议每份报告都跑一次**——尤其在手改过 HTML、或原文卡不是由 `reportkit`
自动生成之后。

### Step 7 交付

写到 Step 2 确认过的路径（默认 `~/Inbox/<session 名>.html`），不要自己另选目录。

**交付前先目视检查版式**（模板配色是 CSS 变量，单看 SVG 是黑白的，压边和重叠都看
不出来）：

```bash
python3 <skill>/scripts/preview.py ~/Inbox/init-sdd.html --theme both --out /tmp/preview
```

它把每个 SVG 内联成亮/暗两套 PNG，并报出画布外文字之类的硬错误。看一眼再交付——
文字贴边、面板标题被卡片盖住、内外边框重合，都是这一步才看得见的。

交付说明里写清楚：文件路径、scope（active branch、UTC）、跑了哪些检查（verify +
preview）、**跳过了什么**（没点主题切换、没测窄屏等）、**用了哪几张图**（时间轴 /
`fork` / `pipeline` / `swatches` / `tiles` 各几张），以及**这份报告是怎么生成的**
（spec 文件路径 + 那条 `reportkit.py` 命令），方便用户下一步说「再去掉一轮」或
「把第一轮展开」「T2 那张换成流水线」时一句话就能重渲。

## 4 图形层（artkit.py）

**默认要有图。** 整篇都是文字卡 = 没做完。先按选型表把内容换成图，再用文字卡补
图说不清的地方。

| 内容长什么样 | 用哪张图 | spec 块 |
|---|---|---|
| 全程节奏：每轮多长、哪轮最重、中间断了多久 | 时间轴条形图（条形长度 ∝ 工具调用次数，虚线标间歇） | 顶层 `timeline`（`extract.py --timeline` 直接给） |
| 一件事拆成 N 路并行做、最后合回来 | 分叉/合流图（主干分 N 条泳道，虚线汇到合流点） | `fork` |
| 分波次/分阶段推进，阶段有先后 | 流水线（盒子 + 箭头；某阶段内部并行就挂 `badge`） | `pipeline` |
| 改之前 vs 改之后（颜色、参数、坏值/好值） | 色板取证（把色块真的画出来 + 大数字） | `swatches` |
| 一堆交付/验收数字 | 大数字仪表盘（3×N 数字块 + 未完成警示条） | `tiles` |
| 若干条并列事实，没有形状 | 文字块 | `columns` / `kv` / `panel` |

**三条纪律**（都是从踩过的坑里来的）：

1. **数字由脚本算，图上不手写。** 时长/间歇/工具次数用 `extract.py --timeline`；
   交付数字从 `--turn N` 的收尾文字里抄。条形长度、总结行都由这些字段驱动。
2. **不手摆坐标。** 只喂数据，高度/折行/箭头位置由 `artkit` 算（它统一返回
   `(markup, height)`）。自己加新图形时也要遵守这个契约。
3. **颜色只用模板类**（`box-acc` / `box-ok` / `box-warn` / `box-pur` / `node` /
   `flow` / `flow-d` / `life` / `sep` …）。属性里内联 `var(--x)` 在独立 SVG 里不解析
   （`preview.py` 会报），字面色值只许出现在 `swatches`——那里画的就是当时的错误颜色。

### 各图的 spec 形状（`artkit.py` 的 docstring 是权威）

下面是示意写法（真 spec 是 JSON，不能带注释）：

    "timeline": [{"label": "T1", "at": "10-06 17:43", "dur": "11m16s", "dur_s": 676,
                  "gap": "24m10s", "gap_s": 1450, "value": 16, "unit": "次",
                  "sub": "11m16s · 1 提交"}]
    // timeline_note 可省：省了就由 dur_s / gap_s / value 自动写总结行

    {"kind": "fork", "title": "T1 · 4 路分叉", "trunk": "T1 · 派发 4 路",
     "merge": "T2 · 4 路合并进 dev",
     "lanes": [{"head": "W1 · config/", "meta": "wt-config · feat/config",
                "line": "wg-quick 解析 / 序列化 / 校验", "sub": "纯 ArkTS（禁 import @kit）"}]}

    {"kind": "pipeline", "title": "T2 · 4 波推进", "foot": "→ 终点：4 模块合并双绿",
     "stages": [{"head": "① 接管 T1 的 4 路", "sub": "3 路撞上 5 小时额度限制",
                 "items": ["逐路核对 worktree 实际状态", "补派 config + native 收尾"],
                 "badge": "∥ 3 路并行 · 同时开工"}]}

    {"kind": "swatches", "title": "T5 · 配色取证", "cls": "box-warn",
     "before": {"title": "改之前", "rows": [{"hex": "#F1F3F5",
                    "text": "详情页卡片底", "why": "浅底浅字，读不出"}]},
     "after": {"title": "改之后", "big": ["25", "→ 0 处硬编码颜色"],
               "items": ["新增 13 个主题化资源（base + dark 双份）"],
               "foot": "真机双主题复验"}}

    {"kind": "tiles", "title": "交付物与验证", "per_row": 3,
     "alert": "未完成：真机清单与互操作用例待设备上执行回填",
     "tiles": [{"n": "119", "unit": "文件", "caption": "PR #1 · dev → main，已 MERGED"}],
     "notes": ["文档：dev-contracts.md · device-verification.md"]}

要点：

- **fork**：`lane.meta` 右对齐（放分支名 / worktree），`line` / `sub` 自动折行并撑高
  卡片；省略 `merge` 就只表示「分出去了」。泳道 3–5 条最好看。
- **pipeline**：阶段数以 4 为佳（≤5）；`badge` 挂在盒子正下方，用来表示「这一阶段内部
  又是并行的」；`foot` 是整条流水线的终点，别写成阶段内容。
- **swatches**：`hex` 必须是字面色值（这就是取证的意义）；`big` 是 `[数字, 单位]`。
- **tiles**：`per_row` 默认 3；`alert` 是琥珀色警示条（未完成项），别拿它当强调用；
  `caption` 自动折行，写长一点没关系。
- **timeline**：只能放顶层（画在概览节点列表上方），不要塞进 `transcript`——它的职责
  就是「一屏看完全程的节奏」；`at` 建议带日期（`extract.py --timeline` 已经带了）。

## 5 常见坑

- **不回溯树** → 把 rewind 掉的支线当成主线渲染。先确认 `支线 N 条` 这个数字，再
  动手；有支线时不要凭文件名顺序假设对话是线性的。
- **一上来 `--json`** → 大 session 撑爆上下文。先 digest。
- **按名字猜 session** → session 名可以重复（`init` 有 6 条、`icon` 有 5 条）。脚本命中
  多条时会列候选并退出码 2，这种情况要问用户，不要挑最新那条。
- **渲染完才问 / 直接覆盖同名报告** → 必须先问导出位置（默认 `~/Inbox/xxx.html`，同名
  会顺延 `-2`）；不要不问就写到 `output/` 或就地覆盖旧报告。
- **手写折行** → 英文单词被从中间劈开（`setEditorCompone|nt`），或卡片高度算错导致
  文字溢出边框。用 `svgkit.wrap` + `svgkit.card_height`，或直接 `svgkit.text_card()`。
- **手算宽度去贴边** → 实测 12.5px 下真实字宽比估算宽约 5%，折好的行会顶到卡片边框。
  `wrap()` 默认带 `SAFETY=1.06` 余量，别自己把内宽写成「卡片宽 - 内边距×2」的极限值。
- **占位符写在模板注释里** → 模板注释若包含 `{{TOKEN}}`，用 `str.replace` 套模板会把
  SVG、chips、footer、verbatim 各再注入一份进注释（体积能涨 40%；verbatim 进注释还
  有 `-->` 提前闭合注释的风险）。用 `reportkit.fill()` / `reportkit.py`，它只替换注释
  以外的占位符；改模板时也不要在注释里写 `{{TOKEN}}`。
- **`--json` 字段靠猜** → `tool_calls` / `commits` / `pushes` 都是**列表**而不是数字，
  计数要 `len()`；轮号字段叫 `index`（verify 用的报告块里叫 `i`）。
- **SVG 多写一个 `<svg>` 开标签** → 浏览器按嵌套 SVG 缩放，页面出现大片空白。
- **`thinkingLevel` 在 message 上，不在条目上** → 取字段时容易取错层级。
- **改了用户原文** → verify.py 会拦，但最好一开始就别碰。
- **图形块忘了把高度算进 y** → 后面的卡片叠在前一张图上。`artkit` 的渲染器统一返回
  `(markup, height)`，由 `reportkit` 负责 `y += height + 12`；自己加图形时照这个契约写。
- **属性里内联 `var(--x)`** → 独立 SVG 渲染器不解析，形状在亮/暗两版里都变黑
  （`preview.py` 现在会直接报）。颜色走模板类；非要在属性里写色值就写字面量。
- **右对齐文字不会自动折行**：`text(..., anchor="end")` 只挪锚点，长了就出框，而
  `preview.py` 的越界检查只看 text 的 x/y、不看排版溢出。先 `wrap_text` 再逐行 `end`，
  或把文案改短。
- **暗色主题下的字面色块要描边**：`#000000` 色块在深色背景上等于消失（加
  `stroke="#8b949e"` 这类中性描边，亮色主题下也顺便有了边界）。
- **时间轴放进概览要占高度**：概览节点列表的起始 y 必须从时间轴底部往下让，否则第一张
  节点卡会盖住时间轴的时长 / 间歇标签。
