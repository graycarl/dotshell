/**
 * CodeGraph Extension — Utilities
 *
 * Shared helpers for codegraph tool execution and status checks.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { accessSync } from "node:fs";
import { join } from "node:path";

/** Check whether the `codegraph` CLI is installed and runnable. */
export async function isCodegraphInstalled(pi: ExtensionAPI): Promise<boolean> {
  try {
    const result = await pi.exec("codegraph", ["version"], { timeout: 10_000 });
    return result.code === 0 && result.stdout.length > 0;
  } catch {
    return false;
  }
}

/** Check whether codegraph has been initialized for the given project dir. */
export function isProjectInitialized(cwd: string): boolean {
  try {
    accessSync(join(cwd, ".codegraph"));
    return true;
  } catch {
    return false;
  }
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
): Promise<CodegraphResult> {
  return pi
    .exec("codegraph", args, { timeout: 60_000 })
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
