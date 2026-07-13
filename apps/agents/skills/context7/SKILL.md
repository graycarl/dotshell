---
name: context7
description: >-
  Retrieves up-to-date documentation, API references, and code examples for any
  developer technology. Use this skill whenever the user asks about a specific
  library, framework, SDK, CLI tool, or cloud service — even for well-known ones
  like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. Your
  training data may not reflect recent API changes or version updates.

  Always use for: API syntax questions, configuration options, version migration
  issues, "how do I" questions mentioning a library name, debugging that involves
  library-specific behavior, setup instructions, and CLI tool usage.

  Use even when you think you know the answer — do not rely on training data for
  API details, signatures, or configuration options as they are frequently outdated.
  Prefer this over web search for library documentation and API details.
---

# Context7 Documentation Lookup

Fetch current documentation and code examples for any library from the Context7 API instead of relying on training data.

## Setup

1.  **Get your Context7 API Key** (optional but recommended for higher rate limits): Obtain an API key from the [Context7 website](https://context7.ai/).

2.  Provide the API key one of two ways:

    **A. Environment variable** (checked first):
    ```bash
    export CONTEXT7_API_KEY="your_key_here"
    ```

    **B. auth.json** (fallback, checked if the env var is unset):
    ```bash
    cp auth.json.tpl auth.json
    # Then edit auth.json and replace "your_context7_api_key_here" with your actual key
    ```

    `auth.json` format:
    ```json
    {
      "api_key": "your_context7_api_key_here"
    }
    ```

    > **Note**: `auth.json` contains sensitive credentials and should not be committed to version control (`**/auth.json` is gitignored at the repo root). Requests without an API key still work, but with lower rate limits.

## Usage

This skill provides two main commands:

1.  `./scripts/resolve-library-id.sh <libraryName> <query>`: Resolves the internal Context7 ID for a given library.
2.  `./scripts/query-docs.sh <libraryId> <query>`: Fetches documentation for a specific library ID and query.

You MUST call `resolve-library-id.sh` first to obtain a valid library ID UNLESS the user explicitly provides one in the format `/org/project` or `/org/project/version`.

**IMPORTANT**: Do not run these commands more than 3 times per question. If you cannot find what you need after 3 attempts, use the best result you have and clearly tell the user that Context7 could not locate the exact information.

## Workflow

1.  **Check for `CONTEXT7_API_KEY`**: If the environment variable is not set, the script falls back to `auth.json`.
2.  **Resolve the Library ID**: Call `./scripts/resolve-library-id.sh` with the library name and the user's full question.
3.  **Select the Best Match**: Choose the best `id` based on exact/closest name match, higher benchmark scores, source reputation, and version-specific IDs if applicable.
4.  **Fetch the Documentation**: Call `./scripts/query-docs.sh` with the selected library ID and a focused, single-topic query.
5.  **Use the Documentation**: Answer the user's question using current, accurate information, including relevant code examples and citing the library version when relevant.

### Step 1: Resolve a Library

Call `./scripts/resolve-library-id.sh` with the library name from the user's question and the full user question as the second argument to improve relevance ranking.

*Examples:*
```bash
./scripts/resolve-library-id.sh "next.js" "How do I configure Next.js middleware?"
./scripts/resolve-library-id.sh "prisma" "How to define one-to-many relations with cascade delete"
```

Use the official library name with proper punctuation (e.g., "Next.js" not "nextjs", "Customer.io" not "customerio"). If results look wrong, try alternate spellings such as `next.js` before changing the query.

Each result includes:

- **id** — Context7-compatible identifier (format: `/org/project`).
- **title** — Library or package name.
- **description** — Short summary.
- **totalSnippets** — Number of available code examples (more is usually better).
- **trustScore** — Source authority indicator.
- **benchmarkScore** — Documentation quality indicator (higher is better).
- **versions** — List of available versions, if any.

**Selection criteria:**
1. Analyze the query to understand what library/package the user is looking for.
2. Select the most relevant match based on:
   - Name similarity (exact matches prioritized).
   - Description relevance to the query's intent.
   - Documentation coverage (`totalSnippets`).
   - Source reputation and benchmark score.
3. Prefer official/primary packages over community forks when multiple matches exist.
4. If multiple good matches exist, acknowledge this but proceed with the most relevant one.
5. If no good matches exist, clearly state this and suggest query refinements.

#### Version-specific IDs

If the user mentions a specific version, use a version-specific library ID. Available versions are listed in the `resolve-library-id` output.

```bash
# Latest indexed version
./scripts/query-docs.sh /vercel/next.js "How to set up app router"

# Version-specific
./scripts/query-docs.sh /vercel/next.js/v15.1.8 "How to set up app router"
./scripts/query-docs.sh /vercel/next.js@v15.1.8 "How to set up app router"
```

Use the closest match to what the user specified.

### Step 2: Fetch the Documentation

Call `./scripts/query-docs.sh` with the selected library ID and the user's specific, focused question.

*Examples:*
```bash
./scripts/query-docs.sh /vercel/next.js "How do I configure Next.js middleware?"
./scripts/query-docs.sh /prisma/prisma "How to define one-to-many relations with cascade delete"
```

#### Writing good queries

The query directly affects the quality of results. Be specific and include relevant details, but **keep each query to one topic**.

| Quality | Example |
|---------|---------|
| Good | `"How to set up authentication with JWT in Express.js"` |
| Good | `"React useEffect cleanup function with async operations"` |
| Bad (too vague) | `"auth"` |
| Bad (too vague) | `"hooks"` |
| Bad (too broad) | `"routing and auth and caching in Next.js"` |

If the user's question spans multiple distinct concepts (e.g. routing and auth and caching), make a **separate `query-docs.sh` call per concept** with the same library ID, unless the question is about how the concepts interact. Combined queries dilute ranking and return shallow results for each topic.

**Security note**: Do not include any sensitive or confidential information in the query, such as API keys, passwords, credentials, personal data, or proprietary code. The query is sent to the Context7 API.

## Error Handling

If a command fails with a quota or spending-limit error ("Monthly quota reached", "quota exceeded", "Spending limit reached", HTTP 402):

1. Inform the user their Context7 quota is exhausted.
2. Suggest they authenticate for higher limits: set `CONTEXT7_API_KEY` or run `ctx7 login` (if using the official Context7 CLI).
3. If they cannot or choose not to authenticate, answer from training knowledge and clearly note that the information may be outdated.

Do not silently fall back to training data — always tell the user why Context7 was not used.

## Common Mistakes

- Library IDs require a `/` prefix — `/facebook/react` not `facebook/react`.
- Always run `resolve-library-id.sh` first — `query-docs.sh react "hooks"` will fail without a valid ID.
- Use descriptive queries, not single words.
- One topic per query — split `routing and auth and caching` into a separate `query-docs.sh` command per concept, unless the question is about how they interact.
- Do not include sensitive information (API keys, passwords, credentials, personal data, or proprietary code) in queries.

## Scripts

The helper scripts are located in the `scripts/` directory within this skill. They handle the interaction with the Context7 API.

- `scripts/resolve-library-id.sh`: resolves a library name to a Context7-compatible ID.
- `scripts/query-docs.sh`: fetches documentation for a given library ID and query.

Both scripts support `CONTEXT7_API_KEY` or `auth.json` for authentication. `resolve-library-id.sh` also supports an optional `--fast` flag (or `CONTEXT7_FAST=1`) to skip LLM reranking and return faster vector-search results.