/**
 * Each source against the response shapes its vendor actually sends. The
 * NewAPI, DeepSeek and bigmodel bodies are trimmed captures from live
 * accounts; the rest follow the shapes the vendors' own clients decode.
 */

import { describe, expect, test } from "bun:test";
import { parseDeepseekBalance, parseOpenrouter } from "./sources/balance.ts";
import { parseClaudeUsage } from "./sources/claude.ts";
import { codex, parseCodexUsage } from "./sources/codex.ts";
import { copilot, parseCopilotUsage } from "./sources/copilot.ts";
import { parseKimiUsage, usageUrl } from "./sources/kimi.ts";
import { parseMinimaxRemains } from "./sources/minimax.ts";
import { opencodeGo, parseOpencodeGoUsage } from "./sources/opencode.ts";
import { checkAccount, NeedsUserId, parseSub2api, parseTokenUsage, quotaAmount, relay, unitFromStatus } from "./sources/relay.ts";
import { grok, parseGrokBilling } from "./sources/grok.ts";
import { zai } from "./sources/zai.ts";
import type { Http, HttpResult, Target } from "./types.ts";

const NOW = Date.UTC(2026, 9, 6, 4, 0);

function json(body: unknown, status = 200): HttpResult {
	return { status, json: body, text: JSON.stringify(body), contentType: "application/json" };
}

function html(status = 200): HttpResult {
	return { status, json: undefined, text: "<html><script>var arg1='…'</script></html>", contentType: "text/html; charset=utf-8" };
}

/** Answers by URL prefix and records what was asked, headers included. */
function fakeHttp(routes: Record<string, HttpResult | (() => HttpResult)>) {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	const http: Http = {
		async getJson(url, init = {}) {
			calls.push({ url, headers: init.headers ?? {} });
			const match = Object.keys(routes)
				.filter((prefix) => url.startsWith(prefix))
				.sort((a, b) => b.length - a.length)[0];
			if (!match) return json({ message: "not found" }, 404);
			const route = routes[match]!;
			return typeof route === "function" ? route() : route;
		},
	};
	return { http, calls };
}

function target(overrides: Partial<Target> = {}): Target {
	return {
		provider: "relay",
		name: "relay",
		auth: "api_key",
		token: "sk-test",
		headers: {},
		baseUrl: "https://relay.example.com/v1",
		site: "relay.example.com",
		settings: {},
		...overrides,
	};
}

describe("claude", () => {
	test("reads both windows; one the plan has not used yet is 0%, as in Claude Code", () => {
		const report = parseClaudeUsage({
			five_hour: null,
			seven_day: { utilization: 17.5, resets_at: "2026-10-09T00:00:00Z" },
		});
		expect(report.meters).toEqual([
			{ label: "5 小时", usedPercent: 0 },
			{ label: "7 天", usedPercent: 17.5, resetsAt: Date.parse("2026-10-09T00:00:00Z") },
		]);
	});

	test("takes Fable's weekly limit from limits, and only that", () => {
		// The mix CCometixLine's parser is tested against.
		const report = parseClaudeUsage({
			five_hour: { utilization: 42, resets_at: "2026-10-06T06:00:00Z" },
			seven_day: { utilization: 41, resets_at: "2026-10-08T14:00:00+00:00" },
			seven_day_opus: { utilization: 76, resets_at: "2026-10-08T14:00:00+00:00" },
			seven_day_sonnet: { utilization: 3 },
			limits: [
				{ kind: "weekly_scoped", scope: { model: null }, percent: 5 },
				"unexpected",
				{ kind: "daily", scope: { model: { display_name: "Fable" } }, percent: 80 },
				{ kind: "weekly_scoped", scope: { model: { display_name: "Opus" } }, percent: 30 },
				{ kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 12.4, resets_at: 1791468000 },
			],
		});
		expect(report.meters.map((m) => [m.label, m.usedPercent])).toEqual([
			["5 小时", 42],
			["7 天", 41],
			["7 天 · Fable", 12.4],
		]);
		expect(report.meters[2]!.resetsAt).toBe(1791468000 * 1000);
	});

	test("a body with neither window shows none, and null limits are no obstacle", () => {
		expect(parseClaudeUsage({ error: { type: "rate_limit_error" } }).meters).toEqual([]);
		expect(parseClaudeUsage({ five_hour: { utilization: 24 }, seven_day: null, limits: null }).meters.map((m) => m.usedPercent)).toEqual([24, 0]);
	});

	test("shows extra usage in dollars, not cents", () => {
		const report = parseClaudeUsage({ extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, currency: "usd" } });
		expect(report.balances[0]).toEqual({ label: "额外用量", value: { value: 37.5, unit: "USD" }, detail: "本月已用 12.50 / 50.00 USD" });
	});
});

describe("codex", () => {
	const body = {
		plan_type: "plus",
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: { used_percent: 23, limit_window_seconds: 18_000, reset_at: 1_791_270_000 },
			secondary_window: { used_percent: 61, limit_window_seconds: 604_800, reset_at: 1_791_700_000 },
		},
		additional_rate_limits: [
			{ limit_name: "GPT-5.5-Codex-Spark", rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18_000, reset_at: 1_791_270_000 } } },
		],
		credits: { has_credits: true, unlimited: false, balance: "12.5" },
	};

	test("labels windows by their length, not their slot", () => {
		const report = parseCodexUsage(body);
		expect(report.plan).toBe("plus");
		expect(report.meters.map((m) => [m.label, m.usedPercent, m.resetsAt])).toEqual([
			["5 小时", 23, 1_791_270_000_000],
			["7 天", 61, 1_791_700_000_000],
			["GPT-5.5-Codex-Spark · 5 小时", 5, 1_791_270_000_000],
		]);
		expect(report.balances).toEqual([{ label: "Credits", value: { value: 12.5, unit: "credits" } }]);
	});

	test("sends the account id from the token when pi did not store one", async () => {
		const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } })).toString("base64url");
		const { http, calls } = fakeHttp({ "https://chatgpt.com/backend-api/wham/usage": json(body) });
		await codex.fetch(target({ provider: "openai-codex", auth: "oauth", token: `h.${claims}.s` }), http);
		expect(calls[0]!.headers["chatgpt-account-id"]).toBe("acct-123");
	});
});

describe("copilot", () => {
	test("turns percent remaining into percent used", () => {
		const report = parseCopilotUsage({
			copilot_plan: "individual",
			quota_reset_date: "2026-11-01",
			quota_snapshots: {
				premium_interactions: { entitlement: 300, remaining: 120, percent_remaining: 40, unlimited: false },
				chat: { unlimited: true },
				completions: { unlimited: true },
			},
		});
		expect(report.meters).toEqual([
			{ label: "高级请求", usedPercent: 60, resetsAt: Date.parse("2026-11-01"), detail: "180 / 300 次" },
		]);
		expect(report.balances.map((b) => [b.label, b.value])).toEqual([
			["Chat", "unlimited"],
			["补全", "unlimited"],
		]);
	});

	test("asks with the GitHub token, which pi stores as the refresh token", async () => {
		const { http, calls } = fakeHttp({ "https://api.github.com/copilot_internal/user": json({ quota_snapshots: {} }) });
		await copilot.fetch(target({ auth: "oauth", token: "copilot-token", credential: { refresh: "gho_abc" } }), http);
		expect(calls[0]!.headers.authorization).toBe("token gho_abc");
	});

	test("goes to the enterprise API host when the login was for one", async () => {
		const { http, calls } = fakeHttp({ "https://api.corp.ghe.com/": json({ quota_snapshots: {} }) });
		await copilot.fetch(target({ auth: "oauth", credential: { refresh: "gho_abc", enterpriseUrl: "corp.ghe.com" } }), http);
		expect(calls[0]!.url).toBe("https://api.corp.ghe.com/copilot_internal/user");
	});
});

describe("kimi", () => {
	test("finds the usages endpoint from any of the base URL shapes", () => {
		expect(usageUrl("https://api.kimi.com/coding")).toBe("https://api.kimi.com/coding/v1/usages");
		expect(usageUrl("https://api.kimi.com/coding/v1/")).toBe("https://api.kimi.com/coding/v1/usages");
		expect(usageUrl("https://api.kimi.com")).toBe("https://api.kimi.com/coding/v1/usages");
	});

	test("reads the rate window and the weekly allowance from counts", () => {
		const report = parseKimiUsage({
			usage: { limit: "2048", used: "512", remaining: "1536", resetTime: "2026-10-10T00:00:00Z" },
			limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "200", remaining: "150" } }],
			user: { membership: { level: "LEVEL_INTERMEDIATE" } },
		});
		expect(report.plan).toBe("intermediate");
		expect(report.meters.map((m) => [m.label, m.usedPercent, m.detail])).toEqual([
			["5 小时", 25, "50 / 200 次"],
			["7 天", 25, "512 / 2048 次"],
		]);
	});

	test("falls back to ratio pools for windows the counts did not cover", () => {
		const report = parseKimiUsage({ usages: { limit_5h: { used_ratio: 0.4 }, limit_7d: { used_ratio: 0.1 } } });
		expect(report.meters.map((m) => [m.label, m.usedPercent])).toEqual([
			["5 小时", 40],
			["7 天", 10],
		]);
	});
});

describe("zai", () => {
	const quota = {
		code: 200,
		success: true,
		data: {
			level: "pro",
			limits: [
				{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 34, nextResetTime: 1_791_280_000_000 },
				{ type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 20, nextResetTime: 1_791_640_000_000 },
				{ type: "TIME_LIMIT", unit: 5, number: 1, percentage: 12, usage: 1000, currentValue: 120, remaining: 880 },
			],
		},
	};

	test("labels the five-hour and weekly windows and the monthly MCP allowance", async () => {
		const { http } = fakeHttp({ "https://api.z.ai/api/monitor/usage/quota/limit": json(quota) });
		const report = await zai.fetch(target({ baseUrl: "https://api.z.ai/api/coding/paas/v4" }), http);
		expect(report.plan).toBe("pro");
		expect(report.meters.map((m) => [m.label, m.usedPercent, m.detail])).toEqual([
			["5 小时", 34, undefined],
			["7 天", 20, undefined],
			["MCP 调用 · 本月", 12, "120 / 1000 次"],
		]);
	});

	test("on bigmodel.cn a key without a Coding Plan still shows its balance", async () => {
		const { http } = fakeHttp({
			"https://open.bigmodel.cn/api/monitor/usage/quota/limit": json({ code: 500, msg: "当前用户不存在coding plan", success: false }),
			"https://www.bigmodel.cn/api/biz/account/query-customer-account-report": json({
				code: 200,
				msg: "操作成功",
				success: true,
				data: { balance: 4.67088976, rechargeAmount: 7.0, giveAmount: 0.0, totalSpendAmount: 2.32911024, availableBalance: 4.67088976 },
			}),
		});
		const report = await zai.fetch(target({ baseUrl: "https://open.bigmodel.cn/api/paas/v4" }), http);
		expect(report.balances).toEqual([{ label: "余额", value: { value: 4.67088976, unit: "CNY" }, detail: "已消费 ¥2.33" }]);
		expect(report.notes).toEqual([]);
	});

	test("fails when neither the plan nor the balance answers", async () => {
		const { http } = fakeHttp({
			"https://open.bigmodel.cn/api/monitor/usage/quota/limit": json({ code: 401, msg: "令牌已过期", success: false }),
			"https://www.bigmodel.cn/": json({ success: false }),
		});
		await expect(zai.fetch(target({ baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" }), http)).rejects.toThrow("令牌已过期");
	});
});

describe("minimax", () => {
	test("reads the usage count as what remains", () => {
		const report = parseMinimaxRemains({
			model_remains: [
				{
					model_name: "MiniMax-M2",
					start_time: 1_791_260_000_000,
					end_time: 1_791_278_000_000,
					current_interval_total_count: 1500,
					current_interval_usage_count: 1200,
				},
			],
			base_resp: { status_code: 0, status_msg: "success" },
		});
		expect(report.meters).toEqual([{ label: "5 小时", usedPercent: 20, resetsAt: 1_791_278_000_000, detail: "300 / 1500 次" }]);
	});

	test("skips lanes the plan does not include", () => {
		const report = parseMinimaxRemains({
			model_remains: [
				{ model_name: "MiniMax-M2", current_interval_total_count: 100, current_interval_usage_count: 100 },
				{ model_name: "video", current_interval_total_count: 0, current_interval_usage_count: 0, current_interval_remaining_percent: 100 },
			],
		});
		expect(report.meters.map((m) => m.label)).toEqual(["MiniMax-M2 · 当前周期"]);
	});
});

describe("deepseek", () => {
	test("shows the balance per currency", () => {
		const report = parseDeepseekBalance({
			is_available: true,
			balance_infos: [{ currency: "CNY", total_balance: "12.79", granted_balance: "0.00", topped_up_balance: "12.79" }],
		});
		expect(report.balances).toEqual([{ label: "余额", value: { value: 12.79, unit: "CNY" } }]);
		expect(report.notes).toEqual([]);
	});

	test("warns when the account can no longer make requests", () => {
		expect(parseDeepseekBalance({ is_available: false, balance_infos: [] }).notes[0]!.tone).toBe("warning");
	});
});

describe("openrouter", () => {
	test("shows the account credits and the key's own cap", () => {
		const report = parseOpenrouter(
			{ data: { label: "pi", limit: 10, limit_remaining: 7.5, usage: 2.5, limit_reset: "monthly", is_free_tier: false } },
			{ data: { total_credits: 20, total_usage: 4.25 } },
		);
		expect(report.balances).toEqual([
			{ label: "账户余额", value: { value: 15.75, unit: "USD" }, detail: "共 $20.00 · 已用 $4.25" },
			{ label: "Key 限额", value: { value: 7.5, unit: "USD" }, detail: "已用 $2.50 / $10.00 · 按月重置" },
		]);
	});

	test("an uncapped key without readable credits is unlimited", () => {
		const report = parseOpenrouter({ data: { limit: null, usage: 1.2 } }, undefined);
		expect(report.balances).toEqual([{ label: "Key 限额", value: "unlimited", detail: "已用 $1.20" }]);
	});
});

describe("NewAPI", () => {
	const cny = unitFromStatus({
		quota_per_unit: 500000,
		display_in_currency: true,
		quota_display_type: "CNY",
		usd_exchange_rate: 5,
	});

	test("converts quota points with the site's own unit", () => {
		expect(cny).toEqual({ quotaPerUnit: 500000, unit: "CNY", rate: 5, known: true });
		expect(quotaAmount(13_090_345, cny)).toEqual({ value: 130.90345, unit: "CNY" });
		expect(unitFromStatus({ quota_per_unit: 500000, display_in_currency: false }).unit).toBe("tokens");
		expect(unitFromStatus({ quota_display_type: "CUSTOM", custom_currency_symbol: "¤", custom_currency_exchange_rate: 2 }).unit).toBe("¤");
	});

	test("an unlimited token reports what it used, not its meaningless remainder", () => {
		const report = parseTokenUsage(
			{
				expires_at: 0,
				model_limits: {},
				model_limits_enabled: false,
				name: "pi",
				object: "token_usage",
				total_available: -4_408_008,
				total_granted: 8_682_337,
				total_used: 13_090_345,
				unlimited_quota: true,
			},
			cny,
			NOW,
		);
		expect(report.balances).toEqual([{ label: "令牌 pi", value: "unlimited", detail: "已用 ¥130.90" }]);
	});

	test("a capped token reports what is left of its grant", () => {
		const report = parseTokenUsage(
			{ name: "ci", total_available: 2_500_000, total_granted: 5_000_000, total_used: 2_500_000, unlimited_quota: false, expires_at: 1_798_028_800 },
			cny,
			NOW,
		);
		expect(report.balances).toEqual([{ label: "令牌 ci", value: { value: 25, unit: "CNY" }, detail: "已用 ¥25.00 / ¥50.00 · 2026-12-23 到期" }]);
	});

	test("an expired token says so", () => {
		const report = parseTokenUsage({ name: "old", total_available: 0, total_used: 0, total_granted: 0, expires_at: 1_700_049_600 }, cny, NOW);
		expect(report.notes).toContainEqual({ text: "令牌已于 2023-11-15 过期", tone: "warning" });
	});
});

describe("relay probe", () => {
	const tokenUsage = json({
		code: true,
		data: { name: "pi", object: "token_usage", total_used: 13_090_345, total_available: -1, total_granted: 0, unlimited_quota: true, expires_at: 0 },
		message: "ok",
	});
	const status = json({ success: true, data: { quota_per_unit: 500000, quota_display_type: "CNY", usd_exchange_rate: 5 } });

	test("recognizes NewAPI and points at quota.json when only the account knows the cap", async () => {
		const { http } = fakeHttp({
			"https://relay.example.com/api/usage/token/": tokenUsage,
			"https://relay.example.com/api/status": status,
			// Per-token stats on: the billing endpoints only repeat that the token is unlimited.
			"https://relay.example.com/v1/dashboard/billing/subscription": json({ object: "billing_subscription", hard_limit_usd: 100_000_000 }),
			"https://relay.example.com/v1/dashboard/billing/usage": json({ object: "list", total_usage: 13090.345 }),
		});
		const report = await relay.fetch(target({ provider: "tw-codex" }), http);
		expect(report.plan).toBe("NewAPI");
		expect(report.balances).toEqual([{ label: "令牌 pi", value: "unlimited", detail: "已用 ¥130.90" }]);
		expect(report.notes).toEqual([]);
		expect(report.setup).toEqual({ site: "relay.example.com", origin: "https://relay.example.com" });
	});

	test("reads the account balance with the key alone when the site bills by account", async () => {
		const { http } = fakeHttp({
			"https://relay.example.com/api/usage/token/": tokenUsage,
			"https://relay.example.com/api/status": status,
			"https://relay.example.com/v1/dashboard/billing/subscription": json({ object: "billing_subscription", hard_limit_usd: 250 }),
			"https://relay.example.com/v1/dashboard/billing/usage": json({ object: "list", total_usage: 13090.345 }),
		});
		const report = await relay.fetch(target(), http);
		expect(report.balances[0]).toEqual({ label: "账户余额", value: { value: expect.closeTo(119.09655, 6), unit: "CNY" }, detail: "已用 ¥130.90" });
		expect(report.notes).toEqual([]);
	});

	test("an access token alone is enough on current builds; older ones ask for the user id", async () => {
		const routes = { "https://relay.example.com/api/usage/token/": tokenUsage, "https://relay.example.com/api/status": status };
		const current = fakeHttp({ ...routes, "https://relay.example.com/api/user/self": json({ success: true, data: { quota: 25_000_000 } }) });
		const report = await relay.fetch(target({ settings: { accessToken: "dash-token" } }), current.http);
		expect(report.balances[0]!.value).toEqual({ value: 250, unit: "CNY" });
		expect(current.calls.find((call) => call.url.endsWith("/api/user/self"))!.headers).toEqual({ authorization: "Bearer dash-token" });

		const old = fakeHttp({
			...routes,
			"https://relay.example.com/api/user/self": json({ success: false, message: "无权进行此操作，未提供 New-Api-User" }),
		});
		const report2 = await relay.fetch(target({ settings: { accessToken: "dash-token" } }), old.http);
		expect(report2.setup).toEqual({
			site: "relay.example.com",
			origin: "https://relay.example.com",
			problem: "无权进行此操作，未提供 New-Api-User（这个站点的版本还要用户 ID）",
		});
		await expect(checkAccount(old.http, "https://relay.example.com", "dash-token")).rejects.toBeInstanceOf(NeedsUserId);
	});

	test("a configured token that resolves to nothing asks for a new one", async () => {
		const { http } = fakeHttp({ "https://relay.example.com/api/usage/token/": tokenUsage, "https://relay.example.com/api/status": status });
		const report = await relay.fetch(target({ settings: { accessToken: "$PI_QUOTA_TEST_UNSET" } }), http);
		expect(report.setup?.problem).toBe("quota.json 里的 accessToken 解析出来是空的");
	});

	test("adds the account balance with an access token and user id", async () => {
		const { http, calls } = fakeHttp({
			"https://relay.example.com/api/usage/token/": tokenUsage,
			"https://relay.example.com/api/status": status,
			"https://relay.example.com/api/user/self": json({ success: true, data: { quota: 25_000_000, used_quota: 13_090_345, group: "default" } }),
		});
		const report = await relay.fetch(target({ settings: { accessToken: "dash-token", userId: 42 } }), http);
		expect(report.balances[0]).toEqual({ label: "账户余额", value: { value: 250, unit: "CNY" }, detail: "已用 ¥130.90 · 分组 default" });
		const self = calls.find((call) => call.url.endsWith("/api/user/self"))!;
		expect(self.headers).toEqual({ authorization: "Bearer dash-token", "new-api-user": "42" });
	});

	test("falls through to the billing endpoints when /api is behind a challenge page", async () => {
		const { http } = fakeHttp({
			"https://relay.example.com/api/": html(),
			"https://relay.example.com/v1/usage": json({ error: { message: "Invalid URL" } }, 404),
			"https://relay.example.com/v1/dashboard/billing/subscription": json({
				object: "billing_subscription",
				has_payment_method: true,
				hard_limit_usd: 100_000_000,
				access_until: 0,
			}),
			"https://relay.example.com/v1/dashboard/billing/usage": json({ object: "list", total_usage: 2.99 }),
		});
		const report = await relay.fetch(target(), http);
		expect(report.plan).toBe("OpenAI 兼容账单");
		expect(report.balances).toEqual([{ label: "额度", value: "unlimited", detail: "已用 $0.03" }]);
		expect(report.notes.map((n) => n.text)).toEqual(["站点没有公开 /api/status，金额单位按 USD 显示"]);
	});

	test("reads billing amounts in the site's display unit", async () => {
		const { http } = fakeHttp({
			"https://relay.example.com/api/status": status,
			"https://relay.example.com/v1/dashboard/billing/subscription": json({ object: "billing_subscription", hard_limit_usd: 200, access_until: 0 }),
			"https://relay.example.com/v1/dashboard/billing/usage": json({ object: "list", total_usage: 13090.345 }),
		});
		const [balance] = (await relay.fetch(target(), http)).balances;
		expect(balance!.detail).toBe("已用 ¥130.90 / ¥200.00");
		expect(balance!.value).toEqual({ value: expect.closeTo(69.09655, 6), unit: "CNY" });
	});

	test("recognizes Sub2API", async () => {
		const { http } = fakeHttp({
			"https://relay.example.com/v1/usage": json({
				isValid: true,
				planName: "Claude Max 共享",
				unit: "USD",
				subscription: { daily_usage_usd: 3, daily_limit_usd: 10, weekly_usage_usd: 20, weekly_limit_usd: 50 },
				rate_limits: [{ window: "5h", limit: 5, used: 1, remaining: 4, reset_at: "2026-10-06T06:00:00Z" }],
			}),
		});
		const report = await relay.fetch(target(), http);
		expect(report.plan).toBe("Claude Max 共享");
		expect(report.meters.map((m) => [m.label, m.usedPercent, m.detail])).toEqual([
			["5 小时", 20, "$1.00 / $5.00"],
			["今日", 30, "$3.00 / $10.00"],
			["本周", 40, "$20.00 / $50.00"],
		]);
	});

	test("a rejected key is reported as rejected, not as an unknown relay", async () => {
		const denied = json({ error: { message: "无效的令牌" } }, 401);
		const { http } = fakeHttp({
			"https://relay.example.com/api/usage/token/": denied,
			"https://relay.example.com/v1/": denied,
		});
		await expect(relay.fetch(target(), http)).rejects.toThrow("拒绝了凭据（HTTP 401）：无效的令牌");
	});

	test("says which families it tried when nothing matches", async () => {
		const { http } = fakeHttp({});
		await expect(relay.fetch(target(), http)).rejects.toThrow("没认出这个中转站的额度接口");
	});
});

describe("sub2api", () => {
	test("an invalid key is an error", () => {
		expect(() => parseSub2api({ isValid: false })).toThrow("无效");
	});

	test("shows a plain balance when that is all there is", () => {
		const report = parseSub2api({ isValid: true, balance: 8.5, unit: "USD" });
		expect(report.balances).toEqual([{ label: "余额", value: { value: 8.5, unit: "USD" } }]);
	});
});

describe("grok", () => {
	// Trimmed from a live `?format=credits` response: proto3 JSON drops GrokChat's 0%.
	const CREDITS = {
		config: {
			currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-10-03T11:44:50.508758+00:00", end: "2026-10-10T11:44:50.508758+00:00" },
			creditUsagePercent: 3.0,
			onDemandCap: { val: 0 },
			onDemandUsed: { val: 0 },
			productUsage: [{ product: "GrokBuild", usagePercent: 3.0 }, { product: "GrokChat" }],
			isUnifiedBillingUser: true,
			prepaidBalance: { val: 0 },
		},
	};
	const NO_ALLOWANCE = { config: { monthlyLimit: { val: 0 }, used: { val: 0 }, onDemandCap: { val: 0 } } };
	const xai = () => target({ provider: "xai", auth: "oauth", token: "xai-token", baseUrl: "https://api.x.ai/v1" });

	test("the weekly window, labelled from the period type, resetting at its end", async () => {
		const { http, calls } = fakeHttp({
			"https://cli-chat-proxy.grok.com/v1/billing?format=credits": json(CREDITS),
			"https://cli-chat-proxy.grok.com/v1/billing": json(NO_ALLOWANCE),
		});
		const report = await grok.fetch(xai(), http);
		expect(report.meters).toEqual([{ label: "7 天", usedPercent: 3, resetsAt: Date.parse("2026-10-10T11:44:50.508Z") }]);
		expect(report.balances).toEqual([]);
		expect(calls.map((call) => call.headers.authorization)).toEqual(["Bearer xai-token", "Bearer xai-token"]);
	});

	test("a percent proto3 left out is 0%", () => {
		const { creditUsagePercent: _, ...config } = CREDITS.config;
		expect(parseGrokBilling({ ...config, productUsage: [] }, undefined).meters[0]!.usedPercent).toBe(0);
	});

	test("products are broken out only when more than one has been used", () => {
		const config = { ...CREDITS.config, creditUsagePercent: 100, productUsage: [{ product: "GrokBuild", usagePercent: 54 }, { product: "Api", usagePercent: 46 }] };
		expect(parseGrokBilling(config, undefined).meters.map((m) => `${m.label} ${m.usedPercent}`)).toEqual([
			"7 天 100",
			"7 天 · Grok Build 54",
			"7 天 · Api 46",
		]);
	});

	test("a monthly allowance, on-demand cap and prepaid balance are read in dollars from cents", () => {
		const report = parseGrokBilling(
			{ ...CREDITS.config, onDemandCap: { val: 5000 }, onDemandUsed: { val: 1250 }, prepaidBalance: { val: 2500 } },
			{ monthlyLimit: { val: 15000 }, used: { val: 2931 }, billingPeriodEnd: "2026-11-01T00:00:00+00:00" },
		);
		expect(report.meters.slice(1)).toEqual([
			{ label: "本月额度", usedPercent: (29.31 / 150) * 100, detail: "$29.31 / $150.00", resetsAt: Date.UTC(2026, 10, 1) },
			{ label: "按需用量", usedPercent: 25, detail: "$12.50 / $50.00" },
		]);
		expect(report.balances).toEqual([{ label: "预付余额", value: { value: 25, unit: "USD" } }]);
	});

	test("one shape failing is fine as long as the other answers", async () => {
		const { http } = fakeHttp({
			"https://cli-chat-proxy.grok.com/v1/billing?format=credits": json(CREDITS),
			"https://cli-chat-proxy.grok.com/v1/billing": json({ error: "boom" }, 500),
		});
		expect((await grok.fetch(xai(), http)).meters).toHaveLength(1);
	});

	test("a rejected token asks for a fresh login", async () => {
		const { http } = fakeHttp({ "https://cli-chat-proxy.grok.com/": json({ error: "unauthorized" }, 401) });
		await expect(grok.fetch(xai(), http)).rejects.toThrow("重新 /login xai");
	});

	test("a response with nothing to show is an error, not an empty row", () => {
		expect(() => parseGrokBilling({ isUnifiedBillingUser: true }, NO_ALLOWANCE.config)).toThrow("没有用量数据");
	});
});

describe("opencode go", () => {
	// The shape from cc-switch#6433, where it was read off a live account.
	const usage = {
		usage: {
			rolling: { status: "ok", percent: 4, resetsAt: "2026-10-06T16:27:38.287Z" },
			weekly: { status: "ok", percent: 3, resetsAt: "2026-10-12T00:00:00.287Z" },
			monthly: { status: "ok", percent: 1, resetsAt: "2026-11-01T06:06:01.287Z" },
		},
	};

	test("asks the service root whatever the base URL ends in", async () => {
		for (const baseUrl of ["https://opencode.ai/zen/go", "https://opencode.ai/zen/go/v1"]) {
			const { http, calls } = fakeHttp({ "https://opencode.ai/zen/go/v1/usage": json(usage) });
			const report = await opencodeGo.fetch(target({ provider: "opencode-go", baseUrl }), http);
			expect(calls.map((call) => call.url)).toEqual(["https://opencode.ai/zen/go/v1/usage"]);
			expect(report.meters.map((m) => [m.label, m.usedPercent, m.resetsAt])).toEqual([
				["5 小时", 4, Date.parse("2026-10-06T16:27:38.287Z")],
				["7 天", 3, Date.parse("2026-10-12T00:00:00.287Z")],
				["本月", 1, Date.parse("2026-11-01T06:06:01.287Z")],
			]);
		}
	});

	test("a window that is not ok is reported instead of drawn as 0%", () => {
		const report = parseOpencodeGoUsage({ usage: { ...usage.usage, rolling: { status: "unavailable", percent: 0 } } });
		expect(report.meters.map((m) => m.label)).toEqual(["7 天", "本月"]);
		expect(report.notes).toEqual([{ text: "5 小时窗口暂时查不到（unavailable）", tone: "warning" }]);
	});

	test("a body without usage is an error", () => {
		expect(() => parseOpencodeGoUsage({ error: "nope" })).toThrow("没有用量");
	});
});
