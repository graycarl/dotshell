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
	parseIndex,
	readIndex,
	readTopic,
	resolveEntryFile,
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
