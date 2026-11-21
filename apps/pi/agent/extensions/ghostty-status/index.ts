/**
 * Ghostty Status Extension for Pi
 *
 * Brings native Ghostty terminal integration to Pi interactive sessions:
 * 1. Dynamic Tab Title (1A style):
 *      [status/spinner] π <dir> [(session)] [· <tool: brief arg>]
 *    - Spinner: ⠋ ⠙ ⠹ ... while working or compacting
 *    - Status glyphs: ⏸ (blocked on prompt), ✓ (done while unfocused), ✗ (error while unfocused)
 *    - Tool tracking: shows active tool + concise argument, including nested codemode tool calls
 *      and concurrent subagent counts.
 *    - Title Tap: guards against Pi core's built-in `updateTerminalTitle()` overwriting our title.
 *
 * 2. Four-Color Native Progress Bar (OSC 9;4):
 *    - Working / Compacting : Blue indeterminate pulse (`9;4;3`, with keepalive)
 *    - Blocked on Prompt    : Yellow paused 100% (`9;4;4;100`)
 *    - Error                : Red error 100% (`9;4;2;100`, held until focused if away, 3s if watching)
 *    - Completed            : Green 100% flash (`9;4;1;100` for 800ms -> clear `9;4;0`)
 *    - Aborted / Shutdown   : Clear (`9;4;0`)
 *
 * 3. Focus-Aware Notifications (OSC 777 + BEL \x07):
 *    - Tracks terminal focus via DECSET 1004 (`\x1b[?1004h` -> `\x1b[I` / `\x1b[O`).
 *    - Sends OSC 777 macOS notification (click to jump back to exact Ghostty tab/split) + BEL
 *      (Ghostty tab 🔔 badge + Dock bounce) when unfocused:
 *      • Normal completion: only if run duration >= 15s (configurable via PI_GHOSTTY_NOTIFY_SECONDS)
 *      • Error completion : always when unfocused
 *      • Blocked on prompt: immediately when unfocused (or if user switches away while prompt is open)
 *
 * Environment overrides:
 *   PI_GHOSTTY_STATUS=0           Disable this extension
 *   PI_GHOSTTY_NOTIFY_SECONDS=15  Minimum run seconds before notifying on normal completion
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const PROGRESS_KEEPALIVE_MS = 4000;
const COMPLETION_FLASH_MS = 800;
const ERROR_WATCHING_MS = 3000;
const DEFAULT_NOTIFY_THRESHOLD_S = 15;

const BEL = "\x07";
const ENABLE_FOCUS_REPORTING = "\x1b[?1004h";
const DISABLE_FOCUS_REPORTING = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

const ProgressState = {
	Clear: 0,
	Set: 1,
	Error: 2,
	Indeterminate: 3,
	Paused: 4,
} as const;

type AttentionState = "waiting" | "done" | "error";
type RunOutcome = "completed" | "aborted" | "error";

interface ActiveTool {
	toolCallId: string;
	toolName: string;
	label: string;
	parentToolCallId?: string;
}

// ============================================================================
// Title Tap (prevents Pi core's updateTerminalTitle from clobbering our title)
// ============================================================================

const TITLE_PREFIX = "\x1b]0;";
const TITLE_TERMINATOR = "\x07";
const TITLE_PATTERN = /\x1b\]0;([\s\S]*?)\x07/g;
const TITLE_PREFIX_BYTES = Buffer.from(TITLE_PREFIX, "utf8");
const TITLE_TAP_KEY = Symbol.for("pi-ghostty-status:title-tap");
const EXIT_HOOK_KEY = Symbol.for("pi-ghostty-status:exit-hook");

interface TitleTapState {
	owned: string | undefined;
}

function mayAnnounceTitle(chunk: unknown): boolean {
	if (typeof chunk === "string") return chunk.includes(TITLE_PREFIX);
	if (chunk instanceof Uint8Array) {
		return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).indexOf(TITLE_PREFIX_BYTES) !== -1;
	}
	return false;
}

function chunkText(chunk: unknown): string {
	if (typeof chunk === "string") return chunk;
	if (chunk instanceof Uint8Array) {
		return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("utf8");
	}
	return "";
}

function installTitleTap(stdout: Pick<NodeJS.WriteStream, "write"> = process.stdout): TitleTapState {
	const globals = globalThis as Record<symbol, unknown>;
	const existing = globals[TITLE_TAP_KEY] as TitleTapState | undefined;
	if (existing) return existing;

	const state: TitleTapState = { owned: undefined };
	const rawWrite = stdout.write.bind(stdout) as (chunk: unknown, ...rest: unknown[]) => boolean;
	stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
		const result = rawWrite(chunk, ...rest);
		if (state.owned && mayAnnounceTitle(chunk)) {
			const text = chunkText(chunk);
			let overwritten = false;
			for (const match of text.matchAll(TITLE_PATTERN)) {
				if ((match[1] ?? "") !== state.owned) {
					overwritten = true;
					break;
				}
			}
			if (overwritten) {
				rawWrite(`${TITLE_PREFIX}${state.owned}${TITLE_TERMINATOR}`);
			}
		}
		return result;
	}) as unknown as typeof stdout.write;

	globals[TITLE_TAP_KEY] = state;
	return state;
}

// ============================================================================
// Terminal Escape Helpers (Ghostty + optional tmux DCS passthrough)
// ============================================================================

function isGhosttyEnv(): boolean {
	if (process.env.PI_GHOSTTY_STATUS === "1") return true;
	return (
		process.env.TERM_PROGRAM === "ghostty" ||
		process.env.TERM === "xterm-ghostty" ||
		Boolean(process.env.GHOSTTY_RESOURCES_DIR)
	);
}

function wrapTmuxPassthrough(seq: string): string {
	if (!process.env.TMUX) return seq;
	// Escape any ESC inside the sequence by doubling it for tmux DCS passthrough
	const escaped = seq.replace(/\x1b/g, "\x1b\x1b");
	return `\x1bPtmux;${escaped}\x1b\\`;
}

function createTtyWriter(): (seq: string, passthrough?: boolean) => void {
	return (seq: string, passthrough = false) => {
		try {
			const payload = passthrough ? wrapTmuxPassthrough(seq) : seq;
			writeFileSync("/dev/tty", payload);
		} catch {
			// /dev/tty unavailable in non-interactive environments
		}
	};
}

function progressSequence(state: number, value?: number): string {
	const args = value !== undefined ? `${state};${value}` : `${state}`;
	return `\x1b]9;4;${args}\x07`;
}

function sanitizeOscText(text: string, maxLength = 160): string {
	const clean = text
		.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
		.replace(/;/g, ",")
		.replace(/\s+/g, " ")
		.trim();
	return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

function notifySequence(title: string, body: string): string {
	return `\x1b]777;notify;${sanitizeOscText(title, 80)};${sanitizeOscText(body, 180)}\x07`;
}

function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function lastFocusEvent(chunk: string): boolean | undefined {
	const lastIn = chunk.lastIndexOf(FOCUS_IN);
	const lastOut = chunk.lastIndexOf(FOCUS_OUT);
	if (lastIn === -1 && lastOut === -1) return undefined;
	return lastIn > lastOut;
}

// ============================================================================
// Tool Label Formatting (Tool Name + Brief Parameter)
// ============================================================================

function truncateText(text: string, maxLen: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	if (clean.length <= maxLen) return clean;
	return `${clean.slice(0, maxLen - 1)}…`;
}

function extractBriefBashCommand(rawCommand: unknown): string {
	if (typeof rawCommand !== "string" || !rawCommand.trim()) return "";
	const lines = rawCommand
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("#"));
	if (lines.length === 0) return "";

	let first = lines[0]!;
	// Strip leading `cd ... &&` or `export ... &&`
	first = first.replace(/^(?:cd|pushd)\s+[^;&|]+(?:&&|;)\s*/i, "");
	// Strip leading env var assignments like `FOO=bar BAZ=1 `
	first = first.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+)+/, "");
	// Take first segment before pipe or chained command
	first = first.split(/\s*(?:\|\||&&|\||;)\s*/)[0] ?? first;
	return truncateText(first, 24);
}

function extractBriefPath(rawPath: unknown): string {
	if (typeof rawPath !== "string" || !rawPath.trim()) return "";
	const cleaned = rawPath.trim().replace(/\/+$/, "");
	const base = path.basename(cleaned);
	return truncateText(base || cleaned, 24);
}

function formatToolLabel(toolName: string, args: Record<string, unknown> | undefined): string {
	const a = args ?? {};
	switch (toolName) {
		case "bash": {
			const cmd = extractBriefBashCommand(a.command);
			return cmd ? `bash: ${cmd}` : "bash";
		}
		case "read":
		case "write":
		case "edit": {
			const file = extractBriefPath(a.path);
			return file ? `${toolName}: ${file}` : toolName;
		}
		case "grep": {
			const pattern = typeof a.pattern === "string" ? truncateText(a.pattern, 20) : "";
			return pattern ? `grep: ${pattern}` : "grep";
		}
		case "find": {
			const pattern = typeof a.pattern === "string" ? truncateText(a.pattern, 20) : "";
			return pattern ? `find: ${pattern}` : "find";
		}
		case "ls": {
			const dir = extractBriefPath(a.path);
			return dir ? `ls: ${dir}` : "ls";
		}
		case "spawn_subagent": {
			const agent = typeof a.agent === "string" && a.agent.trim() ? truncateText(a.agent, 18) : "worker";
			return `subagent: ${agent}`;
		}
		case "fork_subagent":
			return "subagent: fork";
		case "resume_subagent": {
			const id = typeof a.agentId === "string" && a.agentId.trim() ? truncateText(a.agentId, 16) : "resume";
			return `subagent: ${id}`;
		}
		case "todo": {
			const action = typeof a.action === "string" ? a.action : "";
			return action ? `todo: ${action}` : "todo";
		}
		case "codemode":
			return "codemode";
		default: {
			if (toolName.startsWith("server_")) {
				const sub = toolName.slice("server_".length);
				const name = typeof a.name === "string" && a.name.trim() ? truncateText(a.name, 16) : "";
				return name ? `server ${sub}: ${name}` : `server: ${sub}`;
			}
			if (toolName.startsWith("mcp__")) {
				const parts = toolName.slice("mcp__".length).split("__");
				const server = parts[0] ?? "mcp";
				const op = parts.slice(1).join("_");
				return truncateText(op ? `${server}: ${op}` : server, 26);
			}
			return truncateText(toolName, 24);
		}
	}
}

function summarizeActiveTools(activeTools: Map<string, ActiveTool>, compacting: boolean): string | undefined {
	if (compacting) return "compacting…";
	if (activeTools.size === 0) return undefined;

	const all = Array.from(activeTools.values());
	const topLevel = all.filter((t) => !t.parentToolCallId || !activeTools.has(t.parentToolCallId));

	// Check if multiple subagents are running concurrently
	const subagents = topLevel.filter(
		(t) =>
			t.toolName === "spawn_subagent" ||
			t.toolName === "fork_subagent" ||
			t.toolName === "resume_subagent",
	);
	if (subagents.length > 1) {
		return `subagent ×${subagents.length}`;
	}

	const latestTop = topLevel[topLevel.length - 1] ?? all[all.length - 1]!;

	// If latest top-level tool is codemode and it has active nested tool calls, show `codemode → <child>`
	if (latestTop.toolName === "codemode") {
		const children = all.filter((t) => t.parentToolCallId === latestTop.toolCallId);
		if (children.length > 0) {
			const latestChild = children[children.length - 1]!;
			if (children.length > 1) {
				const sameName = children.every((c) => c.toolName === latestChild.toolName);
				if (sameName) {
					return `codemode → ${latestChild.toolName} ×${children.length}`;
				}
			}
			return `codemode → ${latestChild.label}`;
		}
	}

	return latestTop.label;
}

// ============================================================================
// Extension Entrypoint
// ============================================================================

export default function (pi: ExtensionAPI) {
	if (process.env.PI_GHOSTTY_STATUS === "0") return;
	if (process.env.PI_SUBAGENT === "1") return;
	if (!isGhosttyEnv()) return;

	const writeTty = createTtyWriter();
	const notifyThresholdMs = (() => {
		const raw = Number(process.env.PI_GHOSTTY_NOTIFY_SECONDS);
		return (Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_NOTIFY_THRESHOLD_S) * 1000;
	})();

	let cwd = process.cwd();
	let sessionName: string | undefined;
	let lastCtx: ExtensionContext | undefined;

	// Run & lifecycle state
	let runActive = false;
	let runWorking = false;
	let compacting = false;
	let runStartedAt = 0;
	let lastOutcome: RunOutcome = "completed";
	let lastErrorSnippet: string | undefined;
	let runSignal: AbortSignal | undefined;

	// Tool & UI prompt tracking
	const activeTools = new Map<string, ActiveTool>();
	let attention: AttentionState | undefined;
	let promptTitle: string | undefined;
	let promptNotified = false;

	// Focus tracking
	let focused = true;
	let detachFocus: (() => void) | undefined;

	// Timers & Title tap
	let frameIndex = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let progressKeepalive: ReturnType<typeof setInterval> | undefined;
	let progressFlashTimer: ReturnType<typeof setTimeout> | undefined;
	let errorHeld = false;
	let titleTapState: TitleTapState | undefined;

	const ownsSession = (ctx: ExtensionContext) => ctx.mode === "tui" && ctx.hasUI;

	function titleTap(): TitleTapState {
		titleTapState ??= installTitleTap();
		return titleTapState;
	}

	// ---- Title Composition (1A Style) --------------------------------------

	function baseIdentity(): string {
		const dir = path.basename(cwd) || cwd;
		return sessionName ? `${dir} (${sessionName})` : dir;
	}

	function composeTitle(): string {
		const isBusy = runWorking || compacting;
		let prefix = "";
		if (attention === "waiting") {
			prefix = "⏸ ";
		} else if (isBusy) {
			prefix = `${BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length]} `;
		} else if (attention === "done") {
			prefix = "✓ ";
		} else if (attention === "error") {
			prefix = "✗ ";
		}

		const identity = `π ${baseIdentity()}`;
		const activity = isBusy ? summarizeActiveTools(activeTools, compacting) : undefined;
		return activity ? `${prefix}${identity} · ${activity}` : `${prefix}${identity}`;
	}

	function renderTitle(ctx?: ExtensionContext): void {
		const targetCtx = ctx ?? lastCtx;
		if (!targetCtx || !ownsSession(targetCtx)) return;
		const title = composeTitle();
		titleTap().owned = title;
		targetCtx.ui.setTitle(title);
	}

	// ---- Four-Color Progress Bar (OSC 9;4) ---------------------------------

	function clearProgressTimers(): void {
		if (progressKeepalive) {
			clearInterval(progressKeepalive);
			progressKeepalive = undefined;
		}
		if (progressFlashTimer) {
			clearTimeout(progressFlashTimer);
			progressFlashTimer = undefined;
		}
		errorHeld = false;
	}

	function setProgress(state: number, value?: number): void {
		clearProgressTimers();
		const seq = progressSequence(state, value);
		writeTty(seq, true);
		if (state !== ProgressState.Clear) {
			progressKeepalive = setInterval(() => writeTty(seq, true), PROGRESS_KEEPALIVE_MS);
		}
	}

	function flashProgress(state: number, durationMs: number): void {
		setProgress(state, 100);
		progressFlashTimer = setTimeout(() => setProgress(ProgressState.Clear), durationMs);
	}

	// ---- Spinner Management ------------------------------------------------

	function syncSpinner(ctx?: ExtensionContext): void {
		const isBusy = runWorking || compacting;
		if (isBusy && !spinnerTimer) {
			frameIndex = 0;
			spinnerTimer = setInterval(() => {
				if (attention === "waiting") return;
				frameIndex++;
				renderTitle();
			}, SPINNER_INTERVAL_MS);
		} else if (!isBusy && spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
		renderTitle(ctx);
	}

	// ---- Notifications (OSC 777 + BEL) -------------------------------------

	function sendAttentionAlert(kind: AttentionState, elapsedMs?: number): void {
		const title = `π · ${baseIdentity()}`;
		let body: string;
		switch (kind) {
			case "waiting":
				body = promptTitle ? `等待确认：${promptTitle}` : "等待你的确认或输入";
				break;
			case "error": {
				const dur = elapsedMs !== undefined ? `（耗时 ${formatDuration(elapsedMs)}）` : "";
				body = lastErrorSnippet ? `执行出错${dur}：${lastErrorSnippet}` : `执行出错${dur}`;
				break;
			}
			case "done": {
				const dur = elapsedMs !== undefined ? `（耗时 ${formatDuration(elapsedMs)}）` : "";
				body = `已完成${dur}`;
				break;
			}
		}
		writeTty(BEL, true);
		writeTty(notifySequence(title, body), true);
	}

	// ---- Focus Tracking (DECSET 1004) --------------------------------------

	function onFocusChange(isFocused: boolean): void {
		if (focused === isFocused) return;
		focused = isFocused;

		if (isFocused) {
			// Returning to the tab clears unread ✓ / ✗ badges and held red progress bar
			if (errorHeld) {
				setProgress(ProgressState.Clear);
			}
			if (attention === "done" || attention === "error") {
				attention = undefined;
				renderTitle();
			}
		} else {
			// If user switches away while a blocking prompt is open and hasn't been notified yet
			if (attention === "waiting" && !promptNotified) {
				promptNotified = true;
				sendAttentionAlert("waiting");
			}
		}
	}

	function attachFocus(ctx: ExtensionContext): void {
		detachFocus?.();
		if (!process.stdin.isTTY) return;

		const onStdinData = (chunk: string | Buffer) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("latin1");
			const focusEvt = lastFocusEvent(text);
			if (focusEvt !== undefined) {
				onFocusChange(focusEvt);
			} else if (text !== FOCUS_IN && text !== FOCUS_OUT) {
				// Any real keystroke in this terminal means the user is focused and interacting
				onFocusChange(true);
			}
		};

		process.stdin.on("data", onStdinData);
		const unsubscribeInput = ctx.ui.onTerminalInput((data) =>
			data === FOCUS_IN || data === FOCUS_OUT ? { consume: true } : undefined,
		);

		writeTty(ENABLE_FOCUS_REPORTING, true);

		const globals = globalThis as Record<symbol, unknown>;
		if (!globals[EXIT_HOOK_KEY]) {
			globals[EXIT_HOOK_KEY] = true;
			process.once("exit", () => {
				writeTty(DISABLE_FOCUS_REPORTING, true);
				writeTty(progressSequence(ProgressState.Clear), true);
			});
		}

		detachFocus = () => {
			process.stdin.off("data", onStdinData);
			unsubscribeInput();
			detachFocus = undefined;
		};
	}

	// ---- Diagnostic & Test Command (/ghostty-status) -----------------------

	pi.registerCommand("ghostty-status", {
		description: "查看 Ghostty 状态扩展信息，或使用 `/ghostty-status test` 测试后台通知与四色进度条",
		handler: async (args, ctx) => {
			if (!ownsSession(ctx)) return;
			const sub = args.trim().toLowerCase();
			if (sub === "test") {
				ctx.ui.notify("请在 3 秒内切换到其他 Ghostty Tab 或窗口，即将测试阻塞黄条 + 通知…", "info");
				setTimeout(() => {
					if (!lastCtx) return;
					void lastCtx.ui
						.confirm("Ghostty 状态扩展测试", "收到右上角通知、Tab 🔔 图标和顶部黄色进度条了吗？")
						.then((ok) => {
							if (!lastCtx) return;
							if (ok) {
								flashProgress(ProgressState.Set, COMPLETION_FLASH_MS);
								lastCtx.ui.notify("测试通过！绿色完成进度条已闪烁。", "info");
							} else {
								flashProgress(ProgressState.Error, ERROR_WATCHING_MS);
								lastCtx.ui.notify("已演示红色错误进度条（3秒后自动清除）。", "warning");
							}
						})
						.catch(() => {});
				}, 3000);
				return;
			}

			const activeList = Array.from(activeTools.values()).map((t) => t.label);
			ctx.ui.notify(
				[
					`当前标题: ${composeTitle()}`,
					`焦点状态: ${focused ? "focused (当前在看)" : "unfocused (在后台)"}`,
					`关注标记: ${attention ?? "none"}`,
					`运行中工具: ${activeList.length > 0 ? activeList.join(", ") : "无"}`,
					`完成通知阈值: ${notifyThresholdMs / 1000}s (OSC 777 + BEL)`,
					`提示: 运行 /ghostty-status test 可体验完整效果`,
				].join("\n"),
				"info",
			);
		},
	});

	// ---- Lifecycle Event Subscriptions -------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		if (!ownsSession(ctx)) return;
		lastCtx = ctx;
		cwd = ctx.cwd;
		sessionName = pi.getSessionName();
		runActive = false;
		runWorking = false;
		compacting = false;
		activeTools.clear();
		attention = undefined;
		promptTitle = undefined;
		promptNotified = false;
		setProgress(ProgressState.Clear);
		attachFocus(ctx);
		syncSpinner(ctx);
	});

	pi.on("session_info_changed", async (event, ctx) => {
		if (!ownsSession(ctx)) return;
		lastCtx = ctx;
		sessionName = event.name;
		renderTitle(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!ownsSession(ctx)) return;
		lastCtx = ctx;
		if (!runActive) {
			runActive = true;
			runStartedAt = Date.now();
			lastOutcome = "completed";
			lastErrorSnippet = undefined;
		}
		runSignal = ctx.signal;
		runWorking = true;
		activeTools.clear();

		if (attention !== "waiting") {
			attention = undefined;
			setProgress(ProgressState.Indeterminate);
		}
		if (detachFocus) {
			writeTty(ENABLE_FOCUS_REPORTING, true);
		}
		syncSpinner(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (!ownsSession(ctx)) return;
		lastCtx = ctx;
		const msg = event.message as unknown as {
			role?: string;
			stopReason?: string;
			errorMessage?: string;
		};
		if (msg.role !== "assistant") return;

		if (runSignal?.aborted || msg.stopReason === "aborted") {
			lastOutcome = "aborted";
			lastErrorSnippet = undefined;
		} else if (msg.stopReason === "error") {
			lastOutcome = "error";
			const firstLine = (msg.errorMessage ?? "").split(/\r?\n/)[0]?.trim();
			lastErrorSnippet = firstLine ? truncateText(firstLine, 80) : undefined;
		} else {
			// A successful retry clears an earlier transient error in the same run
			lastOutcome = "completed";
			lastErrorSnippet = undefined;
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!ownsSession(ctx)) return;
		lastCtx = ctx;
		if (runSignal?.aborted) {
			lastOutcome = "aborted";
		}
		runWorking = false;
		activeTools.clear();
		syncSpinner(ctx);
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (!ownsSession(ctx) || !runActive) return;
		lastCtx = ctx;
		runActive = false;
		runWorking = false;
		activeTools.clear();

		const outcome: RunOutcome = event.aborted || runSignal?.aborted ? "aborted" : lastOutcome;
		const elapsedMs = Date.now() - runStartedAt;

		if (outcome === "aborted") {
			attention = undefined;
			setProgress(ProgressState.Clear);
		} else if (outcome === "error") {
			if (focused) {
				attention = undefined;
				flashProgress(ProgressState.Error, ERROR_WATCHING_MS);
			} else {
				attention = "error";
				setProgress(ProgressState.Error, 100);
				errorHeld = true;
				sendAttentionAlert("error", elapsedMs);
			}
		} else {
			// Completed
			flashProgress(ProgressState.Set, COMPLETION_FLASH_MS);
			if (focused) {
				attention = undefined;
			} else {
				attention = "done";
				if (elapsedMs >= notifyThresholdMs) {
					sendAttentionAlert("done", elapsedMs);
				}
			}
		}

		syncSpinner(ctx);
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		if (!ownsSession(ctx)) return;
		lastCtx = ctx;
		compacting = true;
		if (attention !== "waiting") {
			setProgress(ProgressState.Indeterminate);
		}
		syncSpinner(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		if (!ownsSession(ctx)) return;
		lastCtx = ctx;
		compacting = false;
		if (!runWorking && attention !== "waiting") {
			setProgress(ProgressState.Clear);
		}
		syncSpinner(ctx);
	});

	pi.on("session_compact_failed", async (_event, ctx) => {
		if (!ownsSession(ctx)) return;
		lastCtx = ctx;
		compacting = false;
		if (!runWorking && attention !== "waiting") {
			setProgress(ProgressState.Clear);
		}
		syncSpinner(ctx);
	});

	pi.on("ui_prompt_start", async (event, ctx) => {
		if (!ownsSession(ctx)) return;
		lastCtx = ctx;
		attention = "waiting";
		promptTitle = event.title;
		promptNotified = false;
		setProgress(ProgressState.Paused, 100);
		if (!focused) {
			promptNotified = true;
			sendAttentionAlert("waiting");
		}
		renderTitle(ctx);
	});

	pi.on("ui_prompt_end", async (_event, ctx) => {
		if (!ownsSession(ctx)) return;
		lastCtx = ctx;
		if (attention === "waiting") {
			attention = undefined;
			promptTitle = undefined;
			promptNotified = false;
		}
		if (runWorking || compacting) {
			setProgress(ProgressState.Indeterminate);
		} else {
			setProgress(ProgressState.Clear);
		}
		renderTitle(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (!ownsSession(ctx)) return;
		lastCtx = ctx;
		const args =
			event.args && typeof event.args === "object" ? (event.args as Record<string, unknown>) : undefined;
		activeTools.set(event.toolCallId, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			label: formatToolLabel(event.toolName, args),
			parentToolCallId: event.parentToolCallId,
		});
		renderTitle(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!ownsSession(ctx)) return;
		lastCtx = ctx;
		activeTools.delete(event.toolCallId);
		renderTitle(ctx);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		if (titleTapState) {
			titleTapState.owned = undefined;
		}
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
		clearProgressTimers();
		writeTty(progressSequence(ProgressState.Clear), true);
		writeTty(DISABLE_FOCUS_REPORTING, true);
		detachFocus?.();
		activeTools.clear();
		runActive = false;
		runWorking = false;
		compacting = false;
	});
}
