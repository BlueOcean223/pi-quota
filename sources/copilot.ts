/**
 * GitHub Copilot: the quota endpoint the editors read.
 *
 * It wants the GitHub OAuth token, not the short-lived Copilot token pi sends
 * with requests. pi keeps the GitHub token as the credential's refresh token,
 * since that is what it trades for a new Copilot token.
 */

import { QuotaError, epochMs, expectJson, num, obj, str } from "../http.ts";
import { emptyReport, type Report, type Source } from "../types.ts";
import { countDetail } from "./shared.ts";

const QUOTAS: Array<[key: string, label: string]> = [
	["premium_interactions", "高级请求"],
	["chat", "Chat"],
	["completions", "补全"],
];

export const copilot: Source = {
	id: "copilot",
	label: "Copilot",
	async fetch(target, http) {
		const githubToken = str(target.credential?.refresh);
		if (!githubToken) throw new QuotaError("auth.json 里没有 GitHub token，重新 /login github-copilot 试试");
		const result = await http.getJson(`https://${apiHost(target.credential?.enterpriseUrl)}/copilot_internal/user`, {
			headers: {
				authorization: `token ${githubToken}`,
				"editor-version": "vscode/1.96.2",
				"editor-plugin-version": "copilot-chat/0.26.7",
				"x-github-api-version": "2025-04-01",
			},
		});
		return parseCopilotUsage(expectJson(result, "GitHub "));
	},
};

export function parseCopilotUsage(body: Record<string, unknown>): Report {
	const report = emptyReport();
	const plan = str(body.copilot_plan);
	if (plan) report.plan = plan;
	const resetsAt = epochMs(body.quota_reset_date);
	const snapshots = obj(body.quota_snapshots);
	for (const [key, label] of QUOTAS) {
		const quota = obj(snapshots?.[key]);
		if (!quota) continue;
		if (quota.unlimited === true) {
			report.balances.push({ label, value: "unlimited" });
			continue;
		}
		const entitlement = num(quota.entitlement);
		const remaining = num(quota.remaining);
		const percentRemaining = num(quota.percent_remaining);
		if (percentRemaining === undefined && (entitlement === undefined || remaining === undefined)) continue;
		const usedPercent =
			percentRemaining !== undefined ? 100 - percentRemaining : ((entitlement! - remaining!) / entitlement!) * 100;
		const detail =
			entitlement !== undefined && remaining !== undefined ? countDetail(entitlement - remaining, entitlement, "次") : undefined;
		report.meters.push({
			label,
			usedPercent,
			...(resetsAt !== undefined ? { resetsAt } : {}),
			...(detail ? { detail } : {}),
		});
	}
	return report;
}

function apiHost(enterpriseUrl: unknown): string {
	const raw = str(enterpriseUrl);
	if (!raw) return "api.github.com";
	try {
		const host = new URL(raw.includes("://") ? raw : `https://${raw}`).host;
		return host.startsWith("api.") ? host : `api.${host}`;
	} catch {
		return "api.github.com";
	}
}
