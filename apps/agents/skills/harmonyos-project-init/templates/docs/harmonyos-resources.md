# HarmonyOS 开发资料清单（供 AI agent 查阅）

> 维护原则（违反即视为坏链接，需修复）：
> 1. 每条 URL 必须是**深链**（直达正文，非目录首页）且**免登录**；
> 2. 每条 URL 追加 `.md` 后缀应返回 Markdown 正文（`curl -sL <url>.md`，404 即失效）；
> 3. 每条附一句话摘要和"何时查阅"；
> 4. 与项目 SDK 对齐：HarmonyOS 6.0.2 / API 22（新项目以 build-profile.json5 的 targetSdkVersion 为准）。
>
> 本文档按**开发任务**分区，不按文档类型分区。新增分区随项目开发需求补充。

## 如何使用本文档

**两层配合，先搜后读：**

1. **搜索/速答 → Context7**（语义搜索官方文档，返回聚焦片段 + 来源 URL）：
   - 指南库 ID：`/websites/developer_huawei_consumer_cn_doc_harmonyos-guides`
   - API 参考库 ID：`/websites/developer_huawei_consumer_cn_doc_harmonyos-references`
   - Samples 库 ID：`/linganmin/harmonyos_samples`
   - 适合：不知道具体页面、"怎么做 X" 类问题。局限：片段式摘录，可能缺完整签名/版本标注。

2. **精读原文 → `.md` 后缀**（拿到权威全文）：

```bash
curl -sL "<URL>.md"        # 获取 Markdown 全文
```

大页面（>100KB，如组件 API 页）建议 pipe 给 grep 定位小节，避免一次读入过多内容。

---

## 入门与项目结构

| 资料 | 何时查阅 |
|---|---|
| [开发准备/快速入门](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/start-overview) | 搭建环境、跑通第一个页面 |
| [创建新工程](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-create-new-project) | 新建模块、理解工程模板 |
| [工程目录结构](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-project-structure) | 理解 AppScope/entry/oh-package/hvigor 各文件职责 |

## ArkTS 语言

| 资料 | 何时查阅 |
|---|---|
| [初识 ArkTS 语言](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/introduction-to-arkts) | ArkTS 与 TypeScript 的差异、严格模式限制（如禁用 any/对象字面量类型等） |
| [状态管理 V1→V2 迁移](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-v1-v2-migration) | 判断该用 @State 还是 @ObservedV2/@Trace 等新一代装饰器 |

## 应用模型（Ability）

| 资料 | 何时查阅 |
|---|---|
| [UIAbility 组件概述](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/uiability-overview) | 理解 Stage 模型、UIAbility 与页面的关系 |
| [UIAbility 生命周期](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/uiability-lifecycle) | onCreate/onForeground/onBackground 等回调的正确用法 |

## ArkUI 组件与声明式 UI

| 资料 | 何时查阅 |
|---|---|
| [声明式 UI 描述](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-declarative-ui-description) | UI 描述范式基础：自定义组件、@Builder、链式属性 |
| [@Builder 函数](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-builder) | 复用 UI 片段、@BuilderParam 传 UI 结构 |
| [自定义组件生命周期](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-page-custom-components-lifecycle) | aboutToAppear/aboutToDisappear/onPageShow 等 |
| [Text 组件 API](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/ts-basic-components-text) | 文本展示、富文本混排 |
| [TextInput 组件 API](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/ts-basic-components-textinput) | 单行/多行文本输入 |
| [RichEditor 组件 API](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/ts-basic-components-richeditor) | 富文本编辑器（图文混排内容编辑） |
| [List 组件 API](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/ts-container-list) | 列表页 |
| [Scroll 组件 API](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/ts-container-scroll) | 滚动容器 |
| [Navigation 组件 API](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/ts-basic-components-navigation) | 页面导航容器（推荐方案，见"路由与导航"） |

> 查其他组件：URL 规律为 `harmonyos-references/ts-basic-components-<名称>` /
> `ts-container-<名称>`，改名后加 `.md` 验证是否存在。

## 状态管理

| 资料 | 何时查阅 |
|---|---|
| [状态管理概述](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-state-management-overview) | 选型入口：组件内状态/跨组件/跨页面/AppStorage 怎么选 |
| [@State 装饰器](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-state) | 组件内可变状态的基本用法 |

## 路由与导航

| 资料 | 何时查阅 |
|---|---|
| [组件导航 Navigation（推荐）](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-navigation-navigation) | **页面跳转首选**。该页是索引，含子链接：基础架构/NavDestination/页面路由/转场动画/跨包路由/分栏模式 |
| [Navigation 子页面 NavDestination](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-navigation-navdestination) | 目标页面的声明与生命周期 |
| [Navigation 页面路由](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-navigation-jump) | push/replace/pop、传参、路由栈操作 |

## 数据持久化

| 资料 | 何时查阅 |
|---|---|
| [应用数据持久化概述](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/app-data-persistence-overview) | 选型：Preferences / KV-Store / RelationalStore 哪个适合业务数据 |
| [通过用户首选项持久化](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/data-persistence-by-preferences) | 配置项、轻量 KV |
| [Preferences API](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-data-preferences) | 首选项完整 API |
| [通过关系型数据库持久化](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/data-persistence-by-rdb-store) | **结构化数据存储首选**（SQLite 封装），建表/增删改查/谓词 |
| [RelationalStore API 总览](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-apis-data-relationalstore) | 模块入口页，含 RdbStore/ResultSet/RdbPredicates 等子页链接 |
| [RdbStore 接口](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-apis-data-relationalstore-rdbstore) | insert/update/query/delete 等方法签名 |

## 网络

| 资料 | 何时查阅 |
|---|---|
| [HTTP 数据请求](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/http-request) | 发起请求、权限声明（ohos.permission.INTERNET） |
| [@ohos.net.http API](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-http) | 请求/响应完整 API |

## 日志与调试

| 资料 | 何时查阅 |
|---|---|
| [HiLog 日志](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/hilog) | 打日志、DOMAIN/TAG 规范、`hdc shell hilog` 查看 |
| [HiLog API](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-hilog) | hilog.debug/info/warn/error 签名 |

## 测试

| 资料 | 何时查阅 |
|---|---|
| [代码测试（Hypium）](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-code-test) | 单元测试/UI 测试编写与执行 |
| [应用测试概述](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/test-kit-overview) | 测试能力全景 |

## 签名、构建与发布

| 资料 | 何时查阅 |
|---|---|
| [应用/元服务签名](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-signing) | 配置签名证书（真机运行前置条件） |
| [真机运行](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-run-device) | 连接设备运行调试 |

## 系统能力与其他

| 资料 | 何时查阅 |
|---|---|
| [SysCap 系统能力](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/syscap) | 判断某 API 在目标设备是否可用 |

---

## 已验证但暂未分区的 URL 规律备忘

- 指南类：`harmonyos-guides/<主题>`；API 参考类：`harmonyos-references/<主题>`
- ArkTS API 模块新命名：`arkts-apis-<kit>-<模块>[-<类/接口>]`
- 旧命名 `js-apis-*` 页面多为子页索引；正文在 `arkts-apis-*` 页面
- 站内搜索命中带 `-V13`/`-V14` 版本后缀的 URL 时，去掉后缀即为最新版地址

## 待补充（随项目开发填充）

- [ ] 文件管理（附件/图片存取，`@ohos.file`）
- [ ] 权限申请流程（acl/user_grant）
- [ ] 键盘处理与输入法
- [ ] 备份与恢复（EntryBackupAbility 已建，backup_config.json）
- [ ] 上架流程（AppGallery Connect）
- [ ] 已知坑清单（报错信息 → 解法 → 文档出处）
