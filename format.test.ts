import { describe, expect, test } from "bun:test";
import { barCells, formatAmount, formatCount, formatPercent, formatReset, usageLevel } from "./format.js";

describe("formatAmount", () => {
	test("puts the symbol in front for USD and CNY", () => {
		expect(formatAmount({ value: 12.789, unit: "CNY" })).toBe("¥12.79");
		expect(formatAmount({ value: 0.0299, unit: "USD" })).toBe("$0.03");
	});

	test("keeps the sign outside the symbol", () => {
		expect(formatAmount({ value: -88.16, unit: "CNY" })).toBe("-¥88.16");
	});

	test("writes other ISO codes after the number and custom symbols before it", () => {
		expect(formatAmount({ value: 3, unit: "EUR" })).toBe("3.00 EUR");
		expect(formatAmount({ value: 3, unit: "¤" })).toBe("¤3.00");
	});

	test("counts tokens and credits instead of formatting them as money", () => {
		expect(formatAmount({ value: 13_090_345, unit: "tokens" })).toBe("13.1M tokens");
		expect(formatAmount({ value: 12.5, unit: "credits" })).toBe("12.5 credits");
	});
});

describe("formatCount", () => {
	test("abbreviates large counts and leaves small ones alone", () => {
		expect(formatCount(1500)).toBe("1500");
		expect(formatCount(45_000)).toBe("45K");
		expect(formatCount(2_000_000)).toBe("2M");
		expect(formatCount(1_250_000_000)).toBe("1.25B");
	});
});

describe("formatPercent", () => {
	test("rounds, but never shows a used window as 0%", () => {
		expect(formatPercent(42.4)).toBe("42%");
		expect(formatPercent(0.3)).toBe("<1%");
		expect(formatPercent(0)).toBe("0%");
	});
});

describe("formatReset", () => {
	const now = new Date(2026, 9, 6, 12, 0).getTime();
	const minutes = (n: number) => now + n * 60_000;

	test("counts minutes, then hours and minutes", () => {
		expect(formatReset(minutes(45), now)).toBe("45 分钟后重置");
		expect(formatReset(minutes(133), now)).toBe("2 小时 13 分后重置");
		expect(formatReset(minutes(180), now)).toBe("3 小时后重置");
	});

	test("adds the clock time once the reset is more than a day away", () => {
		expect(formatReset(minutes(3 * 24 * 60 + 5 * 60), now)).toBe("3 天 5 小时后重置（10/09 17:00）");
	});

	test("says so when the reset time has already passed", () => {
		expect(formatReset(now - 1000, now)).toBe("已到重置时间");
	});
});

describe("barCells", () => {
	test("always adds up to the width", () => {
		for (const percent of [0, 0.4, 13, 50, 99.6, 100, 140]) {
			const { filled, empty } = barCells(percent, 20);
			expect(filled + empty).toBe(20);
		}
	});

	test("shows any use as at least one cell, and only a spent window as full", () => {
		expect(barCells(0.4, 20).filled).toBe(1);
		expect(barCells(99.6, 20).filled).toBe(19);
		expect(barCells(100, 20).filled).toBe(20);
		expect(barCells(0, 20).filled).toBe(0);
	});
});

describe("usageLevel", () => {
	test("warns from 70% and alarms from 90%", () => {
		expect(usageLevel(69)).toBe("ok");
		expect(usageLevel(70)).toBe("high");
		expect(usageLevel(90)).toBe("full");
	});
});
