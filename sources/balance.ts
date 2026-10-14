/**
 * Vendors whose API key can read its own account balance with one GET.
 */

import { arr, expectJson, hostOf, num, obj, originOf, QuotaError, str } from "../http.ts";
import { emptyReport, type Report, type Source } from "../types.ts";
import { bearer } from "./shared.ts";

export const deepseek: Source = {
	id: "deepseek",
	label: "DeepSeek",
	async fetch(target, http) {
		const result = await http.getJson("https://api.deepseek.com/user/balance", {
			headers: { authorization: `Bearer ${bearer(target)}` },
		});
		return parseDeepseekBalance(expectJson(result, "DeepSeek "));
	},
};

export function parseDeepseekBalance(body: Record<string, unknown>): Report {
	const report = emptyReport();
	for (const raw of arr(body.balance_infos)) {
		const info = obj(raw);
		const total = num(info?.total_balance);
		if (!info || total === undefined) continue;
		report.balances.push({ label: "余额", value: { value: total, unit: str(info.currency) ?? "CNY" } });
	}
	if (body.is_available === false) report.notes.push({ text: "余额不足，API 已不可用", tone: "warning" });
	return report;
}

export const moonshot: Source = {
	id: "moonshot",
	label: "Moonshot",
	async fetch(target, http) {
		const origin = /moonshot\.cn$/.test(hostOf(target.baseUrl)) ? "https://api.moonshot.cn" : "https://api.moonshot.ai";
		const result = await http.getJson(`${origin}/v1/users/me/balance`, {
			headers: { authorization: `Bearer ${bearer(target)}` },
		});
		return parseMoonshotBalance(expectJson(result, "Moonshot "), origin.endsWith(".cn") ? "CNY" : "USD");
	},
};

export function parseMoonshotBalance(body: Record<string, unknown>, unit: string): Report {
	const data = obj(body.data);
	const available = num(data?.available_balance);
	if (available === undefined) throw new QuotaError(`Moonshot：${str(body.message) ?? str(body.scode) ?? "响应里没有余额"}`);
	const report = emptyReport();
	const cash = num(data?.cash_balance);
	report.balances.push({ label: "余额", value: { value: available, unit } });
	if (cash !== undefined && cash < 0) report.notes.push({ text: "现金余额为负，已欠费", tone: "warning" });
	return report;
}

/**
 * OpenRouter: the key's own limit from `/key`, and the account's credits from
 * `/credits`. Keys without a management scope can be refused `/credits`; the
 * key limit still stands on its own then.
 */
export const openrouter: Source = {
	id: "openrouter",
	label: "OpenRouter",
	async fetch(target, http) {
		const base = `${originOf(target.baseUrl)}/api/v1`;
		const headers = { authorization: `Bearer ${bearer(target)}` };
		const [key, credits] = await Promise.all([
			http.getJson(`${base}/key`, { headers }),
			http.getJson(`${base}/credits`, { headers }).catch(() => undefined),
		]);
		const creditsBody = credits && credits.status === 200 ? obj(credits.json) : undefined;
		return parseOpenrouter(expectJson(key, "OpenRouter "), creditsBody);
	},
};

export function parseOpenrouter(keyBody: Record<string, unknown>, creditsBody: Record<string, unknown> | undefined): Report {
	const report = emptyReport();
	const key = obj(keyBody.data);
	if (key?.is_free_tier === true) report.plan = "free";

	const credits = obj(creditsBody?.data);
	const total = num(credits?.total_credits);
	const spent = num(credits?.total_usage);
	if (total !== undefined && spent !== undefined) {
		report.balances.push({
			label: "账户余额",
			value: { value: total - spent, unit: "USD" },
			detail: `共 $${total.toFixed(2)} · 已用 $${spent.toFixed(2)}`,
		});
	}

	const limit = num(key?.limit);
	const usage = num(key?.usage);
	if (limit !== undefined) {
		const remaining = num(key?.limit_remaining) ?? limit - (usage ?? 0);
		const reset = str(key?.limit_reset);
		const parts = [`已用 $${(usage ?? limit - remaining).toFixed(2)} / $${limit.toFixed(2)}`];
		if (reset) parts.push(`按${RESET_LABELS[reset] ?? reset}重置`);
		report.balances.push({ label: "Key 限额", value: { value: remaining, unit: "USD" }, detail: parts.join(" · ") });
	} else if (report.balances.length === 0) {
		report.balances.push({
			label: "Key 限额",
			value: "unlimited",
			...(usage !== undefined ? { detail: `已用 $${usage.toFixed(2)}` } : {}),
		});
	}
	return report;
}

const RESET_LABELS: Record<string, string> = { daily: "天", weekly: "周", monthly: "月" };

export const siliconflow: Source = {
	id: "siliconflow",
	label: "硅基流动",
	async fetch(target, http) {
		const origin = originOf(target.baseUrl);
		const result = await http.getJson(`${origin}/v1/user/info`, { headers: { authorization: `Bearer ${bearer(target)}` } });
		return parseSiliconflow(expectJson(result, "硅基流动 "), origin.endsWith(".cn") ? "CNY" : "USD");
	},
};

export function parseSiliconflow(body: Record<string, unknown>, unit: string): Report {
	const data = obj(body.data);
	const total = num(data?.totalBalance);
	if (total === undefined) throw new QuotaError(`硅基流动：${str(body.message) ?? "响应里没有余额"}`);
	const report = emptyReport();
	report.balances.push({ label: "余额", value: { value: total, unit } });
	return report;
}
