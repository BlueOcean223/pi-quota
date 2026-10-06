/**
 * OpenCode Go: the subscription's own usage endpoint, read with the ordinary
 * API key.
 *
 * Three windows, each a share of the plan's monthly dollar limit: `rolling`
 * (five hours, 20%), `weekly` (50%) and `monthly`. A window whose status is
 * not `ok` carries no trustworthy percent, so it is reported, not drawn.
 */

import { epochMs, expectJson, num, obj, originOf, QuotaError, str } from "../http.js";
import { emptyReport, type Report, type Source } from "../types.js";
import { bearer } from "./shared.js";

const WINDOWS: Array<[key: string, label: string]> = [
	["rolling", "5 小时"],
	["weekly", "7 天"],
	["monthly", "本月"],
];

export const opencodeGo: Source = {
	id: "opencode-go",
	label: "OpenCode Go",
	async fetch(target, http) {
		// Built from the origin: the configured base URL may or may not end in /v1.
		const result = await http.getJson(`${originOf(target.baseUrl)}/zen/go/v1/usage`, {
			headers: { authorization: `Bearer ${bearer(target)}` },
		});
		return parseOpencodeGoUsage(expectJson(result, "OpenCode "));
	},
};

export function parseOpencodeGoUsage(body: Record<string, unknown>): Report {
	const usage = obj(body.usage);
	if (!usage) throw new QuotaError("OpenCode 的响应里没有用量");
	const report = emptyReport();
	for (const [key, label] of WINDOWS) {
		const window = obj(usage[key]);
		if (!window) continue;
		const status = str(window.status);
		const percent = num(window.percent);
		if (status !== "ok" || percent === undefined) {
			report.notes.push({ text: `${label}窗口暂时查不到${status ? `（${status}）` : ""}`, tone: "warning" });
			continue;
		}
		const resetsAt = epochMs(window.resetsAt);
		report.meters.push({ label, usedPercent: percent, ...(resetsAt !== undefined ? { resetsAt } : {}) });
	}
	if (report.meters.length === 0 && report.notes.length === 0) throw new QuotaError("OpenCode 的响应里没有用量窗口");
	return report;
}
