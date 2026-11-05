/**
 * Servers Extension — Terminal UI
 *
 *  - ServersOverlay: the /servers overlay (list view + per-server log view)
 *  - promptShutdownServers: quit-time prompt over raw stdio
 *  - updateStatusWidget: footer "⚙ N servers" indicator via ctx.ui.setStatus
 *
 * Why raw stdio for the quit prompt: pi stops the TUI BEFORE emitting
 * session_shutdown on interactive quit (Ctrl+D / Ctrl+C / /quit), so
 * ctx.ui dialogs opened from a session_shutdown handler never render and
 * hang the shutdown forever. After the TUI stops, stdin is back in cooked
 * mode and a plain readline prompt works. When stdin is not usable
 * (signal-triggered quit, print/json/RPC modes), we cannot ask — the
 * caller stops everything to avoid silently leaking processes.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import * as readline from "node:readline";
import { formatUptime, type ServerManager, type ServerSummary } from "./manager.js";

// ── Footer status widget ────────────────────────────────────────────

export function updateStatusWidget(ctx: ExtensionContext, manager: ServerManager): void {
  if (ctx.mode !== "tui") return;
  const n = manager.list().filter((s) => s.state === "running").length;
  ctx.ui.setStatus("servers", n > 0 ? `⚙ ${n} server${n > 1 ? "s" : ""}` : undefined);
}

// ── Quit-time prompt (raw stdio — see header comment) ───────────────

const PROMPT_TIMEOUT_MS = 15_000;

/** True when the TUI has stopped and stdin is usable for a plain prompt. */
function canPromptOnStdio(): boolean {
  if (!process.stdin.isTTY) return false;
  // isRaw is set while the TUI owns stdin (signal-triggered shutdown path).
  return !(process.stdin as unknown as { isRaw?: boolean }).isRaw;
}

type Answer = { kind: "answer"; value: string } | { kind: "eof" } | { kind: "timeout" };

function ask(rl: readline.Interface, question: string): Promise<Answer> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (a: Answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.removeListener("close", onClose);
      resolve(a);
    };
    const timer = setTimeout(() => settle({ kind: "timeout" }), PROMPT_TIMEOUT_MS);
    const onClose = () => settle({ kind: "eof" });
    rl.once("close", onClose);
    rl.question(question, (value) => settle({ kind: "answer", value: value.trim().toLowerCase() }));
  });
}

/**
 * Ask the user which still-running servers to stop.
 * Returns the set of server names to stop.
 * Defaults: empty answer / timeout → stop all; EOF (Ctrl+D) → keep all.
 * No usable stdin → stop all (cannot ask; avoid leaking processes).
 */
export async function promptShutdownServers(running: ServerSummary[]): Promise<Set<string>> {
  const all = new Set(running.map((s) => s.name));
  if (running.length === 0) return new Set();
  if (!canPromptOnStdio()) return all;

  const listText = running
    .map((s) => `  ${s.name} (pid ${s.pid}, up ${s.uptimeMs != null ? formatUptime(s.uptimeMs) : "?"}) — ${s.command}`)
    .join("\n");
  process.stdout.write(`\npi servers: ${running.length} server(s) still running:\n${listText}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await ask(rl, `Stop them? [Y/n/pick] (stop all in ${PROMPT_TIMEOUT_MS / 1000}s) `);
    if (answer.kind === "eof") return new Set(); // cancelled — non-destructive
    if (answer.kind === "answer" && (answer.value === "n" || answer.value === "no")) return new Set();
    if (answer.kind === "answer" && (answer.value === "p" || answer.value === "pick")) {
      const stop = new Set<string>();
      for (const s of running) {
        const a = await ask(rl, `  Stop "${s.name}"? [Y/n] `);
        if (a.kind !== "answer") {
          // timeout → count as yes (consistent with the outer default);
          // EOF → cancel the rest, stop what was confirmed so far.
          if (a.kind === "timeout") stop.add(s.name);
          break;
        }
        if (a.value !== "n" && a.value !== "no") stop.add(s.name);
      }
      return stop;
    }
    return all; // "y", empty input, or timeout
  } finally {
    rl.close();
  }
}

// ── /servers overlay ────────────────────────────────────────────────

const LOG_VIEW_LINES = 16;

interface Row {
  summary: ServerSummary;
  lastLog: string;
}

export class ServersOverlay {
  private rows: Row[] = [];
  private selected = 0;
  private view: "list" | "logs" = "list";
  private logName = "";
  private logLines: string[] = [];
  private logOffset = 0;
  private busy = false;
  private unsubscribeChange: () => void;

  constructor(
    private manager: ServerManager,
    private theme: Theme,
    private requestRender: () => void,
    private close: () => void,
  ) {
    this.refresh();
    // Auto-refresh while open: servers can exit / be changed by the agent.
    this.unsubscribeChange = manager.onChange(() => {
      this.refresh();
      if (this.view === "logs") this.reloadLogs();
      this.requestRender();
    });
  }

  dispose(): void {
    this.unsubscribeChange();
  }

  private refresh(): void {
    const summaries = this.manager.list();
    this.rows = summaries.map((summary) => ({ summary, lastLog: this.manager.lastLogLine(summary.name) }));
    if (this.selected >= this.rows.length) this.selected = Math.max(0, this.rows.length - 1);
  }

  private reloadLogs(): void {
    const { text } = this.manager.tailLog(this.logName, 500);
    this.logLines = text.split("\n");
    // Keep the scroll position stable from the bottom.
  }

  handleInput(data: string): void {
    if (this.view === "logs") {
      this.handleLogKeys(data);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
      this.close();
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.selected = (this.selected - 1 + this.rows.length) % Math.max(1, this.rows.length);
    } else if (matchesKey(data, "down") || data === "j") {
      this.selected = (this.selected + 1) % Math.max(1, this.rows.length);
    } else if (data === "l") {
      this.openLogs();
    } else if (data === "d") {
      void this.act("stop");
    } else if (data === "r") {
      void this.act("restart");
    }
    this.requestRender();
  }

  private handleLogKeys(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.view = "list";
      this.refresh();
    } else if (matchesKey(data, "up") || data === "k") {
      this.logOffset = Math.min(Math.max(0, this.logLines.length - LOG_VIEW_LINES), this.logOffset + 1);
    } else if (matchesKey(data, "down") || data === "j") {
      this.logOffset = Math.max(0, this.logOffset - 1);
    } else if (matchesKey(data, "pageUp")) {
      this.logOffset = Math.min(Math.max(0, this.logLines.length - LOG_VIEW_LINES), this.logOffset + LOG_VIEW_LINES);
    } else if (matchesKey(data, "pageDown")) {
      this.logOffset = Math.max(0, this.logOffset - LOG_VIEW_LINES);
    }
    this.requestRender();
  }

  private openLogs(): void {
    const row = this.rows[this.selected];
    if (!row) return;
    this.logName = row.summary.name;
    this.reloadLogs();
    this.logOffset = 0;
    this.view = "logs";
  }

  private async act(action: "stop" | "restart"): Promise<void> {
    const row = this.rows[this.selected];
    if (!row || this.busy) return;
    this.busy = true;
    try {
      if (action === "stop") await this.manager.stop(row.summary.name);
      else await this.manager.restart(row.summary.name);
    } catch {
      /* surfaced in refreshed state */
    }
    this.busy = false;
    this.refresh();
    this.requestRender();
  }

  render(width: number): string[] {
    return this.view === "logs" ? this.renderLogs(width) : this.renderList(width);
  }

  private renderList(width: number): string[] {
    const th = this.theme;
    const lines: string[] = [""];
    lines.push(
      truncateToWidth(
        th.fg("borderMuted", "─".repeat(3)) +
          th.fg("accent", " Servers ") +
          th.fg("borderMuted", "─".repeat(Math.max(0, width - 12))),
        width,
      ),
    );
    lines.push("");

    if (this.rows.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "No servers. Ask the agent to start one (server_start).")}`, width));
    }
    this.rows.forEach((row, i) => {
      const s = row.summary;
      const cursor = i === this.selected ? th.fg("accent", "❯") : " ";
      const state =
        s.state === "running"
          ? th.fg("success", "● running")
          : th.fg("dim", `○ exited${s.exitCode != null ? `(${s.exitCode})` : ""}`);
      const meta =
        s.state === "running"
          ? th.fg("muted", `pid=${s.pid} up=${s.uptimeMs != null ? formatUptime(s.uptimeMs) : "?"}${s.interactive ? "" : " no-stdin"}`)
          : "";
      lines.push(truncateToWidth(` ${cursor} ${th.fg("text", s.name)} ${state} ${meta}`, width));
      lines.push(truncateToWidth(`     ${th.fg("dim", `$ ${s.command}`)}`, width));
      if (row.lastLog) {
        lines.push(truncateToWidth(`     ${th.fg("muted", `│ ${row.lastLog}`)}`, width));
      }
      lines.push("");
    });

    lines.push(
      truncateToWidth(
        `  ${th.fg("dim", "↑/↓ select · l logs · d stop · r restart · Esc close")}${this.busy ? th.fg("warning", "  …working") : ""}`,
        width,
      ),
    );
    lines.push("");
    return lines;
  }

  private renderLogs(width: number): string[] {
    const th = this.theme;
    const lines: string[] = [""];
    lines.push(
      truncateToWidth(
        th.fg("borderMuted", "─".repeat(3)) +
          th.fg("accent", ` Logs: ${this.logName} `) +
          th.fg("borderMuted", "─".repeat(Math.max(0, width - 14 - this.logName.length))),
        width,
      ),
    );
    const end = this.logLines.length - this.logOffset;
    const start = Math.max(0, end - LOG_VIEW_LINES);
    for (const line of this.logLines.slice(start, end)) {
      lines.push(truncateToWidth(`  ${th.fg("dim", line)}`, width));
    }
    lines.push("");
    const scroll = this.logOffset > 0 ? ` (scrolled +${this.logOffset})` : "";
    lines.push(
      truncateToWidth(`  ${th.fg("dim", `↑/↓ PgUp/PgDn scroll${scroll} · Esc back`)}`, width),
    );
    lines.push("");
    return lines;
  }

  invalidate(): void {}
}
