/**
 * Lines for a query's state. The panel passes pi's theme; plain-text output
 * passes a style that adds nothing, so both read the same layout.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { barCells, formatAmount, formatClock, formatPercent, formatReset, usageLevel } from "./format.js";
import type { QueryState, Row } from "./query.js";
import { RELAY_SOURCES } from "./sources/index.js";
import type { Balance, Meter, Report } from "./types.js";

export type StyleColor = "accent" | "muted" | "dim" | "success" | "warning" | "error" | "text";

export interface Style {
	fg(color: StyleColor, text: string): string;
	bold(text: string): string;
}

export const plainStyle: Style = { fg: (_color, text) => text, bold: (text) => text };

const LEVEL_COLORS = { ok: "success", high: "warning", full: "error" } as const;

export function headerLine(state: QueryState, style: Style): string {
	const title = style.bold(style.fg("accent", "额度"));
	const total = state.rows.length;
	if (state.phase === "resolving") return `${title}${style.fg("dim", " · 读取凭据…")}`;
	if (state.phase === "fetching") {
		const settled = state.rows.filter((row) => row.state.kind !== "loading").length;
		return `${title}${style.fg("dim", ` · 查询中 ${settled}/${total}`)}`;
	}
	const at = state.finishedAt ? ` · ${formatClock(state.finishedAt)} 更新` : "";
	return `${title}${style.fg("dim", ` · ${total} 项${at}`)}`;
}

export function bodyLines(state: QueryState, width: number, style: Style, now = Date.now()): string[] {
	const lines: string[] = [];
	for (const note of state.notes) lines.push(style.fg("warning", `! ${note}`));

	state.rows.forEach((row, index) => {
		if (index > 0 || lines.length > 0) lines.push("");
		lines.push(...rowLines(row, width, style, now));
	});

	if (state.skipped.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(style.fg("muted", "查不了"));
		for (const skip of state.skipped) {
			const name = skip.name.toLowerCase() === skip.provider.toLowerCase() ? skip.name : `${skip.name}（${skip.provider}）`;
			lines.push(style.fg("dim", `  ${name}：${skip.reason}`));
		}
	}

	if (lines.length === 0 && state.phase === "done") lines.push(style.fg("dim", "没有配好凭据的 provider"));
	return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width) : line));
}

export function rowLines(row: Row, width: number, style: Style, now = Date.now()): string[] {
	// A custom display name hides the id `/quota <provider>` takes, so show both.
	const names = row.names
		.map((name, i) => {
			const id = row.providers[i]!;
			return name.toLowerCase() === id.toLowerCase() ? name : `${name}（${id}）`;
		})
		.join(" · ");
	const report = row.state.kind === "ok" ? row.state.report : undefined;
	const title = `${style.bold(names)}${row.current ? style.fg("accent", "（当前）") : ""}`;
	const lines = [`${title}  ${style.fg("dim", subtitle(row, report))}`];

	if (row.state.kind === "loading") {
		lines.push(style.fg("dim", "  查询中…"));
		return lines;
	}
	if (row.state.kind === "error") {
		lines.push(style.fg("error", `  ✗ ${row.state.message}`));
		return lines;
	}

	const { meters, balances, notes } = row.state.report;
	const labelWidth = Math.max(0, ...meters.map((m) => visibleWidth(m.label)), ...balances.map((b) => visibleWidth(b.label)));
	const barWidth = width >= 90 ? 20 : width >= 64 ? 12 : 8;
	for (const meter of meters) lines.push(meterLine(meter, labelWidth, barWidth, style, now));
	for (const balance of balances) lines.push(balanceLine(balance, labelWidth, style));
	for (const note of notes) {
		lines.push(note.tone === "warning" ? style.fg("warning", `  ! ${note.text}`) : style.fg("dim", `  ${note.text}`));
	}
	if (meters.length === 0 && balances.length === 0 && notes.length === 0) {
		lines.push(style.fg("dim", "  没有返回额度数据"));
	}
	return lines;
}

function subtitle(row: Row, report: Report | undefined): string {
	if (RELAY_SOURCES.has(row.source.id)) return `${row.host} · ${report?.plan ?? row.source.label}`;
	const parts = [row.source.label];
	if (report?.plan) parts.push(report.plan);
	parts.push(row.auth === "oauth" ? "OAuth" : "API key");
	return parts.join(" · ");
}

function meterLine(meter: Meter, labelWidth: number, barWidth: number, style: Style, now: number): string {
	const color = LEVEL_COLORS[usageLevel(meter.usedPercent)];
	const { filled, empty } = barCells(meter.usedPercent, barWidth);
	const bar = style.fg(color, "█".repeat(filled)) + style.fg("dim", "░".repeat(empty));
	const percent = style.fg(color, formatPercent(meter.usedPercent).padStart(4));
	const extra = [meter.resetsAt !== undefined ? formatReset(meter.resetsAt, now) : undefined, meter.detail].filter(Boolean).join(" · ");
	return `  ${pad(meter.label, labelWidth)}  ${bar} ${percent}${extra ? `  ${style.fg("dim", extra)}` : ""}`;
}

function balanceLine(balance: Balance, labelWidth: number, style: Style): string {
	const value =
		balance.value === "unlimited"
			? style.fg("success", "不限额")
			: style.fg(balance.value.value < 0 ? "error" : "text", style.bold(formatAmount(balance.value)));
	return `  ${pad(balance.label, labelWidth)}  ${value}${balance.detail ? `  ${style.fg("dim", balance.detail)}` : ""}`;
}

function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
