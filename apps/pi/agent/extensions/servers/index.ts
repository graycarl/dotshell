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
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ServerManager } from "./manager.js";
import { registerAllTools } from "./tools.js";
import { promptShutdownServers, ServersOverlay, updateStatusWidget } from "./ui.js";

export default function (pi: ExtensionAPI) {
  const manager = new ServerManager();
  let toolsRegistered = false;
  let currentCtx: ExtensionContext | undefined;
  let quitHandled = false;

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    quitHandled = false;
    if (!toolsRegistered) {
      registerAllTools(pi, manager);
      toolsRegistered = true;
    }
    manager.init(ctx.cwd);
    manager.pruneExited();
    updateStatusWidget(ctx, manager);
    manager.onChange(() => {
      if (currentCtx) updateStatusWidget(currentCtx, manager);
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

  pi.on("session_shutdown", async (event, ctx) => {
    // Only a real process quit prompts. Session switches (/new, /resume,
    // /fork) and extension reloads leave servers running — the next session
    // re-attaches through the registry.
    if (event.reason !== "quit" || quitHandled) return;
    quitHandled = true;

    const running = manager.list().filter((s) => s.state === "running");
    if (running.length === 0) return;

    if (!ctx.hasUI || ctx.mode !== "tui") {
      // Non-interactive modes: keep servers, just say so.
      if (ctx.hasUI) {
        ctx.ui.notify(`Leaving ${running.length} server(s) running: ${running.map((s) => s.name).join(", ")}`, "warning");
      }
      return;
    }

    const toStop = await promptShutdownServers(ctx, running);
    for (const name of toStop) {
      try {
        await manager.stop(name);
      } catch {
        /* already dead — fine */
      }
    }
    if (toStop.size > 0) {
      ctx.ui.notify(`Stopped ${toStop.size} server(s): ${[...toStop].join(", ")}`, "info");
    }
  });
}
