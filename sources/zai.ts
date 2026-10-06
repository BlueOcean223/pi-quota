/**
 * 智谱 / Z.ai: the GLM Coding Plan windows, and on bigmodel.cn the pay-as-you-go
 * account balance.
 *
 * The two answer for different keys. A Coding Plan key has windows and often
 * no balance worth showing; a plain open-platform key has a balance and the
 * quota endpoint says "no coding plan". Both are asked, and only both failing
 * is an error.
 */

import { arr, epochMs, expectJson, hostOf, num, obj, QuotaError, str } from "../http.js";
import { emptyReport, type Report, type Source } from "../types.js";
import { bearer, countDetail, windowLabel } from "./shared.js";

const BALANCE_URL = "https://www.bigmodel.cn/api/biz/account/query-customer-account-report";
/**
 * `unit` codes in the quota response, as the console and community tools read
 * them; nothing official lists them. `number` counts units: 3/5 is the
 * five-hour window, 6/1 the weekly one, 5/1 the monthly MCP allowance.
 */
const HOUR = 3;
const MONTH = 5;
const WEEK = 6;

export const zai: Source = {
	id: "zai",
	label: "智谱 GLM",
	async fetch(target, http) {
		const china = /(^|\.)bigmodel\.cn$/.test(hostOf(target.baseUrl));
		const headers = { authorization: `Bearer ${bearer(target)}` };
		const quotaBase = china ? "https://open.bigmodel.cn" : "https://api.z.ai";
		const [quota, balance] = await Promise.allSettled([
			http.getJson(`${quotaBase}/api/monitor/usage/quota/limit`, { headers }),
			china ? http.getJson(BALANCE_URL, { headers, timeoutMs: 8_000 }) : Promise.reject(new QuotaError("skip")),
		]);

		const report = emptyReport();
		let quotaError: string | undefined;
		if (quota.status === "fulfilled") {
			const body = expectJson(quota.value, "智谱 ");
			if (body.success === true) mergeQuota(report, body);
			else quotaError = str(body.msg) ?? "没有 Coding Plan";
		} else {
			quotaError = errorText(quota.reason);
		}

		const balanceBody = balance.status === "fulfilled" ? obj(balance.value.json) : undefined;
		const hasBalance = balanceBody?.success === true && addBalance(report, obj(balanceBody.data));

		if (quotaError) {
			if (!hasBalance) throw new QuotaError(quotaError);
			report.notes.push({ text: `Coding Plan：${quotaError}`, tone: "muted" });
		}
		return report;
	},
};

export function mergeQuota(report: Report, body: Record<string, unknown>): void {
	const data = obj(body.data);
	const plan = str(data?.level) ?? str(data?.planName);
	if (plan) report.plan = plan;
	for (const raw of arr(data?.limits)) {
		const limit = obj(raw);
		const usedPercent = num(limit?.percentage);
		if (!limit || usedPercent === undefined) continue;
		const type = str(limit.type);
		const period = periodLabel(num(limit.unit), num(limit.number));
		const label = type === "TIME_LIMIT" ? `MCP 调用 · ${period ?? "周期"}` : (period ?? "Coding Plan");
		const total = num(limit.usage);
		const used = num(limit.currentValue) ?? (total !== undefined && num(limit.remaining) !== undefined ? total - num(limit.remaining)! : undefined);
		const detail = countDetail(used, total, type === "TIME_LIMIT" ? "次" : "");
		const resetsAt = epochMs(limit.nextResetTime);
		report.meters.push({
			label,
			usedPercent,
			...(resetsAt !== undefined ? { resetsAt } : {}),
			...(detail ? { detail } : {}),
		});
	}
}

function periodLabel(unit: number | undefined, count: number | undefined): string | undefined {
	if (!count || count <= 0) return undefined;
	if (unit === HOUR) return windowLabel(count * 60);
	if (unit === WEEK) return windowLabel(count * 60 * 24 * 7);
	if (unit === MONTH) return count === 1 ? "本月" : `${count} 个月`;
	return undefined;
}

/** Add the bigmodel.cn account balance. Returns false when the body has none. */
export function addBalance(report: Report, data: Record<string, unknown> | undefined): boolean {
	const value = num(data?.availableBalance) ?? num(data?.balance);
	if (value === undefined) return false;
	const parts: string[] = [];
	const recharged = num(data?.rechargeAmount);
	const granted = num(data?.giveAmount);
	const spent = num(data?.totalSpendAmount);
	if (recharged !== undefined) parts.push(`充值 ¥${recharged.toFixed(2)}`);
	if (granted) parts.push(`赠送 ¥${granted.toFixed(2)}`);
	if (spent !== undefined) parts.push(`已消费 ¥${spent.toFixed(2)}`);
	report.balances.push({
		label: "余额",
		value: { value, unit: "CNY" },
		...(parts.length > 0 ? { detail: parts.join(" · ") } : {}),
	});
	return true;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
