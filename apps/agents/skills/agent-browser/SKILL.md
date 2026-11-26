---
name: agent-browser
description: 用 agent-browser CLI 驱动本机浏览器：打开导航、可访问性快照 + @eN ref、点击/填表/取文本、截图/PDF、多标签、登录态复用、Electron 桌面应用、Slack。用于打开网站、填表单、点按钮、截图、抓取页面内容、登录站点、测试或调试 Web 应用，以及任何需要程序化操作浏览器的任务。Browser automation CLI: open pages, fill forms, click, screenshot, scrape data, log in, test web apps.
allowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*)
---

# agent-browser

执行任何命令前，先读当前版本随附的工作流（它才是权威，且随升级自动更新）：

```bash
agent-browser skills get core
```

不要加 `--full`（几倍体积）。需要细节时，按 core 里的表格用 `--ref` 单条加载。

pi 侧只有两条约定（core 不涉及）：

1. pi 每次 bash 都是新 shell。本会话第一条命令前跑
   `agent-browser session id --scope worktree --prefix task`，之后每条命令都带 `--session <那个名字>`。
   否则会落进全机共享 session，抢走别的 agent 或你正在用的页面。
2. 任务结束 `agent-browser close`。

省事提示：纯文本页面用 `agent-browser read <url>` 直接取，不必开浏览器。
