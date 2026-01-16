---
name: context7
description: This skill should be used when the user asks about libraries, frameworks, API references, or needs code examples. It uses the Context7 API to fetch up-to-date documentation. Activates for setup questions, code generation involving libraries, or mentions of specific frameworks like React, Vue, Next.js, Prisma, Supabase, etc.
---

# Context7 Documentation Lookup

When the user asks about libraries, frameworks, or needs code examples, use this skill to fetch current documentation from the Context7 API instead of relying on training data.

## Setup

1.  **Get your Context7 API Key**: Obtain an API key from the [Context7 website](https://context7.ai/).
2.  **Set the environment variable**: Export your API key as `CONTEXT7_API_KEY`.

    ```bash
    export CONTEXT7_API_KEY="your_api_key_here"
    ```
    To make this permanent, add the line above to your shell profile (e.g., `~/.zshrc`, `~/.bashrc`).

## Usage

This skill provides two main commands:

1.  `./scripts/resolve-library-id.sh <libraryName> [query]`: Resolves the internal Context7 ID for a given library.
2.  `./scripts/query-docs.sh <libraryId> <query>`: Fetches documentation for a specific library ID and query.

## Workflow

1.  **Check for `CONTEXT7_API_KEY`**: If the environment variable is not set, instruct the user to perform the setup steps.
2.  **Resolve the Library ID**: Call `./scripts/resolve-library-id.sh` with the library name from the user's question. The full user question should be passed as the second argument to improve relevance.

    *Example:*
    ```bash
    ./scripts/resolve-library-id.sh "next.js" "How do I configure Next.js middleware?"
    ```

3.  **Select the Best Match**: From the JSON results, choose the best `id` based on:
    - Exact or closest name match.
    - Higher benchmark scores.
    - Version-specific IDs if the user mentioned a version (e.g., "react@19").

4.  **Fetch the Documentation**: Call `./scripts/query-docs.sh` with the selected `libraryId` and the user's specific question.

    *Example:*
    ```bash
    ./scripts/query-docs.sh "/vercel/next.js" "How do I configure Next.js middleware?"
    ```

5.  **Use the Documentation**: Incorporate the fetched documentation into your response to answer the user's question, including code examples and citing the library version where relevant.

## Scripts

The helper scripts are located in the `scripts/` directory within this skill. They handle the interaction with the Context7 API.
