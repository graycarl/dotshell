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
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";

const MAX_SINGLE_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

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
	agentSource: "user" | "project" | "unknown";
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

interface SubagentDetails {
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
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

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: ${agentName}`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		};
	}

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	let tmpPromptPath: string | null = null;

	const args: string[] = ["--mode", "json", "-p", "--session-dir", tmpDir];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
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
		if (agent.systemPrompt.trim()) {
			const safeName = agentName.replace(/[^\w.-]+/g, "_");
			tmpPromptPath = path.join(tmpDir, `prompt-${safeName}.md`);
			fs.writeFileSync(tmpPromptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn("pi", args, { cwd: cwd ?? defaultCwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let buffer = "";

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

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
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
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
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
			const sessionFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".jsonl"));
			if (sessionFiles.length > 0) {
				const sessionFile = path.join(tmpDir, sessionFiles[0]);
				const safeName = agentName.replace(/[^\w.-]+/g, "_");
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
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"To parallelize, issue multiple subagent calls in the same assistant turn; they run concurrently.",
			`At most ${MAX_SINGLE_CONCURRENCY} subagent processes run at once; excess calls queue until a slot frees.`, "",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		promptGuidelines: [
			"When delegating to a subagent, always specify the exact agent name. If you are unsure which agents are available, first call list_agents to discover available subagents and their descriptions.",
			"To run independent subagents in parallel, issue multiple subagent tool calls in the same assistant turn instead of waiting for each to finish sequentially.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const makeDetails = (results: SingleResult[]): SubagentDetails => ({
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

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const agent = agents.find((a) => a.name === params.agent);
				if (agent?.source === "project") {
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${params.agent}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails([]),
						};
				}
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
				result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					signal,
					onUpdate,
					makeDetails,
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
			const scope: AgentScope = args.agentScope ?? "user";
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
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
		},
	});

	// ── list_agents tool ─────────────────────────────────────────────────────

	pi.registerTool({
		name: "list_agents",
		label: "List Agents",
		description: [
			"Discover available subagents and their descriptions.",
			"Use this to find the correct agent name before calling subagent.",
			"Scans user agents (~/.pi/agent/agents/) and optionally project agents (.pi/agents/).",
		].join(" "),
		promptSnippet: "Discover available subagents and their descriptions",
		promptGuidelines: [
			"Call list_agents first when you need to delegate work to a subagent but are unsure which agent name to use.",
			"Review the returned agent names and descriptions, then use the correct name with the subagent tool.",
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

			if (discovery.projectAgentsDir) {
				lines.push(`Project agents directory: ${discovery.projectAgentsDir}`);
			}

			ctx.ui.notify(lines.join("\n").trim(), "info");
		},
	});
}
