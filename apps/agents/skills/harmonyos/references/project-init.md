# 鸿蒙工程上下文初始化（原 harmonyos-project-init 流程）

给一个**新鸿蒙工程**写入 AI 开发上下文：`AGENTS.md`（项目事实/结构/构建/资料规则）、
`docs/harmonyos-resources.md`（官方深链清单）、`Makefile`（命令行构建封装）。
做完之后，后续任何 agent 接手都不必重新摸索工程结构与构建方式。

> 什么时候读这份文件：用户说「初始化这个鸿蒙项目的 AGENTS.md / 项目上下文」，
> 或者检测到鸿蒙工程（`build-profile.json5` + `entry/`）但根目录没有 `AGENTS.md`。
> 已经初始化过的项目**不要**重复做，除非用户要求刷新。

## 模板文件与捆绑工具（相对本 skill 目录）

```
templates/
├── AGENTS.md                  # AGENTS.md 模板（含 {{占位符}}，需替换）
└── Makefile                   # 命令行构建封装（含 {{app_name}} 占位符）

references/
└── resources.md               # 官方文档深链清单（复制为项目 docs/harmonyos-resources.md，URL 已实测验证，勿改）

scripts/
└── hdc-wifi                   # 真机无线调试端口自动发现（不复制进项目，见 build-test-run.md）
```

**`scripts/hdc-wifi` 与 `references/pitfalls.md` 不复制进项目**：AGENTS.md / Makefile 里写它们的
**绝对路径**（由 `{{harmonyos_skill_dir}}` / `{{hdc_wifi}}` 占位符在 Step 3 替换），项目只引用不持有副本，
skill 升级后所有项目自动受益。唯一例外是 `resources.md`：整篇复制（人要读、要入库）。

## Step 1 触发判断

确认项目是鸿蒙工程：根目录存在 `build-profile.json5` 和 `entry/`。
若已存在 AGENTS.md：**不覆盖**，仅提示用户（可要求 agent 按模板补全缺失章节）。

## Step 2 自动探测（静默读取，不打扰用户）

按下面的占位符映射表读文件提取值。文件缺失/字段不存在 → 该字段留「待补充」占位。

| 占位符 | 探测源 | 说明 |
|---|---|---|
| `{{app_name}}` | `AppScope/resources/base/element/string.json` 的 `app_name`（缺失则 `entry/src/main/resources/base/element/string.json` 的 `EntryAbility_label`） | 注意 app.json5 的 label 是 `$string:app_name` 资源引用，真实名字在资源文件里 |
| `{{bundle_name}}` | `AppScope/app.json5` → `bundleName` | |
| `{{sdk_version}}` | `build-profile.json5` → `products[0].targetSdkVersion` | 形如 `"6.0.2(22)"`，原样填入 |
| `{{sdk_api}}` | 从 sdk_version 提取括号内数字 | 如 `6.0.2(22)` → `22` |
| `{{runtime_os}}` | 同上 → `products[0].runtimeOS` | 默认 `HarmonyOS` |
| `{{hvigor_version}}` | `hvigor/hvigor-config.json5` → `modelVersion`（缺失则 `oh-package.json5` → `modelVersion`） | |
| `{{device_types}}` | `entry/src/main/module.json5` → `deviceTypes` | 数组 `["phone"]` → 逗号连接 `phone` |
| `{{app_positioning}}` | 无源 | 留「待补充」并写入报告 |
| `{{data_source}}` | 无源 | 留「待补充」并写入报告（后端 API/数据来源） |
| `{{design_doc}}` | 探测 `docs/design-*.md` 是否存在 | 有则用实际文件名，无则默认 `docs/design-v0.1.md` |
| `{{harmonyos_skill_dir}}` | 本 skill 目录（SKILL.md 所在目录）的**绝对路径** | 用于引用 `references/pitfalls.md` / `references/resources.md` / `scripts/hdc-wifi` |
| `{{hdc_wifi}}` | `{{harmonyos_skill_dir}}/scripts/hdc-wifi` 的**绝对路径** | 给 Makefile/AGENTS.md 直接给命令用，勿改成项目内副本 |

## Step 2.5 骨架完整性校验（工程为手写/半手写时必做）

DevEco 模板新建的工程自带这些文件；**手写骨架时最容易漏「模块级」配置**，
而且缺了不一定报「文件不存在」，而是抛看不出原因的奇怪错误。逐项确认存在：

| 位置 | 必需文件 | 缺失后果 |
|---|---|---|
| 根 | `build-profile.json5`、`hvigorfile.ts`、`oh-package.json5`、`hvigor/hvigor-config.json5` | 无法构建 |
| 根 | `.gitignore`（至少 `/node_modules`、`/oh_modules`、`/.hvigor`、`**/build`、`**/.test`、`/.idea`、`/local.properties`） | 产物/缓存入库 |
| `entry/` | `build-profile.json5`、`hvigorfile.ts`、**`oh-package.json5`**、`obfuscation-rules.txt`、`.gitignore` | **缺 `oh-package.json5` 报**：`OhPackageLoader.processModuleDependencyMap → ERR_INVALID_ARG_TYPE: The "data" argument must be of type string or an instance of Buffer... Received undefined`（错误信息完全看不出真实原因，排查顺序：模块级 `oh-package.json5` 是否存在） |
| `AppScope/` | `app.json5`、`resources/base/element/string.json`、`resources/base/media/background.png`+`foreground.png`+`layered_image.json` | 图标/label 解析失败 |
| `entry/src/main/` | `module.json5`、`resources/base/element/{string,color,float}.json`、`resources/base/media/startIcon.png`、`resources/base/profile/{main_pages.json,backup_config.json}`、`resources/dark/element/color.json` | 启动页/资源编译失败 |

缺文件时的修法：**用 DevEco 新建一个空工程把对应文件拷过来**（保留其模板内容），
不要手写猜测字段（`module.json5` 的 `skills`/`metadata`、`backup_config.json` 等结构体极易写错）。

## Step 3 写入（不覆盖已有文件）

1. **AGENTS.md**：读取 `templates/AGENTS.md`，把 Step 2 的探测值替换全部占位符后写入项目根目录。
   文件已存在 → 跳过并提示，不要覆盖用户内容。
2. **docs/harmonyos-resources.md**：复制 `references/resources.md`（`docs/` 不存在则先创建），
   在文件头补一行 `> 由 harmonyos skill 生成（<skill 目录>），可重跑初始化刷新`。
3. **Makefile**：从模板直拷并替换 `{{app_name}}`。若用户机器 DevEco Studio
   不在 `/Applications/DevEco-Studio.app`，提示用户改顶部路径。
   （Makefile **不封装**无线调试：`scripts/hdc-wifi` 不拷贝到项目，由 AGENTS.md 直接引用绝对路径）

## Step 4 报告

完成后向用户报告：
- 已生成的文件路径；
- **待补充字段清单**（通常为 `app_positioning` / `data_source`，可让用户口述后补填）；
- 已引用的 skill 路径（`{{harmonyos_skill_dir}}`）：通用坑表 `references/pitfalls.md`、无线调试 `scripts/hdc-wifi`；
- 提示：签名需在 DevEco Studio 里配置后才可装真机；`make build` 可命令行编译验证。

## 注意事项

- **占位符替换必须完整**：写入后 grep 一遍 `{{` 确认无残留（`rg '\{\{' AGENTS.md Makefile`）。
  **例外**：`{{app_positioning}}` 与 `{{data_source}}` 是无源字段，保留占位符 + 说明文字，
  由用户后续口述补填（见 Step 4）。
- **`scripts/hdc-wifi` 只存在于 skill**：项目里不落副本（避免多份漂移）。要改脚本就改 skill 里这份，
  所有引用它的项目立即生效。
- **模板中的「已知坑」只放项目特有内容**：跨项目通用坑统一维护在 `references/pitfalls.md`，
  AGENTS.md 里用绝对路径引用即可。新项目踩到通用坑 → 追加到 `pitfalls.md`（不是模板，也不是所有项目的
  AGENTS.md）；踩到项目特有坑 → 写进该项目 AGENTS.md。
- 若项目已有 `docs/` 目录（含设计文档等），只补写 `harmonyos-resources.md`，不动其他文档。
- 老项目（用旧 `harmonyos-project-init` 名初始化过）里可能残留旧 skill 路径：
  可重跑 Step 3 刷新，或把路径改成 `{{harmonyos_skill_dir}}` 指向的位置。
