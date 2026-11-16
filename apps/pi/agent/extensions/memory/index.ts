/**
 * Memory - 跨 session 的用户记忆。
 *
 * 模型用 `remember` 主动记录长期有效的信息（用户偏好、纠正、项目上下文），
 * 用 `memory_recall` 按需查阅详情；`before_agent_start` 把记忆索引注入 system prompt，
 * 让每个新 session 都带着这些积累开始。
 *
 * 存储分两层，都是人可以随手编辑的纯 Markdown：
 * - 全局 `~/.pi/agent/memory/`：跨项目偏好与纠正
 * - 项目 `<git-root>/.pi/memory/`：只对某个仓库成立的上下文
 *
 * 设计取舍见 README.md。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	deleteEntry,
	ensureGitExcluded,
	formatIndexLine,
	type IndexSize,
	isMemoryType,
	listEntries,
	MAX_INDEX_BYTES,
	MAX_INDEX_LINES,
	MAX_TOPIC_CHARS,
	MEMORY_SCOPES,
	MEMORY_TYPES,
	matchesQuery,
	type MemoryContext,
	type MemoryEntry,
	type MemoryScope,
	type MemoryType,
	projectLabel,
	readConfig,
	readIndex,
	readTopic,
	resolveEntryFile,
	resolveMemoryContext,
	saveEntry,
	scopeDir,
	type TopicFile,
	truncate,
	writeConfig,
} from "./store.ts";

const TOOL_NAMES = ["remember", "memory_recall"];

/**
 * A `{ type: "string", enum: [...] }` schema with a literal static type.
 * Spelled out instead of `Type.Union([Type.Literal(...)])` because providers that
 * reject `anyOf`/`const` (Google) accept a plain string enum, and `Type.Unsafe`
 * keeps the parameter type narrow for `execute()`.
 */
function stringEnum<T extends string>(values: readonly T[], description: string) {
	return Type.Unsafe<T>({ type: "string", enum: [...values], description });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function contextFor(ctx: ExtensionContext): MemoryContext {
	return resolveMemoryContext(ctx.cwd);
}

function scopeLabel(context: MemoryContext, scope: MemoryScope): string {
	return scope === "global" ? "global" : `project (${projectLabel(context)})`;
}

/** Default layer: personal knowledge is global, repository knowledge is project. */
function defaultScope(type: MemoryType): MemoryScope {
	return type === "user" || type === "feedback" ? "global" : "project";
}

function entriesOf(context: MemoryContext, scope: MemoryScope): MemoryEntry[] {
	const dir = scopeDir(context, scope);
	return dir ? readIndex(dir, scope) : [];
}

/**
 * Entries from the requested layers, minus the project layer when the project is
 * not trusted. `.pi/memory` is data, not configuration, but its content reaches
 * the system prompt, so an untrusted clone must not be able to write there.
 */
function visibleEntries(context: MemoryContext, scope: MemoryScope | "all", trusted: boolean): MemoryEntry[] {
	return listEntries(context, scope).filter((entry) => trusted || entry.scope === "global");
}

/**
 * System-prompt section carrying both indexes. Omitted entirely when memory is
 * disabled or empty, so a fresh install adds no prompt tokens at all.
 */
function buildMemorySection(
	context: MemoryContext,
	options: { projectTrusted: boolean },
): string | undefined {
	const groups: string[] = [];
	let truncated = false;

	const addGroup = (title: string, entries: MemoryEntry[]) => {
		// Each layer gets its own budget, matching how measureIndex reports limits
		// per index file, so a large global index cannot starve the project layer.
		let budget = MAX_INDEX_BYTES;
		const lines: string[] = [];
		for (const entry of entries) {
			if (lines.length >= MAX_INDEX_LINES) {
				truncated = true;
				break;
			}
			const line = formatIndexLine(entry);
			budget -= Buffer.byteLength(line, "utf8") + 1;
			if (budget < 0) {
				truncated = true;
				break;
			}
			lines.push(line);
		}
		if (lines.length > 0) groups.push(`[${title}]\n${lines.join("\n")}`);
	};

	addGroup("global", entriesOf(context, "global"));
	if (options.projectTrusted) addGroup(`project ${projectLabel(context)}`, entriesOf(context, "project"));
	if (groups.length === 0) return undefined;

	return [
		"Memories saved in earlier sessions (index only).",
		"Read one in full with memory_recall; add or update one with remember.",
		...(truncated ? [`(Showing part of the index; the full set is on disk.)`] : []),
		"",
		groups.join("\n\n"),
	].join("\n");
}

function indexWarning(size: IndexSize): string | undefined {
	if (size.overLines || size.overBytes) {
		return [
			`The memory index is over its load limit (${size.lines} lines / ${size.bytes} bytes;`,
			`limit ${MAX_INDEX_LINES} lines or ${MAX_INDEX_BYTES} bytes). Entries past the limit will not`,
			"be loaded into future sessions. Merge related memories into one, or remove stale ones with",
			'remember({ action: "delete", name: "..." }), then save again.',
		].join(" ");
	}
	if (size.nearLimit) {
		return [
			`The memory index is near its load limit (${size.lines} lines / ${size.bytes} bytes).`,
			"Consider merging related memories or deleting stale ones with",
			'remember({ action: "delete", name: "..." }).',
		].join(" ");
	}
	return undefined;
}

/** Sync tool availability with the on/off switch. */
function applyEnabled(pi: ExtensionAPI, enabled: boolean): void {
	const active = pi.getActiveTools().filter((name) => !TOOL_NAMES.includes(name));
	pi.setActiveTools(enabled ? [...active, ...TOOL_NAMES] : active);
}

/** Gate for the tool bodies: `/memory off` may happen in another pi window. */
function disabledMessage(): string | undefined {
	return readConfig().enabled ? undefined : "Memory is turned off. The user can re-enable it with /memory on.";
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── remember ────────────────────────────────────────────────────────────

	pi.registerTool({
		name: "remember",
		label: "Remember",
		description: [
			"Save a durable memory that should still be true in future sessions, or delete one.",
			"Use it when the user states a lasting preference, corrects how you work, or tells you",
			"project context you cannot derive from the code. Do not save secrets, credentials,",
			"temporary state, or anything AGENTS.md already states. Saving under an existing name",
			"updates that memory; keep one memory per durable fact.",
		].join(" "),
		promptSnippet: "remember: save or delete a durable memory (preference, correction, project fact)",
		promptGuidelines: [
			"Call `remember` when the user gives a lasting instruction or preference, corrects your behavior, or shares project context the repository does not show. Skip secrets, temporary state, and anything AGENTS.md already says.",
		],
		defaultActive: false,
		// Saves are read-modify-write on the index; parallel calls would lose one.
		executionMode: "sequential",
		parameters: Type.Object({
			name: Type.String({
				minLength: 1,
				description:
					"Stable short name for this memory, such as 'prefers-pnpm' or 'release-flow'. Saving the same name updates the existing memory.",
			}),
			action: Type.Optional(
				stringEnum(["save", "delete"] as const, "What to do: save (default) writes or updates the memory; delete removes it."),
			),
			type: Type.Optional(
				stringEnum(
					MEMORY_TYPES,
					"user: role and working preferences. feedback: corrections and approaches the user confirmed. project: ongoing work, decisions, context the code does not show. reference: where to find outside information. Defaults to user.",
				),
			),
			summary: Type.Optional(
				Type.String({ description: "One short line for the memory index. Required when saving." }),
			),
			content: Type.Optional(
				Type.String({ description: "The memory itself, in Markdown. Required when saving." }),
			),
			scope: Type.Optional(
				stringEnum(
					MEMORY_SCOPES,
					"global: applies to every project on this machine. project: only this git repository. Defaults to global for user/feedback and project for project/reference.",
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const disabled = disabledMessage();
			if (disabled) {
				return { content: [{ type: "text", text: disabled }], isError: true, details: {} };
			}

			const context = contextFor(ctx);
			const type = params.type ?? "user";
			const action = params.action ?? "save";

			if (!isMemoryType(type)) {
				return {
					content: [{ type: "text", text: `Unknown memory type "${type}". Use one of: ${MEMORY_TYPES.join(", ")}.` }],
					isError: true,
					details: {},
				};
			}

			const scope = params.scope ?? defaultScope(type);
			if (scope === "project" && (!context.projectDir || !ctx.isProjectTrusted())) {
				const reason = context.projectDir
					? "this project is not trusted (project memory reaches the system prompt, so an untrusted project cannot write it)"
					: "the working directory is not a git repository";
				return {
					content: [{ type: "text", text: `Cannot save project memory: ${reason}. Retry with scope "global".` }],
					isError: true,
					details: { scope },
				};
			}

			try {
				if (action === "delete") {
					const result = deleteEntry(context, scope, params.name);
					if (!result.found) {
						return {
							content: [
								{ type: "text", text: `No memory named "${params.name}" in ${scopeLabel(context, scope)} memory.` },
							],
							isError: true,
							details: { scope, found: false },
						};
					}
					if (ctx.hasUI) ctx.ui.notify(`🗑️  Memory deleted: ${result.file}`, "info");
					return {
						content: [
							{
								type: "text",
								text: `Deleted ${result.file} from ${scopeLabel(context, scope)} memory (${result.size.lines} entries left).`,
							},
						],
						details: { scope, file: result.file, action: "delete" },
					};
				}

				const summary = params.summary?.trim();
				const content = params.content?.trim();
				if (!summary || !content) {
					return {
						content: [{ type: "text", text: "Both summary and content are required when saving a memory." }],
						isError: true,
						details: {},
					};
				}

				// Project memory is machine-local; keep it out of git status on first use.
				if (scope === "project" && context.projectRoot) ensureGitExcluded(context.projectRoot);

				const result = saveEntry(context, scope, { type, name: params.name, summary, content });
				const warning = indexWarning(result.size);
				const headline = [
					`${result.replaced ? "Updated" : "Saved"} [${type}] "${summary}"`,
					`in ${scopeLabel(context, scope)} memory (${result.file}).`,
				].join(" ");

				if (ctx.hasUI) ctx.ui.notify(`📝 Memory saved: ${truncate(summary, 80)}`, "info");

				return {
					content: [{ type: "text", text: warning ? `${headline}\n\n${warning}` : headline }],
					// Written, but the overflow never reaches future sessions: the model
					// has to prune and report rather than treat this as done.
					isError: result.size.overLines || result.size.overBytes,
					details: { scope, file: result.file, action: "save", replaced: result.replaced, ...result.size },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Memory write failed: ${(error as Error).message}` }],
					isError: true,
					details: {},
				};
			}
		},
	});

	// ── memory_recall ───────────────────────────────────────────────────────

	pi.registerTool({
		name: "memory_recall",
		label: "Recall Memory",
		description: [
			"Read saved memories in full. The memory index is already in your context; use this tool",
			"when a memory applies to the task and you need its details. Filter by keyword, type,",
			"layer, or exact name. Without a filter it lists every saved memory.",
		].join(" "),
		promptSnippet: "memory_recall: read a saved memory in full",
		promptGuidelines: [
			"Call `memory_recall` before relying on details of a memory that the index only summarizes.",
		],
		defaultActive: false,
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({ description: "Keyword matched against index summaries, names, and memory bodies." }),
			),
			name: Type.Optional(
				Type.String({ description: "Exact memory name or topic file name, for a direct lookup." }),
			),
			type: Type.Optional(stringEnum(MEMORY_TYPES, "Restrict results to one memory type.")),
			scope: Type.Optional(stringEnum(["all", ...MEMORY_SCOPES] as const, "Which layer to search. Defaults to all.")),
			limit: Type.Optional(Type.Number({ description: "Maximum number of full memories to return. Defaults to 3." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const disabled = disabledMessage();
			if (disabled) {
				return { content: [{ type: "text", text: disabled }], isError: true, details: { count: 0 } };
			}

			const context = contextFor(ctx);
			const scope = params.scope ?? "all";
			const limit = Math.max(1, Math.min(params.limit ?? 3, 10));

			const accessible = visibleEntries(context, scope, ctx.isProjectTrusted());
			if (accessible.length === 0 && scope === "project" && !ctx.isProjectTrusted()) {
				return {
					content: [{ type: "text", text: "Project memory is unavailable: this project is not trusted." }],
					isError: true,
					details: { count: 0 },
				};
			}

			let entries = params.type ? accessible.filter((entry) => entry.type === params.type) : accessible;

			if (params.name) {
				const file = resolveEntryFile(entries, params.name);
				const wanted = file ? entries.find((entry) => entry.file === file) : undefined;
				if (!wanted) {
					return {
						content: [{ type: "text", text: `No memory named "${params.name}".` }],
						isError: true,
						details: { count: 0 },
					};
				}
				entries = [wanted];
			} else if (params.query) {
				const query = params.query.toLowerCase();
				// Union of index and body matches: a summary hit must not hide a
				// memory whose relevance only shows in its body.
				entries = entries.filter((entry) => matchesQuery(entry, query) || bodyMatches(context, entry, query));
			}

			if (entries.length === 0) {
				const hint = params.query || params.name || params.type ? " matching that filter" : "";
				return {
					content: [{ type: "text", text: `No memories${hint}.` }],
					details: { count: 0 },
				};
			}

			const sections: string[] = [`${entries.length} match${entries.length === 1 ? "" : "es"}.`];
			for (const entry of entries.slice(0, limit)) {
				const dir = scopeDir(context, entry.scope);
				const topic = dir ? readTopic(dir, entry.file) : undefined;
				sections.push(`\n## [${entry.type}] ${entry.summary}\n${describeTopic(entry, topic)}`);
			}
			if (entries.length > limit) {
				sections.push(`\n(${entries.length - limit} more — narrow the query or raise limit.)`);
			}

			return {
				content: [{ type: "text", text: sections.join("\n") }],
				details: { count: entries.length, files: entries.slice(0, limit).map((entry) => entry.file) },
			};
		},
	});

	// ── Injection ───────────────────────────────────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		if (!readConfig().enabled) return;
		const section = buildMemorySection(contextFor(ctx), { projectTrusted: ctx.isProjectTrusted() });
		if (!section) return;
		event.systemPromptOptions.sections["user-memory"] = section;
	});

	// ── /memory ─────────────────────────────────────────────────────────────

	pi.registerCommand("memory", {
		description: "List, enable, disable, or locate saved memories",
		handler: async (args, ctx) => {
			const context = contextFor(ctx);
			const [sub = "list", ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);

			const say = (text: string, type: "info" | "warning" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(text, type);
				else console.log(text);
			};

			if (sub === "on" || sub === "off") {
				const enabled = sub === "on";
				writeConfig({ enabled });
				applyEnabled(pi, enabled);
				say(`Memory ${enabled ? "enabled" : "disabled"}`);
				return;
			}

			if (sub === "path") {
				say(
					[
						`global:  ${context.globalDir}`,
						`project: ${context.projectDir ?? "(not in a git repository)"}`,
					].join("\n"),
				);
				return;
			}

			if (sub !== "list") {
				say("Usage: /memory [list|on|off|path]", "warning");
				return;
			}

			const query = rest.join(" ").trim().toLowerCase();
			say(renderMemoryList(context, query, ctx.isProjectTrusted()));
		},
	});

	// ── Lifecycle ───────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		applyEnabled(pi, readConfig().enabled);
	});
}

// ─── Rendering helpers ──────────────────────────────────────────────────────

function bodyMatches(context: MemoryContext, entry: MemoryEntry, query: string): boolean {
	const dir = scopeDir(context, entry.scope);
	if (!dir) return false;
	return readTopic(dir, entry.file)?.body.toLowerCase().includes(query) ?? false;
}

function describeTopic(entry: MemoryEntry, topic: TopicFile | undefined): string {
	if (!topic) return `(topic file ${entry.file} is missing)`;
	const when = topic.modified ? `updated ${topic.modified.slice(0, 10)}` : "no timestamp";
	return `${truncate(topic.body, MAX_TOPIC_CHARS)}\n\n_${entry.scope} · ${entry.file} · ${when}_`;
}

function renderMemoryList(context: MemoryContext, query: string, projectTrusted: boolean): string {
	const config = readConfig();
	const groups: string[] = [];

	const addGroup = (title: string, entries: MemoryEntry[]) => {
		const filtered = query ? entries.filter((entry) => matchesQuery(entry, query)) : entries;
		if (filtered.length === 0) return;
		groups.push(`[${title}] ${filtered.length}\n${filtered.map(formatIndexLine).join("\n")}`);
	};

	addGroup("global", entriesOf(context, "global"));
	if (projectTrusted) addGroup(`project ${projectLabel(context)}`, entriesOf(context, "project"));

	if (groups.length === 0) {
		return query ? `No memories matching "${query}".` : "No memories saved yet.";
	}

	const notes = [
		`${config.enabled ? "enabled" : "disabled"} · /memory path to locate the files · edit them directly any time`,
	];
	if (!projectTrusted && context.projectDir) notes.push("project memory hidden: this project is not trusted");
	return `${groups.join("\n\n")}\n\n${notes.join("\n")}`;
}
