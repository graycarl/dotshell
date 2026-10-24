# AGENTS.md — {{app_name}}

> 本文件是 AI coding agent 的项目入口。先读"项目事实"，再按任务查"资料索引"。
> 完整资料清单见 [docs/harmonyos-resources.md](docs/harmonyos-resources.md)
> （该文件由 harmonyos skill 的 `references/resources.md` 复制生成，可重跑初始化刷新）。

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
make build        # 编译 + 打包 debug HAP（未签名，产物在 entry/build/default/outputs/）
make test         # 跑 LocalUnit 单测（hypium，entry/src/test）
make ohpm-install # 拉取 ohpm 依赖（首次 make test 前必需；test 目标已内置缺失检测）
make help         # 列出全部目标
```

- 签名需在 DevEco Studio 里配置后才可装真机；未签名时 SignHap WARN 跳过，可忽略
- 环境变量（DEVECO_SDK_HOME / JAVA_HOME / PATH）由 Makefile 自动设置，无需手动导出
- 若本机 DevEco Studio 不在 `/Applications/DevEco-Studio.app`，改 Makefile 顶部路径
- ⚠️ **`make test` 的假绿**：hypium 用例失败时 hvigor 仍可能打印 `BUILD SUCCESSFUL`，
  只有日志里有 `Error in <case>`。判断测试是否真的通过必须：
  `make test 2>&1 | grep -c "Error in"` 为 0（Makefile 的 test 目标已内置该校验）。

## 真机无线调试（hdc 端口随机，别手抄）

鸿蒙手机「无线调试」的端口**每次开启 / 重启 / 换 Wi-Fi 都会变**，官方 UI 不给固定；设备上还常有
3~5 个「TCP 能连上但不是 hdc」的开放端口，`hdc tconn` 打上去会**挂 30~60s** 才返回（不是网络慢、
也不是扫描慢，别被带偏）。已封装自动发现（脚本随 `harmonyos` skill 分发，路径见 `{{harmonyos_skill_dir}}/scripts/hdc-wifi`，无需安装）：

```bash
{{hdc_wifi}}                 # 热路径 ~1s：记住上次 IP:端口，命中即连
{{hdc_wifi}} 192.168.1.23    # 指定手机 IP（手机 → 设置 → 开发者选项 → 无线调试 里能看到）
{{hdc_wifi}} --port 5555     # 配 `hdc tmode port 5555` 的固定端口模式（若机型支持固定端口）
```

- 只有端口变了才扫描：并发扫 25000-65535（1024 并发 / 0.25s，约 10s）+ 逐个带超时验证 → 冷启动约 24s。
- **别**为了更快把扫描并发调到 4096/0.12s：实测 4 万个端口一个都扫不到（SYN 被设备丢弃）。
- 依赖 bash≥3.2 / python3≥3.9 / DevEco 自带 hdc（脚本自动定位，`HDC=` 可覆盖），
  不需要 brew 装任何东西（也无需 timeout/nc/jq，无需 sudo）。
- 首次无线连接需在手机上点「允许」授权；设备侧 ICMP 常被封，所以脚本的 ping 只作提示、不作判据。

## 核心设计决策（详版见设计文档）

> 项目早期填充，建议至少明确以下两条（鸿蒙通用经验，可直接采用）：

1. **路由栈即历史栈**：页面导航用 Navigation + NavDestination，focus 详情页 = push 一个节点页，
   系统返回 = pop，兄弟切换 = replace，面包屑 = popTo。
2. **状态管理用 V2 范式**（@ObservedV2/@Trace/@Local）；页面间共享状态走
   AppStorageV2.connect 单例，勿靠路由 param 传大对象。
   （若共享状态是**普通类单例**而非 @ObservedV2：在单例上加 `addListener/removeListener`，
   页面用 `@Local version: number` 自增触发重渲。）
3. **分层要适配「本地单测平台 API 是空桩」**（重要，会反向决定模块划分）：
   `src/test` 的本地单测里所有 `@kit` API 都是空桩——不抛错、返回空数据
   （实测 `cryptoFramework.createMd('MD5')` 返回 0 字节摘要、AES 解密返回空数组）。
   所以：**纯算法/纯逻辑要自实现或依赖注入**（可 100% 本地测），
   平台原语只做成薄封装（如 5 行的 `cryptoFramework` 调用）并列进真机验证清单。
   否则会出现「测试全绿、生产路径零覆盖」的假安全感。

> 这几条只是最小集。ArkTS/ArkUI/导航/资源名的完整推荐写法见
> `{{harmonyos_skill_dir}}/references/arkts-ui.md`，踩坑症状见 `{{harmonyos_skill_dir}}/references/pitfalls.md`。

<!-- 在此补充项目特有决策（数据流/同步策略/渲染规则等），例如： -->

## 开发资料速查

### 给 agent 的资料使用规则（最小集）

1. **API 是否存在、枚举有几个值 → 看 SDK d.ts，别猜**：
   `$DEVECO_SDK_HOME/default/openharmony/ets/api/*.d.ts`、`ets/kits/@kit.*.d.ts`、`ets/component/*.d.ts`；
   资源合法名看 `toolchains/id_defined.json`，权限级别看 `toolchains/lib/PermissionDefinitions.json`。
2. **华为文档站取不到正文**（JS 渲染 SPA，`curl` 永远 200 空壳；`.md` 后缀已全站 404）：
   精读走 SDK d.ts / OpenHarmony docs 仓库 raw / Context7；本仓库里的深链只供**人工/浏览器**打开。
3. **设计新功能前先查权限级别**：`system_grant`+`normal` 免弹窗；`system_basic` 普通应用拿不到
   （如 `READ_PASTEBOARD`）→ 设计阶段就避开。
4. **只查深链不查目录页**；注意页面「起始版本」标注，ArkTS 状态管理有 V1/V2 两代。

> 完整规则（含 Context7 库 ID、OpenHarmony raw URL 模板、权限查法）与全部深链清单见
> `{{harmonyos_skill_dir}}/references/resources.md`；项目内快照是 [docs/harmonyos-resources.md](docs/harmonyos-resources.md)。

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

## 已知坑

> 跨项目通用坑（构建/ArkTS/UI/资源/数据/设备六类，含症状→根因→修法）见
> `{{harmonyos_skill_dir}}/references/pitfalls.md`（skill 升级后自动生效，**不要抄进本文件**）。
> 这里只记**本项目特有**的坑：第一次踩对之后，把「症状 → 根因 → 修法」写下来。

### 示例：项目特有坑的写法

- **症状**：<看到的报错原文或异常表现>
  **根因**：<为什么>
  **修法**：<怎么改的，涉及哪些文件>
  **验证**：<怎么确认真的修好了>

<!-- 在下面追加本项目踩到的坑（没有就留空） -->
