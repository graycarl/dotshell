# 鸿蒙开发通用坑总表

**这是跨项目坑的唯一汇总处**。项目自己的 AGENTS.md 只留项目特有坑 + 引用本文档绝对路径。
新踩到通用坑 → 追加到这里（按域归类，格式统一），不要往每个项目的 AGENTS.md 里抄一遍。

格式：**症状**（看到什么）→ **根因** → **修法** → 出处/验证方式。

分类：A 构建与工具链 / B ArkTS 语法 / C UI 与 Navigation / D 资源与图标 / E 数据与接口 / F 设备与调试。

---

## A 构建与工具链

### A1 hypium 用例失败却打印 `BUILD SUCCESSFUL`（假绿）

- **症状**：`hvigorw test` 退出码 0、日志末尾 `BUILD SUCCESSFUL`，但实际有用例失败。
- **根因**：hvigor 的 test 任务不把用例失败反映到进程退出码，失败信息只出现在日志的 `Error in <case>`。
- **修法**：判定测试通过必须同时满足退出码 0 且日志无 `Error in `：
  `make test 2>&1 | grep -c "Error in "` 为 0（Makefile 的 `test` 目标已内置该校验）。**不要绕过 Makefile 直接调 hvigorw test**。

### A2 首次 `make test` 报 `Failed to resolve OhmUrl ... "@ohos/hypium"`

- **根因**：工程没有 `oh_modules`（依赖未安装）。
- **修法**：`ohpm install --all`（`make ohpm-install`；Makefile 的 test 目标已内置缺失检测）。

### A3 手写骨架报 `OhPackageLoader.processModuleDependencyMap → ERR_INVALID_ARG_TYPE ... Received undefined`

- **症状**：错误信息完全看不出跟文件缺失有关。
- **根因**：缺 **`entry/oh-package.json5`**（模块级依赖声明）。
- **修法**：补齐 `entry/` 下 `oh-package.json5`、`build-profile.json5`、`hvigorfile.ts`、
  `obfuscation-rules.txt`、`.gitignore`；最佳做法是从 DevEco 新建的空白工程拷模板文件，别手写字段。

### A4 命令行构建找不到 hvigor / ohpm / SDK

- **根因**：Makefile 里导出的 PATH 对 `hvigorw` 无效（make 对简单命令跳过 shell 直接 exec），
  或 `DEVECO_SDK_HOME`/`JAVA_HOME` 没设置。
- **修法**：`hvigorw` 用**绝对路径**调用；在 Makefile 顶部 `export DEVECO_SDK_HOME`、`export JAVA_HOME`、
  `export PATH := $(OHPM_BIN):$(HVIGOR_BIN):$(PATH)`。DevEco 不在 `/Applications` 时改三个路径变量。

### A5 模板工程带他人签名路径导致构建失败/污染仓库

- **根因**：`build-profile.json5` 的 `signingConfigs` 里残留 `.p12` 绝对路径（含用户名、绑定他人账号）。
- **修法**：模板工程留 `"signingConfigs": []`（只 WARN，可构建）；签名在 DevEco Studio 里各自配置，不入库。

### A6 构建产物/缓存被提交进 git

- **修法**：根 `.gitignore` 至少包含 `/node_modules`、`/oh_modules`、`/.hvigor`、`**/build`、`**/.test`、
  `/.idea`、`/local.properties`。

---

## B ArkTS 语法

### B1 一批「TS 写法」编译不过

- **症状/根因对照**（ArkTS 严格模式）：
  - `as const` → 禁；用枚举或显式类型常量。
  - `catch (e: unknown)` 后强转 → 禁；`const err = e as BusinessError`（`@kit.BasicServicesKit`）。
  - `interface` 对象 `obj['key']` 索引访问 → 禁；先 `as Record<string, Object>`。
  - 构造参数属性 `constructor(private x: number)` → 禁；显式字段 + 赋值。
  - 无类型对象字面量 → 必须有显式 interface/class 对应。
  - 字符串传枚举参数（如 `'GET'`）→ 用枚举成员 `http.RequestMethod.GET`。
2. **修法**：按上表逐条替换；编译报错信息里的行号通常很准，别怀疑编译器。

### B2 `buffer.from(str,'utf-8')` 当 `Uint8Array` 用出问题

- **根因**：返回的是 `Buffer`，且本地 mock 下 `byteOffset` 是伪造值。
- **修法**：`new Uint8Array(buffer.from(s, 'utf-8').buffer)`。

### B3 类型/枚举 import 报错或「找不到导出」

- **根因**：鸿蒙有两套来源——**全局声明**（`Navigation`、`NavPathStack`、多数组件属性枚举）不需要 import；
  其余在 `kits/@kit.*.d.ts` 里按 kit 导出（`TextInputType` 实际叫 `InputType`）。
- **修法**：grep `$SDK/ets/component/*.d.ts` 与 `$SDK/ets/kits/@kit.*.d.ts` 确认真实名字与来源；
  不确定就不要凭空 import。

### B4 `MenuItemOptions.content` 传 CustomBuilder 编译失败

- **根因**：该字段只接受 `ResourceStr`；`MenuItemAttribute` 也没有 `fontColor`。
- **修法**：长按菜单里做红字删除项 → 换自定义 `Menu` 布局；或用普通项 + `labelInfo: '不可恢复'` 警示。

---

## C UI 与 Navigation

### C1 push 后页面空白

- **根因排序**：
  1. 路由表是顶层函数/箭头函数，而不是**组件内 `@Builder` 方法**（`.navDestination(this.PageMap)`）；
  2. `pushPath({ name })` 不传 param 时 param 是 `undefined`，透传给子组件 `@Param param: object` 类型不匹配，
     子页构建异常 → 空白；
  3. `NavDestination` 没包在子页组件内（子页根节点必须是 `NavDestination`）。
- **修法**：`@Builder` 只声明 `name` 参数；子页自己 `pathStack.getParamByName()` 取参并兜底 undefined。

### C2 单栏应用出现左右分栏 / 返回行为怪

- **根因**：`Navigation` 默认 `mode = Auto`，平板/宽屏会切成双栏。
- **修法**：单栏应用显式 `.mode(NavigationMode.Stack)`。

### C3 内容区被顶部/底部压缩 ~112vp（标题栏/工具栏占位）

- **根因**：`hideTitleBar` / `hideToolBar` **默认 false**，即使不配置 title/toolbar 也会占位。
- **修法**：`.hideTitleBar(true).hideToolBar(true)`。注意 `NavDestination` 有自己的 `.title()` 标题栏，
  不受 Navigation 级 hideTitleBar 影响。

### C4 底部留白 / `height('100%')` 看起来失效

- **根因**：`Navigation` 自身全屏但**内容区布局在安全区内**（避让状态栏与手势条），
  `expandSafeArea` 只扩展绘制区域、不改变布局。
- **修法**：先量实际高度（`onAreaChange` 打日志）确认根因是标题栏/工具栏占位还是安全区；
  需要内容延伸到屏幕底用
  `.ignoreLayoutSafeArea([LayoutSafeAreaType.SYSTEM], [LayoutSafeAreaEdge.BOTTOM])`（API 20+，枚举全局声明免 import），
  且**前提是标题栏/工具栏已隐藏**。

### C5 长列表滚动持续卡顿、fling 时成片重建组件

- **根因**：用零高度的折叠占位项（`Row().height(0)`）实现折叠，`LazyForEach` 的索引↔像素映射变成非线性，
  可见窗口会单帧跳过上百索引 → 批量创建组件。
- **修法**：数据源只放**可见行**，折叠状态记在全量数组（如 `foldedAncestors`）；
  toggle 时过滤重建可见数组并 `onDataReloaded()`（纯数据 O(n)，不做占位渲染）。

### C6 未绑定组件的 `Scroller` 调 `currentOffset()` / `scrollTo()` 崩溃

- **根因**：页面有多形态布局时，某形态没有 List/Scroll，`scroller` 未挂到组件上，
  在 `onWillHide` 等时机调用直接崩（API 23 才提供安全的 `offset()`，未绑定返回 undefined）。
- **修法**：凡对 scroller 的调用都按形态分支跳过，或统一在调用前判断「该形态是否存在滚动容器」。

### C7 V2 组件能当 NavDestination 宿主吗？

- **结论**：可以。官方 Navigation 示例多为 `@Component`，但 `@ComponentV2` 文档声明行为一致，
  无 NavDestination 限制；页面间共享状态用 `AppStorageV2.connect` 单例，不要靠路由 param 传大对象。

---

## D 资源与图标

### D1 `Unknown resource name`

- **根因**：`sys.color.*` / `sys.media.*` 里看似通用的名字可能是 private 或根本不存在
  （如 `ohos_ic_public_settings`、`ohos_id_color_secondary_text`）。
- **修法**：grep `$SDK/toolchains/id_defined.json` 找合法名：
  `grep -o '"ohos_ic_public[a-z_]*"' ... | sort -u`。常用文本色：`sys.color.primary` / `secondary` /
  `alert_transparent`。

### D2 改了图标但桌面还是旧图标

- **根因**：`module.json5` 的 `$media:layered_image` 用的是 **entry 模块**资源，会覆盖 AppScope 同名资源；
  启动图另有 `startIcon.png`。
- **修法**：同时替换 `AppScope/resources/base/media/*`、`entry/src/main/resources/base/media/*`（background/foreground/
  layered_image）与 `startIcon.png`；均为 1024×1024、不做圆角、背景层不允许透明像素。

### D3 深色模式下颜色不对

- **根因**：硬编码颜色或只在 `base` 提供资源。
- **修法**：颜色写进 `resources/base/element/color.json`，深色对应值放 `resources/dark/element/color.json`；
  代码里统一 `$r('app.color.xxx')`。

---

## E 数据与接口

### E1 对接第三方 REST：本地乐观更新后刷新内容跳变

- **根因**：多数端点（update/move/delete）只回 `{"status":"ok"}`，create 只回 id，缺时间戳/排序位等字段。
- **修法**：本地乐观更新时对缺失字段自算或用「pending 覆盖值」，下次全量刷新时以服务端为准。

### E2 保存表单把服务端富文本覆盖成纯文本

- **根因**：数据源富文本由别处生成（markdown→HTML），纯文本表单整对象回写。
- **修法**：保存时**只提交变更字段**（与纯文本原文比较），未改动字段不提交。

### E3 RDB 查询后内存/句柄泄漏、越用越慢

- **根因**：`ResultSet` 未 `close()`；大量写入没有事务。
- **修法**：`try/finally` 关闭结果集；批量写入用 `beginTransaction/commit`。

---

## F 设备与调试

### F1 无线调试端口每次都变、`hdc tconn` 挂 30~60s

- **根因**：鸿蒙手机无线调试端口每次开启/重启/换 Wi-Fi 都会变（实测落在 `3xxxx`~`6xxxx`，无规律）；
  设备上常有 3~5 个「TCP 能连但不是 hdc」的开放端口，`tconn` 打上去会长时间挂起（易误判为网络慢）。
- **修法**：不手抄端口、不裸调 `tconn`，用 skill 的 `scripts/hdc-wifi`（自动扫描 + 带超时验证 + 记住上次结果）。
  详见 `build-test-run.md`「真机无线调试」。

### F2 已连接时 `hdc tconn` 返回 `[Info]Target is connected, repeat operation`

- **根因**：这是「已连接」的正常提示，不是失败。
- **修法**：判断是否连上统一看 `hdc list targets` 里有没有 `IP:port`。

### F3 `ping` 不通但设备在线

- **根因**：设备侧 ICMP 常被封。
- **修法**：ping 结果只作提示，不作判据；以实际 TCP/hdc 结果为准。

### F4 真机装不上 HAP

- **根因**：未签名 / 签名与设备不匹配 / 设备未授权调试。
- **修法**：DevEco Studio 配置签名（自动生成调试证书）→ 手机开启「USB 调试」并点允许 →
  `hdc install -r entry/build/default/outputs/default/entry-default-signed.hap`。

### F5 本地单测全绿但真机功能不可用（假安全感）

- **根因**：`entry/src/test` 本地单测里所有 `@kit` 平台 API 都是空桩——不抛错、返回空数据
  （实测 `cryptoFramework.createMd('MD5')` 返回 0 字节摘要、AES 解密返回空数组）。
- **修法**：纯算法/纯逻辑自实现或依赖注入（可 100% 本地测），平台原语只做薄封装（5 行以内）并列进
  **真机验证清单**；覆盖率统计要区分「可本地覆盖」与「只能真机验证」两部分。
