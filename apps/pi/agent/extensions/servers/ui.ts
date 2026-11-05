/**
 * Servers Extension — Terminal UI
 *
 *  - ServersOverlay: the /servers overlay (list view + per-server log view)
 *  - promptShutdownServers: the quit-time dialog (stop all / keep all / pick)
 *  - updateStatusWidget: footer "⚙ N servers" indicator via ctx.ui.setStatus
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { ServerManager, ServerSummary } from "./manager.js";

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

// ── Footer status widget ────────────────────────────────────────────

export function updateStatusWidget(ctx: ExtensionContext, manager: ServerManager): void {
  if (ctx.mode !== "tui") return;
  const n = manager.list().filter((s) => s.state === "running").length;
  ctx.ui.setStatus("servers", n > 0 ? `⚙ ${n} server${n > 1 ? "s" : ""}` : undefined);
}

// ── Quit-time prompt ────────────────────────────────────────────────

const STOP_ALL = "Stop all (default)";
const KEEP_ALL = "Keep all running";
const PICK = "Choose individually";

/**
 * Ask the user what to do with still-running servers.
 * Returns the set of server names to stop. Defaults to stopping everything
 * (including when the dialog is dismissed with Esc).
 */
export async function promptShutdownServers(ctx: ExtensionContext, running: ServerSummary[]): Promise<Set<string>> {
  const all = new Set(running.map((s) => s.name));
  if (running.length === 0) return new Set();

  const listText = running
    .map((s) => `  ${s.name} (pid ${s.pid}, up ${s.uptimeMs != null ? formatUptime(s.uptimeMs) : "?"}) — ${s.command}`)
    .join("\n");
  const choice = await ctx.ui.select(
    `${running.length} server(s) still running:\n${listText}`,
    [STOP_ALL, KEEP_ALL, PICK],
  );

  if (choice === KEEP_ALL) return new Set();
  if (choice === PICK) {
    const stop = new Set<string>();
    for (const s of running) {
      if (await ctx.ui.confirm(`Stop server "${s.name}"?`, s.command)) stop.add(s.name);
    }
    return stop;
  }
  return all; // STOP_ALL or dismissed
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

  constructor(
    private manager: ServerManager,
    private theme: Theme,
    private requestRender: () => void,
    private close: () => void,
  ) {
    this.refresh();
  }

  private refresh(): void {
    const summaries = this.manager.list();
    this.rows = summaries.map((summary) => ({ summary, lastLog: this.manager.lastLogLine(summary.name) }));
    if (this.selected >= this.rows.length) this.selected = Math.max(0, this.rows.length - 1);
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
    const { text } = this.manager.tailLog(row.summary.name, 500);
    this.logName = row.summary.name;
    this.logLines = text.split("\n");
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
