/**
 * SuperGrok / X Premium: the billing endpoints the Grok CLI's `/usage` reads.
 *
 * pi signs in to xAI with the Grok CLI's own OAuth client id and scopes, so
 * its access token is accepted here exactly as the CLI's is. There are two
 * shapes, both plain JSON:
 *
 * - `?format=credits`: the usage window (weekly on current plans) as a
 *   percent, combined and per product;
 * - the default shape: a monthly dollar allowance, on plans that have one.
 *
 * Both are asked; the report fails only when neither answers. The bodies are
 * proto3 JSON, which drops zero values, so a missing percent means 0% and
 * every `{ val }` amount is USD cents.
 */

import { arr, epochMs, num, obj, QuotaError, serverMessage, str } from "../http.ts";
import { emptyReport, type HttpResult, type Meter, type Report, type Source } from "../types.ts";
import { bearer } from "./shared.ts";

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";

const PERIOD_LABELS: Record<string, string> = {
	USAGE_PERIOD_TYPE_DAILY: "今天",
	USAGE_PERIOD_TYPE_WEEKLY: "7 天",
	USAGE_PERIOD_TYPE_MONTHLY: "本月",
};

export const grok: Source = {
	id: "grok",
	label: "Grok 订阅",
	async fetch(target, http) {
		const headers = { authorization: `Bearer ${bearer(target)}` };
		const [credits, allowance] = await Promise.allSettled([
			http.getJson(`${BILLING_URL}?format=credits`, { headers }).then(configOf),
			http.getJson(BILLING_URL, { headers }).then(configOf),
		]);
		if (credits.status === "rejected" && allowance.status === "rejected") throw credits.reason;
		return parseGrokBilling(
			credits.status === "fulfilled" ? credits.value : undefined,
			allowance.status === "fulfilled" ? allowance.value : undefined,
		);
	},
};

/** Both arguments are the `config` object of their response. */
export function parseGrokBilling(credits: Record<string, unknown> | undefined, allowance: Record<string, unknown> | undefined): Report {
	const report = emptyReport();

	const period = obj(credits?.currentPeriod);
	if (credits && period) {
		const label = PERIOD_LABELS[str(period.type) ?? ""] ?? "Credits";
		const resetsAt = epochMs(period.end);
		const meter = (name: string, used: unknown): Meter => ({
			label: name,
			usedPercent: num(used) ?? 0,
			...(resetsAt !== undefined ? { resetsAt } : {}),
		});
		report.meters.push(meter(label, credits.creditUsagePercent));
		// A breakdown only says something the combined window does not when more than one product has used it.
		const products = arr(credits.productUsage)
			.map(obj)
			.filter((product) => product && str(product.product) && (num(product.usagePercent) ?? 0) > 0) as Array<Record<string, unknown>>;
		if (products.length > 1) {
			for (const product of products) report.meters.push(meter(`${label} · ${productName(str(product.product)!)}`, product.usagePercent));
		}
	}

	const limit = cents(allowance?.monthlyLimit);
	if (allowance && limit !== undefined && limit > 0) {
		const used = cents(allowance.used) ?? 0;
		const resetsAt = epochMs(allowance.billingPeriodEnd);
		report.meters.push({
			label: "本月额度",
			usedPercent: (used / limit) * 100,
			detail: `$${used.toFixed(2)} / $${limit.toFixed(2)}`,
			...(resetsAt !== undefined ? { resetsAt } : {}),
		});
	}

	const config = credits ?? allowance;
	const cap = cents(config?.onDemandCap);
	if (config && cap !== undefined && cap > 0) {
		const used = cents(config.onDemandUsed) ?? 0;
		report.meters.push({ label: "按需用量", usedPercent: (used / cap) * 100, detail: `$${used.toFixed(2)} / $${cap.toFixed(2)}` });
	}

	const prepaid = cents(credits?.prepaidBalance);
	if (prepaid !== undefined && prepaid > 0) report.balances.push({ label: "预付余额", value: { value: prepaid, unit: "USD" } });

	if (report.meters.length === 0 && report.balances.length === 0) throw new QuotaError("Grok 账单里没有用量数据");
	return report;
}

function configOf(result: HttpResult): Record<string, unknown> {
	if (result.status === 401 || result.status === 403) {
		throw new QuotaError(`Grok 拒绝了凭据（HTTP ${result.status}），重新 /login xai 试试`);
	}
	if (result.status === 429) throw new QuotaError("Grok 限流了，稍后再试（HTTP 429）");
	if (result.status < 200 || result.status >= 300) {
		const message = serverMessage(result);
		throw new QuotaError(`Grok 账单接口返回 HTTP ${result.status}${message ? `：${message}` : ""}`);
	}
	const config = obj(obj(result.json)?.config);
	if (!config) throw new QuotaError("Grok 账单接口返回的不是预期的 JSON");
	return config;
}

/** Dollars from a `{ val }` amount in cents. */
function cents(value: unknown): number | undefined {
	const raw = num(obj(value)?.val);
	return raw === undefined ? undefined : raw / 100;
}

/** `GrokBuild` → `Grok Build`. */
function productName(id: string): string {
	return id.replace(/([a-z])([A-Z])/g, "$1 $2");
}
