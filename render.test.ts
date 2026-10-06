/**
 * The layout both outputs share, read through the plain style, and the panel
 * around it.
 */

import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { bodyHeight, createPanel, HOST_ROWS, type PanelResult } from "./panel.js";
import type { QueryState, Row } from "./query.js";
import { bodyLines, headerLine, plainStyle } from "./render.js";
import { SOURCES } from "./sources/index.js";

const NOW = new Date(2026, 9, 6, 12, 0).getTime();

function row(overrides: Partial<Row>): Row {
	return {
		providers: ["anthropic"],
		names: ["Anthropic"],
		source: SOURCES.claude!,
		auth: "oauth",
		host: "api.anthropic.com",
		current: false,
		state: { kind: "loading" },
		...overrides,
	};
}

function state(rows: Row[], extra: Partial<QueryState> = {}): QueryState {
	return { phase: "done", rows, skipped: [], notes: [], finishedAt: NOW, ...extra };
}

describe("bodyLines", () => {
	test("lines meters and balances up on one label column, counting CJK as two cells", () => {
		const lines = bodyLines(
			state([
				row({
					state: {
						kind: "ok",
						report: {
							plan: "max",
							meters: [
								{ label: "5 小时", usedPercent: 42, resetsAt: NOW + 133 * 60_000 },
								{ label: "7 天 · Opus", usedPercent: 95 },
							],
							balances: [{ label: "额外用量", value: { value: 37.5, unit: "USD" } }],
							notes: [],
						},
					},
				}),
			]),
			100,
			plainStyle,
			NOW,
		);
		expect(lines[0]).toBe("Anthropic  Claude 订阅 · max · OAuth");
		expect(lines[1]).toBe("  5 小时       ████████░░░░░░░░░░░░  42%  2 小时 13 分后重置");
		expect(lines[2]).toBe("  7 天 · Opus  ███████████████████░  95%");
		expect(lines[3]).toBe("  额外用量     $37.50");
	});

	test("shows the host for relays, and the id when a custom name hides it", () => {
		const lines = bodyLines(
			state([
				row({
					providers: ["tw-anthropic", "tw-codex"],
					names: ["tw-anthropic", "台湾中转"],
					source: SOURCES.relay!,
					auth: "api_key",
					host: "new-api.example.com",
					current: true,
					state: { kind: "ok", report: { plan: "NewAPI", meters: [], balances: [{ label: "令牌 pi", value: "unlimited", detail: "已用 ¥130.90" }], notes: [] } },
				}),
			]),
			100,
			plainStyle,
		);
		expect(lines[0]).toBe("tw-anthropic · 台湾中转（tw-codex）（当前）  new-api.example.com · NewAPI");
		expect(lines[1]).toBe("  令牌 pi  不限额  已用 ¥130.90");
	});

	test("loading, failing and empty rows each say what they are", () => {
		const lines = bodyLines(
			state([
				row({ providers: ["a"], names: ["a"] }),
				row({ providers: ["b"], names: ["b"], state: { kind: "error", message: "Anthropic 限流了，稍后再试（HTTP 429）" } }),
				row({ providers: ["c"], names: ["c"], state: { kind: "ok", report: { meters: [], balances: [], notes: [] } } }),
			]),
			100,
			plainStyle,
		);
		expect(lines).toContain("  查询中…");
		expect(lines).toContain("  ✗ Anthropic 限流了，稍后再试（HTTP 429）");
		expect(lines).toContain("  没有返回额度数据");
	});

	test("lists what could not be asked after everything that could", () => {
		const lines = bodyLines(state([], { skipped: [{ provider: "xai", name: "xAI", reason: "这个订阅没有公开的额度接口" }] }), 100, plainStyle);
		expect(lines).toEqual(["查不了", "  xAI：这个订阅没有公开的额度接口"]);
	});

	test("never draws past the width", () => {
		const long = row({ state: { kind: "error", message: "很长的错误".repeat(40) } });
		for (const width of [30, 50, 80]) {
			for (const line of bodyLines(state([long]), width, plainStyle)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

describe("headerLine", () => {
	test("a row that wants an access token says where to give it", () => {
		const setupRow = (problem?: string) =>
			row({
				source: SOURCES.relay!,
				providers: ["tw-codex"],
				names: ["tw-codex"],
				host: "relay.example.com",
				auth: "api_key",
				state: {
					kind: "ok",
					report: {
						plan: "NewAPI",
						meters: [],
						balances: [{ label: "令牌 pi", value: "unlimited" }],
						notes: [],
						setup: { site: "relay.example.com", origin: "https://relay.example.com", ...(problem ? { problem } : {}) },
					},
				},
			});
		expect(bodyLines(state([setupRow()]), 100, plainStyle, NOW, true).at(-1)).toBe("  令牌不限额，按 c 填写访问令牌就能看账户余额");
		expect(bodyLines(state([setupRow()]), 100, plainStyle, NOW).at(-1)).toBe("  令牌不限额，在 /quota 面板按 c 填写访问令牌就能看账户余额");
		expect(bodyLines(state([setupRow("NewAPI 拒绝了凭据（HTTP 401）")]), 100, plainStyle, NOW, true).at(-1)).toBe(
			"  ! 账户余额：NewAPI 拒绝了凭据（HTTP 401），按 c 重新填写访问令牌",
		);
	});

	test("counts answers while they come in", () => {
		const rows = [row({ state: { kind: "ok", report: { meters: [], balances: [], notes: [] } } }), row({})];
		expect(headerLine(state(rows, { phase: "fetching" }), plainStyle)).toBe("额度 · 查询中 1/2");
		expect(headerLine(state(rows), plainStyle)).toBe("额度 · 2 项 · 12:00 更新");
	});
});

/* ------------------------------------------------------------------ */

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function mountPanel(current: () => QueryState, rows = 30) {
	let closed = false;
	let result: PanelResult;
	let refreshed = 0;
	const tui = { terminal: { rows }, requestRender: () => {} };
	const panel = createPanel({ state: current, subscribe: () => () => {}, refresh: () => refreshed++ })(
		tui as never,
		theme as never,
		undefined as never,
		(value) => {
			closed = true;
			result = value;
		},
	);
	return { panel, closed: () => closed, result: () => result, refreshed: () => refreshed };
}

describe("panel", () => {
	test("leaves pi its rows on any terminal height", () => {
		const many = state(Array.from({ length: 12 }, (_, i) => row({ providers: [`p${i}`], names: [`p${i}`] })));
		for (const rows of [12, 20, 30, 50]) {
			const { panel } = mountPanel(() => many, rows);
			const lines = panel.render(80);
			expect(lines.length).toBeLessThanOrEqual(rows - HOST_ROWS);
			// Short content gets a short panel; long content gets every row pi can spare.
			expect(lines.length).toBe(Math.min(bodyHeight(rows), bodyLines(many, 80, plainStyle).length) + 4);
		}
	});

	test("scrolls when there is more than fits, and says where it is", () => {
		const many = state(Array.from({ length: 12 }, (_, i) => row({ providers: [`p${i}`], names: [`p${i}`] })));
		const { panel } = mountPanel(() => many, 20);
		const first = panel.render(80);
		expect(first.at(-1)).toContain("↑↓ 滚动");
		panel.handleInput!("\x1b[B");
		panel.invalidate();
		expect(panel.render(80)[2]).not.toBe(first[2]);
	});

	test("c hands back the rows that want an access token, and does nothing when none do", () => {
		const setup = { site: "relay.example.com", origin: "https://relay.example.com" };
		const wanting = state([
			row({ providers: ["tw-anthropic", "tw-codex"], names: ["tw-anthropic", "tw-codex"], state: { kind: "ok", report: { meters: [], balances: [], notes: [], setup } } }),
		]);
		const { panel, closed, result } = mountPanel(() => wanting);
		expect(panel.render(100).at(-1)).toContain("c 填访问令牌");
		panel.handleInput!("c");
		expect(result()).toEqual({ setup: [{ setup, providers: ["tw-anthropic", "tw-codex"], names: ["tw-anthropic", "tw-codex"] }] });

		const idle = mountPanel(() => state([]));
		expect(idle.panel.render(100).at(-1)).not.toContain("c 填");
		idle.panel.handleInput!("c");
		expect(idle.closed()).toBe(false);
		expect(closed()).toBe(true);
	});

	test("r refreshes and Escape closes", () => {
		const { panel, closed, result, refreshed } = mountPanel(() => state([]));
		panel.handleInput!("r");
		expect(refreshed()).toBe(1);
		expect(closed()).toBe(false);
		panel.handleInput!("\x1b");
		expect(closed()).toBe(true);
		expect(result()).toBeUndefined();
	});
});
