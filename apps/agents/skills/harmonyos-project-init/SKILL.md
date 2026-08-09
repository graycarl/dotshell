---
name: harmonyos-project-init
description: >
  初始化新 HarmonyOS（鸿蒙）App 工程的 AI 开发上下文：为新工程生成
  AGENTS.md（项目事实/仓库结构/命令行构建/资料检索规则/已知坑）、
  docs/harmonyos-resources.md（华为官方文档深链清单）、Makefile（DevEco
  命令行构建封装）。当用户要求在新鸿蒙项目中初始化/补全 AGENTS.md 或项目
  上下文，或检测到鸿蒙工程（存在 build-profile.json5 与 entry/）但缺少
  AGENTS.md 时使用。
---

# HarmonyOS 项目上下文初始化

把鸿蒙 App 开发的通用知识（资料检索规则、官方文档深链清单、实战已知坑、命令行构建）
一键写入新工程，让后续 agent 接手时直接拥有完整开发上下文。

## 模板文件（相对本 skill 目录）

```
templates/
├── AGENTS.md                  # AGENTS.md 模板（含 {{占位符}}，需替换）
├── docs/harmonyos-resources.md # 官方文档深链清单（URL 已实测验证，勿改）
└── Makefile                   # 命令行构建封装（含 {{app_name}} 占位符）
```

## 触发场景

- 用户说"初始化这个鸿蒙项目的 AGENTS.md / 项目上下文"；
- 用户新建了鸿蒙工程并让 agent 开始干活，但项目里没有 AGENTS.md；
- 检测到 `build-profile.json5` + `entry/`（鸿蒙模板工程特征）且根目录无 AGENTS.md。

## 初始化流程

### Step 1 触发判断

确认项目是鸿蒙工程：根目录存在 `build-profile.json5` 和 `entry/`。
若已存在 AGENTS.md：不覆盖，仅提示用户（可要求 agent 按模板补全缺失章节）。

### Step 2 自动探测（静默读取，不打扰用户）

按下面的占位符映射表读文件提取值。文件缺失/字段不存在 → 该字段留"待补充"占位。

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

### Step 3 写入（不覆盖已有文件）

1. **AGENTS.md**：读取 `templates/AGENTS.md`，把上表探测值替换全部占位符后写入项目根目录。
   文件已存在 → 跳过并提示，不要覆盖用户内容。
2. **docs/harmonyos-resources.md**：从模板直拷（`docs/` 目录不存在则先创建）。
   该清单 URL 已实测验证，**不要改动 URL**；只按需新增分区。
3. **Makefile**：从模板直拷并替换 `{{app_name}}`。若用户机器 DevEco Studio
   不在 `/Applications/DevEco-Studio.app`，提示用户改顶部路径。

### Step 4 报告

完成后向用户报告：
- 已生成的文件路径；
- **待补充字段清单**（通常为 `app_positioning` / `data_source`，可让用户口述后补填）；
- 提示：Makefile 签名需在 DevEco Studio 里配置后才可装真机；`make build` 可命令行编译验证。

## 注意事项

- **占位符替换必须完整**：写入后 grep 一遍 `{{` 确认无残留（`rg '\{\{' AGENTS.md Makefile`）。
  **例外**：`{{app_positioning}}` 与 `{{data_source}}` 是无源字段，保留占位符 + 说明文字，由用户后续口述补填（见 Step 4）。
- 模板中的"已知坑"是跨项目通用经验，新项目踩到新坑时按同样的格式追加到
  对应项目 AGENTS.md 的「已知坑」节，**不要改模板本身**（如需沉淀通用坑，反馈给 skill 维护者）。
- 资料检索规则里的 Context7 库 ID 与 `.md` 后缀技巧是通用的，任何鸿蒙项目都适用。
- 若项目已有 docs/ 目录（含设计文档等），只补写 resources.md，不动其他文档。
