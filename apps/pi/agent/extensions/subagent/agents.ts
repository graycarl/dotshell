/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type AgentContextMode = "fresh" | "fork";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	/** Extra tools to disable for this agent (passed as --exclude-tools). */
	excludeTools?: string;
	/** "fork" inherits the parent's full conversation context; "fresh" starts isolated. */
	context?: AgentContextMode;
	systemPrompt: string;
	source: "user" | "project" | "builtin";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);
		const rawContext = frontmatter.context?.trim();
		const context: AgentContextMode | undefined =
			rawContext === "fork" || rawContext === "fresh" ? (rawContext as AgentContextMode) : undefined;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			excludeTools: frontmatter.excludeTools?.trim() || undefined,
			context,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export const FORK_AGENT_NAME = "fork";
export const WORKER_NAME = "worker";

const FORK_SYSTEM_PROMPT = [
	"You are fork, a built-in sub-agent of pi.",
	"You were forked from the main agent's session: the conversation above is shared history, not your own past work on this task.",
	"Treat it strictly as background context.",
	"Work autonomously to complete the task in the final user message.",
	"You cannot ask the user questions; if you are blocked, report the blocker instead of waiting.",
	"When you finish, reply with a concise report: what you did, your findings, files changed (with paths), and anything the main agent must know.",
	"Do not call the subagent or list_agents tools.",
].join(" ");

const WORKER_SYSTEM_PROMPT = [
	"You are a worker agent with full capabilities.",
	"You operate in an isolated context window to handle delegated tasks without polluting the main conversation.",
	"",
	"Work autonomously to complete the assigned task. Use all available tools as needed.",
	"",
	"Output format when finished:",
	"",
	"## Completed",
	"What was done.",
	"",
	"## Files Changed",
	"- `path/to/file.ts` - what changed",
	"",
	"## Notes (if any)",
	"Anything the main agent should know.",
	"",
	"If handing off to another agent (e.g. reviewer), include:",
	"- Exact file paths changed",
	"- Key functions/types touched (short list)",
].join("\n");

/** Agents shipped with the extension, usable without a markdown definition. */
export const BUILTIN_AGENTS: AgentConfig[] = [
	{
		name: FORK_AGENT_NAME,
		description:
			"Built-in forked sub-agent: inherits the main agent's full conversation context and completes the task independently. Use when the delegated task needs context already gathered in this session.",
		context: "fork",
		systemPrompt: FORK_SYSTEM_PROMPT,
		source: "builtin",
		filePath: "(builtin)",
	},
	{
		name: WORKER_NAME,
		description: "General-purpose subagent with full capabilities, isolated context",
		context: "fresh",
		systemPrompt: WORKER_SYSTEM_PROMPT,
		source: "builtin",
		filePath: "(builtin)",
	},
];

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	// Built-in agents are always available; user/project agents may override them by name.
	for (const agent of BUILTIN_AGENTS) agentMap.set(agent.name, agent);

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
