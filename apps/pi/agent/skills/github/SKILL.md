---
name: github
description: Manage GitHub Repository using GitHub CLI (gh). Use this skill when the user wants to interact with GitHub repositories.
---

# GitHub Skill

This skill allows you to manage GitHub repositories using the GitHub CLI (`gh`). You can perform various actions such as creating repositories, managing issues, pull requests, and more.

## Prerequisites

- Ensure you have the GitHub CLI (`gh`) installed on your system. You can download it from [here](https://cli.github.com/).
- You must be authenticated with GitHub CLI. You can authenticate by running `gh auth login` in your terminal.

## Available Commands

### Pull Requests

- `gh pr create --title "Title" --body "Description"`: Create a new pull request.
- `gh pr list`: List all pull requests in the repository.
- `gh pr view <pr-number>`: View details of a specific pull request.
- `gh pr view <pr-number> --comments`: View all general comments on a pull request.
- `gh api repos/{owner}/{repo}/pulls/<pr-number>/comments --jq '.[] | {author: .user.login, diff_hunk: .diff_hunk, file: .path, line: .line, body: .body, createdAt: .created_at}'`: Format inline comments for better readability.
- `gh pr merge <pr-number>`: Merge a specific pull request.
- `gh pr comment <pr-number> --body "Comment"`: Add a comment to a specific pull request.

### Other Commands

You can explore more commands and functionalities of the GitHub CLI by running `gh help` and `gh <command> --help` for specific commands.
