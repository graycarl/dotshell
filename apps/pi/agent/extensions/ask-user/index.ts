/**
 * Ask User Tool - Let the LLM actively ask the user questions during a conversation.
 *
 * The LLM calls this tool with structured questions, and the user answers through
 * an interactive TUI. Answers are returned to the LLM as tool results.
 *
 * Features:
 * - Single or multiple questions
 * - Option selection (arrow keys, number quick-select) or free-text input per question
 * - Dual mode switching per question (select ↔ text)
 * - Progress indicators, Tab navigation, layered Esc
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─── Types ───────────────────────────────────────────────────────────────────

interface AskQuestion {
  id: string;
  question: string;
  context?: string;
  options?: string[];
  allowCustom?: boolean;
}

interface AskAnswer {
  id: string;
  question: string;
  answer: string;
  wasCustom: boolean;
  selectedIndex?: number;
}

interface AskResult {
  title?: string;
  questions: AskQuestion[];
  answers: AskAnswer[];
  cancelled: boolean;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const AskQuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question" }),
  question: Type.String({ description: "The full question text" }),
  context: Type.Optional(
    Type.String({ description: "Optional context/description shown below the question" })
  ),
  options: Type.Optional(
    Type.Array(Type.String(), {
      description: "Predefined choices. When provided, user can select from them or switch to custom input",
    })
  ),
  allowCustom: Type.Optional(
    Type.Boolean({
      description: "Allow user to switch to free-text input (default: true when options exist)",
    })
  ),
});

const AskUserParams = Type.Object({
  title: Type.Optional(
    Type.String({ description: "Optional title for the question dialog" })
  ),
  questions: Type.Array(AskQuestionSchema, {
    description: "Questions to ask the user (1 or more)",
  }),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function errorResult(message: string, questions: AskQuestion[] = []): AskResult {
  return { questions, answers: [], cancelled: true };
}

function errorToolResult(
  message: string,
  questions: AskQuestion[] = [],
): { content: { type: "text"; text: string }[]; details: AskResult } {
  return { content: [{ type: "text", text: message }], details: errorResult(message, questions) };
}

// ─── AskUserComponent ────────────────────────────────────────────────────────

/**
 * Interactive TUI component for answering questions.
 * Based on the answer extension's QnAComponent UI style.
 */
class AskUserComponent implements Component {
  private questions: AskQuestion[];
  private answers: string[];
  private currentIndex: number = 0;
  private editor: Editor;
  private tui: TUI;
  private onDone: (result: AskResult) => void;
  private confirmationState: "none" | "submit" | "cancel" = "none";
  private title?: string;

  // Input mode: 'select' for options, 'text' for free-form input
  private inputMode: ("select" | "text")[] = [];
  private selectedOptionIndex: number[] = [];

  // Cache
  private cachedWidth?: number;
  private cachedLines?: string[];

  // Colors - using proper reset sequences
  private dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  private bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  private cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
  private green = (s: string) => `\x1b[32m${s}\x1b[0m`;
  private yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
  private gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

  constructor(
    questions: AskQuestion[],
    tui: TUI,
    onDone: (result: AskResult) => void,
    title?: string,
  ) {
    this.questions = questions;
    this.answers = questions.map(() => "");
    this.tui = tui;
    this.onDone = onDone;
    this.title = title;

    // Initialize input modes and selected indices
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const allowCustom = q.allowCustom !== false;
      const hasOptions = q.options && q.options.length > 0;
      // Default to select mode if options exist, otherwise text mode
      this.inputMode[i] = hasOptions ? "select" : "text";
      this.selectedOptionIndex[i] = 0;
    }

    // Create a minimal theme for the editor
    const editorTheme: EditorTheme = {
      borderColor: this.dim,
      selectList: {
        selectedBg: (s: string) => `\x1b[44m${s}\x1b[0m`,
        matchHighlight: this.cyan,
        itemSecondary: this.gray,
      },
    };

    this.editor = new Editor(tui, editorTheme);
    this.editor.disableSubmit = true;
    this.editor.onChange = () => {
      this.invalidate();
      this.tui.requestRender();
    };
  }

  private allQuestionsAnswered(): boolean {
    this.saveCurrentAnswer();
    return this.answers.every((a) => (a?.trim() || "").length > 0);
  }

  private saveCurrentAnswer(): void {
    const mode = this.inputMode[this.currentIndex];
    const question = this.questions[this.currentIndex];

    if (mode === "select" && question.options) {
      const selectedIdx = this.selectedOptionIndex[this.currentIndex];
      this.answers[this.currentIndex] = question.options[selectedIdx] || "";
    } else {
      this.answers[this.currentIndex] = this.editor.getText();
    }
  }

  private navigateTo(index: number): void {
    if (index < 0 || index >= this.questions.length) return;
    this.saveCurrentAnswer();
    this.currentIndex = index;

    // Load answer into editor only if in text mode
    const mode = this.inputMode[index];
    if (mode === "text") {
      this.editor.setText(this.answers[index] || "");
    } else {
      this.editor.setText("");
    }

    this.invalidate();
  }

  private switchToTextMode(): void {
    const question = this.questions[this.currentIndex];
    if (!question.options || question.options.length === 0) return;

    this.inputMode[this.currentIndex] = "text";
    // Pre-fill with selected option
    if (this.answers[this.currentIndex]) {
      this.editor.setText(this.answers[this.currentIndex]);
    } else {
      const selectedIdx = this.selectedOptionIndex[this.currentIndex];
      this.editor.setText(question.options[selectedIdx] || "");
    }
    this.invalidate();
  }

  private switchToSelectMode(): void {
    const question = this.questions[this.currentIndex];
    if (!question.options || question.options.length === 0) return;

    this.inputMode[this.currentIndex] = "select";
    // Try to find current answer in options
    const currentAnswer = this.editor.getText().trim();
    const optionIndex = question.options.findIndex((opt) => opt === currentAnswer);
    if (optionIndex >= 0) {
      this.selectedOptionIndex[this.currentIndex] = optionIndex;
    }
    this.editor.setText("");
    this.invalidate();
  }

  private submit(): void {
    this.saveCurrentAnswer();

    const answers: AskAnswer[] = this.questions.map((q, i) => ({
      id: q.id,
      question: q.question,
      answer: this.answers[i]?.trim() || "",
      wasCustom: this.inputMode[i] === "text",
      selectedIndex:
        this.inputMode[i] === "select" && q.options
          ? this.selectedOptionIndex[i] + 1
          : undefined,
    }));

    this.onDone({
      title: this.title,
      questions: this.questions,
      answers,
      cancelled: false,
    });
  }

  private cancel(): void {
    this.onDone({
      title: this.title,
      questions: this.questions,
      answers: [],
      cancelled: true,
    });
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  handleInput(data: string): void {
    // Handle confirmation dialog
    if (this.confirmationState !== "none") {
      if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
        if (this.confirmationState === "submit") {
          this.submit();
        } else {
          this.cancel();
        }
        return;
      }
      if (
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.ctrl("c")) ||
        data.toLowerCase() === "n"
      ) {
        this.confirmationState = "none";
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      return;
    }

    const mode = this.inputMode[this.currentIndex];
    const question = this.questions[this.currentIndex];
    const hasOptions = question.options && question.options.length > 0;
    const allowCustom = question.allowCustom !== false;

    // Ctrl+C always cancels immediately
    if (matchesKey(data, Key.ctrl("c"))) {
      this.cancel();
      return;
    }

    // Handle Esc - layered behavior
    if (matchesKey(data, Key.escape)) {
      this.saveCurrentAnswer();

      // Layer 1: If in text mode and question has options and custom is allowed, switch back to select mode
      if (mode === "text" && hasOptions && allowCustom) {
        this.switchToSelectMode();
        this.tui.requestRender();
        return;
      }

      // Layer 2: Go back to previous question
      if (this.currentIndex > 0) {
        this.navigateTo(this.currentIndex - 1);
        this.tui.requestRender();
        return;
      }

      // Layer 3: At first question, show cancel confirmation
      this.confirmationState = "cancel";
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Tab / Shift+Tab for navigation between questions
    if (matchesKey(data, Key.tab)) {
      if (this.currentIndex < this.questions.length - 1) {
        this.navigateTo(this.currentIndex + 1);
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      if (this.currentIndex > 0) {
        this.navigateTo(this.currentIndex - 1);
        this.tui.requestRender();
      }
      return;
    }

    // ── Select mode ──
    if (mode === "select" && hasOptions) {
      const options = question.options!;

      // Arrow up/down for option selection
      if (matchesKey(data, Key.up)) {
        this.selectedOptionIndex[this.currentIndex] =
          (this.selectedOptionIndex[this.currentIndex] - 1 + options.length) % options.length;
        this.invalidate();
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.selectedOptionIndex[this.currentIndex] =
          (this.selectedOptionIndex[this.currentIndex] + 1) % options.length;
        this.invalidate();
        this.tui.requestRender();
        return;
      }

      // Enter to confirm selection and move to next
      if (matchesKey(data, Key.enter)) {
        this.saveCurrentAnswer();
        if (this.currentIndex < this.questions.length - 1) {
          this.navigateTo(this.currentIndex + 1);
        } else {
          this.confirmationState = "submit";
        }
        this.invalidate();
        this.tui.requestRender();
        return;
      }

      // Number keys for quick selection (1-9)
      if (/^[1-9]$/.test(data)) {
        const num = parseInt(data, 10) - 1;
        if (num < options.length) {
          this.selectedOptionIndex[this.currentIndex] = num;
          this.saveCurrentAnswer();
          if (this.currentIndex < this.questions.length - 1) {
            this.navigateTo(this.currentIndex + 1);
          } else {
            this.confirmationState = "submit";
          }
          this.invalidate();
          this.tui.requestRender();
        }
        return;
      }

      // 'e' key to switch to text input mode (only if custom is allowed)
      if ((data === "e" || data === "E") && allowCustom) {
        this.switchToTextMode();
        this.tui.requestRender();
        return;
      }

      return; // Ignore other input in select mode
    }

    // ── Text mode ──

    // Arrow up/down for question navigation when editor is empty
    if (matchesKey(data, Key.up) && this.editor.getText() === "") {
      if (this.currentIndex > 0) {
        this.navigateTo(this.currentIndex - 1);
        this.tui.requestRender();
        return;
      }
    }
    if (matchesKey(data, Key.down) && this.editor.getText() === "") {
      if (this.currentIndex < this.questions.length - 1) {
        this.navigateTo(this.currentIndex + 1);
        this.tui.requestRender();
        return;
      }
    }

    // Plain Enter moves to next question or shows confirmation
    if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
      this.saveCurrentAnswer();
      if (this.currentIndex < this.questions.length - 1) {
        this.navigateTo(this.currentIndex + 1);
      } else {
        this.confirmationState = "submit";
      }
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    // Pass to editor (handles Shift+Enter for newlines)
    this.editor.handleInput(data);
    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    const boxWidth = Math.min(width - 4, 120);
    const contentWidth = boxWidth - 4; // 2 chars padding on each side

    const horizontalLine = (count: number) => "─".repeat(count);

    const boxLine = (content: string, leftPad: number = 2): string => {
      let paddedContent = " ".repeat(leftPad) + content;
      let contentLen = visibleWidth(paddedContent);
      // Safety net: never let content overflow the box width.
      if (contentLen > boxWidth - 4) {
        paddedContent = truncateToWidth(paddedContent, boxWidth - 4, "…");
        contentLen = visibleWidth(paddedContent);
      }
      const rightPad = Math.max(0, boxWidth - contentLen - 2);
      return this.dim("│") + paddedContent + " ".repeat(rightPad) + this.dim("│");
    };

    const emptyBoxLine = (): string => {
      return this.dim("│") + " ".repeat(boxWidth - 2) + this.dim("│");
    };

    const padToWidth = (line: string): string => {
      const len = visibleWidth(line);
      return line + " ".repeat(Math.max(0, width - len));
    };

    // ── Header ──
    lines.push(padToWidth(this.dim("╭" + horizontalLine(boxWidth - 2) + "╮")));

    // Title
    const titleText = this.title
      ? `${this.bold(this.cyan(this.title))} ${this.dim(`(${this.currentIndex + 1}/${this.questions.length})`)}`
      : `${this.bold(this.cyan("Questions"))} ${this.dim(`(${this.currentIndex + 1}/${this.questions.length})`)}`;
    lines.push(padToWidth(boxLine(titleText)));
    lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));

    // ── Progress indicator ──
    const progressParts: string[] = [];
    for (let i = 0; i < this.questions.length; i++) {
      const answered = (this.answers[i]?.trim() || "").length > 0;
      const current = i === this.currentIndex;
      if (current) {
        progressParts.push(this.cyan("●"));
      } else if (answered) {
        progressParts.push(this.green("●"));
      } else {
        progressParts.push(this.dim("○"));
      }
    }
    lines.push(padToWidth(boxLine(progressParts.join(" "))));
    lines.push(padToWidth(emptyBoxLine()));

    // ── Current question ──
    const q = this.questions[this.currentIndex];
    const mode = this.inputMode[this.currentIndex];
    const hasOptions = q.options && q.options.length > 0;
    const allowCustom = q.allowCustom !== false;

    const questionText = `${this.bold("Q:")} ${q.question}`;
    const wrappedQuestion = wrapTextWithAnsi(questionText, contentWidth);
    for (const line of wrappedQuestion) {
      lines.push(padToWidth(boxLine(line)));
    }

    // Context if present
    if (q.context) {
      lines.push(padToWidth(emptyBoxLine()));
      const contextText = this.gray(`> ${q.context}`);
      const wrappedContext = wrapTextWithAnsi(contextText, contentWidth - 2);
      for (const line of wrappedContext) {
        lines.push(padToWidth(boxLine(line)));
      }
    }

    lines.push(padToWidth(emptyBoxLine()));

    // ── Answer section ──
    if (mode === "select" && hasOptions) {
      // Render options list
      const options = q.options!;
      const selectedIdx = this.selectedOptionIndex[this.currentIndex];

      const answerPrefix = this.bold("A: ");
      lines.push(padToWidth(boxLine(answerPrefix + this.gray("(Select an option)"))));
      lines.push(padToWidth(emptyBoxLine()));

      for (let i = 0; i < options.length; i++) {
        const isSelected = i === selectedIdx;
        const number = this.dim(`${i + 1}. `);
        const marker = isSelected ? this.cyan("❯ ") : "  ";
        // leftPad(4) + marker(2) + number(3) + right padding(2)
        const optionWidth = contentWidth - 11;
        const optionText = isSelected
          ? this.bold(this.cyan(truncateToWidth(options[i], optionWidth, "…")))
          : truncateToWidth(options[i], optionWidth, "…");
        const fullOption = marker + number + optionText;

        lines.push(padToWidth(boxLine(fullOption, 4)));
      }

      lines.push(padToWidth(emptyBoxLine()));
      if (allowCustom) {
        const hint = this.gray(`Press 'e' to switch to text input`);
        lines.push(padToWidth(boxLine(hint, 4)));
      }
    } else {
      // Render text editor
      const answerPrefix = this.bold("A: ");
      const editorWidth = contentWidth - 4 - 3;
      const editorLines = this.editor.render(editorWidth);
      for (let i = 1; i < editorLines.length - 1; i++) {
        if (i === 1) {
          lines.push(padToWidth(boxLine(answerPrefix + editorLines[i])));
        } else {
          lines.push(padToWidth(boxLine("   " + editorLines[i])));
        }
      }

      if (hasOptions && allowCustom) {
        lines.push(padToWidth(emptyBoxLine()));
        const hint = this.gray(`Press 'Esc' to return to option selection`);
        lines.push(padToWidth(boxLine(hint, 4)));
      }
    }

    lines.push(padToWidth(emptyBoxLine()));

    // ── Footer / Confirmation ──
    lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));

    if (this.confirmationState === "submit") {
      const confirmMsg = `${this.yellow("Submit all answers?")} ${this.dim("(Enter/y to confirm, Esc/n to cancel)")}`;
      lines.push(padToWidth(boxLine(truncateToWidth(confirmMsg, contentWidth))));
    } else if (this.confirmationState === "cancel") {
      const confirmMsg = `${this.yellow("Cancel all answers?")} ${this.dim("(Enter/y to confirm, Esc/n to go back)")}`;
      lines.push(padToWidth(boxLine(truncateToWidth(confirmMsg, contentWidth))));
    } else {
      let controls: string;
      if (mode === "select" && hasOptions) {
        if (allowCustom) {
          controls = `${this.dim("↑↓")} select · ${this.dim("1-9")} quick · ${this.dim("e")} text input · ${this.dim("Enter")} confirm · ${this.dim("Esc")} back`;
        } else {
          controls = `${this.dim("↑↓")} select · ${this.dim("1-9")} quick · ${this.dim("Enter")} confirm · ${this.dim("Esc")} back`;
        }
      } else if (mode === "text" && hasOptions && allowCustom) {
        controls = `${this.dim("Tab/Enter")} next · ${this.dim("Shift+Tab")} prev · ${this.dim("Shift+Enter")} newline · ${this.dim("Esc")} back/cancel`;
      } else {
        controls = `${this.dim("Tab/Enter")} next · ${this.dim("Shift+Tab")} prev · ${this.dim("Shift+Enter")} newline · ${this.dim("Esc")} back`;
      }

      lines.push(padToWidth(boxLine(truncateToWidth(controls, contentWidth))));
    }
    lines.push(padToWidth(this.dim("╰" + horizontalLine(boxWidth - 2) + "╯")));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

// ─── Extension entry ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the user one or more questions with an interactive UI. Use when you need user input, preferences, or decisions to proceed. Each question can have predefined options (user selects from list) or be free-text (user types). Supports single or multiple questions with progress tracking.",
    promptSnippet: "Ask the user questions with interactive option selection or free-text input",
    promptGuidelines: [
      "Use ask_user when you need user input to proceed, such as clarifying requirements, choosing between options, or getting preferences.",
      "Use ask_user for single or multiple questions. Prefer ask_user over asking inline when the choices are clear or complex.",
      "Provide clear, concise question text and well-named options. Use context for additional details.",
    ],
    parameters: AskUserParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Guard: TUI mode only
      if (ctx.mode !== "tui") {
        return errorToolResult(
          "Error: ask_user requires interactive mode (TUI). Cannot prompt user in non-interactive mode.",
          params.questions as AskQuestion[],
        );
      }

      if (!params.questions || params.questions.length === 0) {
        return errorToolResult("Error: No questions provided");
      }

      // Normalize questions
      const questions: AskQuestion[] = params.questions.map((q) => ({
        id: q.id,
        question: q.question,
        context: q.context,
        options: q.options,
        allowCustom: q.allowCustom !== false,
      }));

      // Single question: wrap in a simplified flow (no tab, just answer and submit)
      const result = await ctx.ui.custom<AskResult>((tui, _theme, _kb, done) => {
        return new AskUserComponent(questions, tui, done, params.title);
      });

      if (result.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled. No answers were submitted." }],
          details: result,
        };
      }

      // Format answers for LLM
      const answerLines: string[] = [];
      for (const a of result.answers) {
        const aq = questions.find((q) => q.id === a.id);
        const qLabel = aq ? aq.question : a.id;
        answerLines.push(`Q: ${qLabel}`);
        if (aq?.context) {
          answerLines.push(`> ${aq.context}`);
        }
        if (a.wasCustom) {
          answerLines.push(`A: ${a.answer || "(no answer)"}`);
        } else {
          answerLines.push(`A: ${a.selectedIndex}. ${a.answer}`);
        }
        answerLines.push("");
      }

      return {
        content: [{ type: "text", text: answerLines.join("\n").trim() }],
        details: result,
      };
    },

    // ── Custom rendering ──
    renderCall(args, theme, _context) {
      const qs = (args.questions as AskQuestion[]) || [];
      const count = qs.length;
      const title = (args.title as string) || "";

      let text = theme.fg("toolTitle", theme.bold("ask_user "));
      if (title) {
        text += theme.fg("accent", title);
      } else {
        text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
      }

      // List first question as preview
      if (qs.length > 0) {
        const preview = truncateToWidth(qs[0].question, 60);
        text += `\n${theme.fg("dim", `  Q: ${preview}`)}`;
        if (qs.length > 1) {
          text += theme.fg("dim", `  (+${qs.length - 1} more)`);
        }
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as AskResult | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }

      if (details.cancelled) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }

      const lines = details.answers.map((a) => {
        const prefix = theme.fg("success", "✓ ");
        const idDisplay = theme.fg("accent", a.id);
        if (a.wasCustom) {
          return `${prefix}${idDisplay}: ${a.answer || theme.fg("dim", "(no answer)")}`;
        }
        const display = a.selectedIndex ? `${theme.fg("muted", `${a.selectedIndex}.`)} ${a.answer}` : a.answer;
        return `${prefix}${idDisplay}: ${display}`;
      });

      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
