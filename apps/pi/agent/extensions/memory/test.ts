/**
 * Storage tests for the memory extension. Pure Node, no pi runtime needed:
 *
 *   node --experimental-strip-types test.ts
 *
 * Covers index parsing/formatting, write/overwrite/delete, name resolution,
 * the index load limits, and the git exclude side effect.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	deleteEntry,
	ensureGitExcluded,
	listEntries,
	type MemoryContext,
	measureIndex,
	moveEntry,
	parseIndex,
	readIndex,
	readTopic,
	resolveEntry,
	resolveEntryFile,
	rewriteEntry,
	sanitizeSummary,
	saveEntry,
	topicFileName,
	writeIndex,
} from "./store.ts";

const tmpdir = (name: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `memtest-${name}-`)));

const context = (): MemoryContext => {
	const globalDir = tmpdir("global");
	const projectDir = tmpdir("project");
	return { globalDir, projectDir, projectRoot: path.dirname(projectDir) };
};

// ─── Names ──────────────────────────────────────────────────────────────────

assert.equal(topicFileName("user", "Prefers pnpm"), "user_prefers_pnpm.md");
assert.equal(topicFileName("project", "Release Flow!!"), "project_release_flow.md");
// Non-ASCII names keep their characters instead of collapsing to one shared file.
assert.equal(topicFileName("user", "偏好设置"), "user_偏好设置.md");
assert.notEqual(topicFileName("user", "偏好设置"), topicFileName("user", "工作习惯"));
// A name with no letters or digits still gets a stable, distinct file.
assert.equal(topicFileName("user", "   "), topicFileName("user", "   "));
assert.notEqual(topicFileName("user", "   "), topicFileName("user", "!!!"));

assert.equal(sanitizeSummary("a\n b   c"), "a b c");
assert.equal(sanitizeSummary("x".repeat(300)).length, 160);

// ─── Index parsing stays lenient ────────────────────────────────────────────

const parsed = parseIndex(
  [
    "# Memory Index",
    "",
    "- [user] likes pnpm -> user_likes_pnpm.md",
    "garbage line",
    "- [nope] bad type -> bad.md",
    "- [project] flow -> project_flow.md",
  ].join("\n"),
  "global",
);
assert.deepEqual(parsed.entries, [
  { type: "user", summary: "likes pnpm", file: "user_likes_pnpm.md", scope: "global" },
  { type: "project", summary: "flow", file: "project_flow.md", scope: "global" },
]);
// Lines the parser cannot read are kept, not dropped.
assert.deepEqual(parsed.extras, ["garbage line", "- [nope] bad type -> bad.md"]);

// A comment block is skipped as a unit: only its opening line starts a comment,
// so tracking that line alone would leak the continuation into `extras` and
// every rewrite would append another copy of it.
const commented = parseIndex(
	[
		"# Memory Index",
		"",
		"<!-- One line per memory, maintained by the memory extension. Keep summaries short;",
		"     details live in the topic files. Edit or delete entries freely. -->",
		"",
		"- [user] likes tabs -> user_likes_tabs.md",
		"<!-- kept as typed -->",
		"- a hand written note",
	].join("\n"),
	"global",
);
assert.deepEqual(commented.extras, ["- a hand written note"], "hand-written lines after a comment still survive");
assert.equal(commented.entries.length, 1);

// An unterminated comment must not swallow the rest of the file: those lines are
// preserved as extras, so a later rewrite cannot silently delete them.
const unterminated = parseIndex(
	["<!-- oops", "- [user] kept? -> user_kept.md", "- a note"].join("\n"),
	"global",
);
assert.deepEqual(unterminated.entries, []);
assert.deepEqual(unterminated.extras, ["<!--", "- [user] kept? -> user_kept.md", "- a note"]);

// An index line may not point outside the layer directory: `show`, the panel,
// and deleteTopic would otherwise touch an arbitrary file.
const escaping = parseIndex(
	[
		"- [user] sibling -> ../other/notes.md",
		"- [user] absolute -> /tmp/x.md",
		"- [user] fine -> user_fine.md",
	].join("\n"),
	"global",
);
assert.deepEqual(escaping.entries.map((entry) => entry.file), ["user_fine.md"]);
assert.deepEqual(escaping.extras, ["- [user] sibling -> ../other/notes.md", "- [user] absolute -> /tmp/x.md"]);

// ─── Save, read, overwrite, delete ──────────────────────────────────────────

const ctx = context();
const saved = saveEntry(ctx, "global", {
  type: "user",
  name: "prefers pnpm",
  summary: "Prefers pnpm",
  content: "Always use pnpm.",
});
assert.equal(saved.file, "user_prefers_pnpm.md");
assert.equal(saved.replaced, false);

const topic = readTopic(ctx.globalDir, saved.file);
assert.ok(topic);
assert.equal(topic.type, "user");
assert.equal(topic.body, "Always use pnpm.");
assert.ok(topic.modified, "frontmatter records a modified timestamp");

// The same memory under another spelling updates instead of duplicating.
const updated = saveEntry(ctx, "global", {
  type: "user",
  name: "prefers-pnpm",
  summary: "Prefers pnpm over npm",
  content: "Updated.",
});
assert.equal(updated.replaced, true);
assert.equal(readIndex(ctx.globalDir, "global").length, 1);
assert.equal(readTopic(ctx.globalDir, updated.file)?.body, "Updated.");

// The same name under another type replaces the old entry and its topic file,
// so one fact never shows up twice in the index.
const retyped = saveEntry(ctx, "global", {
  type: "feedback",
  name: "prefers-pnpm",
  summary: "User corrected npm to pnpm",
  content: "Use pnpm.",
});
assert.equal(retyped.file, "feedback_prefers_pnpm.md");
assert.equal(retyped.replaced, true);
assert.equal(readIndex(ctx.globalDir, "global").length, 1);
assert.equal(fs.existsSync(path.join(ctx.globalDir, "user_prefers_pnpm.md")), false);

// Hand-written lines survive a programmatic rewrite.
fs.appendFileSync(path.join(ctx.globalDir, "MEMORY.md"), "- my own note about deploys\n");
saveEntry(ctx, "global", { type: "user", name: "likes tabs", summary: "Likes tabs", content: "Tabs." });
assert.match(fs.readFileSync(path.join(ctx.globalDir, "MEMORY.md"), "utf8"), /- my own note about deploys/);

saveEntry(ctx, "project", {
  type: "project",
  name: "release flow",
  summary: "Release: tag then push",
  content: "Steps.",
});
assert.equal(listEntries(ctx).length, 3);
assert.equal(listEntries(ctx, "global").length, 2);
assert.equal(listEntries(ctx, "project").length, 1);

// ─── Name resolution ────────────────────────────────────────────────────────

const projectEntries = readIndex(ctx.projectDir!, "project");
assert.equal(resolveEntryFile(projectEntries, "project_release_flow.md"), "project_release_flow.md");
assert.equal(resolveEntryFile(projectEntries, "release flow"), "project_release_flow.md");
assert.equal(resolveEntryFile(projectEntries, "release-flow"), "project_release_flow.md");
assert.equal(resolveEntryFile(projectEntries, "release"), "project_release_flow.md");
assert.equal(resolveEntryFile(projectEntries, "release", { fuzzy: false }), undefined);
assert.equal(resolveEntryFile(projectEntries, "nope"), undefined);

// ─── Name resolution for the /memory commands ───────────────────────────────

const named: MemoryEntry[] = [
	{ type: "user", summary: "Release flow", file: "user_release_flow.md", scope: "global" },
	{ type: "user", summary: "Release notes", file: "user_release_notes.md", scope: "global" },
	{ type: "project", summary: "Workflow", file: "project_workflow.md", scope: "project" },
];
assert.equal(resolveEntry(named, "workflow").entry?.file, "project_workflow.md", "exact name wins");
assert.equal(resolveEntry(named, "release_flow").entry?.file, "user_release_flow.md", "file name wins");
assert.equal(resolveEntry(named, "notes").entry?.file, "user_release_notes.md", "a unique fragment resolves");
assert.deepEqual(
	resolveEntry(named, "release").candidates.map((entry) => entry.file),
	["user_release_flow.md", "user_release_notes.md"],
	"an ambiguous fragment returns candidates instead of guessing",
);
assert.deepEqual(
	resolveEntry(named, "release", { fuzzy: false }),
	{ candidates: [] },
	"without fuzzy, a fragment resolves to nothing",
);

// The same name in both layers is ambiguous too: a name is unique per layer.
const bothLayers: MemoryEntry[] = [
	{ type: "user", summary: "Workflow", file: "user_workflow.md", scope: "global" },
	{ type: "project", summary: "Workflow", file: "project_workflow.md", scope: "project" },
];
assert.deepEqual(
	resolveEntry(bothLayers, "workflow").candidates.map((entry) => entry.scope),
	["global", "project"],
);

// The topic file name is the most specific input, so it resolves without a flag.
assert.equal(resolveEntry(bothLayers, "user_workflow.md").entry?.file, "user_workflow.md");
assert.equal(resolveEntry(bothLayers, "user_workflow").entry?.file, "user_workflow.md");
// Identical file names in both layers still cannot be told apart.
const identical: MemoryEntry[] = [
	{ type: "user", summary: "Workflow", file: "user_workflow.md", scope: "global" },
	{ type: "user", summary: "Workflow", file: "user_workflow.md", scope: "project" },
];
assert.deepEqual(
	resolveEntry(identical, "user_workflow.md").candidates.map((entry) => entry.scope),
	["global", "project"],
);

// ─── Delete ─────────────────────────────────────────────────────────────────

const deleted = deleteEntry(ctx, "project", "release flow");
assert.equal(deleted.found, true);
assert.equal(readIndex(ctx.projectDir!, "project").length, 0);
assert.equal(fs.existsSync(path.join(ctx.projectDir!, "project_release_flow.md")), false);
assert.equal(deleteEntry(ctx, "project", "release flow").found, false, "deleting twice is not an error");
// Deletion never guesses: a fragment must not remove a longer name.
assert.equal(deleteEntry(ctx, "global", "prefers").found, false);

// ─── Index load limits ──────────────────────────────────────────────────────

const big = tmpdir("big");
writeIndex(big, {
  entries: Array.from({ length: 205 }, (_, i) => ({
    type: "user" as const,
    summary: `entry ${i}`,
    file: `user_entry_${i}.md`,
    scope: "global" as const,
  })),
  extras: [],
});
const size = measureIndex(big);
assert.equal(size.lines, 205);
assert.equal(size.overLines, true);
assert.equal(size.nearLimit, true);
assert.equal(measureIndex(tmpdir("empty")).overLines, false, "a missing index is empty, not an error");

// ─── Rewrite and move ───────────────────────────────────────────────────────

const editCtx = context();
saveEntry(editCtx, "global", {
	type: "user",
	name: "editor flow",
	summary: "Editor: nvim",
	content: "Uses nvim.",
});
const editEntry = readIndex(editCtx.globalDir, "global")[0];

// Body edit keeps the summary and the file name; the index line is rewritten,
// not duplicated.
const bodyEdit = rewriteEntry(editCtx, "global", editEntry, { content: "Uses nvim + tmux." });
assert.equal(bodyEdit.file, "user_editor_flow.md");
assert.equal(bodyEdit.replaced, true);
assert.equal(readTopic(editCtx.globalDir, bodyEdit.file)?.body, "Uses nvim + tmux.");
assert.equal(readIndex(editCtx.globalDir, "global").length, 1);
assert.equal(readIndex(editCtx.globalDir, "global")[0].summary, "Editor: nvim");

// Summary edit keeps the body.
const summaryEdit = rewriteEntry(editCtx, "global", readIndex(editCtx.globalDir, "global")[0], {
	summary: "Editor: nvim + tmux",
});
assert.equal(readTopic(editCtx.globalDir, summaryEdit.file)?.body, "Uses nvim + tmux.");
assert.equal(readIndex(editCtx.globalDir, "global")[0].summary, "Editor: nvim + tmux");

// A type change renames the topic file and drops the old one.
const typeEdit = rewriteEntry(editCtx, "global", readIndex(editCtx.globalDir, "global")[0], {
	type: "feedback",
});
assert.equal(typeEdit.file, "feedback_editor_flow.md");
assert.equal(fs.existsSync(path.join(editCtx.globalDir, "user_editor_flow.md")), false);
assert.equal(readIndex(editCtx.globalDir, "global").length, 1);

// Moving keeps type, summary, and body, and leaves one copy on the other side.
const moved2 = moveEntry(editCtx, "global", "project", typeEdit.file);
assert.equal(moved2.ok, true);
if (!moved2.ok) throw new Error("unreachable");
assert.equal(moved2.file, "feedback_editor_flow.md");
assert.equal(moved2.from, "global");
assert.equal(moved2.to, "project");
assert.equal(readIndex(editCtx.globalDir, "global").length, 0);
assert.equal(fs.existsSync(path.join(editCtx.globalDir, "feedback_editor_flow.md")), false);
assert.deepEqual(
	readIndex(editCtx.projectDir!, "project").map((entry) => [entry.type, entry.summary, entry.file]),
	[["feedback", "Editor: nvim + tmux", "feedback_editor_flow.md"]],
);
assert.equal(readTopic(editCtx.projectDir!, moved2.file)?.body, "Uses nvim + tmux.");

// A rejected move says why, and changes nothing.
const missing = moveEntry(editCtx, "global", "project", "nope");
assert.deepEqual(missing, { ok: false, reason: "not-found" }, "unknown names do not move");
assert.deepEqual(
	moveEntry(editCtx, "project", "project", moved2.file),
	{ ok: false, reason: "same-scope" },
	"same-layer move is a no-op",
);
assert.equal(readIndex(editCtx.projectDir!, "project").length, 1, "a rejected move changes nothing");
assert.equal(readIndex(editCtx.globalDir, "global").length, 0);

// Deletion never guesses: a fragment must not remove a longer name.
saveEntry(editCtx, "global", { type: "user", name: "release flow", summary: "Release flow", content: "r" });
assert.equal(deleteEntry(editCtx, "global", "release").found, false, "rm is exact-name only");
assert.equal(readIndex(editCtx.globalDir, "global").length, 1);

// Rewriting an entry whose topic file cannot be read must fail instead of
// writing an empty body over it.
assert.throws(
	() => rewriteEntry(editCtx, "global", { type: "user", summary: "ghost", file: "user_ghost.md", scope: "global" }, { summary: "x" }),
	/Cannot read/,
);
assert.equal(fs.existsSync(path.join(editCtx.globalDir, "user_ghost.md")), false);

// Rewriting the index twice must not grow it: the managed header's continuation
// line used to be re-appended as a hand-written extra on every write.
const stable = tmpdir("stable");
const stableCtx: MemoryContext = { globalDir: stable };
saveEntry(stableCtx, "global", { type: "user", name: "alpha", summary: "Alpha", content: "a" });
saveEntry(stableCtx, "global", { type: "user", name: "beta", summary: "Beta", content: "b" });
const stableIndex = fs.readFileSync(path.join(stable, "MEMORY.md"), "utf8");
assert.equal(stableIndex.split("details live in the topic files").length - 1, 1, "the header is written once");
assert.equal(stableIndex.includes("kept as typed"), false, "no spurious extras section");

// ─── git exclude ────────────────────────────────────────────────────────────

const repo = tmpdir("repo");
execFileSync("git", ["init", "-q"], { cwd: repo });
ensureGitExcluded(repo);
ensureGitExcluded(repo);
const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
assert.equal(exclude.split("/.pi/memory/").length - 1, 1, "the pattern is appended exactly once");
ensureGitExcluded(tmpdir("norepo")); // a non-repository is a silent no-op

// A repository that already ignores `.pi/` needs no entry of its own.
const covered = tmpdir("covered");
execFileSync("git", ["init", "-q"], { cwd: covered });
fs.writeFileSync(path.join(covered, ".git", "info", "exclude"), ".pi/\n");
ensureGitExcluded(covered);
assert.equal(fs.readFileSync(path.join(covered, ".git", "info", "exclude"), "utf8"), ".pi/\n");

console.log("store tests passed");
