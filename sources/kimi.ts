/**
 * Kimi For Coding: the endpoint the Kimi CLI's `/usage` reads.
 *
 * `usage` is the weekly allowance and `limits` the short rate windows, both as
 * counts. Some accounts get ratio pools (`usages.limit_5h`, …) instead; those
 * fill in windows the counts did not cover.
 */

import { arr, epochMs, expectJson, num, obj, str } from "../http.ts";
import { emptyReport, type Meter, type Report, type Source } from "../types.ts";
import { bearer, countDetail, percentOf, windowLabel } from "./shared.ts";

const DEFAULT_BASE = "https://api.kimi.com/coding";
const TIME_UNIT_MINUTES: Record<string, number> = {
	TIME_UNIT_SECOND: 1 / 60,
	TIME_UNIT_MINUTE: 1,
	TIME_UNIT_HOUR: 60,
	TIME_UNIT_DAY: 60 * 24,
};
const POOLS: Array<[key: string, label: string]> = [
	["limit_5h", "5 小时"],
	["limit_7d", "7 天"],
	["limit_month_total", "本月"],
];

export const kimi: Source = {
	id: "kimi",
	label: "Kimi Coding",
	async fetch(target, http) {
		const result = await http.getJson(usageUrl(target.baseUrl || DEFAULT_BASE), {
			headers: { authorization: `Bearer ${bearer(target)}` },
		});
		return parseKimiUsage(expectJson(result, "Kimi "));
	},
};

/** `…/coding/v1/usages` wherever in that path the configured base URL stops. */
export function usageUrl(baseUrl: string): string {
	const url = new URL(baseUrl);
	const path = url.pathname.replace(/\/+$/, "");
	if (path.endsWith("/coding/v1")) url.pathname = `${path}/usages`;
	else if (path.endsWith("/coding")) url.pathname = `${path}/v1/usages`;
	else url.pathname = "/coding/v1/usages";
	return url.toString();
}

export function parseKimiUsage(body: Record<string, unknown>): Report {
	const report = emptyReport();
	const level = str(obj(obj(body.user)?.membership)?.level);
	if (level) report.plan = level.replace(/^LEVEL_/, "").toLowerCase();

	for (const raw of arr(body.limits)) {
		const limit = obj(raw);
		const window = obj(limit?.window);
		const duration = num(window?.duration);
		const unit = TIME_UNIT_MINUTES[str(window?.timeUnit) ?? ""];
		const label = windowLabel(duration && unit ? Math.round(duration * unit) : undefined) ?? "速率窗口";
		const entry = countMeter(label, obj(limit?.detail));
		if (entry) report.meters.push(entry);
	}

	const weekly = countMeter("7 天", obj(body.usage));
	if (weekly) report.meters.push(weekly);

	const pools = obj(body.usages);
	const labels = new Set(report.meters.map((entry) => entry.label));
	for (const [key, label] of POOLS) {
		const pool = obj(pools?.[key]);
		const ratio = num(pool?.used_ratio);
		if (ratio === undefined || labels.has(label)) continue;
		const resetsAt = resetOf(pool);
		report.meters.push({ label, usedPercent: ratio <= 1 ? ratio * 100 : ratio, ...(resetsAt ? { resetsAt } : {}) });
	}
	return report;
}

function countMeter(label: string, detail: Record<string, unknown> | undefined): Meter | undefined {
	const limit = num(detail?.limit);
	const used = num(detail?.used);
	const remaining = num(detail?.remaining);
	const usedPercent = percentOf(limit, used, remaining);
	if (usedPercent === undefined) return undefined;
	const spent = used ?? (limit !== undefined && remaining !== undefined ? limit - remaining : undefined);
	const resetsAt = resetOf(detail);
	const counts = countDetail(spent, limit, "次");
	return { label, usedPercent, ...(resetsAt ? { resetsAt } : {}), ...(counts ? { detail: counts } : {}) };
}

function resetOf(detail: Record<string, unknown> | undefined): number | undefined {
	return epochMs(detail?.resetTime ?? detail?.reset_time ?? detail?.resetAt ?? detail?.reset_at);
}
