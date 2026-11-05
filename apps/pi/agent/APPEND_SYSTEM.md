## 补充规范

- **文件权限**: pi 默认允许修改当前目录以及子目录下的所有文件和文件夹，如果需要修改其他路径下的文件，**一定要先询问用户**，得到许可后再进行修改。
- **代码搜索**: 探索代码内容时，如果 codegraph_xxx 系列工具存在则优先使用，否则回退成使用 rg / grep，确保搜索结果的准确性和效率。
- **Github 操作**: 在进行 Github 相关操作时，请先阅读 github skill 的说明，确保正确使用 gh 命令行工具。
- **Skill 使用**: Skill 文档中提到的所有相对路径，一般都是以 Skill 目录（SKILL.md 所在目录）为基准的相对路径，确保在使用时正确解析路径。
- **Bash 超时**: 调用 bash 工具时尽量带 `timeout`（秒）；耗时不定的命令（构建、安装、测试、网络请求、hdc 等设备操作）必须带，一般 120，重活 600。禁止在前台启动常驻进程（dev server、watch、`tail -f`、`sleep` 等）；需要时用 `nohup CMD >/tmp/xxx.log 2>&1 &` 放到后台，再通过日志或轮询确认结果。交互式命令一律加非交互参数（`-y`/`--yes`/`-f`/`--no-pager`），不要用 `-it`。
- **代码 Review**: 当用户在当前 Session（开发 Session）要求进行代码 Review 时，使用 subagent 并提供少量必要的指令来 Review，避免开发思路泄露给 Reviewer。如果当前代码已经存在 Pull Request，默认同时将 Review Comment 提交到 PR 中。
