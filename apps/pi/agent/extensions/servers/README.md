# Servers Extension

让 pi agent 以非阻塞方式启动并管理开发中的长驻服务进程（dev web server、watcher 等）。

## 能力

**Agent 工具**（namespace: `server`）:

| 工具 | 作用 |
|---|---|
| `server_start` | 后台启动服务，立即返回 pid 和日志路径 |
| `server_list` | 列出所有服务：running/exited、pid、运行时长、命令 |
| `server_logs` | 读日志尾部（ANSI 已剥离，超长截断并给出文件路径） |
| `server_stop` | SIGTERM→SIGKILL 停止；`restart:true` 重启；`signal:"SIGHUP"` 只发信号 |
| `server_send` | 向运行中服务的 stdin 写一行（仅本 pi 会话启动的服务） |

**用户界面**:

- `/servers` 命令：overlay 列表（状态/pid/时长/最近一行日志，自动刷新），按键 `l` 看日志、`d` 停止、`r` 重启、`Esc` 关闭
- footer 状态栏：有服务运行时显示 `⚙ N servers`
- 退出提示：退出 pi 进程时在终端提示「Stop them? [Y/n/pick]」——回车/15 秒超时 → 全部停止，`n` → 全部保留，`pick` → 逐个选择，Ctrl+D → 取消（全部保留）。session 切换（`/new` `/resume` `/fork`）和扩展 reload 不触发提示、不动进程

> 为什么提示是终端文本而不是 TUI 弹窗：pi 在交互式退出时**先停 TUI 再发 `session_shutdown`**,shutdown 处理器里弹 `ctx.ui` 对话框会永久卡住退出流程。TUI 停止后 stdin 已恢复 cooked 模式，所以用 readline 文本提示。
> 无法提示时（SIGTERM/SIGHUP 信号退出、print/json/RPC 无 TTY)：默认**全部停止**并写 stderr 说明，避免悄悄残留进程。

## 工作原理

- 进程以 `detached` 方式 spawn，stdout/stderr 追加写入 `.pi/servers/logs/<name>.log`,stdin 保持 pipe
- 注册表：`.pi/servers/registry.json`（项目级，不入库——建议把 `.pi/servers/` 加进项目 `.gitignore`)
- pi 崩溃 / reload / `/new` `/resume` `/fork` 切换 session 都**不会**动服务进程；新 session 通过注册表重新发现它们（可 stop/logs/signal,stdin 需 restart 后恢复）
- 停止按**进程组**发送信号（`kill -pid`),dev server 派生的子进程一并清理；SIGTERM 5 秒超时后 SIGKILL
- **pid 复用防护**：启动时记录进程启动时间（`ps lstart`)，对恢复来的进程发信号前重新校验，pid 已被无关进程复用时拒绝操作并把条目标记为 exited（宁残留，不误杀）

## 注意事项

- **平台假设**:POSIX（macOS/Linux)。进程组 kill 是 POSIX 语义，Windows 不支持
- **不要在 `env` 参数里放密钥**:env 会明文写进 `.pi/servers/registry.json`
- **stdin EOF**:pi 退出时保留的服务，其 stdin pipe 会收到 EOF；个别对 stdin 敏感的服务可能因此自行退出（进程本身不会被杀）
- **日志无轮转**：长跑服务的 `.pi/servers/logs/<name>.log` 会持续增长，必要时手动清理

## 部署

```bash
bash apps/pi/setup.sh   # extensions/ 目录整体软链，无需单独注册
```

## 文件

- `index.ts` — 装配:session_start 恢复注册表、/servers 命令、footer widget、quit 提示
- `manager.ts` — 进程生命周期、registry 持久化、pid 存活校验、日志读取
- `tools.ts` — 5 个 LLM 工具（schema + execute + TUI 渲染）
- `ui.ts` — /servers overlay、退出确认、footer 状态
