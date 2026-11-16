/**
 * Servers Extension for Pi Agent
 *
 * Lets the agent start long-lived dev servers in the background and manage
 * them afterwards: list, tail logs, stop/restart/signal, write to stdin.
 * Processes survive pi crashes (detached + registry at .pi/servers/), and a
 * new pi session re-attaches to them (stop/logs/signal; stdin only for
 * servers started by the current runtime).
 *
 * User-facing pieces:
 *   /servers            — overlay with status, logs, stop/restart keys
 *   footer widget       — "⚙ N servers" while anything is running
 *   quit prompt         — on `pi` quit, ask whether to stop running servers
 *                         (session switches / reloads keep them untouched)
 *
 * ctx lifetime: the footer widget is driven by a manager change listener that
 * closes over a session-bound ctx. Pi invalidates that ctx right after
 * session_shutdown (reload / /new / /resume / /fork), and a child process
 * exiting afterwards would otherwise call setStatus on a stale ctx and crash
 * pi from an uncaughtException inside the 'exit' handler. So the listener is
 * dropped in session_shutdown and re-registered in session_start.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ServerManager } from "./manager.js";
import { registerAllTools } from "./tools.js";
import { promptShutdownServers, ServersOverlay, updateStatusWidget } from "./ui.js";

export default function (pi: ExtensionAPI) {
  const manager = new ServerManager();
  let toolsRegistered = false;
  let quitHandled = false;
  let unsubscribeChange: (() => void) | undefined;

  pi.on("session_start", async (_event, ctx) => {
    quitHandled = false;
    // Defensive: pi normally hands a replacement session a fresh extension
    // instance, but a second session_start without session_shutdown must not
    // leave the previous ctx bound to the footer.
    unsubscribeChange?.();
    unsubscribeChange = undefined;
    if (!toolsRegistered) {
      registerAllTools(pi, manager);
      toolsRegistered = true;
    }
    manager.init(ctx.cwd);
    manager.pruneExited();
    updateStatusWidget(ctx, manager);
    unsubscribeChange = manager.onChange(() => {
      // Last-resort net: a child exiting while pi tears the session down must
      // never abort pi (an uncaught throw from a process event handler exits
      // the whole runtime). Real bugs in list()/setStatus still surface via
      // session_start and the /servers overlay, which are not guarded.
      try {
        updateStatusWidget(ctx, manager);
      } catch {
        /* stale ctx — see the header note on ctx lifetime */
      }
    });
  });

  // ── /servers command ─────────────────────────────────────────────

  pi.registerCommand("servers", {
    description: "Show and manage background servers (logs, stop, restart)",
    handler: async (_args, ctx) => {
      const servers = manager.list();
      if (ctx.mode !== "tui") {
        const text = servers.length
          ? servers
              .map((s) => `${s.name} [${s.state}] pid=${s.pid} — ${s.command}`)
              .join("\n")
          : "No servers running.";
        if (ctx.hasUI) ctx.ui.notify(text, "info");
        return;
      }
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) =>
          new ServersOverlay(manager, theme, () => tui.requestRender(true), () => done()),
        { overlay: true, overlayOptions: { width: "80%", maxHeight: "70%" } },
      );
    },
  });

  // ── Quit-time prompt ──────────────────────────────────────────────

  // NOTE: pi stops the TUI BEFORE emitting session_shutdown on interactive
  // quit, so ctx.ui dialogs cannot be used here — promptShutdownServers
  // prompts over raw stdio instead (see ui.ts header).
  pi.on("session_shutdown", async (event, _ctx) => {
    // Unbind the ctx-bound footer listener before pi invalidates this ctx.
    unsubscribeChange?.();
    unsubscribeChange = undefined;

    // Only a real process quit prompts. Session switches (/new, /resume,
    // /fork) and extension reloads leave servers running — the next session
    // re-attaches through the registry.
    if (event.reason !== "quit" || quitHandled) return;
    quitHandled = true;

    const running = manager.list().filter((s) => s.state === "running");
    if (running.length === 0) return;

    const toStop = await promptShutdownServers(running);
    const kept = running.filter((s) => !toStop.has(s.name));
    if (toStop.size > 0) {
      await manager.stopAll([...toStop]);
      process.stderr.write(`pi servers: stopped ${toStop.size} server(s): ${[...toStop].join(", ")}\n`);
    }
    if (kept.length > 0) {
      process.stderr.write(
        `pi servers: left running: ${kept.map((s) => `${s.name} (pid ${s.pid})`).join(", ")} — manage via /servers or .pi/servers/\n`,
      );
    }
  });
}
