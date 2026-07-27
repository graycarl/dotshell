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
      "PRIMARY CODE TOOL — call FIRST for almost any question or before an edit: how does X work, architecture, a bug, where/what is X, or the symbols you are about to change. Returns the verbatim source of the relevant symbols grouped by file in ONE capped call (Read-equivalent — treat the shown source as already Read; do NOT re-open those files), plus call paths and impact summary. Covers dynamic dispatch (callbacks, interface→impl, React re-render) that grep cannot follow. Usually the ONLY call you need — more accurate context, in far fewer tokens and round-trips than a search/Read/grep loop.",
    promptSnippet:
      "Explore code structure, flows, and relationships with one call — returns relevant symbols, source, and call paths.",
    promptGuidelines: [
      "Use codegraph_explore FIRST for any code question — it usually answers the whole question in one call.",
      "Use codegraph_explore before making edits to see what calls the target symbol and what your change would break.",
      "Prefer codegraph_explore over codegraph_search + read loop — one explore call replaces many search/read round-trips.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Symbol names, file names, or short code terms to explore (e.g., 'AuthService loginUser session-manager', 'GraphTraverser BFS impact traversal.ts'). For a flow question, name the symbols spanning the flow (e.g., 'mutateElement renderScene'). A natural-language question works too — no prior codegraph_search needed.",
      }),
      path: pathParam,
      maxFiles: Type.Optional(
        Type.Number({ description: "Maximum number of files to include source from (default: 12)", default: 12 }),
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
      "Two modes. (1) READ A FILE — use INSTEAD of the Read tool: pass `file` (a path or basename) with no `symbol` and it returns that file's current on-disk source with line numbers, exactly the shape Read gives you, narrowable with `offset`/`limit` just like Read — PLUS a one-line note of which files depend on it. Same bytes as Read, faster (served from the index), with the blast radius attached. (2) ONE SYMBOL — its location, signature, source (set `includeCode: true`) and caller/callee trail in one call. For an AMBIGUOUS name it returns EVERY matching definition in one call; pass `file`/`line` to pin one. Use codegraph_explore for several related symbols or the full flow.",
    promptSnippet:
      "Read a file (like the Read tool, but faster) or inspect a symbol and its callers/callees.",
    promptGuidelines: [
      "Use codegraph_node to read a file with line numbers instead of the read tool — faster and includes dependency info.",
      "Use codegraph_node on a specific symbol before editing it to see its callers and callees.",
      "Set `includeCode: true` only when you need the full source body — omit it for a lightweight overview first.",
    ],
    parameters: Type.Object({
      symbol: Type.Optional(Type.String({ description: "Symbol name to look up (symbol mode). Omit it and pass `file` alone to read a whole file like Read." })),
      includeCode: Type.Optional(
        Type.Boolean({ description: "Symbol mode: include the symbol's full body source. Omit or set false for a lightweight overview (location + signature + trail only).", default: false }),
      ),
      file: Type.Optional(Type.String({ description: "A file path or basename (e.g., 'harness.rs', 'src/auth/session.ts'). Pass it ALONE (no symbol) to READ the file like the Read tool. Or pass it WITH a symbol to disambiguate an overloaded name to the definition in this file." })),
      path: pathParam,
      offset: Type.Optional(
        Type.Number({ description: "File mode: 1-based line to start reading from, exactly like Read's offset." }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "File mode: maximum number of lines to return, exactly like Read's limit." }),
      ),
      symbolsOnly: Type.Optional(
        Type.Boolean({ description: "File mode: return only the symbol map + dependents (a cheap structural overview) instead of the file's source.", default: false }),
      ),
      line: Type.Optional(
        Type.Number({ description: "Symbol mode only: disambiguate to the definition at/around this line (use with the file:line a trail showed you)." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const args: string[] = ["node"];
      // Note: includeCode and line are MCP-level features — the CLI always
      // returns full output and doesn't expose these as flags. Keep them in
      // the schema for future compatibility but don't pass to CLI.
      if (params.symbol) args.push(params.symbol);
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
      if (args.symbol) {
        text += theme.fg("accent", args.symbol);
        if (args.includeCode) text += theme.fg("dim", " +code");
      } else if (args.file) {
        text += theme.fg("accent", args.file);
      }
      if (args.path) text += theme.fg("dim", ` path=${args.path}`);
      if (args.offset != null) text += theme.fg("dim", ` offset=${args.offset}`);
      if (args.limit != null) text += theme.fg("dim", ` limit=${args.limit}`);
      if (args.symbolsOnly) text += theme.fg("dim", " symbolsOnly");
      if (args.line != null) text += theme.fg("dim", ` line=${args.line}`);
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
      "Quick symbol search by name. Returns locations only (no code). Use codegraph_explore instead to get the actual source / understand an area in one call.",
    promptSnippet:
      "Find symbol locations by name — returns file:line, not source. Use codegraph_explore for the actual code.",
    promptGuidelines: [
      "Use codegraph_search to find where a symbol is defined when you only need its location, not its source.",
      "Prefer codegraph_explore over codegraph_search when you need to understand code — explore returns source in one call.",
      "Use codegraph_search as a quick lookup when you know the exact symbol name and just need file:line.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Symbol name or partial name (e.g., 'auth', 'signIn', 'UserService')" }),
      path: pathParam,
      limit: Type.Optional(
        Type.Number({ description: "Maximum number of results (default: 10)", default: 10 }),
      ),
      kind: Type.Optional(
        Type.String({
          description: "Filter by node kind",
          enum: ["function", "method", "class", "interface", "type", "variable", "route", "component"],
        }),
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
