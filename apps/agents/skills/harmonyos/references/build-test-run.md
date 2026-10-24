# 构建、测试、签名与真机调试

这篇是「让代码真的跑起来」的部分：环境与工具链路径、命令行编译、单测、签名、真机连接。
UI/语言问题看 `arkts-ui.md`，报错排查看 `pitfalls.md`。

## 环境与工具链（macOS + DevEco Studio）

| 项 | 位置 / 值 |
|---|---|
| DevEco Studio | `/Applications/DevEco-Studio.app`（不在默认路径时改 Makefile 顶部三个变量） |
| SDK | `$DEVECO_APP/Contents/sdk`（`DEVECO_SDK_HOME`）；d.ts 在 `sdk/default/openharmony/ets/` |
| JDK | `$DEVECO_APP/Contents/jbr/Contents/Home`（`JAVA_HOME`） |
| hvigor | `$DEVECO_APP/Contents/tools/hvigor/bin/hvigorw` |
| ohpm | `$DEVECO_APP/Contents/tools/ohpm/bin` |
| hdc | DevEco 自带，`scripts/hdc-wifi` 会自动定位；也可 `HDC=` 覆盖 |

- **SDK/工具链全部来自 DevEco Studio 安装包**，不需要单独装 Node/Java/hvigor CLI。
- `local.properties`（SDK 路径）**不入库**，每台机器由 IDE 生成。
- 命令行构建优先用项目根的 `Makefile`（初始化时生成），它已经把这些环境变量 export 好，
  无需手动导出；没有 Makefile 的老项目可参考模板自己写一份。

## 命令行构建（Makefile 目标）

```bash
make build        # 编译 + 打包 debug HAP（未签名，产物在 entry/build/default/outputs/）
make test         # 跑 LocalUnit 单测（hypium，entry/src/test）
make ohpm-install # 拉取 ohpm 依赖（首次 make test 前必需；test 目标已内置缺失检测）
make clean        # 清 entry/build
make help         # 列出全部目标
```

- 底层：`hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon`
- `hvigorw` 用**绝对路径**调用：make 对简单命令会跳过 shell 直接 exec，导出 PATH 不生效。
- 未配置签名时 SignHap 只 WARN 跳过，构建仍成功 → 可命令行验证编译。
- 真机安装需要签名 + 设备授权，见下面「签名」。

## 单元测试（hypium，有 3 个必须知道的坑）

1. **首次跑报 `Failed to resolve OhmUrl ... "@ohos/hypium"`** → 缺 `oh_modules`，
   先 `make ohpm-install`（Makefile 的 `test` 目标已内置该检测）。
2. **假绿**：hypium 用例失败时 hvigor 仍可能打印 `BUILD SUCCESSFUL`，失败信息只有日志里的
   `Error in <case>`。判断测试是否真通过必须：
   ```bash
   make test 2>&1 | grep -c "Error in "   # 必须为 0
   ```
   Makefile 的 `test` 目标已内置该校验，别绕过它直接 `hvigorw test`。
3. **本地单测里所有 `@kit` 平台 API 都是空桩**：不抛错、返回空数据
   （实测 `cryptoFramework.createMd('MD5')` 返回 0 字节摘要、AES 解密返回空数组）。
   所以：**纯算法/纯逻辑要自实现或依赖注入**（可 100% 本地测），平台原语只做薄封装
   （如 5 行的 `cryptoFramework` 调用）并列进真机验证清单。
   否则会出现「测试全绿、生产路径零覆盖」的假安全感。

测试文件位置：`entry/src/test/`（LocalUnit，本地 JVM 跑）/ `entry/src/ohosTest/`（Instrumented，需真机）。

## 签名（装真机的前置条件）

- 签名只能在 **DevEco Studio** 里配置：`File → Project Structure → Signing Configs`，
  勾选自动生成（需登录华为开发者账号），生成 `.p12`/`.cer`/`.p7b` 并写回 `build-profile.json5`。
- 模板工程默认 `"signingConfigs": []`：**可以构建，不能装真机**；只 WARN，不要误判为构建失败。
- **不要把别人的签名材料绝对路径提交进仓库**（`.p12` 路径含用户名、证书有效期绑定开发者账号）。

## 真机无线调试（hdc 端口每次都会变）

**真机调试前必读**：鸿蒙手机「无线调试」的端口每次开启/重启/换 Wi-Fi 都会变，官方 UI 不给固定；
且设备上常有 3~5 个「TCP 能连上但不是 hdc」的开放端口，`hdc tconn` 打上去会**挂 30~60s** 才返回
（容易被误判成「网络慢/扫描慢」）。所以**别手抄端口、别裸调 tconn**，直接用本 skill 的脚本：

```bash
<skill 目录>/scripts/hdc-wifi                # 热路径 ~1s（已记住上次 IP:端口）
<skill 目录>/scripts/hdc-wifi 192.168.1.23   # 指定 IP（或 USB 反查 wlan IP）
<skill 目录>/scripts/hdc-wifi --port 5555    # 配 `hdc tmode port 5555` 的固定端口模式
```

- 依赖：bash≥3.2、python3≥3.9（仅标准库）、DevEco 自带 hdc（自动定位，`HDC=` 可覆盖）；
  **无需安装、无需 sudo、不需要 timeout/nc/jq/curl**。
- 冷启动约 24s：并发扫描 25000-65535（1024 并发 / 0.25s）→ 逐个带超时验证。
  **不要**为求快把并发调到 4096/0.12s：实测 4 万个端口一个都扫不到（SYN 被设备丢弃）。
- 手机侧准备：`设置 → 系统 → 开发者选项` 打开「USB 调试」和「无线调试」，
  首次连接需在手机上点「允许」授权；记下无线调试页显示的 IP 与端口（脚本会自己扫，不必填）。
- 两个附带坑：① 已连接时 `hdc tconn` 返回 `[Info]Target is connected, repeat operation`
  而不是 `Connect OK`，判断是否连上要看 `hdc list targets` 里有没有 `IP:port`；
  ② 设备侧 ICMP 常被封，`ping` 不通不代表不在线，脚本的 ping 只作提示不作判据。

常用 hdc 命令：

```bash
hdc list targets                     # 已连接设备（IP:port 才是无线连上的）
hdc shell hilog | grep <TAG>         # 看日志（HiLog）
hdc install -r entry/build/default/outputs/default/entry-default-signed.hap
hdc shell aa start -a EntryAbility -b <bundleName>
```

> 项目侧不要在 Makefile 里再包一层 hdc：AGENTS.md 直接给脚本绝对路径，
> 少一层间接、也避免各项目脚本漂移。

## 上架（大致流程，细节查官方）

1. 华为开发者账号 + 实名认证（企业需营业执照）；
2. AppGallery Connect 创建应用（bundleName 必须与工程一致，创建后不可改）；
3. 生成 **发布证书 + Profile**（与调试签名不同），`build-profile.json5` 加 release 签名配置；
4. `hvigorw assembleHap -p buildMode=release` 出正式包（HAP/APP）；
5. AGC 上传 → 填写应用信息/隐私政策/权限使用说明 → 提审（首次审核较慢，驳回常有明确整改项）；
6. 隐私合规是最大驳回源：**任何权限都要在隐私政策里说明用途**，且首次启动不得提前申请与功能无关的权限。

链接：[应用/元服务签名](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-signing)、
[AGC 上架](https://developer.huawei.com/consumer/cn/doc/app/agc-help-releaseharmony-0000001933963166)。
