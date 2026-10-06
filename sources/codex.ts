/**
 * ChatGPT Plus/Pro (Codex): the endpoint the Codex CLI reads its limits from.
 *
 * The primary window is the short one (five hours on most plans), the
 * secondary the weekly one; both say how long they are, so the labels come
 * from `limit_window_seconds` rather than the slot. Plans with separately
 * metered features list them under `additional_rate_limits`.
 */

import { arr, epochMs, expectJson, num, obj, str } from "../http.js";
import { emptyReport, type Meter, type Report, type Source, type Target } from "../types.js";
import { bearer, windowLabel } from "./shared.js";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";

export const codex: Source = {
	id: "codex",
	label: "ChatGPT 订阅",
	async fetch(target, http) {
		const token = bearer(target);
		const headers: Record<string, string> = { authorization: `Bearer ${token}` };
		const accountId = accountIdOf(target, token);
		if (accountId) headers["chatgpt-account-id"] = accountId;
		const result = await http.getJson(USAGE_URL, { headers });
		return parseCodexUsage(expectJson(result, "ChatGPT "));
	},
};

export function parseCodexUsage(body: Record<string, unknown>): Report {
	const report = emptyReport();
	const plan = str(body.plan_type);
	if (plan) report.plan = plan;

	report.meters.push(...windows(obj(body.rate_limit), ""));
	for (const raw of arr(body.additional_rate_limits)) {
		const extra = obj(raw);
		const name = str(extra?.limit_name) ?? str(extra?.metered_feature);
		if (!extra || !name) continue;
		report.meters.push(...windows(obj(extra.rate_limit), `${name} · `));
	}

	const credits = obj(body.credits);
	if (credits?.unlimited === true) {
		report.balances.push({ label: "Credits", value: "unlimited" });
	} else {
		const balance = num(credits?.balance);
		if (credits?.has_credits === true && balance !== undefined) {
			report.balances.push({ label: "Credits", value: { value: balance, unit: "credits" } });
		}
	}

	const limits = obj(body.rate_limit);
	if (limits?.limit_reached === true) report.notes.push({ text: "已触发限额", tone: "warning" });
	return report;
}

function windows(limits: Record<string, unknown> | undefined, prefix: string): Meter[] {
	const meters: Meter[] = [];
	for (const key of ["primary_window", "secondary_window"]) {
		const window = obj(limits?.[key]);
		const used = num(window?.used_percent);
		if (!window || used === undefined) continue;
		const seconds = num(window.limit_window_seconds);
		const label = windowLabel(seconds ? Math.round(seconds / 60) : undefined) ?? (key === "primary_window" ? "短窗口" : "长窗口");
		const resetsAt =
			epochMs(window.reset_at) ??
			(num(window.reset_after_seconds) !== undefined ? Date.now() + num(window.reset_after_seconds)! * 1000 : undefined);
		meters.push(resetsAt === undefined ? { label: prefix + label, usedPercent: used } : { label: prefix + label, usedPercent: used, resetsAt });
	}
	return meters;
}

/** The ChatGPT account id: stored by pi's login, or read from the access token's claims. */
function accountIdOf(target: Target, token: string): string | undefined {
	const stored = str(target.credential?.accountId);
	if (stored) return stored;
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	try {
		const claims = obj(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
		return str(obj(claims?.[JWT_AUTH_CLAIM])?.chatgpt_account_id);
	} catch {
		return undefined;
	}
}
