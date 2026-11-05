/**
 * Servers Extension — Process Manager
 *
 * Spawns long-lived server processes as detached children of the pi process,
 * redirects their stdout/stderr to log files under `.pi/servers/logs/`, and
 * persists a registry at `.pi/servers/registry.json` so that:
 *   - other pi sessions on the same project can see the servers, and
 *   - a new pi runtime (after crash / reload / session switch) can re-attach
 *     to still-running processes (stop / logs / signal only — stdin is lost).
 *
 * Kill semantics: processes are spawned with `detached: true`, so each server
 * leads its own process group; stopping targets the whole group (kill -pid)
 * so child processes of dev servers (pnpm/npm/node wrappers) die too.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";

// ── Types ───────────────────────────────────────────────────────────

export interface ServerRecord {
  name: string;
  pid: number;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  /** ISO timestamp of (re)start. */
  startedAt: string;
  /** Absolute path to the log file. */
  logFile: string;
  state: "running" | "exited";
  exitCode?: number | null;
  exitSignal?: string | null;
  exitedAt?: string;
}

export interface ManagedServer {
  record: ServerRecord;
  /** Present only when this pi runtime spawned the process. */
  child?: ChildProcess;
}

export interface ServerSummary {
  name: string;
  state: "running" | "exited";
  pid: number;
  command: string;
  cwd: string;
  uptimeMs?: number;
  exitCode?: number | null;
  /** True when stdin / direct control is available (spawned by this runtime). */
  interactive: boolean;
}

interface RegistryFile {
  servers: Record<string, ServerRecord>;
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const STOP_TIMEOUT_MS = 5000;
const TAIL_READ_BYTES = 256 * 1024;
// Matches CSI sequences and other common ANSI escapes from dev-server output.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /(?:\[[0-9;?]*[ -/]*[@-~]|\][^]*(?:|\\)|[@-Z\\-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Manager ─────────────────────────────────────────────────────────

export class ServerManager {
  private rootDir = "";
  private serversDir = "";
  private logsDir = "";
  private registryPath = "";
  private servers = new Map<string, ManagedServer>();
  private changeListeners = new Set<() => void>();

  /** (Re)initialise for a project root. Called on every session_start. */
  init(rootDir: string): void {
    this.rootDir = rootDir;
    this.serversDir = path.join(rootDir, ".pi", "servers");
    this.logsDir = path.join(this.serversDir, "logs");
    this.registryPath = path.join(this.serversDir, "registry.json");
    this.servers.clear();
    this.loadFromDisk();
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private emitChange(): void {
    for (const fn of this.changeListeners) fn();
  }

  // ── Registry persistence ────────────────────────────────────────

  private loadFromDisk(): void {
    if (!existsSync(this.registryPath)) return;
    let data: RegistryFile;
    try {
      data = JSON.parse(readFileSync(this.registryPath, "utf8")) as RegistryFile;
    } catch {
      return; // corrupt registry — start empty rather than crash the session
    }
    for (const record of Object.values(data.servers ?? {})) {
      if (record.state === "running" && !pidAlive(record.pid)) {
        record.state = "exited";
        record.exitedAt = record.exitedAt ?? new Date().toISOString();
      }
      this.servers.set(record.name, { record });
    }
    this.persist();
  }

  private persist(): void {
    if (!this.registryPath) return;
    mkdirSync(this.serversDir, { recursive: true });
    const data: RegistryFile = {
      servers: Object.fromEntries([...this.servers.entries()].map(([name, s]) => [name, s.record])),
    };
    const tmp = `${this.registryPath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.registryPath);
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  start(name: string, command: string, opts: { cwd?: string; env?: Record<string, string> } = {}): ServerRecord {
    if (!NAME_RE.test(name)) {
      throw new Error(`Invalid server name "${name}" — use letters, digits, dash, underscore.`);
    }
    const existing = this.servers.get(name);
    if (existing && existing.record.state === "running") {
      throw new Error(`Server "${name}" is already running (pid ${existing.record.pid}). Stop or restart it first.`);
    }

    mkdirSync(this.logsDir, { recursive: true });
    const logFile = path.join(this.logsDir, `${name}.log`);
    const cwd = opts.cwd ? path.resolve(this.rootDir, opts.cwd) : this.rootDir;

    const fd = openSync(logFile, "a");
    const banner = `\n─── pi servers: start ${new Date().toISOString()} | cwd=${cwd} | $ ${command} ───\n`;
    writeFileSync(fd, banner);

    const child = spawn(process.env.SHELL || "/bin/sh", ["-c", command], {
      cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      detached: true,
      stdio: ["pipe", fd, fd],
    });
    closeSync(fd); // child holds its own dup of the fd

    // Don't let the child handle keep pi's event loop alive.
    child.unref();
    (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();

    const record: ServerRecord = {
      name,
      pid: child.pid!,
      command,
      cwd,
      env: opts.env,
      startedAt: new Date().toISOString(),
      logFile,
      state: "running",
    };
    const managed: ManagedServer = { record, child };
    this.servers.set(name, managed);

    child.on("exit", (code, signal) => {
      record.state = "exited";
      record.exitCode = code;
      record.exitSignal = signal;
      record.exitedAt = new Date().toISOString();
      try {
        const lfd = openSync(logFile, "a");
        writeFileSync(lfd, `─── pi servers: exit code=${code} signal=${signal} ───\n`);
        closeSync(lfd);
      } catch {
        /* log file gone — ignore */
      }
      this.persist();
      this.emitChange();
    });

    this.persist();
    this.emitChange();
    return record;
  }

  /** Stop a server. Defaults to SIGTERM, escalating to SIGKILL after a timeout. */
  async stop(name: string, opts: { signal?: string; timeoutMs?: number } = {}): Promise<ServerRecord> {
    const managed = this.mustGet(name);
    const { record } = managed;
    if (record.state !== "running") return record;

    const signal = opts.signal ?? "SIGTERM";
    const timeoutMs = opts.timeoutMs ?? STOP_TIMEOUT_MS;

    this.killGroup(record.pid, signal);

    const deadline = Date.now() + timeoutMs;
    if (managed.child) {
      await Promise.race([this.waitForExit(managed.child), sleep(timeoutMs)]);
    }
    // Poll for recovered processes (no child handle) or after timeout race.
    while (record.state === "running" && pidAlive(record.pid) && Date.now() < deadline) {
      await sleep(100);
    }
    if (record.state === "running" && pidAlive(record.pid)) {
      this.killGroup(record.pid, "SIGKILL");
      const killDeadline = Date.now() + 2000;
      while (pidAlive(record.pid) && Date.now() < killDeadline) {
        await sleep(50);
      }
    }
    if (record.state === "running") {
      // No child handle fired (recovered process) — mark manually.
      record.state = "exited";
      record.exitSignal = record.exitSignal ?? signal;
      record.exitedAt = new Date().toISOString();
    }
    this.persist();
    this.emitChange();
    return record;
  }

  /** Restart with the originally recorded command/cwd/env, appending to the same log. */
  async restart(name: string): Promise<ServerRecord> {
    const managed = this.mustGet(name);
    const { command, cwd, env } = managed.record;
    if (managed.record.state === "running") {
      await this.stop(name);
    }
    return this.start(name, command, {
      cwd: path.relative(this.rootDir, cwd) || undefined,
      env,
    });
  }

  /** Send a signal without stopping (e.g. SIGHUP for reload). */
  signal(name: string, signal: string): void {
    const managed = this.mustGet(name);
    if (managed.record.state !== "running") {
      throw new Error(`Server "${name}" is not running.`);
    }
    this.killGroup(managed.record.pid, signal);
  }

  /** Write text to the server's stdin (newline appended if missing). */
  send(name: string, text: string): void {
    const managed = this.mustGet(name);
    if (managed.record.state !== "running") {
      throw new Error(`Server "${name}" is not running.`);
    }
    const stdin = managed.child?.stdin;
    if (!stdin || stdin.destroyed) {
      throw new Error(
        `stdin of "${name}" is unavailable (process was not started by this pi session). ` +
          `Use server_stop with restart=true to regain stdin control.`,
      );
    }
    stdin.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  // ── Inspection ──────────────────────────────────────────────────

  list(): ServerSummary[] {
    // Reconcile state for recovered processes (no exit event without a handle).
    for (const { record } of this.servers.values()) {
      if (record.state === "running" && !pidAlive(record.pid)) {
        record.state = "exited";
        record.exitedAt = record.exitedAt ?? new Date().toISOString();
      }
    }
    return [...this.servers.values()].map(({ record, child }) => ({
      name: record.name,
      state: record.state,
      pid: record.pid,
      command: record.command,
      cwd: record.cwd,
      uptimeMs: record.state === "running" ? Date.now() - new Date(record.startedAt).getTime() : undefined,
      exitCode: record.exitCode,
      interactive: !!child && record.state === "running",
    }));
  }

  get(name: string): ManagedServer | undefined {
    return this.servers.get(name);
  }

  running(): ManagedServer[] {
    return this.list()
      .filter((s) => s.state === "running")
      .map((s) => this.servers.get(s.name)!);
  }

  /** Remove exited entries older than the given count, keeping the newest. */
  pruneExited(keep = 5): void {
    const exited = [...this.servers.values()].filter((s) => s.record.state === "exited");
    if (exited.length <= keep) return;
    exited.sort((a, b) => (a.record.exitedAt ?? "").localeCompare(b.record.exitedAt ?? ""));
    for (const s of exited.slice(0, exited.length - keep)) {
      this.servers.delete(s.record.name);
    }
    this.persist();
  }

  /** Read the last `lines` lines of a server's log, ANSI codes stripped. */
  tailLog(name: string, lines = 100): { text: string; logFile: string; totalLines: number } {
    const managed = this.mustGet(name);
    const { logFile } = managed.record;
    if (!existsSync(logFile)) {
      return { text: "(log file missing)", logFile, totalLines: 0 };
    }
    const size = statSync(logFile).size;
    const readLen = Math.min(size, TAIL_READ_BYTES);
    const fd = openSync(logFile, "r");
    try {
      const buf = Buffer.alloc(readLen);
      readSync(fd, buf, 0, readLen, size - readLen);
      const all = stripAnsi(buf.toString("utf8")).split("\n");
      const tail = all.slice(-lines);
      return { text: tail.join("\n"), logFile, totalLines: all.length };
    } finally {
      closeSync(fd);
    }
  }

  /** Last non-empty log line, for compact display in the /servers overlay. */
  lastLogLine(name: string): string {
    try {
      const { text } = this.tailLog(name, 50);
      const lines = text.split("\n").filter((l) => l.trim().length > 0 && !l.startsWith("─── pi servers:"));
      return lines.at(-1)?.trim() ?? "";
    } catch {
      return "";
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private mustGet(name: string): ManagedServer {
    const managed = this.servers.get(name);
    if (!managed) {
      const known = [...this.servers.keys()].join(", ") || "(none)";
      throw new Error(`Unknown server "${name}". Known servers: ${known}`);
    }
    return managed;
  }

  /** Kill the process group led by the server (detached spawn ⇒ pgid === pid). */
  private killGroup(pid: number, signal: string): void {
    try {
      process.kill(-pid, signal as NodeJS.Signals);
    } catch {
      try {
        process.kill(pid, signal as NodeJS.Signals);
      } catch {
        /* already dead */
      }
    }
  }

  private waitForExit(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
    });
  }
}
