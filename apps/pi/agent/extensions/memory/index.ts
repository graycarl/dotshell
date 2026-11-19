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
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	deleteEntry,
	formatCapacity,
	formatIndexLine,
	type IndexSize,
	isMemoryType,
	listEntries,
	MAX_INDEX_BYTES,
	MAX_INDEX_LINES,
	MAX_TOPIC_CHARS,
	measureIndex,
	MEMORY_SCOPES,
	MEMORY_TYPES,
	matchesQuery,
	type MemoryContext,
	type MemoryEntry,
	memoryKey,
	type MemoryScope,
	type MemoryType,
	moveEntry,
	projectLabel,
	readConfig,
	readIndex,
	readTopic,
	resolveEntry,
	resolveEntryFile,
	resolveMemoryContext,
	rewriteEntry,
	saveEntry,
	scopeDir,
	slugify,
	type TopicFile,
	truncate,
	writeConfig,
} from "./store.ts";
import {
	MemoryOverlay,
	type MemoryLayerView,
	type MemoryPanelResult,
	type MemoryPanelState,
} from "./ui.ts";

const TOOL_NAMES = ["remember", "memory_recall"];

/**
 * Last session's resolved context and trust flag, so `/memory` argument
 * completion can name memories: `getArgumentCompletions(prefix)` gets no
 * context, and resolving one shells out to git.
 */
let lastContext: MemoryContext | undefined;
let lastTrusted = false;

function trackSession(cwd: string, trusted: boolean): void {
	lastContext = resolveMemoryContext(cwd);
	lastTrusted = trusted;
}

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

/** Entries this session may see, optionally narrowed to one layer. */
function visibleFor(context: MemoryContext, projectTrusted: boolean, scope?: MemoryScope): MemoryEntry[] {
	return visibleEntries(context, "all", projectTrusted).filter((entry) => !scope || entry.scope === scope);
}

/** `<type> summary (layer · file)` lines: the file name is what disambiguates. */
function describeCandidates(candidates: MemoryEntry[], context: MemoryContext): string {
	const shown = candidates.slice(0, 5).map(
		(entry) => `  [${entry.type}] ${entry.summary} (${scopeLabel(context, entry.scope)} · ${entry.file})`,
	);
	if (candidates.length > shown.length) shown.push(`  … ${candidates.length - shown.length} more`);
	return shown.join("\n");
}

/** Why a name did not resolve to exactly one entry, and what to do about it. */
function ambiguityMessage(name: string, candidates: MemoryEntry[], context: MemoryContext): string {
	const scopes = [...new Set(candidates.map((entry) => entry.scope))];
	const hint =
		scopes.length > 1
			? `exists in more than one layer — add ${scopes.map((scope) => `--${scope}`).join(" or ")}, or use the full name`
			: `matches ${candidates.length} memories — use the full name`;
	return `"${name}" ${hint}:\n${describeCandidates(candidates, context)}`;
}

/** `--global` / `--project` narrow name resolution to one layer. */
function scopeFlag(words: string[]): MemoryScope | undefined {
	if (words.includes("--project")) return "project";
	if (words.includes("--global")) return "global";
	return undefined;
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
		description: "List, inspect, edit, or prune saved memories",
		getArgumentCompletions: (prefix) => memoryCompletions(prefix),
		handler: async (args, ctx) => {
			const context = contextFor(ctx);
			trackSession(ctx.cwd, ctx.isProjectTrusted());
			const [sub = "", ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);

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

			if (sub === "help") {
				say(MEMORY_USAGE);
				return;
			}

			// No subcommand: the panel is the point of the command in a TUI; every
			// other mode only has text, so it lists.
			if (sub === "" && ctx.mode === "tui") {
				await runMemoryPanel(ctx);
				return;
			}

			if (sub === "" || sub === "list") {
				const query = rest.join(" ").trim().toLowerCase();
				say(renderMemoryList(context, query, ctx.isProjectTrusted()));
				return;
			}

			// Only show/rm take a layer flag, but parsing it up front keeps the two
			// branches from disagreeing about what the user asked for.
			const requested = scopeFlag(rest);
			if (sub === "show" || sub === "rm") {
				if (rest.includes("--global") && rest.includes("--project")) {
					say("Pick one layer: --global or --project.", "warning");
					return;
				}
				if (requested === "project" && !context.projectDir) {
					say("No project memory: the working directory is not a git repository.", "warning");
					return;
				}
				if (requested === "project" && !ctx.isProjectTrusted()) {
					say("Project memory is hidden: this project is not trusted.", "warning");
					return;
				}
			}

			if (sub === "show") {
				const words = rest.filter((word) => !word.startsWith("--"));
				const name = words.join(" ").trim();
				if (!name) {
					say("Usage: /memory show <name> [--global|--project]", "warning");
					return;
				}
				const { entry, candidates } = resolveEntry(visibleFor(context, ctx.isProjectTrusted(), requested), name);
				if (!entry) {
					say(
						candidates.length > 0 ? ambiguityMessage(name, candidates, context) : `No memory named "${name}".`,
						"warning",
					);
					return;
				}
				const dir = scopeDir(context, entry.scope);
				say(renderMemoryDetail(entry, dir ? readTopic(dir, entry.file) : undefined));
				return;
			}

			if (sub === "rm") {
				const force = rest.includes("--force");
				const name = rest.filter((word) => word !== "--force" && !word.startsWith("--")).join(" ").trim();
				if (!name) {
					say("Usage: /memory rm <name> [--force] [--global|--project]", "warning");
					return;
				}

				const trusted = ctx.isProjectTrusted();
				const scoped = visibleFor(context, trusted, requested);
				// Deletion never guesses: exact name or topic file name only, so a
				// fragment cannot unlink a longer name. Fuzzy matches become a hint.
				const { entry, candidates } = resolveEntry(scoped, name, { fuzzy: false });
				if (!entry) {
					const similar = resolveEntry(scoped, name).candidates;
					say(
						candidates.length > 0
							? ambiguityMessage(name, candidates, context)
							: similar.length > 0
								? `No memory named "${name}". Did you mean:\n${describeCandidates(similar, context)}`
								: `No memory named "${name}".`,
						"warning",
					);
					return;
				}

				if (ctx.mode === "tui") {
					const ok = await ctx.ui.confirm(
						"Delete memory",
						`[${entry.type}] ${entry.summary}\n\n${entry.file} · ${scopeLabel(context, entry.scope)} — this cannot be undone.`,
					);
					if (!ok) {
						say("Cancelled");
						return;
					}
				} else if (!force) {
					// Nothing can ask outside a TUI, so deletion needs an explicit flag.
					say(`Refusing to delete without confirmation. Re-run with --force: /memory rm ${name} --force`, "warning");
					return;
				}

				const result = deleteEntry(context, entry.scope, entry.file);
				say(`🗑️  Deleted ${result.file} from ${scopeLabel(context, entry.scope)} memory (${result.size.lines} left).`);
				return;
			}

			if (sub === "stat") {
				say(renderMemoryStats(context, ctx.isProjectTrusted()));
				return;
			}

			say(`Unknown subcommand "${sub}".\n\n${MEMORY_USAGE}`, "warning");
		},
	});

	// ── Lifecycle ───────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		trackSession(ctx.cwd, ctx.isProjectTrusted());
		applyEnabled(pi, readConfig().enabled);
	});
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

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

// ─── Command helpers ────────────────────────────────────────────────────────

const MEMORY_USAGE = [
	"Usage: /memory [subcommand]",
	"",
	"  (none)          panel in a TUI, otherwise the list",
	"  list [query]    list saved memories, optionally filtered",
	"  show <name>     print one memory in full (--global|--project picks a layer)",
	"  rm <name>       delete one memory (asks in a TUI, needs --force elsewhere;",
	"                  also accepts --global|--project)",
	"  stat            index size and type breakdown per layer",
	"  on | off        enable or disable memory",
	"  path            print the two memory directories",
	"  help            this message",
].join("\n");

/** Every subcommand, in the order the help text lists them. */
const SUBCOMMANDS = ["list", "show", "rm", "stat", "on", "off", "path", "help"];

/** One-line capacity for both layers, shown under the list. */
function capacitySummary(context: MemoryContext, projectTrusted: boolean): string {
	const parts = [`global ${formatCapacity(measureIndex(context.globalDir))}`];
	if (projectTrusted && context.projectDir) {
		parts.push(`project ${formatCapacity(measureIndex(context.projectDir))}`);
	}
	return parts.join(" · ");
}

/** Layers the panel shows: project memory only when the project is trusted. */
function layersFor(context: MemoryContext, projectTrusted: boolean): MemoryLayerView[] {
	const layers: MemoryLayerView[] = [
		{
			scope: "global",
			label: "global",
			dir: context.globalDir,
			entries: readIndex(context.globalDir, "global"),
			size: measureIndex(context.globalDir),
		},
	];
	if (projectTrusted && context.projectDir) {
		layers.push({
			scope: "project",
			label: `project ${projectLabel(context)}`,
			dir: context.projectDir,
			entries: readIndex(context.projectDir, "project"),
			size: measureIndex(context.projectDir),
		});
	}
	return layers;
}

/**
 * The panel loop. The overlay cannot open a native dialog itself, so it returns
 * the intent (`filter` / `action`), this loop runs the dialog, then reopens the
 * panel on the same entry so repeated edits do not lose the cursor.
 */
async function runMemoryPanel(ctx: ExtensionContext): Promise<void> {
	let state: MemoryPanelState = {};
	for (;;) {
		const layers = layersFor(contextFor(ctx), ctx.isProjectTrusted());
		const result = await ctx.ui.custom<MemoryPanelResult>(
			(tui, theme, _kb, done) =>
				new MemoryOverlay(state, layers, theme, tui.terminal.rows, () => tui.requestRender(true), done),
			{ overlay: true, overlayOptions: { width: "80%", maxHeight: "80%" } },
		);
		if (!result || result.kind === "close") return;

		if (result.kind === "filter") {
			// ui.input has no prefill, only a placeholder: the current filter is shown
			// greyed out, and an empty answer clears it.
			const next = await ctx.ui.input("Filter memories (empty clears)", state.filter || "keyword");
			const filter = next === undefined ? state.filter : next.trim();
			// Keep the cursor where the user left it — but only the row number is
			// reusable when the filter text changes: rows disappear from the list, so
			// an old position would point at an unrelated memory.
			const keepIndex = filter === state.filter;
			state = {
				...state,
				filter,
				scope: result.scope,
				selected: result.file,
				index: keepIndex ? result.index : undefined,
			};
			continue;
		}

		// A move or a type change renames the entry (and a move changes its layer);
		// follow it so the reopened panel is still on it. Delete returns nothing, so
		// the cursor falls back to the row number, i.e. the neighbour.
		const after = await runMemoryActions(ctx, result.scope, result.file);
		state = {
			...state,
			scope: after?.scope ?? result.scope,
			selected: after?.file ?? result.file,
			index: result.index,
		};
	}
}

/** Notify after a store write, including the index-limit warning. */
function reportWrite(ctx: ExtensionContext, file: string, size: IndexSize): void {
	const over = size.overLines || size.overBytes;
	ctx.ui.notify(`📝 Memory updated: ${truncate(file, 80)}`, over ? "warning" : "info");
	const warning = indexWarning(size);
	if (warning) ctx.ui.notify(warning, "warning");
}

/**
 * The action menu behind Enter in the panel's detail view. Returns where the
 * entry lives now, so a reopened panel can follow a rename or a move; `undefined`
 * means "nothing to follow" (cancelled, deleted, or the action failed).
 */
async function runMemoryActions(
	ctx: ExtensionContext,
	scope: MemoryScope,
	file: string,
): Promise<{ scope: MemoryScope; file: string } | undefined> {
	const context = contextFor(ctx);
	const entry = entriesOf(context, scope).find((candidate) => candidate.file === file);
	if (!entry) {
		ctx.ui.notify(`Memory ${file} is gone.`, "warning");
		return undefined;
	}

	const dir = scopeDir(context, scope);
	const topic = dir ? readTopic(dir, file) : undefined;
	// Every action except delete rewrites the topic file; with the body unreadable
	// that rewrite would silently drop it, so only deletion is safe here.
	const readOnlyDelete = !topic;

	// Moving needs a target layer that exists, is trusted, and a readable body.
	const canMoveToProject = Boolean(context.projectDir) && ctx.isProjectTrusted();
	const canMove = !readOnlyDelete && (scope === "global" ? canMoveToProject : Boolean(context.projectDir));

	const options = readOnlyDelete ? [] : ["Edit body", "Edit summary", "Change type"];
	if (canMove) {
		options.push(scope === "global" ? `Move to project (${projectLabel(context)})` : "Move to global");
	}
	options.push("Delete");

	const heading = `[${entry.type}] ${truncate(entry.summary, 60)}`;
	const title = readOnlyDelete ? `${heading} — no readable topic file, delete only` : heading;
	const choice = await ctx.ui.select(title, options);
	if (!choice) return;

	try {
		if (choice === "Edit body") {
			const next = await ctx.ui.editor(`Edit body: ${entry.file}`, topic?.body ?? "");
			const body = next?.trim();
			if (body === undefined || body === topic?.body) return;
			const result = rewriteEntry(context, scope, entry, { content: body });
			reportWrite(ctx, result.file, result.size);
			return { scope, file: result.file };
		}

		if (choice === "Edit summary") {
			const next = await ctx.ui.input("Summary", entry.summary);
			const summary = next?.trim();
			// Empty input keeps the current summary: a memory without one cannot exist.
			if (!summary || summary === entry.summary) return;
			const result = rewriteEntry(context, scope, entry, { summary });
			reportWrite(ctx, result.file, result.size);
			return { scope, file: result.file };
		}

		if (choice === "Change type") {
			const next = await ctx.ui.select("Type", [...MEMORY_TYPES]);
			if (!next || !isMemoryType(next) || next === entry.type) return;
			// saveEntry keys on the name inside the type prefix, so the old
			// `<type>_<slug>.md` is removed as part of the rewrite.
			const result = rewriteEntry(context, scope, entry, { type: next });
			reportWrite(ctx, result.file, result.size);
			return { scope, file: result.file };
		}

		if (choice.startsWith("Move")) {
			const to: MemoryScope = scope === "global" ? "project" : "global";
			const ok = await ctx.ui.confirm(
				"Move memory",
				`Move "${truncate(entry.summary, 80)}" from ${scopeLabel(context, scope)} to ${scopeLabel(context, to)} memory?`,
			);
			if (!ok) return;
			const moved = moveEntry(context, scope, to, file);
			if (moved.ok) {
				ctx.ui.notify(`📝 Moved ${moved.file} to ${scopeLabel(context, to)} memory`, "info");
				return { scope: moved.to, file: moved.file };
			} else {
				const why = {
					"same-scope": "source and target layer are the same",
					"no-layer": "that layer does not exist here",
					"not-found": "the memory is no longer in the index",
					"no-topic": "its topic file is missing",
				}[moved.reason];
				ctx.ui.notify(`Could not move ${file}: ${why}.`, "warning");
			}
			return undefined;
		}

		if (choice === "Delete") {
			const ok = await ctx.ui.confirm(
				"Delete memory",
				`[${entry.type}] ${entry.summary}\n\n${entry.file} · ${scopeLabel(context, scope)} — this cannot be undone.`,
			);
			if (!ok) return;
			const result = deleteEntry(context, scope, file);
			ctx.ui.notify(
				result.found ? `🗑️  Deleted ${result.file} (${result.size.lines} left).` : `No memory named "${file}".`,
				result.found ? "info" : "warning",
			);
		}
	} catch (error) {
		ctx.ui.notify(`Memory update failed: ${(error as Error).message}`, "error");
	}
	return undefined;
}

function renderMemoryDetail(entry: MemoryEntry, topic: TopicFile | undefined): string {
	return `[${entry.type}] ${entry.summary}\n\n${describeTopic(entry, topic)}`;
}

function renderMemoryStats(context: MemoryContext, projectTrusted: boolean): string {
	const config = readConfig();
	const lines = [`memory is ${config.enabled ? "enabled" : "disabled"}`];
	for (const scope of MEMORY_SCOPES) {
		const dir = scopeDir(context, scope);
		if (!dir) {
			lines.push("", `[${scope}] unavailable: not in a git repository`);
			continue;
		}
		if (scope === "project" && !projectTrusted) {
			lines.push("", `[${scopeLabel(context, scope)}] hidden: this project is not trusted`);
			continue;
		}
		const entries = readIndex(dir, scope);
		const byType = MEMORY_TYPES.map(
			(type) => `${type} ${entries.filter((entry) => entry.type === type).length}`,
		).join(" · ");
		lines.push(
			"",
			`[${scopeLabel(context, scope)}]`,
			`  index  ${formatCapacity(measureIndex(dir))}`,
			`  types  ${byType}`,
			`  dir    ${dir}`,
		);
	}
	return lines.join("\n");
}

/** `/memory ` argument completion: subcommands, then memory names for show/rm. */
function memoryCompletions(prefix: string): AutocompleteItem[] | null {
	const text = prefix ?? "";
	const words = text.trim() ? text.trim().split(/\s+/) : [];
	const current = /\s$/.test(text) ? "" : (words.pop() ?? "");

	if (words.length === 0) {
		const items = SUBCOMMANDS.filter((name) => name.startsWith(current)).map((name) => ({ value: name, label: name }));
		return items.length > 0 ? items : null;
	}

	// Only the first argument is a name; a second word cannot resolve.
	if (words.length > 1 || (words[0] !== "show" && words[0] !== "rm")) return null;
	const context = lastContext ?? resolveMemoryContext(process.cwd());
	const needle = slugify(current);
	const items = visibleFor(context, lastTrusted)
		.map((entry) => ({
			value: memoryKey(entry.file),
			label: memoryKey(entry.file),
			description: `[${entry.type}] ${truncate(entry.summary, 60)}`,
		}))
		.filter((item) => item.value.startsWith(needle));
	return items.length > 0 ? items : null;
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
		`${config.enabled ? "enabled" : "disabled"} · ${capacitySummary(context, projectTrusted)}`,
		"/memory path to locate the files · edit them directly any time",
	];
	if (!projectTrusted && context.projectDir) notes.push("project memory hidden: this project is not trusted");
	return `${groups.join("\n\n")}\n\n${notes.join("\n")}`;
}
