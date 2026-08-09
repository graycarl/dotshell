# AGENTS.md — {{app_name}}

> 本文件是 AI coding agent 的项目入口。先读"项目事实"，再按任务查"资料索引"。
> 完整资料清单见 [docs/harmonyos-resources.md](docs/harmonyos-resources.md)。

## 项目事实

| 项 | 值 |
|---|---|
| 应用 | {{app_name}}（应用中文名/定位见下） |
| 定位 | **{{app_positioning}}**（待补充：产品定位一句话，决策见设计文档） |
| 数据源 | {{data_source}}（待补充：后端/数据来源，含 API 基址与鉴权方式） |
| 设计文档 | **[{{design_doc}}]({{design_doc}})**（MVP 范围/架构/排版规则/任务拆解） |
| bundleName | `{{bundle_name}}` |
| 平台 | HarmonyOS（纯鸿蒙，`runtimeOS: {{runtime_os}}`，非兼容模式） |
| SDK | {{sdk_version}}，target/compatible 均为 {{sdk_api}} |
| 设备 | {{device_types}} |
| 语言/UI | ArkTS + ArkUI 声明式开发 |
| 构建系统 | hvigor（modelVersion {{hvigor_version}}） |

## 仓库结构

```
AppScope/            # 应用级配置（app.json5: bundleName/版本/图标）
entry/               # 主模块（type: entry）
  src/main/ets/
    entryability/    # EntryAbility.ets（UIAbility 入口）
    entrybackupability/
    pages/           # Index.ets（@Entry 页面，当前为模板）
  src/main/module.json5   # 模块配置：abilities、deviceTypes
  src/main/resources/     # base/dark 资源（string/color/float/media）
build-profile.json5  # 应用级构建配置（products/签名/SDK 版本）
oh-package.json5     # 依赖声明（无三方依赖时仅 devDeps: hypium, hamock）
docs/                # 设计文档与开发资料索引
```

ets/ 下业务代码建议按设计文档划分：`api/`（后端客户端）、`store/`（状态/快照）、`repo/`（持久化）、
`pages/`、`components/`、`model/`。

注意：仓库内无 `hvigorw` 脚本，但 DevEco Studio 内置工具链支持**命令行编译验证**
（见下节「命令行构建」）；预览/调试/真机运行仍在 **DevEco Studio** 中进行；
`local.properties`（SDK 路径）不入库。

## 命令行构建（Makefile 封装，agent 可直接编译验证）

已封装进根目录 `Makefile`（底层调用 DevEco Studio 内置工具链，无需打开 IDE）：

```bash
make build   # 编译 + 打包 debug HAP（未签名，产物在 entry/build/default/outputs/）
make test    # 跑 LocalUnit 单测（hypium，entry/src/test）
make help    # 列出全部目标
```

- 签名需在 DevEco Studio 里配置后才可装真机；未签名时 SignHap WARN 跳过，可忽略
- 环境变量（DEVECO_SDK_HOME / JAVA_HOME / PATH）由 Makefile 自动设置，无需手动导出
- 若本机 DevEco Studio 不在 `/Applications/DevEco-Studio.app`，改 Makefile 顶部路径

## 核心设计决策（详版见设计文档）

> 项目早期填充，建议至少明确以下两条（鸿蒙通用经验，可直接采用）：

1. **路由栈即历史栈**：页面导航用 Navigation + NavDestination，focus 详情页 = push 一个节点页，
   系统返回 = pop，兄弟切换 = replace，面包屑 = popTo。
2. **状态管理用 V2 范式**（@ObservedV2/@Trace/@Local）；页面间共享状态走
   AppStorageV2.connect 单例，勿靠路由 param 传大对象。

<!-- 在此补充项目特有决策（数据流/同步策略/渲染规则等），例如： -->

## 开发资料速查

### 给 agent 的资料使用规则（重要）

1. **搜索优先用 Context7**：华为官方 Guides/References 已被 Context7 收录（官方源，
   trustScore 10），支持语义搜索、返回带来源的聚焦片段，比读全页省 context：
   - 指南库：`/websites/developer_huawei_consumer_cn_doc_harmonyos-guides`
   - API 参考库：`/websites/developer_huawei_consumer_cn_doc_harmonyos-references`
   （用法见 context7 skill：先 resolve 再 query，每个查询聚焦单一主题）
2. **精读原文用 `.md` 后缀**：Context7 片段不全或需核对版本标注时，
   任何华为官方文档 URL 追加 `.md` 后缀即可直接获取 Markdown 正文，
   例如 `.../harmonyos-references/ts-basic-components-text.md`。
   用 `curl -sL` 即可拿到全文，无需浏览器渲染；返回 404 说明页面不存在。
3. **只查深链，不查目录页**。本文档给出的 URL 均已验证可达（2026-08）。
4. **版本对齐**：查 API 时注意页面中 "起始版本" 标注，忽略低于项目版本已废弃的接口；
   ArkTS 状态管理有 V1/V2 两代范式，优先了解差异。
5. 完整分类清单（含一句话摘要 + 何时查阅）：
   **[docs/harmonyos-resources.md](docs/harmonyos-resources.md)**

### 任务 → 资料分区索引

| 我要做什么 | 去看 resources.md 哪一节 |
|---|---|
| 新建页面 / 写 UI 布局 / 用组件 | ArkUI 组件与声明式 UI |
| 组件状态、父子通信、页面刷新 | 状态管理 |
| 多页面跳转、传参、返回栈 | 路由与导航 |
| 存数据（配置/KV/SQLite/文件） | 数据持久化 |
| 发 HTTP 请求 | 网络 |
| 打日志、调试、排查崩溃 | 日志与调试 |
| 写单元测试 / UI 测试 | 测试 |
| 签名、打包、真机运行 | 签名、构建与发布 |
| 不懂 ArkTS 与 TS 的差异 | ArkTS 语言 |
| Ability 生命周期、应用模型 | 应用模型 |

## 已知坑（随开发积累）

当第一次做错了，后续修复时，需要总结一些经验写入这里，避免后续继续踩坑。

- 华为文档站是 SPA：不带 `.md` 后缀的 URL 用 curl 永远返回 200 的空壳 HTML，
  **不能用裸 URL 的 200 判断页面存在**，必须加 `.md` 看是否 404。
- `js-apis-*` 旧命名页面多为子页面索引（几 KB 的链接列表），
  `arkts-apis-*` 新命名页面才有完整 API 正文。
- **Navigation 路由表必须绑组件内 @Builder 方法**（`.navDestination(this.PageMap)`，@Builder 只声明
  `name` 参数）。`pushPath({name})` 不传 param 时运行时是 `undefined`，顶层 @Builder/lambda 若把它
  透传给 `@Param param: object` 会类型不匹配 → 子页组件构建异常，表现为**页面空白**；
  Navigation 默认 mode=Auto，单栏应用应显式 `.mode(NavigationMode.Stack)`。
  排查空白页优先级：路由表形式 → param 透传 → NavDestination 是否包在子页组件内。
- **Navigation 默认显示空标题栏+空工具栏并占位**：`hideTitleBar`/`hideToolBar` 默认值均为 false，即使不
  配置 title/toolbar 也会占位压缩内容区（实测 ~112vp）→ 单栏应用应显式 `.hideTitleBar(true).hideToolBar(true)`。
  注意：NavDestination 有自己的 `.title()` 标题栏，不受 Navigation 级 hideTitleBar 影响。
- **Navigation 内容区安全区/高度规则**：Navigation 自身全屏但**内容区布局在安全区内**（顶部避让状态栏、
  底部避让手势条，底部手势条区域露 Navigation 背景）；Navigation 默认 `expandSafeArea([SYSTEM],TOP/BOTTOM)`
  只是绘制扩展。排查底部留白时不要怀疑子组件 `height('100%')` 失效——先量 Navigation/内容区实际高度
  （`onAreaChange` 打日志），根因常是标题栏/工具栏占位或安全区。
- **正文延伸到屏幕底用 Navigation 级 ignoreLayoutSafeArea**：`expandSafeArea` 仅扩展绘制区域、布局不变，
  透明背景组件加它无视觉效果、滚动内容也不会延伸（旧方案在页面 Column 上加它无效）；正确做法是
  Navigation 上 `.ignoreLayoutSafeArea([LayoutSafeAreaType.SYSTEM], [LayoutSafeAreaEdge.BOTTOM])`
  （API 20+，枚举全局声明免 import），且**前提是标题栏/工具栏已隐藏**，否则无法扩展到非安全区。
- **组件类型/枚举不是全从 @kit.ArkUI 导出**：`NavPathStack`/`Navigation` 等是全局声明（不 import）；
  `TextInputType` 实为 `InputType`。不确定时 grep SDK：`component/*.d.ts`（组件声明）与
  `kits/@kit.*.d.ts`（导出列表）。
- **系统资源名以 SDK `toolchains/id_defined.json` 为准**：`$r('sys.color.ohos_id_color_secondary_text')`/
  `error_container` 等并不存在（用 `secondary`/`alert_transparent`），编译报 "Unknown resource name"
  即去该文件 grep 合法名。
- **ArkTS 严格模式编译坑（一次踩遍）**：禁 `as const`；禁 `unknown` 类型转换（错误对象
  用 `as BusinessError`，`import { BusinessError } from '@kit.BasicServicesKit'`）；interface 对象
  禁 `obj['key']` 索引访问（先 `as Record<string, Object>`）；禁构造参数属性 `constructor(private x)`；
  对象字面量必须对应显式类型；字符串不能直接传枚举参数（用 `http.RequestMethod.GET`）。
- **V2 组件可作 NavDestination 宿主**：官方 Navigation 案例全是 V1（@Component），但 @ComponentV2 文档
  声明与 @Component 行为一致（无 NavDestination 限制），可放心用；页面间共享状态走
  AppStorageV2.connect 单例（@ObservedV2 + @Trace），勿靠路由 param 传大对象。
- **LazyForEach 禁用零高度占位项实现折叠**：折叠行若渲染为 `Row().height(0)`，索引↔像素映射非线性，
  fling 穿过折叠块边界时可见窗口单帧跳过上百索引 → 单帧批量创建组件，造成严重滚动抖动
  （症状：含折叠内容多时滚动持续卡顿，日志可见行组件成片重建）。正确做法：数据源只放可见行，
  折叠态记录在全量数组（foldedAncestors），toggle 时过滤重建可见数组 + onDataReloaded（纯数据 O(n)）。
- **应用图标规范**（官方《应用图标》设计指南）：分层资源 background+foreground 均 1024×1024 正方形 PNG，
  不做圆角（系统裁切）；**背景层不允许透明像素**；渐变色方向统一、上浅下深、两端色值差异适度；
  前景主体居中、勿近四角。module.json5 的 `$media:layered_image` 用的是 entry 模块资源（覆盖 AppScope
  同名资源），改图标时 **AppScope 与 entry 两处 + startIcon.png 都要替换**。
- **MenuItemOptions.content 只接受 ResourceStr**：不能传 CustomBuilder（编译报 `Type '() => void' is
  not assignable to 'ResourceStr'`）；MenuItemAttribute 也没有 fontColor。长按菜单里删除项做红字需换
  自定义 Menu 布局，或用普通项 + `labelInfo: '不可恢复'` 警示。
- **Menu 长按菜单用 bindContextMenu(ResponseType.LongPress)**，半模态表单用 bindSheet（SheetOptions 的
  height/dragBar/showClose，API 22 可用）；表单宿主组件需同时持有 `@Local showSheet` + `@Builder` 构造器。
- **未绑定组件的 Scroller 调用 currentOffset()/scrollTo() 会崩溃**（SDK 实测：页面存在多形态布局时，
  某形态无 List/Scroll，未挂组件的 scroller 在 onWillHide 等时机调 currentOffset() 直接崩；API 23 才提供
  `offset()` 安全版并注明"未绑定返回 undefined"）。修复模式：**凡是对未绑定 scroller 的方法调用都要按
  形态分支跳过**。
- **对接第三方 REST API 先查清写操作回显**：部分端点（如 create）有 id 回显但缺完整字段，
  多数（update/move/delete）只有 `{"status":"ok"}` 无回显；本地乐观更新时缺失字段（priority/时间戳等）
  需自行估算，否则下次全量刷新后内容跳变。
- **编辑表单防富文本覆盖**：数据源富文本（如服务器端 markdown→HTML 转换）由别处生成时，简单纯文本
  表单无法编辑富文本。保存时**只提交变更字段**（与纯文本原文比较），未改动的字段不提交，
  避免"纯文本回写覆盖服务器已存富文本"。
