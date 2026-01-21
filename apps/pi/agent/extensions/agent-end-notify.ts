import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// See: <https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#custom-tools>
export default function (pi: ExtensionAPI) {
  // Send notification on macOS when agent ends (task complete/waiting for input).
  pi.on("agent_end", async (event, ctx) => {
    await pi.exec("osascript", ["-e", `display notification "Task completed" with title "Pi Mono"`]);
  });
}
