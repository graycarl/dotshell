/**
 * tmux status bridge for Pi.
 *
 * Pi reports its state with the Program Status Protocol (OSC 7501), but tmux
 * neither answers the protocol's support query nor forwards the sequence, so
 * the reports never reach the outer terminal or the status bar.
 *
 * This extension mirrors Pi's own state machine onto a tmux window option
 * (`@pi_status`) for the pane running Pi, so tmux can render it. Pair it with
 * something like this in tmux.conf:
 *
 *   setw -g window-status-format ' #I:#W#{?#{==:#{@pi_status},working}, #[fg=colour214]●,} '
 *
 * tmux re-evaluates the format whenever the option changes, so no extra
 * refresh command is needed.
 *
 * States: idle | working | blocked | done | error. `blocked` wins over
 * `working`, and an aborted run goes back to `idle`.
 *
 * Disable with PI_TMUX_STATUS=0. Outside tmux the extension is a no-op.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OPTION = "@pi_status";
const TIMEOUT_MS = 2000;

type State = "idle" | "working" | "blocked" | "done" | "error";

export default function (pi: ExtensionAPI) {
  if (process.env.PI_TMUX_STATUS === "0") return;

  const pane = process.env.TMUX_PANE;
  if (!process.env.TMUX || !pane) return;

  let last: State | undefined;

  const run = (args: string[]) =>
    pi.exec("tmux", args, { timeout: TIMEOUT_MS }).catch(() => undefined);

  const set = (state: State) => {
    if (state === last) return;
    last = state;
    return run(["set-option", "-w", "-t", pane, OPTION, state]);
  };

  const clear = () => {
    last = undefined;
    return run(["set-option", "-w", "-t", pane, "-u", OPTION]);
  };

  // Mirrors ProgramStatusReporter in pi's interactive mode.
  let runActive = false;
  let runResult: State = "done";
  let resting: State = "idle";
  let blocked = false;

  const report = () => void set(blocked ? "blocked" : runActive ? "working" : resting);

  pi.on("agent_start", () => {
    runActive = true;
    runResult = "done";
    report();
  });

  pi.on("message_end", (event) => {
    const message = event.message as unknown as { role?: string; stopReason?: string };
    // The latest response decides the outcome, so a retried error is replaced
    // by its successful retry.
    if (message.role !== "assistant") return;
    runResult = message.stopReason === "error" ? "error" : "done";
    report();
  });

  pi.on("agent_settled", (event) => {
    runActive = false;
    resting = event.aborted ? "idle" : runResult;
    report();
  });

  pi.on("ui_prompt_start", () => {
    blocked = true;
    report();
  });

  pi.on("ui_prompt_end", () => {
    blocked = false;
    report();
  });

  pi.on("session_start", () => {
    runActive = false;
    runResult = "done";
    resting = "idle";
    blocked = false;
    last = undefined;
    report();
  });

  pi.on("session_shutdown", () => void clear());
}
