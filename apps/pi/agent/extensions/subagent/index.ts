/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Delegates one task to a specialized agent. To parallelize, the LLM issues
 * multiple calls in the same assistant turn.
 *
 * Every run is persisted in its own directory under
 * `<agent dir>/subagent-sessions/<agentId>/`, so a finished subagent can be
 * resumed later with `resume_subagent`: the child session file is re-opened
 * with `pi --session <file>` and keeps its own context across turns.
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
const RESUME_SUBAGENT_TOOL = "resume_subagent";
const RECURSION_EXCLUDE_TOOLS = `${SPAWN_SUBAGENT_TOOL},list_agents,${FORK_SUBAGENT_TOOL},${RESUME_SUBAGENT_TOOL}`;

// 措辞对多轮续接同样成立：首轮之后的历史是该子 agent 自己的产出。
const FORK_SYSTEM_PROMPT = [
	"You are a forked sub-agent of pi.",
	"The beginning of this session was forked from the main agent as background context, not your own prior work.",
	"Any later turns in this session are your own work; continue from them instead of starting over.",
	"Treat the inherited history strictly as background, then complete the task given in the final user message.",
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
	/** Text shown in the TUI (the task on a first run, the message when resuming). */
	task: string;
	/** Exact text appended as the final user message. */
	prompt: string;
	/** Model to use when the agent spec does not define one (the parent's current model). */
	parentModel?: string;
	/** When set, the subprocess forks this context instead of starting fresh. */
	forkContext?: ForkContext;
	/** Persisted session to create/continue; without it the run uses a throwaway tmp dir. */
	run?: PersistedRun;
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
	/** Handle used to resume this subagent later; absent when persistence failed. */
	agentId?: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	htmlReportPath?: string;
	/** Set when the run could not be persisted and therefore cannot be resumed. */
	persistenceWarning?: string;
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

/** `${provider}/${id}` label for a model, as accepted by `--model`. */
function formatModelLabel(model: { provider: string; id: string } | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
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

// ── 持久化子会话：目录布局、元数据、过期清理 ─────────────────
// 每个可续接的 subagent 拥有独立目录：
//   <root>/<agentId>/<pi-session>.jsonl  — 子进程的 --session-dir 直接指向该目录
//   <root>/<agentId>/system.md           — 首轮系统提示词快照，续接时复用
//   <root>/<agentId>/meta.json           — 运行配置快照 + 活跃时间
// resume 用 `pi --session <jsonl>` 打开既有会话，因此上下文得以延续。
const SUBAGENT_SESSION_DIRNAME = "subagent-sessions";
const SYSTEM_PROMPT_FILENAME = "system.md";
const FORK_SOURCE_FILENAME = "parent.jsonl";
/** 未活跃超过该天数的子会话目录会在父进程启动时被清理。 */
const RETENTION_DAYS = 180;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** agentId 同时作为目录名，必须无法逃出 subagent-sessions 根目录。 */
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;

interface AgentMeta {
	agentId: string;
	kind: "spawn" | "fork";
	/** Agent definition name (the tool name for fork runs). */
	agent: string;
	/** Where the agent definition came from; drives the TUI label on resume. */
	source?: "user" | "project" | "builtin";
	model?: string;
	tools?: string;
	excludeTools?: string;
	sessionFile?: string;
	parentSession?: string;
	createdAt: string;
	lastActiveAt: string;
}

/** A persisted child session that `resume_subagent` can continue. */
interface PersistedRun {
	agentId: string;
	/** Directory holding the child session file, its system prompt and meta.json. */
	dir: string;
	/** When set, `pi --session <file>` continues this session instead of starting a new one. */
	sessionFile?: string;
}

/** Agent ids currently running in this process; also blocks concurrent resumes. */
const activeAgentIds = new Set<string>();

/** Reserve an agent id for the duration of one run. */
function claimAgentId(agentId: string): boolean {
	if (activeAgentIds.has(agentId)) return false;
	activeAgentIds.add(agentId);
	return true;
}

function releaseAgentId(agentId: string): void {
	activeAgentIds.delete(agentId);
}

function expandTilde(p: string): string {
	const expanded = p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
	return path.resolve(expanded);
}

/** Root of the persisted subagent sessions, alongside pi's own session storage. */
function agentSessionsRoot(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
	const base = agentDir && agentDir.length > 0 ? expandTilde(agentDir) : path.join(os.homedir(), ".pi", "agent");
	return path.join(base, SUBAGENT_SESSION_DIRNAME);
}

/** agentId prefix derived from the agent name, so ids stay recognizable. */
function sanitizeAgentName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24)
		.replace(/-+$/, "");
	return slug || "agent";
}

function writeAgentMeta(dir: string, meta: AgentMeta): boolean {
	const file = path.join(dir, "meta.json");
	const tmp = `${file}.tmp`;
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
		fs.renameSync(tmp, file);
		return true;
	} catch {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		return false;
	}
}

function readAgentMeta(dir: string): AgentMeta | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8")) as AgentMeta;
		if (!parsed || typeof parsed.agentId !== "string" || !parsed.agentId) return null;
		if (typeof parsed.agent !== "string" || !parsed.agent.trim()) return null;
		if (parsed.kind !== "spawn" && parsed.kind !== "fork") return null;
		if (parsed.source !== undefined && !["user", "project", "builtin"].includes(parsed.source)) return null;
		// Optional fields feed child argv/session lookup, so reject non-strings outright.
		const optionalStrings = [parsed.model, parsed.tools, parsed.excludeTools, parsed.sessionFile];
		if (optionalStrings.some((value) => value !== undefined && typeof value !== "string")) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** Refresh the last-active timestamp (and optionally the session file) of a persisted run. */
function touchAgentMeta(dir: string, patch: Partial<AgentMeta> = {}): void {
	const meta = readAgentMeta(dir);
	if (!meta) return;
	writeAgentMeta(dir, { ...meta, ...patch, lastActiveAt: new Date().toISOString() });
}

/**
 * Create the directory + metadata for a fresh run.
 * Returns null when the directory cannot be created; the caller then runs
 * without persistence (the result simply cannot be resumed).
 */
function createPersistedRun(meta: Omit<AgentMeta, "agentId" | "createdAt" | "lastActiveAt">): PersistedRun | null {
	const root = agentSessionsRoot();
	try {
		fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	} catch {
		return null;
	}
	const slug = sanitizeAgentName(meta.agent);
	for (let attempt = 0; attempt < 20; attempt++) {
		const agentId = `${slug}-${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}`;
		const dir = path.join(root, agentId);
		try {
			// Non-recursive: an existing directory must be an error, not silently reused.
			fs.mkdirSync(dir, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "EEXIST") continue;
			return null;
		}
		const now = new Date().toISOString();
		if (!writeAgentMeta(dir, { ...meta, agentId, createdAt: now, lastActiveAt: now })) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
			return null;
		}
		return { agentId, dir };
	}
	return null;
}

/** Resolve an agent id to its directory; null when the id is invalid or unknown. */
function resolveAgentDir(agentId: string): string | null {
	if (!AGENT_ID_PATTERN.test(agentId)) return null;
	const dir = path.join(agentSessionsRoot(), agentId);
	return fs.existsSync(dir) ? dir : null;
}

/** Most recently active agent ids, used to hint when an agentId is unknown. */
function listRecentAgentIds(limit = 5): string[] {
	const root = agentSessionsRoot();
	try {
		return fs
			.readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && AGENT_ID_PATTERN.test(entry.name))
			.map((entry) => {
				const dir = path.join(root, entry.name);
				return { id: entry.name, lastActive: agentLastActiveMs(dir) ?? 0 };
			})
			.sort((a, b) => b.lastActive - a.lastActive)
			.slice(0, limit)
			.map((entry) => entry.id);
	} catch {
		return [];
	}
}

/** Last activity of an agent dir: its recorded timestamp, else the directory mtime. */
function agentLastActiveMs(dir: string): number | undefined {
	const meta = readAgentMeta(dir);
	if (meta?.lastActiveAt) {
		const parsed = Date.parse(meta.lastActiveAt);
		if (!Number.isNaN(parsed)) return parsed;
	}
	try {
		return fs.statSync(dir).mtimeMs;
	} catch {
		return undefined;
	}
}

/** Session file recorded in meta.json, but only when it really lives inside the agent dir. */
function resolveSessionFile(dir: string, recorded: string | undefined): string | undefined {
	if (recorded) {
		const resolved = path.resolve(dir, recorded);
		if (resolved.startsWith(`${path.resolve(dir)}${path.sep}`) && resolved.endsWith(".jsonl") && fs.existsSync(resolved)) {
			return resolved;
		}
	}
	return findSessionFile(dir);
}

/** Newest session file inside an agent dir, ignoring the fork source fixture. */
function findSessionFile(dir: string): string | undefined {
	try {
		const candidates = fs
			.readdirSync(dir)
			.filter((name) => name.endsWith(".jsonl") && name !== FORK_SOURCE_FILENAME)
			.map((name) => {
				const filePath = path.join(dir, name);
				try {
					return { filePath, mtime: fs.statSync(filePath).mtimeMs };
				} catch {
					return null;
				}
			})
			.filter((entry): entry is { filePath: string; mtime: number } => entry !== null)
			.sort((a, b) => b.mtime - a.mtime);
		return candidates[0]?.filePath;
	} catch {
		return undefined;
	}
}

/** Delete persisted subagent sessions untouched for RETENTION_DAYS. */
function pruneAgentSessions(): void {
	const root = agentSessionsRoot();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	const now = Date.now();
	for (const entry of entries) {
		if (!entry.isDirectory() || !AGENT_ID_PATTERN.test(entry.name)) continue;
		if (activeAgentIds.has(entry.name)) continue;
		const dir = path.join(root, entry.name);
		const lastActive = agentLastActiveMs(dir);
		if (lastActive === undefined || now - lastActive <= RETENTION_MS) continue;
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
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
	sessionDir: string,
): string {
	const filePath = path.join(sessionDir, FORK_SOURCE_FILENAME);
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

/** Follow-up message sent to a subagent that already finished its first turn. */
function buildResumePrompt(message: string): string {
	return `继续推进上面这项任务，以下是新的输入：\n\n${message}`;
}

type OnUpdateCallback = (partial: AgentToolResult<AgentDetails>) => void;

async function runAgent(defaultCwd: string, spec: AgentSpec, options: RunAgentOptions): Promise<SingleResult> {
	const { task, prompt, parentModel, forkContext, signal, onUpdate, makeDetails, run } = options;
	const isFork = !!forkContext && forkContext.entries.length > 0;
	const effectiveModel = spec.model ?? parentModel;
	const agentId = run?.agentId;
	const resumeSessionFile = run?.sessionFile;
	// Persisted runs keep their session in the agent dir so a later resume can
	// re-open it; runs without a persistent dir fall back to a throwaway tmp dir.
	const sessionDir = run ? run.dir : fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const disposable = !run;
	let forkSourcePath: string | null = null;
	let sessionFile: string | undefined;

	const args: string[] = ["--mode", "json", "-p", "--session-dir", sessionDir];
	// 子进程不暴露委派类工具，防止无限递归；再叠加 agent 定义的 excludeTools。
	const effectiveExcludeTools = [spec.excludeTools, RECURSION_EXCLUDE_TOOLS]
		.filter((s): s is string => !!s && s.trim().length > 0)
		.join(",");

	if (effectiveModel) args.push("--model", effectiveModel);
	if (spec.tools) args.push("--tools", spec.tools);
	if (effectiveExcludeTools) args.push("--exclude-tools", effectiveExcludeTools);

	const currentResult: SingleResult = {
		agent: spec.name,
		agentSource: spec.source,
		agentId,
		task,
		exitCode: 0,
		persistenceWarning: run ? undefined : "session persistence unavailable; this run cannot be resumed",
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: effectiveModel,
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
		if (resumeSessionFile) {
			// Continue the same child session: `pi --session <file>` appends to it.
			args.push("--session", resumeSessionFile);
		} else if (isFork && forkContext) {
			forkSourcePath = writeForkSourceFile(forkContext.entries, defaultCwd, forkContext.parentSession, sessionDir);
			args.push("--session-id", createForkSessionId(), "--fork", forkSourcePath);
		}

		if (spec.systemPrompt.trim()) {
			// Persisted runs keep the prompt in the agent dir, so resume reuses it verbatim.
			const safeName = spec.name.replace(/[^\w.-]+/g, "_");
			const promptPath = path.join(sessionDir, run ? SYSTEM_PROMPT_FILENAME : `prompt-${safeName}.md`);
			fs.writeFileSync(promptPath, spec.systemPrompt, { encoding: "utf-8", mode: 0o600 });
			args.push("--append-system-prompt", promptPath);
		}

		args.push(prompt);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			// PI_SUBAGENT lets extensions tell a subagent process from the
			// interactive session that spawned it; it inherits TMUX/TMUX_PANE
			// and must not touch the parent's terminal state.
			const proc = spawn("pi", args, {
				cwd: defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PI_SUBAGENT: "1" },
			});
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
		// Record the child session file so a later resume_subagent can re-open it.
		sessionFile = findSessionFile(sessionDir);
		if (run && sessionFile) touchAgentMeta(run.dir, { sessionFile });
		if (wasAborted) throw new Error("Subagent was aborted");

		// Generate HTML report from the saved session file
		if (sessionFile) {
			try {
				const safeName = spec.name.replace(/[^\w.-]+/g, "_");
				const htmlPath = path.join(os.tmpdir(), `pi-subagent-${safeName}-${Date.now()}.html`);
				const exportResult = spawnSync("pi", ["--export", sessionFile, htmlPath], { timeout: 15000 });
				if (exportResult.status === 0) {
					currentResult.htmlReportPath = htmlPath;
				}
			} catch {
				/* export failure is non-fatal */
			}
		}

		return currentResult;
	} finally {
		if (forkSourcePath) {
			try { fs.unlinkSync(forkSourcePath); } catch { /* ignore */ }
		}
		if (disposable) {
			// Throwaway dir: prompt file + session files
			try {
				const entries = fs.readdirSync(sessionDir);
				for (const entry of entries) {
					try { fs.unlinkSync(path.join(sessionDir, entry)); } catch { /* ignore */ }
				}
				fs.rmdirSync(sessionDir);
			} catch { /* ignore */ }
		} else if (run && !resumeSessionFile && !sessionFile) {
			// Nothing was ever written (e.g. the child failed to start): drop the empty
			// directory so we do not advertise an agentId that can never be resumed.
			try { fs.rmSync(run.dir, { recursive: true, force: true }); } catch { /* ignore */ }
			currentResult.agentId = undefined;
			currentResult.persistenceWarning = "the run produced no session file; this agent cannot be resumed";
		}
	}
}

/**
 * Create the persisted session, reserve its agent id, run the agent in it, then
 * release the id. A failed createPersistedRun degrades to a throwaway run.
 */
async function runPersistedAgent(
	cwd: string,
	spec: AgentSpec,
	meta: Omit<AgentMeta, "agentId" | "createdAt" | "lastActiveAt">,
	options: Omit<RunAgentOptions, "run">,
): Promise<SingleResult> {
	const run = createPersistedRun(meta);
	if (run) claimAgentId(run.agentId);
	try {
		return await runAgent(cwd, spec, { ...options, run: run ?? undefined });
	} finally {
		if (run) releaseAgentId(run.agentId);
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
		if (r.agentId) header += theme.fg("dim", ` ${r.agentId}`);
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
	if (r.agentId) text += theme.fg("dim", ` ${r.agentId}`);
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

/** Render the final tool result shared by spawn_subagent and fork_subagent. */
function finalizeResult(
	result: SingleResult,
	makeDetails: (results: SingleResult[]) => AgentDetails,
): AgentToolResult<AgentDetails> {
	const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
	// The agent id is the handle for resuming this subagent in a later turn.
	const header = [
		result.agentId ? `agentId: ${result.agentId} (resume with ${RESUME_SUBAGENT_TOOL})` : undefined,
		result.persistenceWarning,
	]
		.filter((line): line is string => !!line)
		.join("\n");
	const prefix = header ? `${header}\n` : "";
	if (isError) {
		const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
		return {
			content: [{ type: "text", text: `${prefix}Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
			details: makeDetails([result]),
			isError: true,
		};
	}
	return {
		content: [{ type: "text", text: `${prefix}${getFinalOutput(result.messages) || "(no output)"}` }],
		details: makeDetails([result]),
	};
}

/** Format the agent list shared by the list_agents tool and /list-agents command. */
function formatAgentList(
	agents: AgentConfig[],
	projectAgentsDir: string | null | undefined,
	labels: { header: string; descriptionLabel: string; toolsLabel: string },
): string[] {
	const lines: string[] = [labels.header, ""];
	for (const agent of agents) {
		lines.push(`  ${agent.name}`);
		lines.push(`    ${labels.descriptionLabel}${agent.description}`);
		lines.push(`    Source: ${agent.source}`);
		if (agent.tools && agent.tools.length > 0) {
			lines.push(`    ${labels.toolsLabel}${agent.tools.join(", ")}`);
		}
		lines.push("");
	}
	lines.push(`Tip: use the ${FORK_SUBAGENT_TOOL} tool to delegate with the parent's full context.`);
	lines.push("");
	if (projectAgentsDir) {
		lines.push(`Project agents directory: ${projectAgentsDir}`);
	}
	return lines;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: SPAWN_SUBAGENT_TOOL,
		label: "Spawn Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			`For tasks that need the parent's accumulated context, use the ${FORK_SUBAGENT_TOOL} tool instead.`,
			"To parallelize, issue multiple spawn_subagent calls in the same assistant turn; they run concurrently.",
			"The result starts with `agentId: <id>`; keep that id to send follow-up work to the same subagent with the resume_subagent tool.",
			`At most ${MAX_SINGLE_CONCURRENCY} subagent processes run at once; excess calls queue until a slot frees.`, "",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		promptGuidelines: [
			"When delegating to a subagent, always specify the exact agent name. If you are unsure which agents are available, first call list_agents to discover available subagents and their descriptions.",
			`Use the ${FORK_SUBAGENT_TOOL} tool when the sub-task needs the parent's accumulated context; use spawn_subagent for isolated recon with a fresh context.`,
			"To run independent subagents in parallel, issue multiple spawn_subagent calls in the same assistant turn instead of waiting for each to finish sequentially.",
			`When the follow-up depends on what a subagent already did, keep its agentId and use ${RESUME_SUBAGENT_TOOL} instead of spawning a new agent.`,
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
				const parentModel = formatModelLabel(ctx.model);
				if (params.model) spec.model = params.model;
				result = await runPersistedAgent(
					ctx.cwd,
					spec,
					{
						kind: "spawn",
						agent: targetAgent.name,
						source: spec.source,
						model: spec.model ?? parentModel,
						tools: spec.tools,
						excludeTools: spec.excludeTools,
						parentSession: ctx.sessionManager.getSessionFile(),
					},
					{
						task: params.task,
						prompt: buildTaskPrompt(params.task, false),
						parentModel,
						signal,
						onUpdate,
						makeDetails,
					},
				);
			} finally {
				release();
			}
			return finalizeResult(result, makeDetails);
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

	// ── fork_subagent tool ──────────────────────────────────────

	pi.registerTool({
		name: FORK_SUBAGENT_TOOL,
		label: "Fork Agent",
		description: [
			"Delegate a task to a forked subagent that inherits the main agent's full conversation context.",
			"The forked agent sees the current conversation as shared history and completes the task independently in an isolated session.",
			"Use it when the sub-task needs context already gathered in this session; use the spawn_subagent tool for isolated recon with a fresh context.",
			"The result starts with `agentId: <id>`; keep that id to send follow-up work to the same fork with the resume_subagent tool.",
			`At most ${MAX_SINGLE_CONCURRENCY} subagent processes run at once; excess calls queue until a slot frees.`,
		].join(" "),
		promptGuidelines: [
			`Use ${FORK_SUBAGENT_TOOL} when the sub-task needs the parent's accumulated context; use spawn_subagent for isolated recon with a fresh context.`,
			`To run independent forks in parallel, issue multiple ${FORK_SUBAGENT_TOOL} calls in the same assistant turn.`,
			`Keep the returned agentId and use ${RESUME_SUBAGENT_TOOL} when the follow-up builds on what that fork already did.`,
		],
		parameters: Type.Object({
			task: Type.String({ description: "Task for the forked agent to complete independently" }),
			model: Type.Optional(
				Type.String({
					description: 'Model for the fork (e.g. "deepseek/deepseek-flash"); default: inherit the parent model',
				}),
			),
			tools: Type.Optional(
				Type.String({
					description:
						"Comma-separated tool allowlist; default: the child pi's own default tools (not inherited from the parent)",
				}),
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
				result = await runPersistedAgent(
					ctx.cwd,
					{
						name: FORK_SUBAGENT_TOOL,
						source: "builtin",
						systemPrompt: FORK_SYSTEM_PROMPT,
						model: params.model,
						tools: params.tools,
					},
					{
						kind: "fork",
						agent: FORK_SUBAGENT_TOOL,
						source: "builtin",
						model: params.model ?? formatModelLabel(ctx.model),
						tools: params.tools,
						parentSession: ctx.sessionManager.getSessionFile(),
					},
					{
						task: params.task,
						prompt: buildTaskPrompt(params.task, true),
						parentModel: formatModelLabel(ctx.model),
						forkContext,
						signal,
						onUpdate,
						makeDetails,
					},
				);
			} finally {
				release();
			}

			return finalizeResult(result, makeDetails);
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

	// ── resume_subagent tool ────────────────────────────────────

	pi.registerTool({
		name: RESUME_SUBAGENT_TOOL,
		label: "Resume Agent",
		description: [
			"Send a follow-up message to a subagent that already finished, continuing its own context.",
			"Every spawn_subagent / fork_subagent result starts with `agentId: <id>`; pass that id here.",
			"Use it for review→fix loops: after another agent reviews the work, resume the original coding agent with the review findings so it fixes them with its earlier context intact.",
			"The subagent keeps the system prompt, tools and model it was created with; only its session is continued.",
			`Resuming an agent that is still running fails with "is busy"; at most ${MAX_SINGLE_CONCURRENCY} subagent processes run at once.`,
		].join(" "),
		promptGuidelines: [
			`Prefer ${RESUME_SUBAGENT_TOOL} over a fresh spawn_subagent whenever the follow-up depends on what a previous subagent already did.`,
			`Typical loop: spawn a coding agent → review its work with a fresh subagent → ${RESUME_SUBAGENT_TOOL} the coding agent with the review findings → repeat until clean.`,
			"Put the full instruction in `message`; the subagent cannot see anything except its own session history.",
		],
		parameters: Type.Object({
			agentId: Type.String({
				description: 'Agent id returned by spawn_subagent / fork_subagent (e.g. "worker-3f9a1c02")',
			}),
			message: Type.String({ description: "Follow-up message to deliver to that subagent" }),
			model: Type.Optional(
				Type.String({
					description:
						'Model override for this run only (e.g. "deepseek/deepseek-flash"); default: the model the agent was created with',
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const makeDetails = (results: SingleResult[]): AgentDetails => ({ results });

			const dir = resolveAgentDir(params.agentId);
			if (!dir) {
				const recent = listRecentAgentIds();
				const hint =
					recent.length > 0 ? ` Recent agent ids: ${recent.join(", ")}.` : " No resumable subagent sessions found.";
				return {
					content: [{ type: "text", text: `Unknown or invalid agentId: ${params.agentId}.${hint}` }],
					details: makeDetails([]),
					isError: true,
				};
			}

			const meta = readAgentMeta(dir);
			if (!meta) {
				return {
					content: [{ type: "text", text: `Cannot resume ${params.agentId}: meta.json is missing or unreadable.` }],
					details: makeDetails([]),
					isError: true,
				};
			}

			const sessionFile = resolveSessionFile(dir, meta.sessionFile);
			if (!sessionFile) {
				return {
					content: [
						{
							type: "text",
							text: `Cannot resume ${params.agentId}: it has no session file yet (its first run never started).`,
						},
					],
					details: makeDetails([]),
					isError: true,
				};
			}

			if (!claimAgentId(params.agentId)) {
				return {
					content: [
						{
							type: "text",
							text: `Agent ${params.agentId} is busy; wait for its current run to finish before resuming it.`,
						},
					],
					details: makeDetails([]),
					isError: true,
				};
			}

			try {
				// Reuse the system prompt snapshot; a missing one falls back to the child's default prompt.
				let systemPrompt = "";
				try {
					systemPrompt = fs.readFileSync(path.join(dir, SYSTEM_PROMPT_FILENAME), "utf-8");
				} catch {
					/* ignore */
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
							name: meta.agent,
							source: meta.source ?? (meta.kind === "fork" ? "builtin" : "user"),
							systemPrompt,
							tools: meta.tools,
							excludeTools: meta.excludeTools,
							model: params.model ?? meta.model,
						},
						{
							task: params.message,
							prompt: buildResumePrompt(params.message),
							// Deliberately no parentModel fallback: the recorded model (or pi's own
							// default when none was recorded) keeps resumed runs reproducible.
							run: { agentId: params.agentId, dir, sessionFile },
							signal,
							onUpdate,
							makeDetails,
						},
					);
				} finally {
					release();
				}
				return finalizeResult(result, makeDetails);
			} finally {
				releaseAgentId(params.agentId);
			}
		},

		renderCall(args, theme) {
			const preview = args.message ? (args.message.length > 60 ? `${args.message.slice(0, 60)}...` : args.message) : "...";
			const text =
				theme.fg("toolTitle", theme.bold(`${RESUME_SUBAGENT_TOOL} `)) +
				theme.fg("accent", args.agentId || "...") +
				`\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			return renderAgentResult(result, expanded, theme);
		},
	});

	// ── list_agents tool ─────────────────────────────────────────────────────
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

			const lines = formatAgentList(agents, discovery.projectAgentsDir, {
				header: `Found ${agents.length} subagent(s) (scope: ${agentScope}):`,
				descriptionLabel: "Description: ",
				toolsLabel: "Tools: ",
			});

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

			const lines = formatAgentList(agents, discovery.projectAgentsDir, {
				header: `Available subagents (${agents.length} total):`,
				descriptionLabel: "",
				toolsLabel: "Allowed tools: ",
			});

			ctx.ui.notify(lines.join("\n").trim(), "info");
		},
	});

	// ── 过期子会话清理 ──────────────────────────────────────────────────────────

	pi.on("session_start", async () => {
		// Only the interactive parent prunes; subagent processes skip it.
		if (process.env.PI_SUBAGENT) return;
		pruneAgentSessions();
	});
}
