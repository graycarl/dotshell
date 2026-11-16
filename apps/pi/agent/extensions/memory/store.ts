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
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_SCOPES = ["global", "project"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

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

/** Directory holding one layer's index and topic files. */
export function scopeDir(context: MemoryContext, scope: MemoryScope): string | undefined {
	return scope === "global" ? context.globalDir : context.projectDir;
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

/** Short, readable label for a project layer, without leaking the home path. */
export function projectLabel(context: MemoryContext): string {
	return context.projectRoot ? path.basename(context.projectRoot) : "none";
}

// ─── Files ──────────────────────────────────────────────────────────────────

/** Write through a temporary file so a crash never leaves a half-written file. */
function writeFileAtomic(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, text, "utf8");
	fs.renameSync(temp, file);
}

export function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG_FILE = "config.json";

export function readConfig(): MemoryConfig {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(globalMemoryDir(), CONFIG_FILE), "utf8")) as unknown;
		const enabled = (raw as { enabled?: unknown } | null)?.enabled;
		// Only a real boolean turns memory off; a hand-edited "false" string or a
		// broken file must not silently disable a feature the user relies on.
		return { enabled: typeof enabled === "boolean" ? enabled : true };
	} catch {
		return { enabled: true };
	}
}

export function writeConfig(config: MemoryConfig): void {
	writeFileAtomic(path.join(globalMemoryDir(), CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
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
	return truncate(summary.replace(/\s+/g, " ").trim(), 160);
}

/** Lowercase, non-alphanumerics collapsed to `_`: the key file names and lookups share. */
export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 60);
}

/**
 * `<type>_<slug>.md`. A name with no letters or digits at all (whitespace,
 * punctuation) still needs a stable file, so it falls back to a short hash of
 * the original name instead of a constant that would make every such name
 * overwrite the previous one.
 */
export function topicFileName(type: MemoryType, name: string): string {
	const slug = slugify(name) || createHash("sha1").update(name).digest("hex").slice(0, 8);
	return `${type}_${slug}.md`;
}

/** The name of a topic file without its extension and `<type>_` prefix. */
export function memoryKey(file: string): string {
	return file.replace(/\.md$/i, "").replace(/^[a-z]+_/, "");
}

export function formatIndexLine(entry: MemoryEntry): string {
	return `- [${entry.type}] ${entry.summary} -> ${entry.file}`;
}

export interface IndexContent {
	entries: MemoryEntry[];
	/** Hand-written lines kept verbatim so a user's own notes survive a rewrite. */
	extras: string[];
}

/**
 * Parse an index leniently: a bad line never breaks anything, it is kept as an
 * `extra` so the next rewrite does not silently delete what the user typed.
 */
export function parseIndex(text: string, scope: MemoryScope): IndexContent {
	const entries: MemoryEntry[] = [];
	const extras: string[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const match = INDEX_LINE.exec(trimmed);
		if (match) {
			const [, type, summary, file] = match;
			if (isMemoryType(type) && summary && file) {
				entries.push({ type, summary: summary.trim(), file, scope });
				continue;
			}
		}
		// Headings and the managed comment block are regenerated, not preserved.
		if (trimmed.startsWith("#") || trimmed.startsWith("<!--") || trimmed.startsWith("-->")) continue;
		extras.push(trimmed);
	}
	return { entries, extras };
}

export function readIndexContent(dir: string, scope: MemoryScope): IndexContent {
	try {
		return parseIndex(fs.readFileSync(path.join(dir, INDEX_FILE), "utf8"), scope);
	} catch {
		return { entries: [], extras: [] };
	}
}

export function readIndex(dir: string, scope: MemoryScope): MemoryEntry[] {
	return readIndexContent(dir, scope).entries;
}

export function writeIndex(dir: string, content: IndexContent): void {
	const lines = content.entries.map(formatIndexLine);
	const tail = content.extras.length > 0 ? `\n<!-- kept as typed -->\n${content.extras.join("\n")}\n` : "";
	writeFileAtomic(
		path.join(dir, INDEX_FILE),
		`${INDEX_HEADER}${lines.length > 0 ? `${lines.join("\n")}\n` : ""}${tail}`,
	);
}

export interface IndexSize {
	lines: number;
	bytes: number;
	overLines: boolean;
	overBytes: boolean;
	nearLimit: boolean;
}

/** Measure an index against the load limits. */
export function measureIndex(dir: string): IndexSize {
	let text = "";
	try {
		text = fs.readFileSync(path.join(dir, INDEX_FILE), "utf8");
	} catch {
		// Missing index counts as empty.
	}
	const lines = text.split("\n").filter((line) => INDEX_LINE.test(line)).length;
	const bytes = Buffer.byteLength(text, "utf8");
	return {
		lines,
		bytes,
		overLines: lines > MAX_INDEX_LINES,
		overBytes: bytes > MAX_INDEX_BYTES,
		nearLimit: lines >= MAX_INDEX_LINES * INDEX_WARN_RATIO || bytes >= MAX_INDEX_BYTES * INDEX_WARN_RATIO,
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
	writeFileAtomic(
		path.join(dir, file),
		["---", `type: ${type}`, `modified: ${modified}`, "---", "", content.trim(), ""].join("\n"),
	);
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

export interface SaveResult {
	file: string;
	scope: MemoryScope;
	modified: string;
	size: IndexSize;
	/** True when this name already existed, under this type or another one. */
	replaced: boolean;
}

/**
 * Write one memory: topic file first, then the index line that points at it.
 *
 * A name is unique per layer regardless of type, so re-saving `release-flow` as
 * `project` after `user` replaces the old entry instead of leaving a duplicate
 * index line and an orphan topic file.
 *
 * Callers must not run two writes concurrently: the read-modify-write window on
 * the index is not locked here (the tool declares `executionMode: "sequential"`).
 */
export function saveEntry(
	context: MemoryContext,
	scope: MemoryScope,
	input: { type: MemoryType; name: string; summary: string; content: string },
): SaveResult {
	const dir = scopeDir(context, scope);
	if (!dir) throw new Error("No project memory directory: the current working directory is not a git repository.");

	const file = topicFileName(input.type, input.name);
	const key = memoryKey(file);
	const content = readIndexContent(dir, scope);

	const stale = content.entries.filter((entry) => memoryKey(entry.file) === key);
	for (const entry of stale) {
		if (entry.file !== file) deleteTopic(dir, entry.file);
	}

	const entries = content.entries.filter((entry) => memoryKey(entry.file) !== key);
	entries.push({ type: input.type, summary: sanitizeSummary(input.summary), file, scope });

	const modified = writeTopic(dir, file, input.type, input.content);
	writeIndex(dir, { entries, extras: content.extras });
	return { file, scope, modified, size: measureIndex(dir), replaced: stale.length > 0 };
}

export interface DeleteResult {
	file: string;
	found: boolean;
	scope: MemoryScope;
	size: IndexSize;
}

/** Remove a memory by exact name (or topic file name). */
export function deleteEntry(context: MemoryContext, scope: MemoryScope, nameOrFile: string): DeleteResult {
	const dir = scopeDir(context, scope);
	if (!dir) throw new Error("No project memory directory: the current working directory is not a git repository.");

	const content = readIndexContent(dir, scope);
	const target = resolveEntryFile(content.entries, nameOrFile, { fuzzy: false });
	if (!target) return { file: nameOrFile, found: false, scope, size: measureIndex(dir) };

	deleteTopic(dir, target);
	writeIndex(dir, {
		entries: content.entries.filter((entry) => entry.file !== target),
		extras: content.extras,
	});
	return { file: target, found: true, scope, size: measureIndex(dir) };
}

/**
 * Match a memory by topic file name or by memory name, where the name is the
 * file name without its `<type>_` prefix. Both sides are slugified, so
 * `release flow` and `release_flow` find the same memory. Fuzzy matching also
 * accepts a fragment, which is handy for lookup but not for deletion.
 */
export function resolveEntryFile(
	entries: MemoryEntry[],
	nameOrFile: string,
	options: { fuzzy?: boolean } = {},
): string | undefined {
	const needle = nameOrFile.trim().toLowerCase();
	if (!needle) return undefined;

	const exact = entries.find(
		(entry) => entry.file.toLowerCase() === needle || entry.file.toLowerCase() === `${needle}.md`,
	);
	if (exact) return exact.file;

	const slug = slugify(needle);
	if (!slug) return undefined;

	const byName = entries.find((entry) => memoryKey(entry.file) === slug);
	if (byName) return byName.file;
	if (options.fuzzy === false) return undefined;
	return entries.find((entry) => memoryKey(entry.file).includes(slug))?.file;
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
		// Already covered by any rule (`.pi/`, `**/.pi/**`, `.pi/memory`, ...)?
		try {
			execFileSync("git", ["check-ignore", "-q", ".pi/memory/"], {
				cwd: projectRoot,
				stdio: "ignore",
				timeout: 5000,
			});
			return;
		} catch {
			// Not ignored yet: fall through and add the narrowest pattern.
		}

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
		const lead = text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
		fs.mkdirSync(path.dirname(excludePath), { recursive: true });
		fs.appendFileSync(excludePath, `${lead}# pi memory (local only)\n/.pi/memory/\n`, "utf8");
	} catch {
		// Best effort: a repository that refuses the write keeps working.
	}
}
