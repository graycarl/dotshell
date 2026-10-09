/**
 * Predict Input - show the model's guess for the user's next message as ghost text.
 *
 * After every settled agent run the extension sends the last user message and the
 * assistant reply to a (ideally fast) model and renders the top prediction as dim
 * virtual text inside the input box, with a `⇥ N` hint when more candidates exist.
 *
 *   Enter   accept the top suggestion into the input (does not submit)
 *   Tab     open the autocomplete list with every candidate (↑/↓ to pick, Enter/Tab to apply)
 *   typing  dismiss the suggestions
 *
 * The candidates only exist while the input is empty, so the native autocomplete
 * (slash commands, @-paths, files) is untouched: with input or without candidates
 * the extension delegates to the wrapped provider.
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
import {
  CURSOR_MARKER,
  matchesKey,
  truncateToWidth,
  type AutocompleteItem,
  type AutocompleteProvider,
} from "@earendil-works/pi-tui";
import type { Api, Model } from "@earendil-works/pi-ai";

const MAX_CONTEXT_CHARS = 4000;
const MAX_SUGGESTION_CHARS = 300;
const MAX_SUGGESTIONS = 8;

const SYSTEM_PROMPT = [
  "You predict the user's next messages in a coding-agent chat.",
  "You are given the last user message and the assistant's reply.",
  "Output the most likely next user message first, then only the closest alternatives, one per line.",
  "Usually 1 to 4 candidates are the right amount; 8 is the hard maximum, not a target.",
  "Never pad the list: if only one message is plausible, output just that one.",
  "Write them in the user's language.",
  "No numbering, no bullets, no quotes, no markdown fences, no explanations.",
  "Keep each line under 200 characters.",
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

/** Autocomplete item produced from a prediction; marked so applyCompletion can recognize it. */
interface PredictItem extends AutocompleteItem {
  __predict?: true;
}

// ─── Editor ──────────────────────────────────────────────────────────────────

/**
 * A CustomEditor that renders the top prediction as a dim ghost right after the
 * cursor. Enter accepts it, Tab opens the autocomplete list with every candidate,
 * and any edit that makes the input non-empty drops the candidates.
 */
class PredictEditor extends CustomEditor {
  private suggestions: string[] = [];
  private ghostStyled: string | undefined;

  setSuggestions(list: string[], styledTop?: string): void {
    this.suggestions = list;
    this.ghostStyled = list.length > 0 ? (styledTop ?? list[0]) : undefined;
    this.tui.requestRender();
  }

  clearSuggestions(): void {
    if (this.suggestions.length === 0 && this.ghostStyled === undefined) return;
    this.suggestions = [];
    this.ghostStyled = undefined;
    this.tui.requestRender();
  }

  /** Single source of truth for the autocomplete provider. */
  getSuggestionList(): string[] {
    return this.suggestions;
  }

  private acceptTop(): void {
    const top = this.suggestions[0];
    if (!top) return;
    this.setText(top);
    this.clearSuggestions();
  }

  handleInput(data: string): void {
    // Empty input + visible ghost + Enter -> accept instead of submitting empty.
    if (
      this.suggestions.length > 0 &&
      this.getText().length === 0 &&
      !this.isShowingAutocomplete() &&
      matchesKey(data, "enter")
    ) {
      this.acceptTop();
      return;
    }

    // Tab needs no special case: the base editor triggers autocomplete, our
    // provider answers it while the input is empty.
    super.handleInput(data);

    if (this.suggestions.length > 0 && this.getText().length > 0) this.clearSuggestions();
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (!this.ghostStyled || this.isShowingAutocomplete()) return lines;

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

function cleanSuggestionLine(line: string): string {
  const withoutFences = line
    .trim()
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/\s*```$/, "");
  const stripped = withoutFences
    .replace(/^\s*(?:\d+[.)]|[-*•·])\s+/, "")
    .replace(/^["'“”‘’`]+/, "")
    .replace(/["'“”‘’`]+$/, "")
    .replace(/^(?:user|用户)\s*[:：]\s*/i, "")
    .trim();
  return stripped.length > MAX_SUGGESTION_CHARS ? stripped.slice(0, MAX_SUGGESTION_CHARS) : stripped;
}

/** Split a model response into up to MAX_SUGGESTIONS de-duplicated one-line candidates. */
function parseSuggestions(text: string): string[] {
  const body = text
    .trim()
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/\s*```$/, "");
  const suggestions: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const cleaned = cleanSuggestionLine(line);
    if (!cleaned || suggestions.includes(cleaned)) continue;
    suggestions.push(cleaned);
    if (suggestions.length >= MAX_SUGGESTIONS) break;
  }
  return suggestions;
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

  // Reuse the native autocomplete: while the input is empty and candidates exist,
  // Tab (force) receives them; everything else is delegated untouched.
  const buildAutocompleteProvider = (current: AutocompleteProvider): AutocompleteProvider => ({
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const empty = lines.every((line) => line.length === 0);
      const list = editor?.getSuggestionList() ?? [];
      if (empty && list.length > 0) {
        const items: PredictItem[] = list.map((value) => ({ value, label: value, __predict: true }));
        return { items, prefix: "" };
      }
      return current.getSuggestions(lines, cursorLine, cursorCol, options);
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if ((item as PredictItem).__predict) {
        editor?.clearSuggestions();
        return { lines: [item.value], cursorLine: 0, cursorCol: item.value.length };
      }
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  });

  pi.on("session_start", (_event, ctx) => {
    loadConfig();
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const instance = new PredictEditor(tui, theme, keybindings);
      editor = instance;
      return instance;
    });
    ctx.ui.addAutocompleteProvider(buildAutocompleteProvider);
  });

  pi.on("agent_start", () => {
    cancel();
    editor?.clearSuggestions();
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
            maxTokens: 512,
            reasoning: "off",
          },
        );
        if (token !== requestToken || controller.signal.aborted) return;
        const suggestions = parseSuggestions(extractText(response.content));
        if (suggestions.length === 0) return;
        if (!editor || editor.getText().length > 0) return;
        const hint = suggestions.length > 1 ? theme.fg("muted", ` ⇥ ${suggestions.length}`) : "";
        editor.setSuggestions(suggestions, theme.fg("dim", suggestions[0]) + hint);
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
          editor?.clearSuggestions();
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
        editor?.clearSuggestions();
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
