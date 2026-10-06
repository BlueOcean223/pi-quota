/**
 * MiniMax Coding / Token Plan.
 *
 * Two endpoints exist: the current token-plan one and the older coding-plan
 * one. Accounts answer on one or the other, so the newer is tried first.
 *
 * `current_interval_usage_count` is the count *remaining*, despite the name;
 * the console and MiniMax's own tooling read it that way.
 */

import { arr, epochMs, expectJson, hostOf, num, obj, QuotaError, str } from "../http.js";
import { emptyReport, type Http, type Meter, type Report, type Source } from "../types.js";
import { bearer, countDetail, percentOf, windowLabel } from "./shared.js";

const PATHS = ["/v1/token_plan/remains", "/v1/api/openplatform/coding_plan/remains"];

export const minimax: Source = {
	id: "minimax",
	label: "MiniMax",
	async fetch(target, http) {
		const origin = /minimaxi\.com$/.test(hostOf(target.baseUrl)) ? "https://api.minimaxi.com" : "https://api.minimax.io";
		const headers = { authorization: `Bearer ${bearer(target)}` };
		let lastError: unknown;
		for (const path of PATHS) {
			try {
				return await fetchRemains(http, origin + path, headers);
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError;
	},
};

async function fetchRemains(http: Http, url: string, headers: Record<string, string>): Promise<Report> {
	const body = expectJson(await http.getJson(url, { headers }), "MiniMax ");
	const status = num(obj(body.base_resp)?.status_code);
	if (status !== undefined && status !== 0) {
		throw new QuotaError(`MiniMax：${str(obj(body.base_resp)?.status_msg) ?? `status_code ${status}`}`);
	}
	return parseMinimaxRemains(body);
}

export function parseMinimaxRemains(body: Record<string, unknown>, now = Date.now()): Report {
	const report = emptyReport();
	const items = arr(body.model_remains).map(obj).filter((item) => item !== undefined);
	const named = items.length > 1;
	for (const item of items) {
		const model = str(item.model_name);
		const prefix = named && model ? `${model} · ` : "";
		const interval = meter(
			prefix,
			num(item.current_interval_total_count),
			num(item.current_interval_usage_count),
			num(item.current_interval_remaining_percent),
			item.start_time,
			item.end_time,
			num(item.remains_time),
			now,
		);
		if (interval) report.meters.push(interval);
		const weekly = meter(
			prefix,
			num(item.current_weekly_total_count),
			num(item.current_weekly_usage_count),
			num(item.current_weekly_remaining_percent),
			item.weekly_start_time,
			item.weekly_end_time,
			num(item.weekly_remains_time),
			now,
		);
		if (weekly) report.meters.push(weekly);
	}
	return report;
}

function meter(
	prefix: string,
	total: number | undefined,
	remaining: number | undefined,
	remainingPercent: number | undefined,
	start: unknown,
	end: unknown,
	remainsMs: number | undefined,
	now: number,
): Meter | undefined {
	// A lane the plan does not include comes back with a zero total.
	if (!total || total <= 0) return undefined;
	// Percent-metered plans report a zero count next to the percent that matters.
	const byPercent = remainingPercent !== undefined && !remaining;
	const usedPercent = byPercent ? 100 - remainingPercent : percentOf(total, undefined, remaining);
	if (usedPercent === undefined) return undefined;
	const startMs = epochMs(start);
	const endMs = epochMs(end);
	const minutes = startMs && endMs && endMs > startMs ? Math.round((endMs - startMs) / 60_000) : undefined;
	const resetsAt = endMs ?? (remainsMs ? now + remainsMs : undefined);
	const detail = byPercent ? undefined : countDetail(total - (remaining ?? 0), total, "次");
	return {
		label: prefix + (windowLabel(minutes) ?? "当前周期"),
		usedPercent,
		...(resetsAt !== undefined ? { resetsAt } : {}),
		...(detail ? { detail } : {}),
	};
}
