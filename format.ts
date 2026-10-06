/**
 * Text for amounts, percents and reset times, shared by the panel and the
 * plain-text output.
 */

import type { Amount } from "./types.js";

const SYMBOLS: Record<string, string> = { USD: "$", CNY: "¥" };

export function formatAmount(amount: Amount): string {
	const { value, unit } = amount;
	if (unit === "tokens") return `${formatCount(value)} tokens`;
	if (unit === "credits") return `${trimFixed(value)} credits`;
	const sign = value < 0 ? "-" : "";
	const digits = Math.abs(value).toFixed(2);
	const symbol = SYMBOLS[unit];
	if (symbol) return `${sign}${symbol}${digits}`;
	if (/^[A-Z]{3}$/.test(unit)) return `${sign}${digits} ${unit}`;
	return `${sign}${unit}${digits}`;
}

export function formatCount(value: number): string {
	const abs = Math.abs(value);
	if (abs >= 1e9) return `${trimFixed(value / 1e9)}B`;
	if (abs >= 1e6) return `${trimFixed(value / 1e6)}M`;
	if (abs >= 1e4) return `${trimFixed(value / 1e3)}K`;
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatPercent(percent: number): string {
	if (percent > 0 && percent < 1) return "<1%";
	return `${Math.round(percent)}%`;
}

/**
 * `2 小时 13 分后重置`. Past a day the clock time is added, since "3 天 5 小时"
 * alone makes the reader do date arithmetic.
 */
export function formatReset(resetsAt: number, now = Date.now()): string {
	const ms = resetsAt - now;
	if (ms <= 0) return "已到重置时间";
	const minutes = Math.ceil(ms / 60_000);
	if (minutes < 60) return `${minutes} 分钟后重置`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const rest = minutes % 60;
		return rest ? `${hours} 小时 ${rest} 分后重置` : `${hours} 小时后重置`;
	}
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	const span = restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
	return `${span}后重置（${formatDateTime(resetsAt)}）`;
}

/** `10/09 14:00`, local time. */
export function formatDateTime(at: number): string {
	const date = new Date(at);
	return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDate(at: number): string {
	const date = new Date(at);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatClock(at: number): string {
	const date = new Date(at);
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The filled and empty parts of a usage bar `width` cells wide. */
export function barCells(percent: number, width: number): { filled: number; empty: number } {
	const clamped = Math.max(0, Math.min(100, percent));
	// Any use at all shows at least one cell; a full bar means the window is spent.
	let filled = Math.round((clamped / 100) * width);
	if (clamped > 0 && filled === 0) filled = 1;
	if (clamped < 100 && filled === width) filled = width - 1;
	return { filled, empty: width - filled };
}

export type Level = "ok" | "high" | "full";

export function usageLevel(percent: number): Level {
	if (percent >= 90) return "full";
	if (percent >= 70) return "high";
	return "ok";
}

function trimFixed(value: number): string {
	const abs = Math.abs(value);
	return value.toFixed(abs >= 100 ? 0 : abs >= 10 ? 1 : 2).replace(/\.0+$|(\.\d*?)0+$/, "$1");
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}
