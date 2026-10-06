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
/** `unit` codes in the quota response. */
const UNIT_MINUTES: Record<number, number> = { 1: 60 * 24, 3: 60, 5: 1, 6: 60 * 24 * 7 };

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
		const unit = num(limit.unit);
		const count = num(limit.number);
		const minutes = unit !== undefined && count ? (UNIT_MINUTES[unit] ?? 0) * count : undefined;
		let label: string;
		if (type === "TIME_LIMIT") {
			// unit 5 / number 1 marks the monthly MCP allowance, not a one-minute window.
			label = unit === 5 && count === 1 ? "MCP 调用 · 本月" : `MCP 调用 · ${windowLabel(minutes) ?? "周期"}`;
		} else {
			label = windowLabel(minutes) ?? "Coding Plan";
		}
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
