/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Delegates one task to a specialized agent. To parallelize, the LLM issues
 * multiple calls in the same assistant turn.
 *
 * A process-level semaphore caps how many subagent processes run at once
 * (default 4); excess calls queue until a slot frees up.
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";

const MAX_SINGLE_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

// 工具名；所有子进程都固定排除委派类工具，防止递归
const SPAWN_SUBAGENT_TOOL = "spawn_subagent";
const FORK_SUBAGENT_TOOL = "fork_subagent";
const RECURSION_EXCLUDE_TOOLS = `${SPAWN_SUBAGENT_TOOL},list_agents,${FORK_SUBAGENT_TOOL}`;

const FORK_SYSTEM_PROMPT = [
	"You are a forked sub-agent of pi.",
	"The conversation in this session is shared history forked from the main agent, not your own prior work.",
	"Treat it strictly as background context, then complete the task given in the final user message.",
].join(" ");

/** Context forked from the main agent's active session branch. */
interface ForkContext {
	entries: SessionEntry[];
	parentSession?: string;
}

/** A resolved agent to execute in a subprocess. */
interface AgentSpec {
	name: string;
	source: "user" | "project" | "builtin";
	systemPrompt: string;
	/** Comma-separated tool allowlist (maps to --tools). */
	tools?: string;
	/** Comma-separated tools to disable (maps to --exclude-tools). */
	excludeTools?: string;
	/** Model override (maps to --model). */
	model?: string;
}

/** Options for a single agent run. */
interface RunAgentOptions {
	task: string;
	/** When set, the subprocess forks this context instead of starting fresh. */
	forkContext?: ForkContext;
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	makeDetails: (results: SingleResult[]) => AgentDetails;
}

// ── 全局信号量：限制同一时刻运行的子进程数量 ──────────────
let activeSingleAgents = 0;
const singleWaiters: { releaseSlot: () => void; onAbort: () => void }[] = [];

function releaseSingleSlot(): void {
	activeSingleAgents -= 1;
	const next = singleWaiters.shift();
	if (next) {
		activeSingleAgents += 1;
		next.releaseSlot();
	}
}

function acquireSingleSlot(signal?: AbortSignal): Promise<(() => void) | null> {
	if (activeSingleAgents < MAX_SINGLE_CONCURRENCY) {
		activeSingleAgents += 1;
		return Promise.resolve(releaseSingleSlot);
	}
	return new Promise((resolve) => {
		let removed = false;
		const onAbort = () => {
			if (removed) return;
			removed = true;
			const index = singleWaiters.indexOf(waiter);
			if (index >= 0) singleWaiters.splice(index, 1);
			signal?.removeEventListener("abort", onAbort);
			resolve(null);
		};
		const waiter = {
			releaseSlot: () => {
				if (removed) return;
				removed = true;
				signal?.removeEventListener("abort", onAbort);
				resolve(releaseSingleSlot);
			},
			onAbort,
		};
		if (signal?.aborted) {
			resolve(null);
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		singleWaiters.push(waiter);
	});
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "builtin" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	htmlReportPath?: string;
}

interface AgentDetails {
	results: SingleResult[];
	agentScope?: AgentScope;
	projectAgentsDir?: string | null;
}

/** Convert a discovered agent into an executable spec. */
function toAgentSpec(agent: AgentConfig): AgentSpec {
	return {
		name: agent.name,
		source: agent.source,
		systemPrompt: agent.systemPrompt,
		tools: agent.tools && agent.tools.length > 0 ? agent.tools.join(",") : undefined,
		excludeTools: agent.excludeTools,
		model: agent.model,
	};
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

/** Session id for a forked subagent session (must start and end alphanumeric). */
function createForkSessionId(): string {
	return `fork-${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16).slice(-4)}`;
}

/**
 * Drop the in-progress turn from an active branch.
 *
 * The parent session file usually ends with the assistant tool call that spawned
 * this subagent, which has no tool result yet. Forking that verbatim makes the
 * child inherit a dangling tool call (and often continue the parent's train of
 * thought). Cutting at the last assistant message with an unmatched tool call
 * keeps every completed step but removes the half-finished one.
 */
function buildForkEntries(branch: SessionEntry[]): SessionEntry[] {
	const resultIds = new Set<string>();
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "toolResult" && typeof entry.message.toolCallId === "string") {
			resultIds.add(entry.message.toolCallId);
		}
	}

	let cut = branch.length;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		const hasPendingToolCall = content.some(
			(part: any) => part.type === "toolCall" && typeof part.id === "string" && !resultIds.has(part.id),
		);
		if (hasPendingToolCall) {
			cut = i;
			break;
		}
	}

	return branch.slice(0, cut);
}

/** Persist a forked branch as a standalone session file that `pi --fork` can consume. */
function writeForkSourceFile(
	entries: SessionEntry[],
	targetCwd: string,
	parentSession: string | undefined,
	tmpDir: string,
): string {
	const filePath = path.join(tmpDir, "parent.jsonl");
	const header = {
		type: "session",
		version: 3,
		id: `src-${Math.random().toString(16).slice(2, 10)}`,
		timestamp: new Date().toISOString(),
		cwd: targetCwd,
		...(parentSession ? { parentSession } : {}),
	};
	const content = [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))].join("\n");
	fs.writeFileSync(filePath, `${content}\n`, { encoding: "utf-8", mode: 0o600 });
	return filePath;
}

function buildTaskPrompt(task: string, isFork: boolean): string {
	if (!isFork) return `Task: ${task}`;
	return [
		"Complete the task below autonomously.",
		"Do not ask the user questions; if you are blocked, state the blocker instead of waiting.",
		"Finish with a concise report: what you did, your findings, files changed (with paths), and anything the main agent must know.",
		"",
		"Task:",
		task,
	].join("\n");
}

type OnUpdateCallback = (partial: AgentToolResult<AgentDetails>) => void;

async function runAgent(defaultCwd: string, spec: AgentSpec, options: RunAgentOptions): Promise<SingleResult> {
	const { task, forkContext, signal, onUpdate, makeDetails } = options;
	const isFork = !!forkContext && forkContext.entries.length > 0;
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	let tmpPromptPath: string | null = null;

	const args: string[] = ["--mode", "json", "-p", "--session-dir", tmpDir];
	// 子进程不暴露委派类工具，防止无限递归；再叠加 agent 定义的 excludeTools。
	const effectiveExcludeTools = [spec.excludeTools, RECURSION_EXCLUDE_TOOLS]
		.filter((s): s is string => !!s && s.trim().length > 0)
		.join(",");

	if (spec.model) args.push("--model", spec.model);
	if (spec.tools) args.push("--tools", spec.tools);
	if (effectiveExcludeTools) args.push("--exclude-tools", effectiveExcludeTools);

	const currentResult: SingleResult = {
		agent: spec.name,
		agentSource: spec.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: spec.model,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (isFork && forkContext) {
			const sourceFile = writeForkSourceFile(forkContext.entries, defaultCwd, forkContext.parentSession, tmpDir);
			args.push("--session-id", createForkSessionId(), "--fork", sourceFile);
		}

		if (spec.systemPrompt.trim()) {
			const safeName = spec.name.replace(/[^\w.-]+/g, "_");
			tmpPromptPath = path.join(tmpDir, `prompt-${safeName}.md`);
			fs.writeFileSync(tmpPromptPath, spec.systemPrompt, { encoding: "utf-8", mode: 0o600 });
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(buildTaskPrompt(task, isFork));
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, { cwd: defaultCwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let buffer = "";
			let exited = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.setEncoding("utf8");
			proc.stdout.on("data", (data) => {
				buffer += data;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.setEncoding("utf8");
			proc.stderr.on("data", (data) => {
				currentResult.stderr += data;
			});

			proc.on("close", (code) => {
				exited = true;
				if (killTimer) clearTimeout(killTimer);
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					killTimer = setTimeout(() => {
						if (!exited) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");

		// Generate HTML report from the saved session file
		try {
			const sessionFiles = fs
				.readdirSync(tmpDir)
				.filter((f) => f.endsWith(".jsonl") && f !== "parent.jsonl");
			if (sessionFiles.length > 0) {
				const sessionFile = path.join(tmpDir, sessionFiles[0]);
				const safeName = spec.name.replace(/[^\w.-]+/g, "_");
				const htmlPath = path.join(os.tmpdir(), `pi-subagent-${safeName}-${Date.now()}.html`);
				const exportResult = spawnSync("pi", ["--export", sessionFile, htmlPath], { timeout: 15000 });
				if (exportResult.status === 0) {
					currentResult.htmlReportPath = htmlPath;
				}
			}
		} catch {
			/* export failure is non-fatal */
		}

		return currentResult;
	} finally {
		// Clean up tmpDir (prompt file + session files)
		try {
			const entries = fs.readdirSync(tmpDir);
			for (const entry of entries) {
				try { fs.unlinkSync(path.join(tmpDir, entry)); } catch { /* ignore */ }
			}
			fs.rmdirSync(tmpDir);
		} catch { /* ignore */ }
	}
}

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke" })),
	task: Type.Optional(Type.String({ description: "Task to delegate to the agent" })),
	agentScope: Type.Optional(AgentScopeSchema),
	model: Type.Optional(
		Type.String({
			description:
				'Model for this call (e.g. "deepseek/deepseek-flash"); default: the agent definition\'s model, or inherit the parent model',
		}),
	),
});

function renderAgentResult(result: any, expanded: boolean, theme: any): Text | Container {
	const details = result.details as AgentDetails | undefined;
	if (!details || details.results.length === 0) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
	}

	const r = details.results[0];
	const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
	const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const mdTheme = getMarkdownTheme();
	const displayItems = getDisplayItems(r.messages);
	const finalOutput = getFinalOutput(r.messages);

	const renderCollapsed = (items: DisplayItem[]) => {
		const toShow = items.slice(-COLLAPSED_ITEM_COUNT);
		const skipped = items.length > COLLAPSED_ITEM_COUNT ? items.length - COLLAPSED_ITEM_COUNT : 0;
		let text = "";
		if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
		for (const item of toShow) {
			if (item.type === "text") {
				text += `${theme.fg("toolOutput", item.text.split("\n").slice(0, 3).join("\n"))}\n`;
			} else {
				text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
			}
		}
		return text.trimEnd();
	};

	if (expanded) {
		const container = new Container();
		let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
		if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		container.addChild(new Text(header, 0, 0));
		if (isError && r.errorMessage)
			container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
		container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
		if (displayItems.length === 0 && !finalOutput) {
			container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
		} else {
			for (const item of displayItems) {
				if (item.type === "toolCall")
					container.addChild(
						new Text(
							theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
							0,
							0,
						),
					);
			}
			if (finalOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
			}
		}
		const usageStr = formatUsageStats(r.usage, r.model);
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
		}
		if (r.htmlReportPath) {
			container.addChild(new Text(theme.fg("muted", "Report: ") + theme.fg("accent", r.htmlReportPath), 0, 0));
		}
		return container;
	}

	let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
	if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
	if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
	else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
	else {
		text += `\n${renderCollapsed(displayItems)}`;
		if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	}
	const usageStr = formatUsageStats(r.usage, r.model);
	if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
	if (r.htmlReportPath) text += `\n${theme.fg("muted", "Report: ")}${theme.fg("accent", r.htmlReportPath)}`;
	return new Text(text, 0, 0);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: SPAWN_SUBAGENT_TOOL,
		label: "Spawn Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			`For tasks that need the parent's accumulated context, use the ${FORK_SUBAGENT_TOOL} tool instead.`,
			"To parallelize, issue multiple spawn_subagent calls in the same assistant turn; they run concurrently.",
			`At most ${MAX_SINGLE_CONCURRENCY} subagent processes run at once; excess calls queue until a slot frees.`, "",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		promptGuidelines: [
			"When delegating to a subagent, always specify the exact agent name. If you are unsure which agents are available, first call list_agents to discover available subagents and their descriptions.",
			`Use the ${FORK_SUBAGENT_TOOL} tool when the sub-task needs the parent's accumulated context; use spawn_subagent for isolated recon with a fresh context.`,
			"To run independent subagents in parallel, issue multiple spawn_subagent calls in the same assistant turn instead of waiting for each to finish sequentially.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			const makeDetails = (results: SingleResult[]): AgentDetails => ({
				agentScope,
				projectAgentsDir: discovery.projectAgentsDir,
				results,
			});

			if (!params.agent || !params.task) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide both agent and task.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails([]),
				};
			}

			const release = await acquireSingleSlot(signal);
			if (!release) {
				return {
					content: [{ type: "text", text: "Cancelled while waiting for a subagent concurrency slot." }],
					details: makeDetails([]),
				};
			}

			let result: SingleResult;
			try {
				const targetAgent = agents.find((a) => a.name === params.agent);
				if (!targetAgent) {
					return {
						content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
						details: makeDetails([]),
						isError: true,
					};
				}

				const spec = toAgentSpec(targetAgent);
				if (params.model) spec.model = params.model;
				result = await runAgent(ctx.cwd, spec, {
					task: params.task,
					signal,
					onUpdate,
					makeDetails,
				});
			} finally {
				release();
			}
			const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
			if (isError) {
				const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
				return {
					content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
					details: makeDetails([result]),
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
				details: makeDetails([result]),
			};
		},

		renderCall(args, theme) {
			const scope: AgentScope = args.agentScope ?? "user";
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold(`${SPAWN_SUBAGENT_TOOL} `)) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			return renderAgentResult(result, expanded, theme);
		},
	});

	// ── list_agents tool ─────────────────────────────────────────────────────

	// ── fork_subagent tool ──────────────────────────────────────

	pi.registerTool({
		name: FORK_SUBAGENT_TOOL,
		label: "Fork Agent",
		description: [
			"Delegate a task to a forked subagent that inherits the main agent's full conversation context.",
			"The forked agent sees the current conversation as shared history and completes the task independently in an isolated session.",
			"Use it when the sub-task needs context already gathered in this session; use the spawn_subagent tool for isolated recon with a fresh context.",
			`At most ${MAX_SINGLE_CONCURRENCY} subagent processes run at once; excess calls queue until a slot frees.`,
		].join(" "),
		promptGuidelines: [
			`Use ${FORK_SUBAGENT_TOOL} when the sub-task needs the parent's accumulated context; use spawn_subagent for isolated recon with a fresh context.`,
			`To run independent forks in parallel, issue multiple ${FORK_SUBAGENT_TOOL} calls in the same assistant turn.`,
		],
		parameters: Type.Object({
			task: Type.String({ description: "Task for the forked agent to complete independently" }),
			model: Type.Optional(
				Type.String({
					description: 'Model for the fork (e.g. "deepseek/deepseek-flash"); default: inherit the parent model',
				}),
			),
			tools: Type.Optional(
				Type.String({ description: "Comma-separated tool allowlist; default: inherit the parent's tools" }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			let forkContext: ForkContext | undefined;
			try {
				const entries = buildForkEntries(ctx.sessionManager.getBranch());
				if (entries.length > 0) {
					forkContext = { entries, parentSession: ctx.sessionManager.getSessionFile() };
				}
			} catch {
				forkContext = undefined;
			}

			const makeDetails = (results: SingleResult[]): AgentDetails => ({ results });

			if (!forkContext) {
				return {
					content: [
						{
							type: "text",
							text: "Cannot fork: the current session has no conversation history to fork. Use the spawn_subagent tool for a fresh, isolated run instead.",
						},
					],
					details: makeDetails([]),
					isError: true,
				};
			}

			const release = await acquireSingleSlot(signal);
			if (!release) {
				return {
					content: [{ type: "text", text: "Cancelled while waiting for a subagent concurrency slot." }],
					details: makeDetails([]),
				};
			}

			let result: SingleResult;
			try {
				result = await runAgent(
					ctx.cwd,
					{
						name: FORK_SUBAGENT_TOOL,
						source: "builtin",
						systemPrompt: FORK_SYSTEM_PROMPT,
						model: params.model,
						tools: params.tools,
					},
					{ task: params.task, forkContext, signal, onUpdate, makeDetails },
				);
			} finally {
				release();
			}

			const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
			if (isError) {
				const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
				return {
					content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
					details: makeDetails([result]),
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
				details: makeDetails([result]),
			};
		},

		renderCall(args, theme) {
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			const text = `${theme.fg("toolTitle", theme.bold(FORK_SUBAGENT_TOOL))}\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			return renderAgentResult(result, expanded, theme);
		},
	});

	pi.registerTool({
		name: "list_agents",
		label: "List Agents",
		description: [
			"Discover available subagents and their descriptions.",
			"Use this to find the correct agent name before calling spawn_subagent.",
			"Scans user agents (~/.pi/agent/agents/) and optionally project agents (.pi/agents/).",
		].join(" "),
		promptSnippet: "Discover available subagents and their descriptions",
		promptGuidelines: [
			"Call list_agents first when you need to delegate work to a subagent but are unsure which agent name to use.",
			"Review the returned agent names and descriptions, then use the correct name with the spawn_subagent tool.",
		],
		parameters: Type.Object({
			agentScope: Type.Optional(AgentScopeSchema),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			if (agents.length === 0) {
				return {
					content: [{ type: "text", text: "No subagents found." }],
					details: { count: 0, agentScope, projectAgentsDir: discovery.projectAgentsDir },
				};
			}

			const lines: string[] = [];
			lines.push(`Found ${agents.length} subagent(s) (scope: ${agentScope}):`);
			lines.push("");

			for (const agent of agents) {
				lines.push(`  ${agent.name}`);
				lines.push(`    Description: ${agent.description}`);
				lines.push(`    Source: ${agent.source}`);
				if (agent.tools && agent.tools.length > 0) {
					lines.push(`    Tools: ${agent.tools.join(", ")}`);
				}
				lines.push("");
			}

			lines.push(`Tip: use the ${FORK_SUBAGENT_TOOL} tool to delegate with the parent's full context.`);
			lines.push("");

			if (discovery.projectAgentsDir) {
				lines.push(`Project agents directory: ${discovery.projectAgentsDir}`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n").trim() }],
				details: {
					count: agents.length,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					agents: agents.map((a) => ({
						name: a.name,
						description: a.description,
						source: a.source,
						tools: a.tools ?? [],
						model: a.model ?? null,
					})),
				},
			};
		},
	});

	// ── /list-agents command ──────────────────────────────────────────────────

	pi.registerCommand("list-agents", {
		description: "List all available subagents and their descriptions",
		handler: async (_args, ctx) => {
			const agentScope: AgentScope = "both";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;

			if (agents.length === 0) {
				ctx.ui.notify("No subagents found.", "info");
				return;
			}

			const lines: string[] = [];
			lines.push(`Available subagents (${agents.length} total):`);
			lines.push("");

			for (const agent of agents) {
				lines.push(`  ${agent.name}`);
				lines.push(`    ${agent.description}`);
				lines.push(`    Source: ${agent.source}`);
				if (agent.tools && agent.tools.length > 0) {
					lines.push(`    Allowed tools: ${agent.tools.join(", ")}`);
				}
				lines.push("");
			}

			lines.push(`Tip: use the ${FORK_SUBAGENT_TOOL} tool to delegate with the parent's full context.`);
			lines.push("");

			if (discovery.projectAgentsDir) {
				lines.push(`Project agents directory: ${discovery.projectAgentsDir}`);
			}

			ctx.ui.notify(lines.join("\n").trim(), "info");
		},
	});
}
