/**
 * Picking a source per provider, and a whole run against a fake registry:
 * what gets merged, skipped, and in which order rows come out.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { startQuery } from "./query.ts";
import { type PickInput, pickSource } from "./sources/index.ts";
import type { CandidateContext } from "./targets.ts";
import type { Http, HttpResult } from "./types.ts";

function pick(overrides: Partial<PickInput>) {
	const result = pickSource({ provider: "p", auth: "api_key", baseUrl: "https://relay.example.com/v1", custom: true, settings: {}, ...overrides });
	if ("source" in result) return result.source.id;
	if ("unsupported" in result) return `unsupported: ${result.unsupported}`;
	return "off";
}

describe("pickSource", () => {
	test("subscriptions go by provider id", () => {
		expect(pick({ provider: "anthropic", auth: "oauth", baseUrl: "https://api.anthropic.com" })).toBe("claude");
		expect(pick({ provider: "openai-codex", auth: "oauth", baseUrl: "https://chatgpt.com/backend-api" })).toBe("codex");
		expect(pick({ provider: "github-copilot", auth: "oauth" })).toBe("copilot");
		expect(pick({ provider: "kimi-coding", auth: "oauth" })).toBe("kimi");
		expect(pick({ provider: "xai", auth: "oauth" })).toBe("grok");
		expect(pick({ provider: "meta", auth: "oauth" })).toStartWith("unsupported");
		expect(pick({ provider: "openai", auth: "oauth", baseUrl: "https://api.openai.com/v1" })).toContain("chatgpt.com/settings/usage");
	});

	test("API keys go by the host they are sent to", () => {
		expect(pick({ baseUrl: "https://api.deepseek.com", custom: false })).toBe("deepseek");
		expect(pick({ baseUrl: "https://open.bigmodel.cn/api/paas/v4" })).toBe("zai");
		expect(pick({ baseUrl: "https://api.z.ai/api/coding/paas/v4", custom: false })).toBe("zai");
		expect(pick({ baseUrl: "https://api.minimaxi.com/anthropic", custom: false })).toBe("minimax");
		expect(pick({ baseUrl: "https://api.kimi.com/coding", custom: false })).toBe("kimi");
		expect(pick({ baseUrl: "https://api.moonshot.cn/v1", custom: false })).toBe("moonshot");
		expect(pick({ baseUrl: "https://openrouter.ai/api/v1", custom: false })).toBe("openrouter");
		expect(pick({ baseUrl: "https://api.siliconflow.cn/v1" })).toBe("siliconflow");
		expect(pick({ provider: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1", custom: false })).toBe("opencode-go");
		expect(pick({ provider: "opencode", baseUrl: "https://opencode.ai/zen/v1", custom: false })).toStartWith("unsupported");
	});

	test("a built-in provider pointed at a relay is the relay", () => {
		expect(pick({ provider: "anthropic", baseUrl: "https://new-api.example.com", custom: true })).toBe("relay");
	});

	test("official endpoints without a balance API say so instead of probing", () => {
		expect(pick({ provider: "anthropic", baseUrl: "https://api.anthropic.com", custom: false })).toContain("Admin key");
		expect(pick({ provider: "openai", baseUrl: "https://api.openai.com/v1", custom: true })).toContain("OpenAI");
		expect(pick({ provider: "groq", baseUrl: "https://api.groq.com/openai/v1", custom: false })).toBe("unsupported: 没有已知的余额接口");
	});

	test("local servers are not probed", () => {
		expect(pick({ baseUrl: "http://localhost:11434/v1" })).toStartWith("unsupported");
		expect(pick({ baseUrl: "http://192.168.1.20:8080/v1" })).toStartWith("unsupported");
	});

	test("quota.json can force a source or turn a provider off", () => {
		expect(pick({ settings: { type: "sub2api" } })).toBe("sub2api");
		expect(pick({ settings: { type: "off" } })).toBe("off");
		expect(pick({ settings: { type: "nope" } })).toContain("不认识");
	});
});

/* ------------------------------------------------------------------ */

interface FakeProvider {
	id: string;
	name?: string;
	baseUrl: string;
	key?: string;
	oauth?: boolean;
	configured?: boolean;
}

function model(provider: FakeProvider): Model<Api> {
	return { id: `${provider.id}-model`, name: "m", api: "openai-completions", provider: provider.id, baseUrl: provider.baseUrl } as unknown as Model<Api>;
}

function fakeContext(providers: FakeProvider[], current?: string): CandidateContext {
	const models = providers.map(model);
	const find = (id: string) => providers.find((p) => p.id === id)!;
	const registry = {
		getAll: () => models,
		getAvailable: () => models.filter((m) => find(m.provider).configured !== false),
		getProviderDisplayName: (id: string) => find(id).name ?? id,
		isUsingOAuth: (m: Model<Api>) => find(m.provider).oauth === true,
		hasConfiguredAuth: (m: Model<Api>) => find(m.provider).configured !== false,
		getApiKeyAndHeaders: async (m: Model<Api>) => {
			const p = find(m.provider);
			return p.key ? { ok: true, apiKey: p.key } : { ok: false, error: `No API key found for "${p.id}"` };
		},
	};
	return {
		modelRegistry: registry as unknown as CandidateContext["modelRegistry"],
		model: current ? models.find((m) => m.provider === current) : undefined,
	};
}

function counting(routes: Record<string, unknown>) {
	const seen: string[] = [];
	const http: Http = {
		async getJson(url): Promise<HttpResult> {
			seen.push(url);
			const body = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1];
			return body === undefined
				? { status: 404, json: { message: "not found" }, text: "", contentType: "application/json" }
				: { status: 200, json: body, text: JSON.stringify(body), contentType: "application/json" };
		},
	};
	return { http, seen };
}

async function run(ctx: CandidateContext, http: Http, options: { only?: string; config?: Parameters<typeof startQuery>[0]["config"] } = {}) {
	let changes = 0;
	const { state, finished } = startQuery({
		ctx,
		config: options.config ?? { sites: {}, providers: {} },
		...(options.only ? { only: options.only } : {}),
		http,
		signal: new AbortController().signal,
		onChange: () => changes++,
	});
	await finished;
	return { state, changes };
}

const DEEPSEEK = { "https://api.deepseek.com/user/balance": { balance_infos: [{ currency: "CNY", total_balance: "1.00" }] } };
const NEWAPI = {
	"https://relay.example.com/api/usage/token/": { data: { object: "token_usage", name: "pi", total_used: 0, unlimited_quota: true } },
	"https://relay.example.com/api/status": { success: true, data: { quota_display_type: "USD" } },
};

describe("startQuery", () => {
	let agentDir: string;
	beforeAll(() => {
		// listCandidates reads models.json to tell custom providers from built-in ones.
		agentDir = mkdtempSync(join(tmpdir(), "pi-quota-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"tw-anthropic": { baseUrl: "https://relay.example.com" },
					"tw-codex": { baseUrl: "https://relay.example.com/v1" },
				},
			}),
		);
	});
	afterAll(() => {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(agentDir, { recursive: true, force: true });
	});

	test("one row per credential: two providers on the same relay key are asked once", async () => {
		const ctx = fakeContext([
			{ id: "tw-anthropic", baseUrl: "https://relay.example.com", key: "sk-shared" },
			{ id: "tw-codex", baseUrl: "https://relay.example.com/v1", key: "sk-shared" },
		]);
		const { http, seen } = counting(NEWAPI);
		const { state } = await run(ctx, http);
		expect(state.rows).toHaveLength(1);
		expect(state.rows[0]!.providers).toEqual(["tw-anthropic", "tw-codex"]);
		expect(seen.filter((url) => url.endsWith("/api/usage/token/"))).toHaveLength(1);
	});

	test("different quota.json settings keep the rows apart, since they ask different things", async () => {
		const ctx = fakeContext([
			{ id: "tw-anthropic", baseUrl: "https://relay.example.com", key: "sk-shared" },
			{ id: "tw-codex", baseUrl: "https://relay.example.com/v1", key: "sk-shared" },
		]);
		const { http } = counting(NEWAPI);
		const { state } = await run(ctx, http, { config: { sites: {}, providers: { "tw-codex": { accessToken: "t", userId: 1 } } } });
		expect(state.rows.map((row) => row.providers)).toEqual([["tw-anthropic"], ["tw-codex"]]);
	});

	test("settings under the site apply to every provider on it, so the shared row stays one row", async () => {
		const ctx = fakeContext([
			{ id: "tw-anthropic", baseUrl: "https://relay.example.com", key: "sk-shared" },
			{ id: "tw-codex", baseUrl: "https://relay.example.com/v1", key: "sk-shared" },
		]);
		const { http, seen } = counting(NEWAPI);
		const { state } = await run(ctx, http, { config: { sites: { "relay.example.com": { accessToken: "t" } }, providers: {} } });
		expect(state.rows.map((row) => row.providers)).toEqual([["tw-anthropic", "tw-codex"]]);
		expect(seen).toContain("https://relay.example.com/api/user/self");
	});

	test("a site can be turned off", async () => {
		const ctx = fakeContext([{ id: "anyrouter", baseUrl: "https://anyrouter.top", key: "sk" }]);
		const { state } = await run(ctx, counting({}).http, { config: { sites: { "anyrouter.top": { type: "off" } }, providers: {} } });
		expect(state.rows).toEqual([]);
	});

	test("the session's provider comes first, the rest by name", async () => {
		const ctx = fakeContext(
			[
				{ id: "tw-codex", baseUrl: "https://relay.example.com/v1", key: "sk-a" },
				{ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", key: "sk-b" },
				{ id: "bigmodel", name: "智谱API", baseUrl: "https://open.bigmodel.cn/api/paas/v4", key: "sk-c" },
			],
			"tw-codex",
		);
		const { http } = counting({ ...DEEPSEEK, ...NEWAPI });
		const { state } = await run(ctx, http);
		expect(state.rows.map((row) => row.providers[0])).toEqual(["tw-codex", "deepseek", "bigmodel"]);
		expect(state.rows[0]!.current).toBe(true);
	});

	test("unsupported providers are listed, not queried", async () => {
		const ctx = fakeContext([{ id: "meta", name: "Meta", baseUrl: "https://api.llama.com/v1", key: "tok", oauth: true }]);
		const { http, seen } = counting({});
		const { state } = await run(ctx, http);
		expect(state.rows).toEqual([]);
		expect(state.skipped).toEqual([{ provider: "meta", name: "Meta", reason: "这个订阅没有公开的额度接口" }]);
		expect(seen).toEqual([]);
	});

	test("asking for a provider without credentials says it has none", async () => {
		const ctx = fakeContext([{ id: "anthropic", baseUrl: "https://api.anthropic.com", configured: false }]);
		const { state } = await run(ctx, counting({}).http, { only: "anthropic" });
		expect(state.skipped[0]!.reason).toContain("还没有凭据");
	});

	test("asking for a provider that does not exist says so", async () => {
		const { state } = await run(fakeContext([]), counting({}).http, { only: "nope" });
		expect(state.notes).toEqual(["没有叫 nope 的 provider"]);
	});

	test("a failing source becomes an error row and the others still land", async () => {
		const ctx = fakeContext([
			{ id: "deepseek", baseUrl: "https://api.deepseek.com", key: "sk-b" },
			{ id: "tw-codex", baseUrl: "https://relay.example.com/v1", key: "sk-a" },
		]);
		const { state, changes } = await run(ctx, counting(DEEPSEEK).http);
		expect(state.phase).toBe("done");
		expect(state.rows.map((row) => row.state.kind)).toEqual(["ok", "error"]);
		// Once when rows are planned, once per answer, once when done.
		expect(changes).toBe(4);
	});

	test("turned-off providers vanish entirely", async () => {
		const ctx = fakeContext([{ id: "deepseek", baseUrl: "https://api.deepseek.com", key: "sk" }]);
		const { state } = await run(ctx, counting(DEEPSEEK).http, { config: { sites: {}, providers: { deepseek: { type: "off" } } } });
		expect(state.rows).toEqual([]);
		expect(state.skipped).toEqual([]);
	});
});
