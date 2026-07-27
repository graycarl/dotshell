/**
 * CodeGraph Extension for Pi Agent
 *
 * Wraps the codegraph CLI (https://github.com/colbymchenry/codegraph) as
 * custom tools so the agent can semantically explore code instead of
 * crawling files with grep/read.
 *
 * Behaviour:
 *  - At session_start, checks whether `codegraph` is installed and the
 *    current project has been initialised (`codegraph init`).
 *  - If both are true → activates codegraph_explore, codegraph_node,
 *    codegraph_search so the LLM can use them.
 *  - If not → tools stay registered but inactive (hidden from the LLM).
 *
 * Also registers a /codegraph-init command for convenience.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isCodegraphInstalled, isProjectInitialized } from "./utils.js";
import { registerAllTools, MANAGED_TOOL_NAMES } from "./tools.js";

let registered = false;

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Only register tools once per extension lifetime.
    if (!registered) {
      const installed = await isCodegraphInstalled(pi);
      if (!installed) return; // codegraph CLI not installed — nothing to do
      registerAllTools(pi);
      registered = true;
    }

    // Deactivate managed tools first, then reactivate only if project is ready.
    // This handles session switches where one project may be initialised and another not.
    const currentTools = pi.getActiveTools().filter((n) => !MANAGED_TOOL_NAMES.has(n));

    if (isProjectInitialized(ctx.cwd)) {
      pi.setActiveTools([...currentTools, ...MANAGED_TOOL_NAMES]);
    } else {
      pi.setActiveTools(currentTools);
    }
  });

  // ── /codegraph-init command ──────────────────────────────────────

  pi.registerCommand("codegraph-init", {
    description: "Initialize CodeGraph for the current project (runs codegraph init)",
    handler: async (_args, ctx) => {
      const installed = await isCodegraphInstalled(pi);
      if (!installed) {
        ctx.ui.notify(
          "codegraph CLI is not installed.\n\n" +
            "Install it with:\n" +
            '  curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh\n\n' +
            "Or see https://github.com/colbymchenry/codegraph",
          "error",
        );
        return;
      }

      const result = await pi.exec("codegraph", ["init", ctx.cwd], { timeout: 300_000 });
      if (result.code !== 0) {
        ctx.ui.notify(
          `codegraph init failed (exit ${result.code}):\n${result.stderr}`,
          "error",
        );
        return;
      }

      // Activate codegraph tools now that the project is initialised.
      if (!registered) {
        registerAllTools(pi);
        registered = true;
      }
      const currentTools = pi.getActiveTools().filter((n) => !MANAGED_TOOL_NAMES.has(n));
      pi.setActiveTools([...currentTools, ...MANAGED_TOOL_NAMES]);

      ctx.ui.notify(
        `CodeGraph initialized for ${ctx.cwd}\n\n` +
          "Tools codegraph_explore, codegraph_node, codegraph_search are now available.",
        "info",
      );
    },
  });
}
