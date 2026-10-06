/**
 * Claude Pro/Max: the same endpoint Claude Code's `/usage` reads.
 *
 * `utilization` is already a percent. Windows the plan does not have come back
 * as null. Newer responses also carry a flat `limits` list whose scoped entries
 * name the model they apply to; those are shown when the flat fields did not
 * already cover them.
 */

import { arr, epochMs, expectJson, num, obj, str } from "../http.js";
import { emptyReport, type Meter, type Report, type Source } from "../types.js";
import { bearer } from "./shared.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** Matches the identity pi's own Anthropic OAuth requests send. */
const CLAUDE_CLI_VERSION = "2.1.280";

const WINDOWS: Array<[key: string, label: string]> = [
	["five_hour", "5 小时"],
	["seven_day", "7 天"],
	["seven_day_opus", "7 天 · Opus"],
	["seven_day_sonnet", "7 天 · Sonnet"],
	["seven_day_oauth_apps", "7 天 · 第三方应用"],
];

export const claude: Source = {
	id: "claude",
	label: "Claude 订阅",
	async fetch(target, http) {
		const result = await http.getJson(USAGE_URL, {
			headers: {
				authorization: `Bearer ${bearer(target)}`,
				"anthropic-beta": "oauth-2025-04-20",
				"user-agent": `claude-cli/${CLAUDE_CLI_VERSION}`,
				"x-app": "cli",
			},
		});
		return parseClaudeUsage(expectJson(result, "Anthropic "));
	},
};

export function parseClaudeUsage(body: Record<string, unknown>): Report {
	const report = emptyReport();
	const seen = new Set<string>();
	for (const [key, label] of WINDOWS) {
		const window = obj(body[key]);
		const used = num(window?.utilization);
		if (used === undefined) continue;
		report.meters.push(meter(label, used, window?.resets_at));
		seen.add(label);
	}

	for (const raw of arr(body.limits)) {
		const limit = obj(raw);
		const used = num(limit?.percent);
		if (!limit || used === undefined || limit.is_active === false) continue;
		const model = str(obj(obj(limit.scope)?.model)?.display_name);
		if (!model) continue;
		const label = `7 天 · ${model}`;
		if (seen.has(label)) continue;
		report.meters.push(meter(label, used, limit.resets_at));
		seen.add(label);
	}

	const extra = obj(body.extra_usage);
	if (extra?.is_enabled === true) {
		// Cents, like the rest of Anthropic's billing fields.
		const used = num(extra.used_credits);
		const limit = num(extra.monthly_limit);
		const unit = str(extra.currency)?.toUpperCase() ?? "USD";
		if (used !== undefined && limit !== undefined && limit > 0) {
			report.balances.push({
				label: "额外用量",
				value: { value: (limit - used) / 100, unit },
				detail: `本月已用 ${(used / 100).toFixed(2)} / ${(limit / 100).toFixed(2)} ${unit}`,
			});
		}
	}
	return report;
}

function meter(label: string, usedPercent: number, resetsAt: unknown): Meter {
	const reset = epochMs(resetsAt);
	return reset === undefined ? { label, usedPercent } : { label, usedPercent, resetsAt: reset };
}
