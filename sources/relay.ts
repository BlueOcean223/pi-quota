/**
 * Relays and aggregators: NewAPI (and its OneAPI ancestry), Sub2API, and
 * anything that implements OpenAI's old `/dashboard/billing` endpoints.
 *
 * A custom provider says nothing about which of these it runs, so `relay`
 * probes them in order, cheapest-to-recognize first, and the first one that
 * answers in its own shape wins:
 *
 * 1. NewAPI `/api/usage/token/` — the token's own allowance, in raw quota
 *    points. `/api/status` says how many points make a unit and which unit
 *    the site displays.
 * 2. Sub2API `/v1/usage`.
 * 3. `/v1/dashboard/billing/subscription` + `/usage`. NewAPI and OneAPI both
 *    serve these, already converted to the site's display unit, and they are
 *    on the `/v1` path a relay's anti-bot layer usually leaves open when it
 *    challenges `/api/*`.
 *
 * NewAPI tokens are often created with unlimited quota, in which case the
 * token reports no limit and the real cap is the account balance. Sites that
 * turn off per-token stats answer the billing endpoints for the account, so
 * the key alone is enough there. Elsewhere it takes a system access token,
 * configured per provider in `quota.json`.
 */

import { resolveConfigValue } from "../config.js";
import { formatAmount, formatDate } from "../format.js";
import { arr, epochMs, expectJson, num, obj, originOf, QuotaError, str } from "../http.js";
import { type Amount, type Balance, emptyReport, type Http, type Report, type Source, type Target } from "../types.js";
import { bearer } from "./shared.js";

/** NewAPI's sentinel for an unlimited token in the billing endpoints. */
const UNLIMITED_SENTINEL = 100_000_000;
const DEFAULT_QUOTA_PER_UNIT = 500_000;

/** How a NewAPI site turns raw quota points into what it displays. */
export interface SiteUnit {
	quotaPerUnit: number;
	/** `USD`, `CNY`, `tokens`, or a custom symbol. */
	unit: string;
	/** Multiplier from USD to `unit`. */
	rate: number;
	/** False when `/api/status` could not be read and the defaults are a guess. */
	known: boolean;
}

export const newapi: Source = {
	id: "newapi",
	label: "NewAPI",
	async fetch(target, http) {
		const origin = originOf(target.settings.baseUrl ?? target.baseUrl);
		const [token, unit] = await Promise.all([
			http.getJson(`${origin}/api/usage/token/`, { headers: { authorization: `Bearer ${bearer(target)}` } }),
			siteUnit(http, origin),
		]);
		const data = obj(expectJson(token, "NewAPI ").data);
		if (!data) throw new QuotaError("NewAPI 没有返回令牌信息");
		return finishNewapi(http, origin, target, parseTokenUsage(data, unit), unit);
	},
};

export const sub2api: Source = {
	id: "sub2api",
	label: "Sub2API",
	async fetch(target, http) {
		const origin = originOf(target.settings.baseUrl ?? target.baseUrl);
		const result = await http.getJson(`${origin}/v1/usage?days=30`, { headers: { authorization: `Bearer ${bearer(target)}` } });
		return parseSub2api(expectJson(result, "Sub2API "));
	},
};

export const billing: Source = {
	id: "billing",
	label: "OpenAI 兼容账单",
	async fetch(target, http) {
		const origin = originOf(target.settings.baseUrl ?? target.baseUrl);
		return fetchBilling(http, origin, bearer(target), siteUnit(http, origin));
	},
};

/** Probe a custom provider for the relay family it belongs to. */
export const relay: Source = {
	id: "relay",
	label: "中转站",
	async fetch(target, http) {
		const origin = originOf(target.settings.baseUrl ?? target.baseUrl);
		const key = bearer(target);
		const headers = { authorization: `Bearer ${key}` };
		const unit = siteUnit(http, origin);

		const token = await http.getJson(`${origin}/api/usage/token/`, { headers }).catch(() => undefined);
		const tokenData = obj(obj(token?.json)?.data);
		if (token?.status === 200 && tokenData?.object === "token_usage") {
			const site = await unit;
			const report = await finishNewapi(http, origin, target, parseTokenUsage(tokenData, site), site);
			return { ...report, plan: report.plan ?? "NewAPI" };
		}

		const usage = await http.getJson(`${origin}/v1/usage?days=30`, { headers }).catch(() => undefined);
		const usageBody = obj(usage?.json);
		if (usage?.status === 200 && usageBody && looksLikeSub2api(usageBody)) {
			const report = parseSub2api(usageBody);
			return { ...report, plan: report.plan ?? "Sub2API" };
		}

		try {
			const report = await fetchBilling(http, origin, key, unit);
			return { ...report, plan: report.plan ?? "OpenAI 兼容账单" };
		} catch (error) {
			if (error instanceof QuotaError && /HTTP 40[13]/.test(error.message)) throw error;
			throw new QuotaError("没认出这个中转站的额度接口（试过 NewAPI、Sub2API、OpenAI 兼容账单）");
		}
	},
};

/* ------------------------------------------------------------------ */
/* NewAPI                                                              */
/* ------------------------------------------------------------------ */

async function siteUnit(http: Http, origin: string): Promise<SiteUnit> {
	try {
		const result = await http.getJson(`${origin}/api/status`, { timeoutMs: 8_000 });
		const body = obj(result.json);
		const data = obj(body?.data);
		if (result.status === 200 && body?.success === true && data) return unitFromStatus(data);
	} catch {
		// Fall through to the defaults a stock install ships with.
	}
	return { quotaPerUnit: DEFAULT_QUOTA_PER_UNIT, unit: "USD", rate: 1, known: false };
}

export function unitFromStatus(data: Record<string, unknown>): SiteUnit {
	const quotaPerUnit = num(data.quota_per_unit) || DEFAULT_QUOTA_PER_UNIT;
	const type = str(data.quota_display_type)?.toUpperCase();
	if (type === "CNY") return { quotaPerUnit, unit: "CNY", rate: num(data.usd_exchange_rate) || 7.3, known: true };
	if (type === "TOKENS") return { quotaPerUnit, unit: "tokens", rate: 1, known: true };
	if (type === "CUSTOM") {
		return {
			quotaPerUnit,
			unit: str(data.custom_currency_symbol) ?? "¤",
			rate: num(data.custom_currency_exchange_rate) || 1,
			known: true,
		};
	}
	// Builds before `quota_display_type` only say whether amounts are currency at all.
	if (type === undefined && data.display_in_currency === false) return { quotaPerUnit, unit: "tokens", rate: 1, known: true };
	return { quotaPerUnit, unit: "USD", rate: 1, known: true };
}

export function quotaAmount(points: number, unit: SiteUnit): Amount {
	if (unit.unit === "tokens") return { value: points, unit: "tokens" };
	return { value: (points / unit.quotaPerUnit) * unit.rate, unit: unit.unit };
}

export function parseTokenUsage(data: Record<string, unknown>, unit: SiteUnit, now = Date.now()): Report {
	const report = emptyReport();
	const name = str(data.name);
	const label = name ? `令牌 ${name}` : "令牌";
	const used = num(data.total_used) ?? 0;
	const parts = [`已用 ${formatAmount(quotaAmount(used, unit))}`];
	const expires = num(data.expires_at);
	if (expires && expires > 0) {
		const at = epochMs(expires)!;
		if (at < now) report.notes.push({ text: `令牌已于 ${formatDate(at)} 过期`, tone: "warning" });
		else parts.push(`${formatDate(at)} 到期`);
	}

	if (data.unlimited_quota === true) {
		report.balances.push({ label, value: "unlimited", detail: parts.join(" · ") });
	} else {
		const available = num(data.total_available) ?? 0;
		const granted = num(data.total_granted);
		if (granted !== undefined) parts[0] = `已用 ${formatAmount(quotaAmount(used, unit))} / ${formatAmount(quotaAmount(granted, unit))}`;
		report.balances.push({ label, value: quotaAmount(available, unit), detail: parts.join(" · ") });
	}

	if (data.model_limits_enabled === true) {
		const models = Object.keys(obj(data.model_limits) ?? {});
		if (models.length > 0) report.notes.push({ text: `只能用：${models.slice(0, 6).join(", ")}${models.length > 6 ? " 等" : ""}`, tone: "muted" });
	}
	if (!unit.known) report.notes.push({ text: "站点没有公开 /api/status，金额按默认 500000 点 = $1 换算", tone: "muted" });
	return report;
}

/**
 * Add the account balance: from the access token in `quota.json` when there is
 * one, else from the billing endpoints when the site reports the account
 * there. Otherwise, or when the token is refused, the report says what it
 * would take, and the panel offers to take it.
 */
async function finishNewapi(http: Http, origin: string, target: Target, report: Report, unit: SiteUnit): Promise<Report> {
	const configured = target.settings.accessToken;
	if (configured) {
		try {
			const token = resolveConfigValue(configured);
			if (!token) throw new QuotaError("quota.json 里的 accessToken 解析出来是空的");
			report.balances.unshift(await accountBalance(http, origin, token, target.settings.userId, unit));
		} catch (error) {
			report.setup = { site: target.site, origin, problem: error instanceof Error ? error.message : String(error) };
		}
		return report;
	}
	if (!report.balances.some((balance) => balance.value === "unlimited")) return report;
	const account = await billingAccount(http, origin, bearer(target), unit).catch(() => undefined);
	if (account) report.balances.unshift(account);
	else report.setup = { site: target.site, origin };
	return report;
}

/**
 * With per-token stats off (`DisplayTokenStatEnabled`), the billing endpoints
 * answer for the account, in the site's display unit. With them on, an
 * unlimited token gets the sentinel instead, which says nothing.
 */
async function billingAccount(http: Http, origin: string, key: string, unit: SiteUnit): Promise<Balance | undefined> {
	const headers = { authorization: `Bearer ${key}` };
	const [subscription, usage] = await Promise.all([
		http.getJson(`${origin}/v1/dashboard/billing/subscription`, { headers }),
		http.getJson(`${origin}/v1/dashboard/billing/usage`, { headers }),
	]);
	if (subscription.status !== 200 || usage.status !== 200) return undefined;
	const total = num(obj(subscription.json)?.hard_limit_usd);
	const usedCents = num(obj(usage.json)?.total_usage);
	if (total === undefined || usedCents === undefined || total >= UNLIMITED_SENTINEL - 1) return undefined;
	const used = usedCents / 100;
	return {
		label: "账户余额",
		value: { value: total - used, unit: unit.unit },
		detail: `已用 ${formatAmount({ value: used, unit: unit.unit })}`,
	};
}

/** The site wants the user id next to the access token, and none was given. */
export class NeedsUserId extends QuotaError {
	override name = "NeedsUserId";
}

/** Check a system access token the way a query would use it, for saving it from the panel. */
export async function checkAccount(http: Http, origin: string, token: string, userId?: number | string): Promise<Balance> {
	return accountBalance(http, origin, token, userId, await siteUnit(http, origin));
}

async function accountBalance(http: Http, origin: string, token: string, userId: number | string | undefined, unit: SiteUnit): Promise<Balance> {
	const headers: Record<string, string> = { authorization: `Bearer ${token}` };
	// Builds before mid-2026 refuse an access token without the matching user id.
	if (userId !== undefined) headers["new-api-user"] = String(userId);
	const body = expectJson(await http.getJson(`${origin}/api/user/self`, { headers }), "NewAPI ");
	if (body.success !== true) {
		const message = str(body.message) ?? "查询账户失败";
		if (/new-api-user/i.test(message) && userId === undefined) throw new NeedsUserId(`${message}（这个站点的版本还要用户 ID）`);
		throw new QuotaError(message);
	}
	const data = obj(body.data);
	const quota = num(data?.quota);
	if (quota === undefined) throw new QuotaError("响应里没有账户额度");
	const used = num(data?.used_quota);
	const parts: string[] = [];
	if (used !== undefined) parts.push(`已用 ${formatAmount(quotaAmount(used, unit))}`);
	const group = str(data?.group);
	if (group) parts.push(`分组 ${group}`);
	return { label: "账户余额", value: quotaAmount(quota, unit), ...(parts.length ? { detail: parts.join(" · ") } : {}) };
}

/* ------------------------------------------------------------------ */
/* OpenAI-compatible billing                                           */
/* ------------------------------------------------------------------ */

/**
 * Amounts come back in the site's display unit already; the `_usd` in the
 * field names is OpenAI's, not a promise.
 */
async function fetchBilling(http: Http, origin: string, key: string, unit: Promise<SiteUnit>): Promise<Report> {
	const headers = { authorization: `Bearer ${key}` };
	const [subscription, usage] = await Promise.all([
		http.getJson(`${origin}/v1/dashboard/billing/subscription`, { headers }),
		http.getJson(`${origin}/v1/dashboard/billing/usage`, { headers }),
	]);
	return parseBilling(expectJson(subscription, "账单接口"), expectJson(usage, "账单接口"), await unit);
}

export function parseBilling(
	subscription: Record<string, unknown>,
	usage: Record<string, unknown>,
	unit: SiteUnit,
	now = Date.now(),
): Report {
	const errorMessage = str(obj(subscription.error)?.message) ?? str(obj(usage.error)?.message);
	if (errorMessage) throw new QuotaError(`账单接口：${errorMessage}`);
	const hardLimit = num(subscription.hard_limit_usd);
	const usedCents = num(usage.total_usage);
	if (hardLimit === undefined || usedCents === undefined) throw new QuotaError("账单接口返回的格式不认识");

	const report = emptyReport();
	const money = (value: number) => formatAmount({ value, unit: unit.unit });
	const used = usedCents / 100;
	const parts = [`已用 ${money(used)}`];
	const until = num(subscription.access_until);
	if (until && until > 0) {
		const at = epochMs(until)!;
		if (at < now) report.notes.push({ text: `已于 ${formatDate(at)} 过期`, tone: "warning" });
		else parts.push(`${formatDate(at)} 到期`);
	}
	if (hardLimit >= UNLIMITED_SENTINEL - 1) {
		report.balances.push({ label: "额度", value: "unlimited", detail: parts.join(" · ") });
	} else {
		parts[0] = `已用 ${money(used)} / ${money(hardLimit)}`;
		report.balances.push({ label: "额度", value: { value: hardLimit - used, unit: unit.unit }, detail: parts.join(" · ") });
	}
	if (!unit.known) report.notes.push({ text: "站点没有公开 /api/status，金额单位按 USD 显示", tone: "muted" });
	return report;
}

/* ------------------------------------------------------------------ */
/* Sub2API                                                             */
/* ------------------------------------------------------------------ */

export function looksLikeSub2api(body: Record<string, unknown>): boolean {
	return (
		typeof body.isValid === "boolean" ||
		obj(body.quota) !== undefined ||
		obj(body.subscription) !== undefined ||
		Array.isArray(body.rate_limits)
	);
}

const SUB2API_WINDOWS: Record<string, string> = { "5h": "5 小时", "1d": "1 天", "7d": "7 天" };

export function parseSub2api(body: Record<string, unknown>, now = Date.now()): Report {
	if (body.isValid === false) throw new QuotaError("Sub2API 说这个 key 无效或没分配分组");
	const report = emptyReport();
	const plan = str(body.planName);
	if (plan) report.plan = plan;
	const unit = str(body.unit)?.toUpperCase() ?? "USD";
	const money = (value: number) => formatAmount({ value, unit });

	for (const raw of arr(body.rate_limits)) {
		const rate = obj(raw);
		const limit = num(rate?.limit);
		const used = num(rate?.used);
		if (!rate || !limit || used === undefined) continue;
		const window = str(rate.window)?.toLowerCase() ?? "";
		const resetsAt = epochMs(rate.reset_at);
		report.meters.push({
			label: SUB2API_WINDOWS[window] ?? window,
			usedPercent: (used / limit) * 100,
			detail: `${money(used)} / ${money(limit)}`,
			...(resetsAt !== undefined ? { resetsAt } : {}),
		});
	}

	const subscription = obj(body.subscription);
	for (const [period, label] of [
		["daily", "今日"],
		["weekly", "本周"],
		["monthly", "本月"],
	] as const) {
		const limit = num(subscription?.[`${period}_limit_usd`]);
		const used = num(subscription?.[`${period}_usage_usd`]) ?? 0;
		if (!limit || limit <= 0) continue;
		report.meters.push({ label, usedPercent: (used / limit) * 100, detail: `${money(used)} / ${money(limit)}` });
	}

	const quota = obj(body.quota);
	const quotaLimit = num(quota?.limit);
	const quotaUsed = num(quota?.used);
	const quotaRemaining = num(quota?.remaining);
	if (quota && quotaRemaining !== undefined) {
		const quotaUnit = str(quota.unit)?.toUpperCase() ?? unit;
		const detail =
			quotaLimit !== undefined && quotaUsed !== undefined
				? `已用 ${formatAmount({ value: quotaUsed, unit: quotaUnit })} / ${formatAmount({ value: quotaLimit, unit: quotaUnit })}`
				: undefined;
		report.balances.push({ label: "额度", value: { value: quotaRemaining, unit: quotaUnit }, ...(detail ? { detail } : {}) });
	}

	const balance = num(body.balance);
	if (balance !== undefined) report.balances.push({ label: "余额", value: { value: balance, unit } });
	const remaining = num(body.remaining);
	if (report.balances.length === 0 && report.meters.length === 0 && remaining !== undefined) {
		report.balances.push({ label: "剩余", value: { value: remaining, unit } });
	}

	const expires = epochMs(subscription?.expires_at ?? body.expires_at);
	if (expires !== undefined) {
		report.notes.push(
			expires < now
				? { text: `订阅已于 ${formatDate(expires)} 过期`, tone: "warning" }
				: { text: `订阅 ${formatDate(expires)} 到期`, tone: "muted" },
		);
	}
	return report;
}
