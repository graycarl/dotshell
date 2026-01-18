---
name: github
description: Manage GitHub Pull Requests using GitHub CLI (gh). Create, merge, view status, and comment on PRs. Use this skill when the user wants to interact with GitHub repositories.
---

# GitHub Skill

This skill provides a set of tools to manage GitHub Pull Requests directly from the agent. It wraps the `gh` CLI to provide simplified workflows for creating, merging, and reviewing PRs.

## Prerequisites

- **GitHub CLI (`gh`)**: Must be installed and authenticated.
  ```bash
  gh auth login
  ```
- **jq**: Required for parsing JSON responses in `view-comments.sh`.

## Usage

**Important Convention**: When creating a PR or adding a comment, always append the signature `-- From Agent PI` to the body text.

### 1. Create a Pull Request

Create a new PR from the current branch.

```bash
./scripts/create-pr.sh "<Title>" "<Body>" ["<BaseBranch>"]
```

- `BaseBranch` is optional (defaults to repository default, usually `main` or `master`).
- Note: Use single quotes around the title and body if they contain special characters.

### 2. Check Status

View the status of relevant PRs or details of a specific one.
```bash
# Overview of current branch PRs and review requests
./scripts/check-status.sh

# Detailed view of a specific PR
./scripts/check-status.sh <pr-number>
```

### 3. Merge a Pull Request

Merge a PR using the **merge commit** strategy (preserves commit history).
```bash
./scripts/merge-pr.sh <pr-number>
```

### 4. View Comments (Conversation + Code Reviews)

Fetch and display all comments, including general discussion and specific code review comments (line comments), sorted chronologically.
```bash
./scripts/view-comments.sh <pr-number>
```

### 5. Add a Comment

Post a new comment to the PR discussion.
```bash
./scripts/add-comment.sh <pr-number> "<Comment Text>"
```

## Workflow Example

1.  **Check Status**: ` ./scripts/check-status.sh` to see if there's an open PR.
2.  **View Comments**: ` ./scripts/view-comments.sh 123` to read feedback.
3.  **Add Comment**: ` ./scripts/add-comment.sh 123 "Fixed the typo."`
4.  **Merge**: ` ./scripts/merge-pr.sh 123` once approved.
