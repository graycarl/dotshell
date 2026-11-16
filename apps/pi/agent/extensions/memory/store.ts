/**
 * Storage layer for the memory extension.
 *
 * Two layers, both plain Markdown so the user can read and edit them by hand:
 *
 *   ~/.pi/agent/memory/            global: preferences, corrections, references
 *   <git-root>/.pi/memory/         project: facts tied to one repository
 *
 * Each layer holds one `MEMORY.md` index (one line per memory, loaded into every
 * session) plus one topic file per memory (read on demand). The index is capped
 * at MAX_INDEX_LINES lines or MAX_INDEX_BYTES bytes, whichever comes first, so a
 * growing memory never silently crowds out the prompt.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemoryScope = "global" | "project";

export const MEMORY_TYPES: readonly MemoryType[] = ["user", "feedback", "project", "reference"];

export const INDEX_FILE = "MEMORY.md";
export const MAX_INDEX_LINES = 200;
export const MAX_INDEX_BYTES = 25 * 1024;

/** Fraction of a limit above which the model is reminded to prune. */
export const INDEX_WARN_RATIO = 0.8;

/** Cap for one topic file body returned to the model. */
export const MAX_TOPIC_CHARS = 4000;

export interface MemoryEntry {
	type: MemoryType;
	summary: string;
	file: string;
	scope: MemoryScope;
}

export interface MemoryContext {
	globalDir: string;
	/** Project memory directory, undefined outside a git repository. */
	projectDir?: string;
	projectRoot?: string;
}

export interface MemoryConfig {
	enabled: boolean;
}

/** Root of the global memory layer. */
export function globalMemoryDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "memory");
}

/** Nearest git repository root for `cwd`, or undefined when not in a repository. */
export function resolveProjectRoot(cwd: string): string | undefined {
	try {
		const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		});
		const root = out.trim();
		return root ? root : undefined;
	} catch {
		return undefined;
	}
}

export function resolveMemoryContext(cwd: string): MemoryContext {
	const projectRoot = resolveProjectRoot(cwd);
	return {
		globalDir: globalMemoryDir(),
		projectRoot,
		projectDir: projectRoot ? path.join(projectRoot, ".pi", "memory") : undefined,
	};
}

// ─── Config ─────────────────────────────────────────────────────────────────

export function readConfig(): MemoryConfig {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(globalMemoryDir(), "config.json"), "utf8")) as {
			enabled?: unknown;
		};
		return { enabled: raw.enabled !== false };
	} catch {
		return { enabled: true };
	}
}

export function writeConfig(config: MemoryConfig): void {
	const dir = globalMemoryDir();
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

// ─── Index ──────────────────────────────────────────────────────────────────

const INDEX_LINE = /^\s*[-*]\s*\[([a-zA-Z]+)\]\s*(.+?)\s*->\s*([^\s>]+\.md)\s*$/;

const INDEX_HEADER = [
	"# Memory Index",
	"",
	"<!-- One line per memory, maintained by the memory extension. Keep summaries short;",
	"     details live in the topic files. Edit or delete entries freely. -->",
	"",
].join("\n");

export function isMemoryType(value: string): value is MemoryType {
	return (MEMORY_TYPES as readonly string[]).includes(value);
}

/** Collapse whitespace and cap length so an entry always fits on one index line. */
export function sanitizeSummary(summary: string): string {
	const flat = summary.replace(/\s+/g, " ").trim();
	return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}

/** Lowercase, non-alphanumerics collapsed to `_`: the key both file names and lookups use. */
export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 60);
}

/** `<type>_<slug>.md`, stable across rewrites of the same memory name. */
export function topicFileName(type: MemoryType, name: string): string {
	return `${type}_${slugify(name) || "memory"}.md`;
}

export function formatIndexLine(entry: MemoryEntry): string {
	return `- [${entry.type}] ${entry.summary} -> ${entry.file}`;
}

/** Parse an index file leniently: bad lines are skipped, never fatal. */
export function parseIndex(text: string, scope: MemoryScope): MemoryEntry[] {
	const entries: MemoryEntry[] = [];
	for (const line of text.split("\n")) {
		const match = INDEX_LINE.exec(line);
		if (!match) continue;
		const [, type, summary, file] = match;
		if (!type || !isMemoryType(type)) continue;
		if (!summary || !file) continue;
		entries.push({ type, summary: summary.trim(), file, scope });
	}
	return entries;
}

export function readIndex(dir: string, scope: MemoryScope): MemoryEntry[] {
	try {
		return parseIndex(fs.readFileSync(path.join(dir, INDEX_FILE), "utf8"), scope);
	} catch {
		return [];
	}
}

export function writeIndex(dir: string, entries: MemoryEntry[]): void {
	fs.mkdirSync(dir, { recursive: true });
	const body = entries.map(formatIndexLine).join("\n");
	fs.writeFileSync(path.join(dir, INDEX_FILE), `${INDEX_HEADER}${body ? `${body}\n` : ""}`, "utf8");
}

export interface IndexSize {
	lines: number;
	bytes: number;
	overLines: boolean;
	overBytes: boolean;
	nearLimit: boolean;
}

/** Measure an index against the load limits, without reading it back. */
export function measureIndex(dir: string): IndexSize {
	let text = "";
	try {
		text = fs.readFileSync(path.join(dir, INDEX_FILE), "utf8");
	} catch {
		// Missing index counts as empty.
	}
	const entryLines = text.split("\n").filter((line) => INDEX_LINE.test(line)).length;
	const bytes = Buffer.byteLength(text, "utf8");
	return {
		lines: entryLines,
		bytes,
		overLines: entryLines > MAX_INDEX_LINES,
		overBytes: bytes > MAX_INDEX_BYTES,
		nearLimit: entryLines >= MAX_INDEX_LINES * INDEX_WARN_RATIO || bytes >= MAX_INDEX_BYTES * INDEX_WARN_RATIO,
	};
}

// ─── Topic files ────────────────────────────────────────────────────────────

export interface TopicFile {
	type: MemoryType;
	modified?: string;
	body: string;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

export function readTopic(dir: string, file: string): TopicFile | undefined {
	let text: string;
	try {
		text = fs.readFileSync(path.join(dir, file), "utf8");
	} catch {
		return undefined;
	}
	let type: MemoryType = "user";
	let modified: string | undefined;
	let body = text;
	const match = FRONTMATTER.exec(text);
	if (match) {
		for (const line of match[1].split("\n")) {
			const idx = line.indexOf(":");
			if (idx === -1) continue;
			const key = line.slice(0, idx).trim();
			const value = line.slice(idx + 1).trim();
			if (key === "type" && isMemoryType(value)) type = value;
			if (key === "modified") modified = value;
		}
		body = text.slice(match[0].length);
	}
	return { type, modified, body: body.trim() };
}

export function writeTopic(dir: string, file: string, type: MemoryType, content: string): string {
	const modified = new Date().toISOString();
	fs.mkdirSync(dir, { recursive: true });
	const text = ["---", `type: ${type}`, `modified: ${modified}`, "---", "", content.trim(), ""].join("\n");
	fs.writeFileSync(path.join(dir, file), text, "utf8");
	return modified;
}

export function deleteTopic(dir: string, file: string): boolean {
	try {
		fs.unlinkSync(path.join(dir, file));
		return true;
	} catch {
		return false;
	}
}

// ─── Compound operations ────────────────────────────────────────────────────

export function scopeDir(context: MemoryContext, scope: MemoryScope): string | undefined {
	return scope === "global" ? context.globalDir : context.projectDir;
}

export interface SaveResult {
	file: string;
	scope: MemoryScope;
	modified: string;
	size: IndexSize;
	/** True when the entry replaced an existing memory of the same name. */
	replaced: boolean;
}

/** Write one memory: topic file first, then the index line that points at it. */
export function saveEntry(
	context: MemoryContext,
	scope: MemoryScope,
	input: { type: MemoryType; name: string; summary: string; content: string },
): SaveResult {
	const dir = scopeDir(context, scope);
	if (!dir) throw new Error("No project memory directory: the current working directory is not a git repository.");

	const file = topicFileName(input.type, input.name);
	const entries = readIndex(dir, scope);
	const replaced = entries.some((entry) => entry.file === file);
	const kept = entries.filter((entry) => entry.file !== file);
	kept.push({ type: input.type, summary: sanitizeSummary(input.summary), file, scope });

	const modified = writeTopic(dir, file, input.type, input.content);
	writeIndex(dir, kept);
	return { file, scope, modified, size: measureIndex(dir), replaced };
}

export interface DeleteResult {
	file: string;
	found: boolean;
	scope: MemoryScope;
	size: IndexSize;
}

/** Remove a memory by name (or by topic file name). */
export function deleteEntry(
	context: MemoryContext,
	scope: MemoryScope,
	nameOrFile: string,
): DeleteResult {
	const dir = scopeDir(context, scope);
	if (!dir) throw new Error("No project memory directory: the current working directory is not a git repository.");

	const entries = readIndex(dir, scope);
	const target = resolveEntryFile(entries, nameOrFile);
	if (!target) return { file: nameOrFile, found: false, scope, size: measureIndex(dir) };

	deleteTopic(dir, target);
	writeIndex(
		dir,
		entries.filter((entry) => entry.file !== target),
	);
	return { file: target, found: true, scope, size: measureIndex(dir) };
}

/**
 * Match a memory by topic file name or by memory name, where the name is the
 * file name without its `<type>_` prefix. Both spellings are slugified, so
 * "release flow" and "release_flow" find the same memory. An ambiguous
 * fragment matches the first entry that contains it.
 */
export function resolveEntryFile(entries: MemoryEntry[], nameOrFile: string): string | undefined {
	const needle = nameOrFile.trim().toLowerCase();
	if (!needle) return undefined;

	const exact = entries.find(
		(entry) => entry.file.toLowerCase() === needle || entry.file.toLowerCase() === `${needle}.md`,
	);
	if (exact) return exact.file;

	const slug = slugify(needle);
	if (slug) {
		const stripped = (file: string) => slugify(file.replace(/^[a-z]+_/, ""));
		const byName = entries.find((entry) => stripped(entry.file) === slug);
		if (byName) return byName.file;
		return entries.find((entry) => stripped(entry.file).includes(slug))?.file;
	}
	return undefined;
}

/** Keyword match against what the index itself shows: the summary and the file name. */
export function matchesQuery(entry: MemoryEntry, query: string): boolean {
	const needle = query.toLowerCase();
	return entry.summary.toLowerCase().includes(needle) || entry.file.toLowerCase().includes(needle);
}

/** Entries from both layers, global first. */
export function listEntries(context: MemoryContext, scope: MemoryScope | "all" = "all"): MemoryEntry[] {
	const entries: MemoryEntry[] = [];
	if (scope !== "project") entries.push(...readIndex(context.globalDir, "global"));
	if (scope !== "global" && context.projectDir) entries.push(...readIndex(context.projectDir, "project"));
	return entries;
}

/**
 * Keep project memory out of `git status` without touching the shared
 * `.gitignore`: the local-only exclude file is invisible to teammates.
 */
export function ensureGitExcluded(projectRoot: string): void {
	try {
		const relative = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
			cwd: projectRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		}).trim();
		if (!relative) return;
		const excludePath = path.isAbsolute(relative) ? relative : path.join(projectRoot, relative);

		let text = "";
		try {
			text = fs.readFileSync(excludePath, "utf8");
		} catch {
			text = "";
		}
		const patterns = new Set(
			text
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line && !line.startsWith("#")),
		);
		if (patterns.has("/.pi/memory/") || patterns.has(".pi/memory/") || patterns.has(".pi/") || patterns.has("/.pi/")) {
			return;
		}

		fs.mkdirSync(path.dirname(excludePath), { recursive: true });
		const lead = text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
		fs.appendFileSync(excludePath, `${lead}# pi memory (local only)\n/.pi/memory/\n`, "utf8");
	} catch {
		// Best effort: a repository that refuses the write keeps working.
	}
}
