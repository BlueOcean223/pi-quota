/**
 * Claude Pro/Max: the same endpoint Claude Code's `/usage` reads.
 *
 * `five_hour` and `seven_day` are the two windows every plan has, with
 * `utilization` already a percent. Either comes back null before anything
 * has been used in it; as in Claude Code, that is 0%. The one model with a
 * weekly limit of its own, Fable, is an entry of the `limits` list, shaped
 * `{ kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent }`.
 * Other entries there, and the older `seven_day_opus` style fields, describe
 * limits that no longer apply and are left out.
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
	const windows = WINDOWS.map(([key, label]) => ({ label, window: obj(body[key]) }));
	if (windows.some(({ window }) => num(window?.utilization) !== undefined)) {
		for (const { label, window } of windows) report.meters.push(meter(label, num(window?.utilization) ?? 0, window?.resets_at));
	}

	const fable = arr(body.limits)
		.map(obj)
		.find((limit) => {
			const model = str(obj(obj(limit?.scope)?.model)?.display_name);
			return limit?.kind === "weekly_scoped" && model?.toLowerCase().startsWith("fable") && num(limit.percent) !== undefined;
		});
	if (fable) {
		const model = str(obj(obj(fable.scope)?.model)?.display_name)!;
		report.meters.push(meter(`7 天 · ${model}`, num(fable.percent)!, fable.resets_at));
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
