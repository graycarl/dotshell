/**
 * Memory Extension — Terminal UI
 *
 * The `/memory` overlay: a read-only list (grouped per layer) plus a read-only
 * detail view. It never writes. Every mutation is handed back to index.ts as a
 * `MemoryPanelResult`, because pi cannot nest a native dialog (select / confirm
 * / editor) inside a custom component: the overlay closes, the dialog runs, and
 * the overlay reopens on the same entry.
 *
 * Keys stay deliberately few — navigation only. Everything with a consequence
 * lives in the action menu behind Enter, so there is no inline state machine
 * (no y/N prompts, no type picker) to get stuck in.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	formatCapacity,
	type IndexSize,
	type MemoryEntry,
	memoryKey,
	type MemoryScope,
	matchesQuery,
	readTopic,
} from "./store.ts";

/** One layer as the overlay needs it: the entries, where they live, how full. */
export interface MemoryLayerView {
	scope: MemoryScope;
	/** Group heading, e.g. `global` or `project dotshell`. */
	label: string;
	dir: string;
	entries: MemoryEntry[];
	size: IndexSize;
}

/** What the overlay asks index.ts to do next. */
export type MemoryPanelResult =
	| { kind: "close" }
	| { kind: "filter"; scope?: MemoryScope; file?: string; index: number }
	| { kind: "action"; scope: MemoryScope; file: string; index: number };

/** View state carried across panel reopens. */
export interface MemoryPanelState {
	filter?: string;
	/** Layer of the entry to reselect: a name is unique per layer, not overall. */
	scope?: MemoryScope;
	/** Topic file to select when the panel reopens. */
	selected?: string;
	/** Fallback row when that file no longer exists (renamed, deleted). */
	index?: number;
}

interface Row {
	entry: MemoryEntry;
	layer: MemoryLayerView;
}

interface Group {
	layer: MemoryLayerView;
	rows: Row[];
}

type Item = { kind: "group"; layer: MemoryLayerView; count: number } | { kind: "entry"; row: Row };

/**
 * Overlay chrome around the list: blank, title, blank, owner heading, `↑` marker,
 * the selected row's file line, `↓` marker, and the three hint lines.
 */
const LIST_CHROME = 10;
/** Overlay chrome around the detail body. */
const DETAIL_CHROME = 8;

export class MemoryOverlay {
	private layers: MemoryLayerView[];
	private theme: Theme;
	private height: number;
	private requestRender: () => void;
	private close: (result: MemoryPanelResult) => void;
	private groups: Group[] = [];
	private flat: Row[] = [];
	private selected = 0;
	private view: "list" | "detail" = "list";
	private detailOffset = 0;
	private filter: string;
	/** Topic bodies and timestamps, read on demand and cached per open. */
	private topics = new Map<string, { body: string; modified?: string }>();

	// Fields are assigned explicitly instead of using TypeScript parameter
	// properties: those need a transform pass, and everything in this extension
	// stays runnable under plain `node --experimental-strip-types`.
	constructor(
		state: MemoryPanelState,
		layers: MemoryLayerView[],
		theme: Theme,
		height: number,
		requestRender: () => void,
		close: (result: MemoryPanelResult) => void,
	) {
		this.layers = layers;
		this.theme = theme;
		this.height = height;
		this.requestRender = requestRender;
		this.close = close;
		this.filter = state.filter?.trim() ?? "";
		this.flatten();
		this.selected = this.restore(state);
	}

	/** Overlay height in lines (`maxHeight: "80%"`); rendering more would clip. */
	private budget(): number {
		return Math.max(8, Math.floor(this.height * 0.8));
	}

	private listItems(): number {
		return Math.max(1, this.budget() - LIST_CHROME);
	}

	private detailLines(): number {
		return Math.max(1, this.budget() - DETAIL_CHROME);
	}

	/** Flatten the layers into rows, applying the filter, and drop empty groups. */
	private flatten(): void {
		this.groups = [];
		this.flat = [];
		for (const layer of this.layers) {
			const entries = this.filter
				? layer.entries.filter((entry) => matchesQuery(entry, this.filter.toLowerCase()))
				: layer.entries;
			if (entries.length === 0) continue;
			const rows = entries.map((entry) => ({ entry, layer }));
			this.groups.push({ layer, rows });
			this.flat.push(...rows);
		}
	}

	/**
	 * Where the cursor should land on open. Layers are matched too: the same name
	 * may exist globally and in the project, and only one of them was acted on.
	 * The topic file name changes when the type does, so compare the name without
	 * its `<type>_` prefix; when the entry is gone (deleted) fall back to the row
	 * number it used to occupy, which is the natural neighbour after the shift.
	 */
	private restore(state: MemoryPanelState): number {
		const max = Math.max(0, this.flat.length - 1);
		if (state.selected) {
			const key = memoryKey(state.selected);
			const found = this.flat.findIndex(
				(row) => memoryKey(row.entry.file) === key && (!state.scope || row.layer.scope === state.scope),
			);
			if (found !== -1) return found;
		}
		return state.index === undefined ? 0 : Math.min(Math.max(0, state.index), max);
	}

	private move(delta: number): void {
		if (this.flat.length === 0) return;
		this.selected = Math.min(Math.max(0, this.selected + delta), this.flat.length - 1);
	}

	private currentRow(): Row | undefined {
		return this.flat[this.selected];
	}

	/** The topic file of a row, read at most once per panel open. */
	private topicOf(row: Row): { body: string; modified?: string } {
		const key = `${row.layer.scope}:${row.entry.file}`;
		const cached = this.topics.get(key);
		if (cached) return cached;
		const topic = readTopic(row.layer.dir, row.entry.file);
		const value = { body: topic?.body ?? "", modified: topic?.modified };
		this.topics.set(key, value);
		return value;
	}

	handleInput(data: string): void {
		if (this.view === "detail") {
			this.handleDetailKeys(data);
			this.requestRender();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.close({ kind: "close" });
			return;
		}
		const row = this.currentRow();
		if (matchesKey(data, "up") || data === "k") this.move(-1);
		else if (matchesKey(data, "down") || data === "j") this.move(1);
		else if (matchesKey(data, "pageUp")) this.move(-this.listItems());
		else if (matchesKey(data, "pageDown")) this.move(this.listItems());
		else if (data === "/") {
			this.close({ kind: "filter", scope: row?.layer.scope, file: row?.entry.file, index: this.selected });
			return;
		} else if (matchesKey(data, "enter")) this.openDetail();
		this.requestRender();
	}

	private handleDetailKeys(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.view = "list";
			return;
		}
		const row = this.currentRow();
		if (!row) {
			this.view = "list";
			return;
		}
		if (matchesKey(data, "enter")) {
			this.close({
				kind: "action",
				scope: row.layer.scope,
				file: row.entry.file,
				index: this.selected,
			});
			return;
		}
		const maxOffset = Math.max(0, this.topicOf(row).body.split("\n").length - this.detailLines());
		if (matchesKey(data, "up") || data === "k") this.detailOffset = Math.max(0, this.detailOffset - 1);
		else if (matchesKey(data, "down") || data === "j") {
			this.detailOffset = Math.min(maxOffset, this.detailOffset + 1);
		} else if (matchesKey(data, "pageUp")) this.detailOffset = Math.max(0, this.detailOffset - this.detailLines());
		else if (matchesKey(data, "pageDown")) {
			this.detailOffset = Math.min(maxOffset, this.detailOffset + this.detailLines());
		}
	}

	private openDetail(): void {
		if (!this.currentRow()) return;
		this.view = "detail";
		this.detailOffset = 0;
	}

	render(width: number): string[] {
		return this.view === "detail" ? this.renderDetail(width) : this.renderList(width);
	}

	private title(width: number, label: string): string {
		const th = this.theme;
		const filled = Math.max(0, width - visibleWidth(label) - 5);
		return truncateToWidth(
			`${th.fg("borderMuted", "───")}${th.fg("accent", ` ${label} `)}${th.fg("borderMuted", "─".repeat(filled))}`,
			width,
		);
	}

	/** Group heading: layer label, entry count, and how full that index is. */
	private heading(width: number, layer: MemoryLayerView, count: number): string {
		const th = this.theme;
		return truncateToWidth(
			`  ${th.fg("muted", `[${layer.label}] ${count}`)} ${th.fg("dim", `· ${formatCapacity(layer.size)}`)}`,
			width,
		);
	}

	private renderList(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [""];
		lines.push(this.title(width, "Memory"));
		lines.push("");

		if (this.flat.length === 0) {
			const text = this.filter ? `No memories matching "${this.filter}".` : "No memories saved yet.";
			lines.push(truncateToWidth(`  ${th.fg("dim", text)}`, width));
			lines.push("");
			this.pushHint(lines, width);
			return lines;
		}

		// The overlay is clipped to `maxHeight` from the top and render() receives
		// no height, so the list windows itself around the cursor.
		const items: Item[] = [];
		for (const group of this.groups) {
			items.push({ kind: "group", layer: group.layer, count: group.rows.length });
			for (const row of group.rows) items.push({ kind: "entry", row });
		}

		const limit = this.listItems();
		const cursor = items.findIndex((item) => item.kind === "entry" && item.row === this.currentRow());
		const start = Math.min(Math.max(0, cursor - Math.floor(limit / 2)), Math.max(0, items.length - limit));
		const end = Math.min(items.length, start + limit);

		// A window that starts mid-group would otherwise show entries with no layer
		// label at all; the heading of the owning group is cheap to repeat.
		let owner: { layer: MemoryLayerView; count: number } | undefined;
		if (items[start]?.kind === "entry") {
			for (let i = start - 1; i >= 0; i--) {
				const item = items[i];
				if (item?.kind === "group") {
					owner = item;
					break;
				}
			}
		}
		if (owner) lines.push(this.heading(width, owner.layer, owner.count));
		if (start > 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", `↑ ${start} more above`)}`, width));
		}

		for (const item of items.slice(start, end)) {
			if (item.kind === "group") {
				lines.push(this.heading(width, item.layer, item.count));
				continue;
			}
			const isSelected = item.row === this.currentRow();
			const mark = isSelected ? th.fg("accent", "❯") : " ";
			const { entry } = item.row;
			lines.push(
				truncateToWidth(
					` ${mark} ${th.fg(isSelected ? "text" : "muted", `[${entry.type}]`)} ${th.fg(isSelected ? "text" : "dim", entry.summary)}`,
					width,
				),
			);
			if (isSelected) {
				const modified = this.topicOf(item.row).modified;
				const when = modified ? ` · updated ${modified.slice(0, 10)}` : "";
				lines.push(truncateToWidth(`     ${th.fg("dim", `${entry.file}${when}`)}`, width));
			}
		}

		if (items.length > end) {
			lines.push(truncateToWidth(`  ${th.fg("dim", `↓ ${items.length - end} more below`)}`, width));
		}
		this.pushHint(lines, width);
		return lines;
	}

	/** Blank line plus the key legend and the active filter. */
	private pushHint(lines: string[], width: number): void {
		const th = this.theme;
		const filter = this.filter ? ` · filter "${this.filter}"` : "";
		lines.push("");
		lines.push(
			truncateToWidth(`  ${th.fg("dim", `↑/↓ move · Enter details · / filter · Esc close${filter}`)}`, width),
		);
		lines.push("");
	}

	private renderDetail(width: number): string[] {
		const th = this.theme;
		const row = this.currentRow();
		const lines: string[] = [""];
		if (!row) return [truncateToWidth(`  ${th.fg("dim", "Nothing selected.")}`, width)];

		const topic = this.topicOf(row);
		const body = topic.body.split("\n");
		const visible = this.detailLines();
		const maxOffset = Math.max(0, body.length - visible);
		const offset = Math.min(this.detailOffset, maxOffset);

		lines.push(this.title(width, `Memory · ${row.layer.label}`));
		lines.push("");
		lines.push(
			truncateToWidth(`  ${th.fg("muted", `[${row.entry.type}]`)} ${th.fg("text", row.entry.summary)}`, width),
		);
		lines.push("");

		for (let i = offset; i < Math.min(body.length, offset + visible); i++) {
			lines.push(truncateToWidth(`  ${th.fg("text", body[i] ?? "")}`, width));
		}

		const when = topic.modified ? `updated ${topic.modified.slice(0, 10)}` : "no timestamp";
		lines.push(
			truncateToWidth(`  ${th.fg("dim", `_${row.layer.scope} · ${row.entry.file} · ${when}_`)}`, width),
		);
		const scrolled = offset > 0 ? ` (line ${offset + 1})` : "";
		lines.push(
			truncateToWidth(`  ${th.fg("dim", `↑/↓ PgUp/PgDn scroll${scrolled} · Enter actions · Esc back`)}`, width),
		);
		lines.push("");
		return lines;
	}

	invalidate(): void {}
}
