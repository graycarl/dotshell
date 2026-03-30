/* Copy from: https://github.com/mitsuhiko/agent-stuff/blob/d47add0f7d60e4c4c8ef97c938780fe374742872/pi-extensions/answer.ts */
/**
 * Q&A extraction hook - extracts questions from assistant responses
 *
 * Custom interactive TUI for answering questions.
 *
 * Demonstrates the "prompt generator" pattern with custom TUI:
 * 1. /answer command gets the last assistant message
 * 2. Shows a spinner while extracting questions as structured JSON
 * 3. Presents an interactive TUI to navigate and answer questions
 * 4. Submits the compiled answers when done
 */

import { complete, type Model, type Api, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

// Structured output format for question extraction
interface ExtractedQuestion {
	question: string;
	context?: string;
	options?: string[];  // Optional list of predefined choices
}

interface ExtractionResult {
	questions: ExtractedQuestion[];
}

const SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering.

Output a JSON object with this structure:
{
  "questions": [
    {
      "question": "The question text",
      "context": "Optional context that helps answer the question",
      "options": ["option1", "option2", "..."]  // Optional array of choices
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Be concise with question text
- Include context only when it provides essential information for answering
- If the question presents specific choices/options, extract them into the "options" array
- Options should be extracted even if presented in different formats (bullet points, "or" separated, numbered list, etc.)
- If no questions are found, return {"questions": []}

Example output:
{
  "questions": [
    {
      "question": "What is your preferred database?",
      "context": "We can only configure MySQL and PostgreSQL because of what is implemented.",
      "options": ["MySQL", "PostgreSQL"]
    },
    {
      "question": "Should we use TypeScript or JavaScript?",
      "options": ["TypeScript", "JavaScript"]
    },
    {
      "question": "What should we name this project?"
    }
  ]
}`;

const CODEX_MODEL_ID = "gpt-5.1-codex-mini";
const HAIKU_MODEL_ID = "claude-haiku-4-5";

/**
 * Prefer Codex mini for extraction when available, otherwise fallback to haiku or the current model.
 */
async function selectExtractionModel(
	currentModel: Model<Api>,
	modelRegistry: {
		find: (provider: string, modelId: string) => Model<Api> | undefined;
		getApiKeyAndHeaders: (model: Model<Api>) => Promise<{ ok: true; apiKey: string; headers?: Record<string, string> } | { ok: false; error: string }>;
	},
): Promise<Model<Api>> {
	const codexModel = modelRegistry.find("openai-codex", CODEX_MODEL_ID);
	if (codexModel) {
		const auth = await modelRegistry.getApiKeyAndHeaders(codexModel);
		if (auth.ok && auth.apiKey) {
			return codexModel;
		}
	}

	const haikuModel = modelRegistry.find("anthropic", HAIKU_MODEL_ID);
	if (!haikuModel) {
		return currentModel;
	}

	const auth = await modelRegistry.getApiKeyAndHeaders(haikuModel);
	if (!auth.ok || !auth.apiKey) {
		return currentModel;
	}

	return haikuModel;
}

/**
 * Parse the JSON response from the LLM
 */
function parseExtractionResult(text: string): ExtractionResult | null {
	try {
		// Try to find JSON in the response (it might be wrapped in markdown code blocks)
		let jsonStr = text;

		// Remove markdown code block if present
		const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch) {
			jsonStr = jsonMatch[1].trim();
		}

		const parsed = JSON.parse(jsonStr);
		if (parsed && Array.isArray(parsed.questions)) {
			return parsed as ExtractionResult;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Interactive Q&A component for answering extracted questions
 */
class QnAComponent implements Component {
	private questions: ExtractedQuestion[];
	private answers: string[];
	private currentIndex: number = 0;
	private editor: Editor;
	private tui: TUI;
	private onDone: (result: string | null) => void;
	private showingConfirmation: boolean = false;
	
	// Input mode: 'select' for options, 'text' for free-form input
	private inputMode: ('select' | 'text')[] = [];
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
	private blue = (s: string) => `\x1b[34m${s}\x1b[0m`;

	constructor(
		questions: ExtractedQuestion[],
		tui: TUI,
		onDone: (result: string | null) => void,
	) {
		this.questions = questions;
		this.answers = questions.map(() => "");
		this.tui = tui;
		this.onDone = onDone;

		// Initialize input modes and selected indices
		for (let i = 0; i < questions.length; i++) {
			const hasOptions = questions[i].options && questions[i].options!.length > 0;
			this.inputMode[i] = hasOptions ? 'select' : 'text';
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
		// Disable the editor's built-in submit (which clears the editor)
		// We'll handle Enter ourselves to preserve the text
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
		
		if (mode === 'select' && question.options) {
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
		if (mode === 'text') {
			this.editor.setText(this.answers[index] || "");
		} else {
			this.editor.setText("");
		}
		
		this.invalidate();
	}
	
	private switchToTextMode(): void {
		const question = this.questions[this.currentIndex];
		// Only allow switching if there are options
		if (!question.options || question.options.length === 0) return;
		
		this.inputMode[this.currentIndex] = 'text';
		// Load existing answer (might be a selected option) into editor
		this.editor.setText(this.answers[this.currentIndex] || "");
		this.invalidate();
	}
	
	private switchToSelectMode(): void {
		const question = this.questions[this.currentIndex];
		// Only allow switching if there are options
		if (!question.options || question.options.length === 0) return;
		
		this.inputMode[this.currentIndex] = 'select';
		// Try to find current answer in options
		const currentAnswer = this.editor.getText().trim();
		const optionIndex = question.options.findIndex(opt => opt === currentAnswer);
		if (optionIndex >= 0) {
			this.selectedOptionIndex[this.currentIndex] = optionIndex;
		}
		this.editor.setText("");
		this.invalidate();
	}

	private submit(): void {
		this.saveCurrentAnswer();

		// Build the response text
		const parts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const q = this.questions[i];
			const a = this.answers[i]?.trim() || "(no answer)";
			parts.push(`Q: ${q.question}`);
			if (q.context) {
				parts.push(`> ${q.context}`);
			}
			parts.push(`A: ${a}`);
			parts.push("");
		}

		this.onDone(parts.join("\n").trim());
	}

	private cancel(): void {
		this.onDone(null);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		// Handle confirmation dialog
		if (this.showingConfirmation) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
				this.submit();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
				this.showingConfirmation = false;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			return;
		}

		// Global navigation and commands
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}

		const mode = this.inputMode[this.currentIndex];
		const question = this.questions[this.currentIndex];
		const hasOptions = question.options && question.options.length > 0;

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

		// Toggle between select and text mode with 't' or 'e' key
		if (hasOptions && (data === 't' || data === 'e' || data === 'T' || data === 'E')) {
			if (mode === 'select') {
				this.switchToTextMode();
			} else {
				this.switchToSelectMode();
			}
			this.tui.requestRender();
			return;
		}

		// Handle select mode
		if (mode === 'select' && hasOptions) {
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
			
			// Enter to confirm selection and move to next question
			if (matchesKey(data, Key.enter)) {
				this.saveCurrentAnswer();
				if (this.currentIndex < this.questions.length - 1) {
					this.navigateTo(this.currentIndex + 1);
				} else {
					// On last question - show confirmation
					this.showingConfirmation = true;
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
						this.showingConfirmation = true;
					}
					this.invalidate();
					this.tui.requestRender();
				}
				return;
			}
			
			return; // Ignore other input in select mode
		}

		// Handle text mode (original behavior)
		
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

		// Handle Enter ourselves (editor's submit is disabled)
		// Plain Enter moves to next question or shows confirmation on last question
		// Shift+Enter adds a newline (handled by editor)
		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			this.saveCurrentAnswer();
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
			} else {
				// On last question - show confirmation
				this.showingConfirmation = true;
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		// Pass to editor
		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const boxWidth = Math.min(width - 4, 120); // Allow wider box
		const contentWidth = boxWidth - 4; // 2 chars padding on each side

		// Helper to create horizontal lines (dim the whole thing at once)
		const horizontalLine = (count: number) => "─".repeat(count);

		// Helper to create a box line
		const boxLine = (content: string, leftPad: number = 2): string => {
			const paddedContent = " ".repeat(leftPad) + content;
			const contentLen = visibleWidth(paddedContent);
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

		// Title
		lines.push(padToWidth(this.dim("╭" + horizontalLine(boxWidth - 2) + "╮")));
		const title = `${this.bold(this.cyan("Questions"))} ${this.dim(`(${this.currentIndex + 1}/${this.questions.length})`)}`;
		lines.push(padToWidth(boxLine(title)));
		lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));

		// Progress indicator
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

		// Current question
		const q = this.questions[this.currentIndex];
		const mode = this.inputMode[this.currentIndex];
		const hasOptions = q.options && q.options.length > 0;
		
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

		// Answer section - either options or text editor
		if (mode === 'select' && hasOptions) {
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
				const optionText = isSelected 
					? this.bold(this.cyan(options[i]))
					: options[i];
				const fullOption = marker + number + optionText;
				
				lines.push(padToWidth(boxLine(fullOption, 4)));
			}
			
			lines.push(padToWidth(emptyBoxLine()));
			const modeSwitchHint = this.gray(`Press 't' to switch to text input`);
			lines.push(padToWidth(boxLine(modeSwitchHint, 4)));
		} else {
			// Render text editor (original behavior)
			const answerPrefix = this.bold("A: ");
			const editorWidth = contentWidth - 4 - 3; // Extra padding + space for "A: "
			const editorLines = this.editor.render(editorWidth);
			for (let i = 1; i < editorLines.length - 1; i++) {
				if (i === 1) {
					// First content line gets the "A: " prefix
					lines.push(padToWidth(boxLine(answerPrefix + editorLines[i])));
				} else {
					// Subsequent lines get padding to align with the first line
					lines.push(padToWidth(boxLine("   " + editorLines[i])));
				}
			}
			
			if (hasOptions) {
				lines.push(padToWidth(emptyBoxLine()));
				const modeSwitchHint = this.gray(`Press 't' to switch to option selection`);
				lines.push(padToWidth(boxLine(modeSwitchHint, 4)));
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		// Confirmation dialog or footer with controls
		if (this.showingConfirmation) {
			lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
			const confirmMsg = `${this.yellow("Submit all answers?")} ${this.dim("(Enter/y to confirm, Esc/n to cancel)")}`;
			lines.push(padToWidth(boxLine(truncateToWidth(confirmMsg, contentWidth))));
		} else {
			lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
			
			let controls: string;
			if (mode === 'select' && hasOptions) {
				controls = `${this.dim("↑↓")} select · ${this.dim("1-9")} quick select · ${this.dim("Enter")} confirm · ${this.dim("Tab")} next · ${this.dim("Esc")} cancel`;
			} else {
				controls = `${this.dim("Tab/Enter")} next · ${this.dim("Shift+Tab")} prev · ${this.dim("Shift+Enter")} newline · ${this.dim("Esc")} cancel`;
			}
			
			lines.push(padToWidth(boxLine(truncateToWidth(controls, contentWidth))));
		}
		lines.push(padToWidth(this.dim("╰" + horizontalLine(boxWidth - 2) + "╯")));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	const answerHandler = async (ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("answer requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			// Find the last assistant message on the current branch
			const branch = ctx.sessionManager.getBranch();
			let lastAssistantText: string | undefined;

			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type === "message") {
					const msg = entry.message;
					if ("role" in msg && msg.role === "assistant") {
						if (msg.stopReason !== "stop") {
							ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
							return;
						}
						const textParts = msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text);
						if (textParts.length > 0) {
							lastAssistantText = textParts.join("\n");
							break;
						}
					}
				}
			}

			if (!lastAssistantText) {
				ctx.ui.notify("No assistant messages found", "error");
				return;
			}

			// Select the best model for extraction (prefer Codex mini, then haiku)
			const extractionModel = await selectExtractionModel(ctx.model, ctx.modelRegistry);

			// Run extraction with loader UI
			const extractionResult = await ctx.ui.custom<ExtractionResult | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Extracting questions using ${extractionModel.id}...`);
				loader.onAbort = () => done(null);

				const doExtract = async () => {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(extractionModel);
					if (!auth.ok || !auth.apiKey) {
						throw new Error(auth.ok ? `No API key for ${extractionModel.provider}` : auth.error);
					}
					const userMessage: UserMessage = {
						role: "user",
						content: [{ type: "text", text: lastAssistantText! }],
						timestamp: Date.now(),
					};

					const response = await complete(
						extractionModel,
						{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
						{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
					);

					if (response.stopReason === "aborted") {
						return null;
					}

					const responseText = response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");

					return parseExtractionResult(responseText);
				};

				doExtract()
					.then(done)
					.catch(() => done(null));

				return loader;
			});

			if (extractionResult === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			if (extractionResult.questions.length === 0) {
				ctx.ui.notify("No questions found in the last message", "info");
				return;
			}

			// Show the Q&A component
			const answersResult = await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => {
				return new QnAComponent(extractionResult.questions, tui, done);
			});

			if (answersResult === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Send the answers directly as a message and trigger a turn
			pi.sendMessage(
				{
					customType: "answers",
					content: "I answered your questions in the following way:\n\n" + answersResult,
					display: true,
				},
				{ triggerTurn: true },
			);
	};

	pi.registerCommand("answer", {
		description: "Extract questions from last assistant message into interactive Q&A",
		handler: (_args, ctx) => answerHandler(ctx),
	});

	pi.registerShortcut("ctrl+.", {
		description: "Extract and answer questions",
		handler: answerHandler,
	});
}
