/**
 * CodeGraph Extension — Utilities
 *
 * Shared helpers for codegraph tool execution and status checks.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Check whether the `codegraph` CLI is installed and runnable. */
export async function isCodegraphInstalled(pi: ExtensionAPI): Promise<boolean> {
  try {
    const result = await pi.exec("codegraph", ["version"], { timeout: 10_000 });
    return result.code === 0 && result.stdout.length > 0;
  } catch {
    return false;
  }
}

/**
 * Name of the index directory inside a project root. The CLI honours a
 * single-segment `CODEGRAPH_DIR` override (e.g. `.codegraph-wsl` on WSL) and
 * ignores anything that isn't a plain name, so this does the same.
 */
function indexDirName(): string {
  const name = (process.env.CODEGRAPH_DIR ?? "").trim();
  const plainName = name !== "" && name !== "." && name !== ".." && !/[/\\]/.test(name);
  return plainName ? name : ".codegraph";
}

/**
 * Nearest directory at or above `startDir` that holds an index — the same root
 * resolution the CLI does, so a query run from a subdirectory (or with a file
 * path as the hint) syncs the right project.
 */
export function findCodeGraphRoot(startDir: string): string | null {
  const indexDir = indexDirName();
  let current = resolve(startDir);
  for (;;) {
    try {
      if (statSync(join(current, indexDir)).isDirectory()) return current;
    } catch {
      /* not here — keep walking up */
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ── Pre-query catch-up sync ─────────────────────────────────────────

/** Minimum interval between two catch-up syncs per project. */
const DEFAULT_SYNC_TTL_MS = 10_000;
/** How long a tool call waits for the sync before serving the current index. */
const SYNC_WAIT_MS = 3_000;
/** `codegraph sync` is incremental but still walks the tree; cap it. */
const SYNC_TIMEOUT_MS = 60_000;
/** Ceiling for the retry backoff after a failed sync. */
const FAILURE_BACKOFF_MAX_MS = 300_000;

interface SyncState {
  /** Wall-clock ms of the last sync attempt (success or failure). */
  lastAttemptMs: number;
  /** Retry backoff after failures; 0 once a sync succeeds. */
  retryDelayMs: number;
  /** When the in-flight run stops blocking queries. */
  waitUntilMs: number;
  /** In-flight sync shared by concurrent callers. */
  inFlight: Promise<void> | null;
}

const syncStates = new Map<string, SyncState>();

/** `CODEGRAPH_PI_SYNC_TTL_MS=0` disables auto-sync entirely. */
function syncTtlMs(): number {
  const raw = process.env.CODEGRAPH_PI_SYNC_TTL_MS;
  if (raw == null || raw.trim() === "") return DEFAULT_SYNC_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SYNC_TTL_MS;
  return n;
}

/**
 * Reconcile the index with the working tree before a query — the CLI
 * equivalent of the MCP server's connect-time catch-up
 * (`MCPEngine.catchUpSync`). One-shot `codegraph explore|node|query` processes
 * never start the file watcher, so without this the index only changes when
 * somebody runs `codegraph sync` by hand.
 *
 * Deliberately conservative:
 *  - at most one sync per `ttl` per project (default 10s);
 *  - concurrent callers share the in-flight run, and wait only for what is
 *    left of its {@link SYNC_WAIT_MS} budget — a slow sync costs each query at
 *    most 3s in total, not 3s per query;
 *  - after a failed sync the next attempt backs off (up to 5min);
 *  - never throws: a locked/failing index must not break the tool call.
 *    A live MCP daemon holding the writer lock is the normal case here — its
 *    watcher already keeps that project fresh.
 */
export async function ensureIndexFresh(pi: ExtensionAPI, projectRoot: string): Promise<void> {
  const ttl = syncTtlMs();
  if (ttl === 0) return;

  const key = resolve(projectRoot);
  const state = syncStates.get(key) ?? {
    lastAttemptMs: 0,
    retryDelayMs: 0,
    waitUntilMs: 0,
    inFlight: null,
  };
  syncStates.set(key, state);

  const now = Date.now();
  if (state.inFlight) return waitAtMost(state.inFlight, state.waitUntilMs - now);
  if (now - state.lastAttemptMs < Math.max(ttl, state.retryDelayMs)) return;

  // Stamp before running so a failing/locked index isn't retried on every call.
  state.lastAttemptMs = now;
  state.waitUntilMs = now + SYNC_WAIT_MS;
  state.inFlight = (async () => {
    // `execCodegraph` reports failure via `code`, it never rejects. A failing
    // sync (typically a live MCP daemon holding the writer lock) backs off
    // exponentially so a doomed process isn't spawned on every query.
    const { code } = await execCodegraph(pi, ["sync", key], SYNC_TIMEOUT_MS);
    state.retryDelayMs =
      code === 0 ? 0 : Math.min(state.retryDelayMs ? state.retryDelayMs * 2 : ttl * 2, FAILURE_BACKOFF_MAX_MS);
  })().finally(() => {
    state.inFlight = null;
  });

  return waitAtMost(state.inFlight, SYNC_WAIT_MS);
}

/** Resolve after `p` settles or `ms` elapses, whichever comes first. */
function waitAtMost(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((done) => {
    const timer = setTimeout(done, Math.max(0, ms));
    const finish = () => {
      clearTimeout(timer);
      done();
    };
    p.then(finish, finish);
  });
}

/** Result from invoking codegraph CLI. */
export interface CodegraphResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Execute a codegraph CLI command and return stdout / stderr. */
export function execCodegraph(
  pi: ExtensionAPI,
  args: string[],
  timeoutMs = 60_000,
): Promise<CodegraphResult> {
  return pi
    .exec("codegraph", args, { timeout: timeoutMs })
    .then((r) => ({
      stdout: r.stdout?.trim() || "",
      stderr: r.stderr?.trim() || "",
      code: r.code,
    }))
    .catch((err) => ({
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      code: -1,
    }));
}
