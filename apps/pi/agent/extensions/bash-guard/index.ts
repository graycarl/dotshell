/**
 * Bash Guard - injects a default timeout into bash tool calls.
 *
 * Pi's bash tool has no default timeout (`timeout` is optional and the tool then
 * waits forever). A hung command - a dev server started in the foreground, a
 * network call to an unreachable host, a device tool like `hdc tconn` - blocks
 * the turn until the user presses Esc, and in print/JSON/RPC mode nothing can.
 *
 * This extension fills in `timeout` on the `tool_call` event when the model did
 * not set one. It registers no tool, so it cannot collide with another extension
 * that replaces the `bash` tool: extension tools silently overwrite built-ins by
 * name, so a second `registerTool("bash")` would be a load-order coin flip.
 * Nested calls (a codemode script calling `tools.bash`) go through the same
 * event, so they are covered as well.
 *
 * Escape hatches:
 * - An explicit `timeout` from the model is never touched.
 * - A command containing a `# pi:no-timeout` comment is left untouched, for work
 *   that legitimately runs longer than the heavy ceiling.
 *
 * Limits: this only caps wall-clock time. It cannot notice a quiet hang (an
 * idle child holding the output pipe open) and it does not apply to `!` commands,
 * which go through AgentSession.executeBash and support no timeout at all.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Default ceiling for an ordinary command. */
const DEFAULT_TIMEOUT_S = 120;

/** Ceiling for work that is expected to take minutes (installs, builds, tests). */
const HEAVY_TIMEOUT_S = 600;

/** Opt-out marker: a command containing this comment runs without an injected timeout. */
const NO_TIMEOUT_MARKER = /^\s*#\s*pi:no-timeout\b/m;

/** Command shapes that are routinely slow, so they get the larger ceiling. */
const HEAVY_PATTERNS: RegExp[] = [
  // Package managers and installers
  /\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci|link|update|upgrade)\b/,
  /\b(pip|pip3|conda|poetry|composer|bundle|gem)\s+(install|add|update|sync)\b/,
  /\buv\s+(sync|add|pip|venv|lock)\b/,
  /\b(brew|apt-get|apt|dnf|yum|pacman|apk)\b/,
  // Tool runners that fetch or compile on demand
  /\b(npx|uvx|pnpx|bunx)\b/,
  // Package-manager scripts that build or test
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|compile|package|test|e2e)\b/,
  // Build tools and compilers
  /\b(xcodebuild|swiftc?|gradle|gradlew|mvn|hvigorw|cmake|ninja|tsc|webpack|vite\s+build|next\s+build)\b/,
  /\b(cargo|go|rustc)\s+(build|test|run|bench)\b/,
  /\bdocker\s+(build|compose|pull|push|run)\b/,
  // Test suites
  /\b(pytest|tox|nosetests|jest|vitest|mocha|playwright|cypress|rspec)\b/,
  // Network and device operations
  /\bgit\s+(clone|fetch|pull|push|submodule|remote\s+update)\b/,
  /\b(curl|wget|rsync|scp|ssh)\b/,
  /\bhdc\b/,
  /\b(open|ghcup|rustup|sdkman)\b/,
];

function pickTimeout(command: string): number {
  return HEAVY_PATTERNS.some((pattern) => pattern.test(command)) ? HEAVY_TIMEOUT_S : DEFAULT_TIMEOUT_S;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;

    const { command, timeout } = event.input;
    if (timeout !== undefined) return;
    if (NO_TIMEOUT_MARKER.test(command)) return;

    event.input.timeout = pickTimeout(command);
  });
}
