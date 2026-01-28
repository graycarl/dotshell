---
name: github
description: GitHub CLI (gh) Skill. **Make sure** to read this before using `gh` commands.
---

# GitHub Skill

This skill allows you to interact with GitHub using the GitHub CLI (`gh`). You can perform various actions such as manage pull requests, expore repositories and more.

## Prerequisites

- Ensure you have the GitHub CLI (`gh`) installed on your system. You can download it from [here](https://cli.github.com/).
- You must be authenticated with GitHub CLI. You can authenticate by running `gh auth login` in your terminal.

## Instructions

- 如果你对 gh 命令不熟悉，通过 `gh help` 获取更多信息。
- 当使用 `gh api` 命令时，请通过 `--jq` 参数来提取你需要的信息，而不是获取完整的 JSON 响应。

### Pull Requests

当你要获取 Pull Request 的 Review comments 时，使用 `gh api` 来获取所有的 inline comments。

### Expore repositories

当你想要阅读某个 GitHub 仓库的代码时，不要直接 clone 仓库到本地，而是直接使用 `gh api` 来获取你需要的文件内容。
