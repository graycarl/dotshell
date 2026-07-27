/**
 * CodeGraph Extension — Tool Definitions
 *
 * Registers three tools that wrap the `codegraph` CLI:
 *   codegraph_explore — Semantic code exploration (symbols, call paths, source)
 *   codegraph_node   — Symbol detail or file read with line numbers
 *   codegraph_search — Fuzzy symbol search by name
 *
 * Each tool provides custom renderCall (shows invocation args) and
 * renderResult (collapsed summary by default; full output on expand).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { relative, isAbsolute } from "node:path";
import { execCodegraph } from "./utils.js";

// ── Shared schemas ──────────────────────────────────────────────────

const pathParam = Type.Optional(
  Type.String({ description: "Project path relative to workspace root (defaults to current working directory)" }),
);

// ── Render helpers ──────────────────────────────────────────────────

/** Count non-empty lines of text output. */
function lineCount(text: string): number {
  return text.split("\n").filter((l) => l.trim().length > 0).length;
}

/**
 * Convert an absolute path to one relative to ctx.cwd.
 * Returns the original value unchanged if it's already relative or if ctx is unavailable.
 */
function toRelativePath(value: string, ctx: ExtensionContext): string {
  if (isAbsolute(value)) {
    return relative(ctx.cwd, value);
  }
  return value;
}

// ── codegraph_explore ───────────────────────────────────────────────

export function registerExploreTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "codegraph_explore",
    label: "CodeGraph Explore",
    description:
      "Semantically explore code: find relevant symbols, their source code grouped by file, call paths between them, and blast-radius impact summary. Covers dynamic dispatch (callbacks, interface→impl, React re-render) that grep cannot follow. Name a file or symbol in the query to read its source with line numbers.",
    promptSnippet:
      "Explore code structure, flows, and relationships with one call — returns relevant symbols, source, and call paths.",
    promptGuidelines: [
      "Use codegraph_explore to understand how a feature or flow works instead of crawling files with grep/read/ls.",
      "Use codegraph_explore to survey a module or area before making changes.",
      "Prefer codegraph_explore when you need to trace a call path (who calls X, what X calls).",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural-language or keyword query describing what to explore" }),
      path: pathParam,
      maxFiles: Type.Optional(
        Type.Number({ description: "Maximum number of files to include source from", default: 5 }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const args = ["explore", ...params.query.trim().split(/\s+/)];
      if (params.path) args.push("--path", toRelativePath(params.path, ctx));
      if (params.maxFiles != null) args.push("--max-files", String(params.maxFiles));

      const { stdout, stderr, code } = await execCodegraph(pi, args);
      return {
        content: [{ type: "text", text: code === 0 ? stdout : `codegraph explore failed (exit ${code}):\n${stderr}` }],
        details: { code, args },
      };
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("⌕ explore "));
      text += theme.fg("accent", `"${args.query}"`);
      if (args.path) text += theme.fg("dim", ` path=${args.path}`);
      if (args.maxFiles != null) text += theme.fg("dim", ` maxFiles=${args.maxFiles}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const content = result.content[0];
      const output = content?.type === "text" ? content.text : "";
      const code = (result.details as { code?: number } | undefined)?.code;
      const isError = code != null && code !== 0;

      if (isError) {
        return new Text(theme.fg("error", output.split("\n")[0] || "Error"), 0, 0);
      }

      let text = theme.fg("success", `${lineCount(output)} lines`);

      if (expanded) {
        const displayLines = output.split("\n").slice(0, 50);
        for (const line of displayLines) {
          text += `\n${theme.fg("dim", line)}`;
        }
        if (output.split("\n").length > 50) {
          text += `\n${theme.fg("muted", `... ${output.split("\n").length - 50} more lines`)}`;
        }
      }

      return new Text(text, 0, 0);
    },
  });
}

// ── codegraph_node ──────────────────────────────────────────────────

export function registerNodeTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "codegraph_node",
    label: "CodeGraph Node",
    description:
      "Inspect a symbol's full source with callers and callees, or read a file with line numbers and an overview of symbols it declares. Use --file mode to read a specific file; use --symbols-only to get just the symbol index without file content.",
    promptSnippet:
      "Read a file (with line numbers) or inspect a symbol’s source and its call relationships.",
    promptGuidelines: [
      "Use codegraph_node to read a file with line numbers as an alternative to the read tool.",
      "Use codegraph_node to inspect a specific symbol and see its callers/callees at a glance.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Symbol name to look up (omit for file mode)" })),
      file: Type.Optional(Type.String({ description: "File path to read — must be relative to the project root, not absolute (activates file mode)" })),
      path: pathParam,
      offset: Type.Optional(
        Type.Number({ description: "File mode: 1-based start line" }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "File mode: maximum lines to return" }),
      ),
      symbolsOnly: Type.Optional(
        Type.Boolean({ description: "File mode: return only the symbol map + dependents, no file content", default: false }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const args: string[] = ["node"];
      if (params.name) args.push(params.name);
      if (params.file) args.push("--file", toRelativePath(params.file, ctx));
      if (params.path) args.push("--path", toRelativePath(params.path, ctx));
      if (params.offset != null) args.push("--offset", String(params.offset));
      if (params.limit != null) args.push("--limit", String(params.limit));
      if (params.symbolsOnly) args.push("--symbols-only");

      const { stdout, stderr, code } = await execCodegraph(pi, args);
      return {
        content: [{ type: "text", text: code === 0 ? stdout : `codegraph node failed (exit ${code}):\n${stderr}` }],
        details: { code, args },
      };
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("● node "));
      if (args.name) {
        text += theme.fg("accent", args.name);
      } else if (args.file) {
        text += theme.fg("accent", args.file);
      }
      if (args.path) text += theme.fg("dim", ` path=${args.path}`);
      if (args.offset != null) text += theme.fg("dim", ` offset=${args.offset}`);
      if (args.limit != null) text += theme.fg("dim", ` limit=${args.limit}`);
      if (args.symbolsOnly) text += theme.fg("dim", " symbolsOnly");
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const content = result.content[0];
      const output = content?.type === "text" ? content.text : "";
      const code = (result.details as { code?: number } | undefined)?.code;
      const isError = code != null && code !== 0;

      if (isError) {
        return new Text(theme.fg("error", output.split("\n")[0] || "Error"), 0, 0);
      }

      let text = theme.fg("success", `${lineCount(output)} lines`);

      if (expanded) {
        const displayLines = output.split("\n").slice(0, 50);
        for (const line of displayLines) {
          text += `\n${theme.fg("dim", line)}`;
        }
        if (output.split("\n").length > 50) {
          text += `\n${theme.fg("muted", `... ${output.split("\n").length - 50} more lines`)}`;
        }
      }

      return new Text(text, 0, 0);
    },
  });
}

// ── codegraph_search ────────────────────────────────────────────────

export function registerSearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "codegraph_search",
    label: "CodeGraph Search",
    description:
      "Search for symbols by name across the entire codebase using FTS5 full-text search. Returns symbols ranked by relevance.",
    promptSnippet:
      "Quickly find symbols (functions, classes, methods, types) by name across the codebase.",
    promptGuidelines: [
      "Use codegraph_search to find where a function/class/type is defined or referenced by name.",
      "Use codegraph_search before codegraph_explore when you know the symbol name but not its location.",
      "Prefer codegraph_search over grep for finding code definitions — it understands symbols, not raw text.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Symbol name or partial name to search for" }),
      path: pathParam,
      limit: Type.Optional(
        Type.Number({ description: "Maximum number of results", default: 10 }),
      ),
      kind: Type.Optional(
        Type.String({ description: "Filter by node kind (e.g., function, class, method, interface)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const args = ["query", params.query];
      if (params.path) args.push("--path", toRelativePath(params.path, ctx));
      if (params.limit != null) args.push("--limit", String(params.limit));
      if (params.kind) args.push("--kind", params.kind);

      const { stdout, stderr, code } = await execCodegraph(pi, args);
      return {
        content: [{ type: "text", text: code === 0 ? stdout : `codegraph search failed (exit ${code}):\n${stderr}` }],
        details: { code, args },
      };
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("⌖ search "));
      text += theme.fg("accent", `"${args.query}"`);
      if (args.path) text += theme.fg("dim", ` path=${args.path}`);
      if (args.limit != null) text += theme.fg("dim", ` limit=${args.limit}`);
      if (args.kind) text += theme.fg("dim", ` kind=${args.kind}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const content = result.content[0];
      const output = content?.type === "text" ? content.text : "";
      const code = (result.details as { code?: number } | undefined)?.code;
      const isError = code != null && code !== 0;

      if (isError) {
        return new Text(theme.fg("error", output.split("\n")[0] || "Error"), 0, 0);
      }

      let text = theme.fg("success", `${lineCount(output)} lines`);

      if (expanded) {
        const displayLines = output.split("\n").slice(0, 50);
        for (const line of displayLines) {
          text += `\n${theme.fg("dim", line)}`;
        }
        if (output.split("\n").length > 50) {
          text += `\n${theme.fg("muted", `... ${output.split("\n").length - 50} more lines`)}`;
        }
      }

      return new Text(text, 0, 0);
    },
  });
}

/** Shorthand to register all three codegraph tools. */
export function registerAllTools(pi: ExtensionAPI): void {
  registerExploreTool(pi);
  registerNodeTool(pi);
  registerSearchTool(pi);
}

/** Tool names that this extension manages. */
export const MANAGED_TOOL_NAMES = new Set([
  "codegraph_explore",
  "codegraph_node",
  "codegraph_search",
]);
