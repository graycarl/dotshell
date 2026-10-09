/**
 * Predict Input - show the model's guess for the user's next message as ghost text.
 *
 * After every settled agent run the extension sends the last user message and the
 * assistant reply to a (ideally fast) model, and renders the predicted next user
 * message as dim virtual text inside the input box. Tab accepts the prediction and
 * turns it into real text; typing anything else dismisses it.
 *
 * Config (read once, from settings.json; unknown keys are passed through):
 *
 *   {
 *     "predictInput": {
 *       "enabled": true,
 *       "model": "deepseek/deepseek-flash"   // provider/id; omit to follow the session model
 *     }
 *   }
 *
 * Commands (the toggle and model override are session-only, never written back):
 *   /predict                  toggle on/off
 *   /predict on | off
 *   /predict model <p/id>     override the prediction model
 *   /predict model default    follow the session model
 *   /predict status
 *
 * This extension replaces the input editor. If another extension later calls
 * ctx.ui.setEditorComponent(), the ghost text is lost.
 */
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Api, Model } from "@earendil-works/pi-ai";

const MAX_CONTEXT_CHARS = 4000;
const MAX_PREDICTION_CHARS = 300;

const SYSTEM_PROMPT = [
  "You predict the user's next message in a coding-agent chat.",
  "You are given the last user message and the assistant's reply.",
  "Output ONLY the single most likely next user message, written in the user's language.",
  "No quotes, no markdown fences, no explanation, no preamble.",
  "Keep it under 200 characters and on one line.",
  "If nothing sensible can be predicted, output nothing.",
].join(" ");

interface PredictConfig {
  enabled: boolean;
  /** "provider/id"; undefined means follow the session model. */
  model?: string;
}

interface Turn {
  user: string;
  assistant: string;
}

// ─── Editor ──────────────────────────────────────────────────────────────────

/**
 * A CustomEditor that renders an optional dim "ghost" suggestion right after the
 * cursor. Ghost text is only shown while the editor is empty; any other key clears
 * it, Tab accepts it.
 */
class PredictEditor extends CustomEditor {
  private ghostRaw: string | undefined;
  private ghostStyled: string | undefined;

  setGhost(raw: string | undefined, styled?: string): void {
    this.ghostRaw = raw;
    this.ghostStyled = raw ? (styled ?? raw) : undefined;
    this.tui.requestRender();
  }

  clearGhost(): void {
    if (this.ghostRaw === undefined && this.ghostStyled === undefined) return;
    this.ghostRaw = undefined;
    this.ghostStyled = undefined;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.ghostRaw && this.getText().length === 0 && matchesKey(data, "tab")) {
      this.setText(this.ghostRaw);
      this.clearGhost();
      return;
    }
    if (this.ghostRaw) this.clearGhost();
    super.handleInput(data);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (!this.ghostStyled) return lines;

    const index = lines.findIndex((line) => line.includes(CURSOR_MARKER));
    if (index === -1) return lines;

    const line = lines[index]!;
    const markerAt = line.indexOf(CURSOR_MARKER);
    const resetAt = line.indexOf("\x1b[0m", markerAt);
    const insertAt = resetAt === -1 ? markerAt + CURSOR_MARKER.length : resetAt + "\x1b[0m".length;
    const merged = line.slice(0, insertAt) + this.ghostStyled + line.slice(insertAt);
    lines[index] = truncateToWidth(merged, width, "");
    return lines;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readConfig(pi: ExtensionAPI): PredictConfig {
  const raw = (pi.getSettings() as unknown as { predictInput?: { enabled?: unknown; model?: unknown } })
    .predictInput;
  const model = typeof raw?.model === "string" ? raw.model.trim() : "";
  return { enabled: raw?.enabled !== false, model: model || undefined };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}

/** Last assistant text on the current branch plus the user message that preceded it. */
function lastTurn(ctx: ExtensionContext): Turn | undefined {
  const branch = ctx.sessionManager.getBranch();
  let assistant: string | undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; content?: unknown };
    if (!assistant) {
      if (message.role !== "assistant") continue;
      const text = extractText(message.content).trim();
      if (text) assistant = text;
      continue;
    }
    if (message.role !== "user") continue;
    const text = extractText(message.content).trim();
    return text ? { user: text, assistant } : undefined;
  }
  return undefined;
}

function buildPrompt(turn: Turn): string {
  return [
    "<last_user_message>",
    clip(turn.user, MAX_CONTEXT_CHARS),
    "</last_user_message>",
    "",
    "<assistant_reply>",
    clip(turn.assistant, MAX_CONTEXT_CHARS),
    "</assistant_reply>",
  ].join("\n");
}

function cleanPrediction(text: string): string {
  const withoutFences = text
    .trim()
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/\s*```$/, "");
  const firstLine =
    withoutFences
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const stripped = firstLine
    .replace(/^["'“”‘’`]+/, "")
    .replace(/["'“”‘’`]+$/, "")
    .replace(/^(?:user|用户)\s*[:：]\s*/i, "")
    .trim();
  return stripped.length > MAX_PREDICTION_CHARS ? stripped.slice(0, MAX_PREDICTION_CHARS) : stripped;
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // pi.getSettings() is an action method and cannot run while extensions load,
  // so the config is read lazily once the runtime is initialized.
  let configLoaded = false;
  let enabled = true;
  let modelOverride: string | undefined;

  let editor: PredictEditor | undefined;
  let abort: AbortController | undefined;
  let requestToken = 0;

  const loadConfig = () => {
    if (configLoaded) return;
    const config = readConfig(pi);
    enabled = config.enabled;
    modelOverride = config.model;
    configLoaded = true;
  };

  const resolveModel = (ctx: ExtensionContext): Model<Api> | undefined => {
    if (!modelOverride) return ctx.model;
    const slash = modelOverride.indexOf("/");
    if (slash <= 0) return undefined;
    return ctx.modelRegistry.find(modelOverride.slice(0, slash), modelOverride.slice(slash + 1));
  };

  const cancel = () => {
    abort?.abort();
    abort = undefined;
    requestToken++;
  };

  pi.on("session_start", (_event, ctx) => {
    loadConfig();
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const instance = new PredictEditor(tui, theme, keybindings);
      editor = instance;
      return instance;
    });
  });

  pi.on("agent_start", () => {
    cancel();
    editor?.clearGhost();
  });

  // Fire and forget: awaiting here would stall the settled/notification path.
  pi.on("agent_settled", (event, ctx) => {
    if (!enabled || event.aborted || ctx.mode !== "tui" || !editor) return;

    const model = resolveModel(ctx);
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return;

    const turn = lastTurn(ctx);
    if (!turn) return;

    const registry = ctx.modelRegistry;
    const theme = ctx.ui.theme;

    void (async () => {
      cancel();
      const controller = new AbortController();
      abort = controller;
      const token = requestToken;
      try {
        const response = await registry.complete(
          model,
          {
            systemPrompt: SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: buildPrompt(turn) }],
                timestamp: Date.now(),
              },
            ],
          },
          {
            signal: controller.signal,
            cacheRetention: "none",
            maxTokens: 256,
            reasoning: "off",
          },
        );
        if (token !== requestToken || controller.signal.aborted) return;
        const prediction = cleanPrediction(extractText(response.content));
        if (!prediction) return;
        if (!editor || editor.getText().length > 0) return;
        editor.setGhost(prediction, theme.fg("dim", prediction));
      } catch {
        // Prediction is best-effort; ignore failures.
      } finally {
        if (abort === controller) abort = undefined;
      }
    })();
  });

  pi.on("session_shutdown", () => {
    cancel();
    editor = undefined;
  });

  pi.registerCommand("predict", {
    description: "Toggle next-input prediction and configure its model",
    handler: async (args, ctx) => {
      loadConfig();
      const arg = args.trim();

      if (!arg) {
        enabled = !enabled;
        if (!enabled) {
          cancel();
          editor?.clearGhost();
        }
        ctx.ui.notify(`Next-input prediction ${enabled ? "enabled" : "disabled"}`, "info");
        return;
      }

      const [sub, ...rest] = arg.split(/\s+/);
      if (sub === "on") {
        enabled = true;
        ctx.ui.notify("Next-input prediction enabled", "info");
        return;
      }
      if (sub === "off") {
        enabled = false;
        cancel();
        editor?.clearGhost();
        ctx.ui.notify("Next-input prediction disabled", "info");
        return;
      }
      if (sub === "model") {
        const value = rest.join(" ").trim();
        if (!value || value === "default") {
          modelOverride = undefined;
          ctx.ui.notify("Prediction model: follow the session model", "info");
          return;
        }
        const slash = value.indexOf("/");
        const found =
          slash > 0 ? ctx.modelRegistry.find(value.slice(0, slash), value.slice(slash + 1)) : undefined;
        if (!found) {
          ctx.ui.notify(`Model not found: ${value}`, "error");
          return;
        }
        modelOverride = value;
        const note = ctx.modelRegistry.hasConfiguredAuth(found) ? "" : " (no credentials)";
        ctx.ui.notify(`Prediction model: ${value}${note}`, "info");
        return;
      }
      if (sub === "status") {
        const model = resolveModel(ctx);
        const label = model ? `${model.provider}/${model.id}${modelOverride ? "" : " (session)"}` : "unavailable";
        ctx.ui.notify(`Prediction: ${enabled ? "on" : "off"} · model: ${label}`, "info");
        return;
      }

      ctx.ui.notify("Usage: /predict [on|off|status|model <provider/id>|model default]", "warning");
    },
  });
}
