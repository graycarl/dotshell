---
name: harmonyos
description: >
  HarmonyOS（鸿蒙）App 开发引导台：写/改 ArkTS + ArkUI 代码、页面与组件、路由导航、
  状态管理、数据持久化、HTTP 请求、权限申请、HiLog 日志、hvigor/ohpm 命令行构建、
  hypium 单元测试、签名与真机无线调试（hdc 连不上、端口每次变）、鸿蒙工程 AGENTS.md
  初始化。触发词：鸿蒙、HarmonyOS、ArkTS、ArkUI、ArkData、DevEco Studio、hvigor、
  ohpm、hdc、build-profile.json5、module.json5、entry/ 模块、.ets 文件、har/hap/app 包。
  也用于「先在 SDK 里确认 API 是否存在」「这个权限普通应用能不能申请」这类事实核对。
  不适用：非鸿蒙项目（Android/iOS/Flutter/React Native/uni-app 跨端）、纯 Web 前端。
---

# HarmonyOS App 开发

鸿蒙应用开发的通用引导台：**铁律 + 能力地图 + 资料入口**。不绑定任何具体项目。
深度内容都在 `references/`（相对本 skill 目录），按需读取——不要一次全读。

## 动手前必守的 4 条铁律

1. **API 事实以 SDK d.ts 为准，不要凭记忆或猜。** 华为文档站是 JS 渲染的 SPA，
   `curl` 任何 URL 都返回 200 空壳；`.md` 后缀技巧已全站 404（2026-09 实测）。
   取正文三条正路：① `$SDK/ets/api/*.d.ts` + `ets/kits/@kit.*.d.ts` + `ets/component/*.d.ts`（第一手事实）
   ② OpenHarmony docs 仓库 raw（完整示例/规格表）③ Context7（语义速搜）。
   细节见 `references/resources.md`「如何取正文」。
2. **设计新功能前先查权限级别。** `toolchains/lib/PermissionDefinitions.json` 里
   `system_grant`+`normal` = 声明即用；`user_grant`+`normal` = 运行时弹窗；
   `system_basic`/`system_core` = **普通应用拿不到**（如 `READ_PASTEBOARD`）→ 设计阶段就换方案。
3. **本地单测里所有 `@kit` 平台 API 都是空桩**（不抛错、返回空数据）。纯算法/纯逻辑要自实现或依赖注入，
   平台原语只做薄封装 + 列进真机验证清单，否则「测试全绿但生产路径零覆盖」。
4. **判定测试通过不能只看退出码**：hypium 用例失败时 hvigor 仍打印 `BUILD SUCCESSFUL`（假绿），
   必须同时确认日志无 `Error in `（用项目 Makefile 的 `make test`，它已内置校验）。
   编译验证优先 `make build`（DevEco 内置工具链，无需开 IDE）。

## 能力地图（先看这里，再决定读哪个 reference）

| 你在做什么 | 读 |
|---|---|
| 写 ArkTS 代码报语法错、用哪个装饰器、Navigation 怎么搭、状态怎么共享、图标/资源名怎么写 | `references/arkts-ui.md` |
| 存数据（配置/结构化数据/文件）、发 HTTP、申请权限、打日志、对接第三方 REST | `references/data-network.md` |
| 编译、打包、跑单测、签名、连真机（hdc）、上架大致流程 | `references/build-test-run.md` |
| 查官方文档、确认某 API/枚举/权限是否存在 | `references/resources.md` |
| 遇到报错/页面空白/卡顿/build 挂住，想知道是不是已知坑 | `references/pitfalls.md` |
| 给鸿蒙工程生成 AGENTS.md / docs 资料清单 / Makefile | `references/project-init.md` |

**分工原则**：`arkts-ui.md` / `data-network.md` / `build-test-run.md` 讲「推荐怎么做」；
`pitfalls.md` 讲「踩过的症状 → 根因 → 修法」（其他文件遇坑只指路，不复述）；`resources.md` 是唯一 URL 源。

## 常用环境与命令速查

```bash
DEVECO=/Applications/DevEco-Studio.app          # 不在默认路径时按实际改
SDK=$DEVECO/Contents/sdk/default/openharmony    # d.ts / toolchains 都在这
ls $SDK/ets/api/*.d.ts                          # 单模块 API
grep -rn 'PermissionDefinitions' $SDK/toolchains/lib/  # 权限级别表

make build          # 编译 + 打包 debug HAP（项目有 Makefile 时；未签名，只 WARN）
make test           # LocalUnit 单测（缺 oh_modules 会自动 ohpm install）
make ohpm-install   # 拉依赖

hdc list targets    # 设备列表（IP:port = 无线已连）
hdc shell hilog | grep TAG
<本 skill 目录>/scripts/hdc-wifi                # 真机无线调试：自动发现端口（热路径 ~1s）
<本 skill 目录>/scripts/hdc-wifi 192.168.1.23    # 指定手机 IP
```

真机调试**别手抄端口、别裸调 `hdc tconn`**（设备上常有几个「能连但不是 hdc」的端口，会挂 30~60s）。
用 `scripts/hdc-wifi`，细节见 `references/build-test-run.md`。

## 第一次进入某个鸿蒙工程时

1. 根目录有 `AGENTS.md` → **先读它**（项目事实、构建方式、项目特有坑），本 skill 只做补充。
2. 没有 `AGENTS.md`，但存在 `build-profile.json5` + `entry/` → 这是初始化场景：
   先问用户是否要生成，同意后按 `references/project-init.md` 走（探测字段 → 校验骨架 → 写入 → 报告）。
3. 两样都没有 → 可能不是鸿蒙工程，向用户确认，不要硬套。

## 维护约定（改本 skill 时遵守）

- **新踩到的通用坑写到 `references/pitfalls.md`**，按域归类、格式统一；
  **不要**写进 `templates/AGENTS.md`（模板只放最致命的 3~5 条 + 引用路径），也不要往每个项目的 AGENTS.md 抄。
- **新增/修正官方链接写到 `references/resources.md`**，它同时是初始化时复制到项目的唯一来源。
- 项目侧只引用不复制：`scripts/hdc-wifi`、`references/pitfalls.md`、`references/resources.md` 都按**绝对路径**引用；
  唯一复制进项目的是 `docs/harmonyos-resources.md`（快照，给人读）。
- 反例提醒：不要写「探测命令支持什么参数再分支」的运行时探测代码；按本机实测结论写死并注明验证时间。
