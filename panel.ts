/**
 * The `/quota` panel: takes the editor's slot, fills in as answers land, and
 * scrolls when there are more providers than rows.
 *
 * It owns the keyboard while it is up. Escape, Enter, Space and `q` all close
 * it, so the way back to the editor is whatever the reader reaches for first.
 * Closing aborts any request still in flight.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type KeybindingsManager, Key, matchesKey, parseKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { QueryState } from "./query.js";
import { bodyLines, headerLine } from "./render.js";

/**
 * Rows pi keeps for itself while the panel is up: the transcript row
 * fullscreen never gives away, the widget spacer, the two-line footer, and one
 * for an extension status line. A panel taller than what is left is cut from
 * the bottom, which is where the key hints are.
 */
export const HOST_ROWS = 5;
/** Header, the rule under it, the rule above the hints, the hints. */
const CHROME_ROWS = 4;
const MIN_BODY_ROWS = 3;

export interface PanelDeps {
	/** Read on every render; a refresh swaps in a new state. */
	state(): QueryState;
	/** Redraw hook. Returns an unsubscribe function. */
	subscribe(onChange: () => void): () => void;
	refresh(): void;
}

export function bodyHeight(terminalRows: number): number {
	return Math.max(MIN_BODY_ROWS, terminalRows - HOST_ROWS - CHROME_ROWS);
}

export function createPanel(deps: PanelDeps) {
	return (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: void) => void): Component & { dispose(): void } => {
		let scroll = 0;
		let bodyRows = MIN_BODY_ROWS;
		let bodyCount = 0;
		let cachedWidth = -1;
		// pi does not invalidate components on resize, so a height-only resize
		// has to miss the cache on its own.
		let cachedRows = -1;
		let cachedLines: string[] | undefined;

		const bound = (id: Parameters<KeybindingsManager["matches"]>[1], fallback: Parameters<typeof matchesKey>[1]) => {
			const resolver = typeof keybindings?.matches === "function" ? keybindings : undefined;
			return (data: string) => (resolver ? resolver.matches(data, id) : matchesKey(data, fallback));
		};
		const isCancel = bound("tui.select.cancel", "escape");
		const isConfirm = bound("tui.select.confirm", "enter");
		const isUp = bound("tui.select.up", "up");
		const isDown = bound("tui.select.down", "down");
		/** Letters arrive as escape sequences under the Kitty and modifyOtherKeys protocols. */
		const letter = (data: string): string => parseKey(data) ?? data;

		function redraw() {
			cachedLines = undefined;
			tui.requestRender();
		}
		const unsubscribe = deps.subscribe(redraw);

		function rule(width: number): string {
			return theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
		}

		function hintRow(width: number): string {
			const hints = ["Esc 关闭", "r 刷新"];
			if (bodyCount > bodyRows) hints.push("↑↓ 滚动", `${scroll + 1}-${Math.min(bodyCount, scroll + bodyRows)}/${bodyCount}`);
			let row = "";
			for (const hint of hints) {
				const next = row ? `${row}  ·  ${hint}` : hint;
				if (visibleWidth(next) > width) break;
				row = next;
			}
			return theme.fg("dim", row);
		}

		function render(width: number): string[] {
			const rows = tui.terminal.rows;
			if (cachedLines && cachedWidth === width && cachedRows === rows) return cachedLines;
			cachedWidth = width;
			cachedRows = rows;

			const state = deps.state();
			const body = bodyLines(state, width, theme);
			bodyCount = body.length;
			bodyRows = bodyHeight(rows);
			scroll = Math.min(scroll, Math.max(0, body.length - bodyRows));

			const lines = [headerLine(state, theme), rule(width), ...body.slice(scroll, scroll + bodyRows), rule(width), hintRow(width)];
			cachedLines = lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width) : line));
			return cachedLines;
		}

		function scrollBy(delta: number) {
			const next = Math.min(Math.max(0, bodyCount - bodyRows), Math.max(0, scroll + delta));
			if (next === scroll) return;
			scroll = next;
			redraw();
		}

		return {
			render,
			invalidate() {
				cachedLines = undefined;
			},
			dispose() {
				unsubscribe();
			},
			handleInput(data: string): void {
				if (isUp(data)) return scrollBy(-1);
				if (isDown(data)) return scrollBy(1);
				if (matchesKey(data, Key.pageUp)) return scrollBy(-bodyRows);
				if (matchesKey(data, Key.pageDown)) return scrollBy(bodyRows);
				const key = letter(data);
				if (key === "r") {
					scroll = 0;
					deps.refresh();
					redraw();
					return;
				}
				if (isCancel(data) || isConfirm(data) || key === "q" || matchesKey(data, Key.space)) done();
			},
		};
	};
}
