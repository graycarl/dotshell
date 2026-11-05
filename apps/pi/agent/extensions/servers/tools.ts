/**
 * Servers Extension — Tool Definitions
 *
 * Registers five tools under the "server" namespace so the agent can manage
 * long-lived dev servers without blocking the session:
 *   server_start  — spawn a server in the background, return immediately
 *   server_list   — show all servers with state / pid / uptime
 *   server_logs   — read the tail of a server's log file
 *   server_stop   — stop (SIGTERM→SIGKILL), restart, or just send a signal
 *   server_send   — write text to a server's stdin
 *
 * All process mechanics live in manager.ts; this file is schema + rendering.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatUptime, type ServerManager, type ServerSummary } from "./manager.js";

const MAX_LOG_CHARS = 20_000;
const SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM", "SIGKILL", "SIGUSR1", "SIGUSR2"] as const;

const nameParam = Type.String({ description: "Server name (as given to server_start)" });


function summaryLine(s: ServerSummary): string {
  if (s.state === "running") {
    const up = s.uptimeMs != null ? formatUptime(s.uptimeMs) : "?";
    return `${s.name} [running] pid=${s.pid} up=${up}${s.interactive ? "" : " (no stdin)"} — ${s.command}`;
  }
  return `${s.name} [exited${s.exitCode != null ? ` code=${s.exitCode}` : ""}] — ${s.command}`;
}

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function errorResult(text: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: `Error: ${text}` }],
    details: { ...details, error: text },
    isError: true,
  };
}

interface RenderableResult {
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
}

/** Collapsed/expanded rendering for plain-text results (codegraph style). */
function renderTextResult(
  result: RenderableResult,
  options: { expanded: boolean },
  theme: Theme,
  previewLines = 10,
): InstanceType<typeof Text> {
  const error = (result.details as { error?: string } | undefined)?.error;
  if (error) {
    return new Text(theme.fg("error", `Error: ${error}`), 0, 0);
  }
  const content = result.content?.[0];
  const output = (content?.type === "text" ? content.text : "") ?? "";
  const allLines = output.split("\n");
  const linesToShow = options.expanded ? allLines.length : Math.min(previewLines, allLines.length);
  let text = "";
  for (let i = 0; i < linesToShow; i++) {
    text += `\n${theme.fg("dim", allLines[i]!)}`;
  }
  if (allLines.length > linesToShow) {
    text += `\n${theme.fg("muted", `... (${allLines.length - linesToShow} more lines,`)} ${theme.fg("accent", "Ctrl+E")}${theme.fg("muted", " to expand)")}`;
  }
  return new Text(text, 0, 0);
}

const TOOL_NAMESPACE = {
  name: "server",
  description: "Manage long-lived background server processes for the current project (start/list/logs/stop/stdin).",
  instructions:
    "Servers started here keep running after the tool returns. Logs live in .pi/servers/logs/<name>.log. " +
    "server_stop defaults to SIGTERM with SIGKILL escalation; use its restart/signal options for reloads. " +
    "server_send writes to stdin but only for servers started by this pi session.",
} as const;

export function registerAllTools(pi: ExtensionAPI, manager: ServerManager): void {
  // ── server_start ────────────────────────────────────────────────
  pi.registerTool({
    name: "server_start",
    namespace: TOOL_NAMESPACE,
    label: "Server Start",
    description:
      "Start a long-lived server process (e.g. a dev web server) in the background and return immediately. " +
      "Output is appended to .pi/servers/logs/<name>.log; use server_logs to read it and server_list to check state. " +
      "The command runs through the user's shell in the project root (or optional cwd).",
    promptSnippet: "Start a background server process and return immediately.",
    promptGuidelines: [
      "Use server_start for any long-running process (dev servers, watchers) instead of the bash tool — it returns immediately and keeps logs.",
      "After server_start, poll server_logs to confirm the server is ready (e.g. listening port) before interacting with it.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Unique server name (letters, digits, dash, underscore)" }),
      command: Type.String({ description: "Shell command that starts the server (e.g. 'pnpm dev --port 3000')" }),
      cwd: Type.Optional(Type.String({ description: "Working directory relative to project root (default: root)" })),
      env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra environment variables" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const record = manager.start(params.name, params.command, { cwd: params.cwd, env: params.env });
        return textResult(
          `Server "${record.name}" started (pid ${record.pid}).\n` +
            `Log: ${record.logFile}\n` +
            `Use server_logs name="${record.name}" to check output. The server keeps running in the background.`,
          { record },
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("▶ server_start ")) + theme.fg("accent", args.name);
      text += theme.fg("dim", ` $ ${args.command}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, options, theme, _context) {
      return renderTextResult(result, options, theme, 4);
    },
  });

  // ── server_list ─────────────────────────────────────────────────
  pi.registerTool({
    name: "server_list",
    namespace: TOOL_NAMESPACE,
    label: "Server List",
    description:
      "List all servers known to this project (running and recently exited), with pid, uptime, exit code and command. " +
      "'(no stdin)' marks servers started by a previous pi session — they can be stopped but not written to.",
    promptSnippet: "List background servers and their state.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      manager.pruneExited();
      const servers = manager.list();
      if (servers.length === 0) {
        return textResult("No servers. Use server_start to launch one.", { servers: [] });
      }
      return textResult(servers.map(summaryLine).join("\n"), { servers });
    },
    renderCall(_args, theme, _context) {
      return new Text(theme.fg("toolTitle", theme.bold("≡ server_list")), 0, 0);
    },
    renderResult(result, options, theme, _context) {
      return renderTextResult(result, options, theme, 8);
    },
  });

  // ── server_logs ─────────────────────────────────────────────────
  pi.registerTool({
    name: "server_logs",
    namespace: TOOL_NAMESPACE,
    label: "Server Logs",
    description:
      "Read the tail of a server's log file (ANSI colors stripped). " +
      "Large tails are truncated — the full log path is included in the result for the read tool.",
    promptSnippet: "Read the tail of a background server's log.",
    parameters: Type.Object({
      name: nameParam,
      lines: Type.Optional(Type.Number({ description: "Number of trailing lines (default: 100)", default: 100 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const { text, logFile } = manager.tailLog(params.name, params.lines ?? 100);
        const truncated = text.length > MAX_LOG_CHARS ? text.slice(-MAX_LOG_CHARS) : text;
        const note = text.length > MAX_LOG_CHARS ? `(truncated to last ${MAX_LOG_CHARS} chars) ` : "";
        return textResult(`${note}Log file: ${logFile}\n\n${truncated}`, { logFile });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("≡ server_logs ")) + theme.fg("accent", args.name);
      if (args.lines != null) text += theme.fg("dim", ` lines=${args.lines}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, options, theme, _context) {
      return renderTextResult(result, options, theme);
    },
  });

  // ── server_stop ─────────────────────────────────────────────────
  pi.registerTool({
    name: "server_stop",
    namespace: TOOL_NAMESPACE,
    label: "Server Stop",
    description:
      "Stop a server: SIGTERM to its process group, escalating to SIGKILL after 5s. " +
      "With restart=true the server is stopped and started again with its original command. " +
      "With signal set, only that signal is sent (e.g. SIGHUP to reload) and the server keeps running.",
    promptSnippet: "Stop, restart, or signal a background server.",
    parameters: Type.Object({
      name: nameParam,
      restart: Type.Optional(Type.Boolean({ description: "Restart after stopping (default: false)", default: false })),
      signal: Type.Optional(
        Type.String({ description: `Only send this signal without stopping. One of: ${SIGNALS.join(", ")}`, enum: [...SIGNALS] }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        if (params.signal && params.restart) {
          return errorResult("signal and restart are mutually exclusive — pick one.");
        }
        if (params.signal) {
          manager.signal(params.name, params.signal);
          return textResult(`Sent ${params.signal} to "${params.name}" (still running).`);
        }
        if (params.restart) {
          const record = await manager.restart(params.name);
          return textResult(`Server "${record.name}" restarted (pid ${record.pid}).`, { record });
        }
        const record = await manager.stop(params.name);
        return textResult(
          `Server "${record.name}" stopped (exit code=${record.exitCode ?? "?"} signal=${record.exitSignal ?? "none"}).`,
          { record },
        );
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("■ server_stop ")) + theme.fg("accent", args.name);
      if (args.restart) text += theme.fg("dim", " restart");
      if (args.signal) text += theme.fg("dim", ` signal=${args.signal}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, options, theme, _context) {
      return renderTextResult(result, options, theme, 4);
    },
  });

  // ── server_send ─────────────────────────────────────────────────
  pi.registerTool({
    name: "server_send",
    namespace: TOOL_NAMESPACE,
    label: "Server Send",
    description:
      "Write a line of text to a running server's stdin (e.g. answer an interactive prompt). " +
      "Only works for servers started by this pi session; restart a server to regain stdin.",
    promptSnippet: "Write text to a server's stdin.",
    parameters: Type.Object({
      name: nameParam,
      text: Type.String({ description: "Text to write (newline appended automatically)" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        manager.send(params.name, params.text);
        return textResult(`Sent to "${params.name}": ${JSON.stringify(params.text)}`);
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
    renderCall(args, theme, _context) {
      return new Text(
        theme.fg("toolTitle", theme.bold("⌨ server_send ")) +
          theme.fg("accent", args.name) +
          theme.fg("dim", ` ${JSON.stringify(args.text)}`),
        0,
        0,
      );
    },
    renderResult(result, options, theme, _context) {
      return renderTextResult(result, options, theme, 4);
    },
  });
}
