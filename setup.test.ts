/**
 * The `c` flow from the panel: ask, check against the site, write quota.json.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SetupRequest } from "./panel.js";
import { runSetup } from "./setup.js";
import type { Http, HttpResult } from "./types.js";

const agentDir = mkdtempSync(join(tmpdir(), "pi-quota-setup-"));
const configPath = join(agentDir, "quota.json");
// Other test files point the agent dir elsewhere and unset it when done.
beforeAll(() => {
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterAll(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(agentDir, { recursive: true, force: true });
});
beforeEach(() => rmSync(configPath, { force: true }));

function json(body: unknown, status = 200): HttpResult {
	return { status, json: body, text: JSON.stringify(body), contentType: "application/json" };
}

/** `/api/user/self` answers by the headers it gets; `/api/status` says CNY. */
function site(self: (headers: Record<string, string>) => HttpResult): Http {
	return {
		async getJson(url, init = {}) {
			if (url.endsWith("/api/status")) return json({ success: true, data: { quota_per_unit: 500000, quota_display_type: "CNY", usd_exchange_rate: 5 } });
			if (url.endsWith("/api/user/self")) return self(init.headers ?? {});
			return json({}, 404);
		},
	};
}

function fakeContext(answers: Array<string | undefined>, choice?: string) {
	const asked: string[] = [];
	const notices: Array<[string, string | undefined]> = [];
	const ctx = {
		ui: {
			input: async (title: string) => {
				asked.push(title);
				return answers.shift();
			},
			select: async (title: string, options: string[]) => {
				asked.push(`${title} ${options.join(" | ")}`);
				return choice;
			},
			confirm: async () => true,
			notify: (message: string, type?: string) => notices.push([message, type]),
			setStatus: () => {},
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, asked, notices };
}

const request: SetupRequest = {
	setup: { site: "relay.example.com", origin: "https://relay.example.com" },
	providers: ["tw-anthropic", "tw-codex"],
	names: ["tw-anthropic", "tw-codex"],
};
const ok = json({ success: true, data: { quota: 25_000_000 } });

describe("runSetup", () => {
	test("checks the token, saves it under the site, owner-only", async () => {
		const { ctx, notices } = fakeContext(["  dash-token  "]);
		expect(await runSetup(ctx, [request], site(() => ok))).toBe(true);
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ sites: { "relay.example.com": { accessToken: "dash-token" } } });
		expect(statSync(configPath).mode & 0o777).toBe(0o600);
		expect(notices).toEqual([["已保存到 " + configPath.replace(process.env.HOME ?? "~", "~") + "，账户余额 ¥250.00", "info"]]);
	});

	test("asks for the user id only when the site wants it", async () => {
		const { ctx, asked } = fakeContext(["dash-token", "42"]);
		const http = site((headers) => (headers["new-api-user"] === "42" ? ok : json({ success: false, message: "无权进行此操作，未提供 New-Api-User" })));
		expect(await runSetup(ctx, [request], http)).toBe(true);
		expect(asked).toHaveLength(2);
		expect(JSON.parse(readFileSync(configPath, "utf8")).sites["relay.example.com"]).toEqual({ accessToken: "dash-token", userId: 42 });
	});

	test("a refused token is not saved", async () => {
		const { ctx, notices } = fakeContext(["wrong"]);
		expect(await runSetup(ctx, [request], site(() => json({ success: false, message: "invalid access token" }, 401)))).toBe(false);
		expect(existsSync(configPath)).toBe(false);
		expect(notices[0]![0]).toStartWith("令牌没通过验证：");
		expect(notices[0]![1]).toBe("error");
	});

	test("cancelling writes nothing", async () => {
		const { ctx } = fakeContext([undefined]);
		expect(await runSetup(ctx, [request], site(() => ok))).toBe(false);
		expect(existsSync(configPath)).toBe(false);
	});

	test("with several sites waiting, asks which one first", async () => {
		const other: SetupRequest = { setup: { site: "b.example.com", origin: "https://b.example.com" }, providers: ["b"], names: ["B"] };
		const { ctx, asked } = fakeContext(["t"], "b.example.com（B）");
		expect(await runSetup(ctx, [request, other], site(() => ok))).toBe(true);
		expect(asked[0]).toBe("给哪个站点填访问令牌？ relay.example.com（tw-anthropic、tw-codex） | b.example.com（B）");
		expect(Object.keys(JSON.parse(readFileSync(configPath, "utf8")).sites)).toEqual(["b.example.com"]);
	});

	test("keeps what quota.json already had", async () => {
		writeFileSync(configPath, JSON.stringify({ sites: { "anyrouter.top": { type: "off" } }, providers: { "tw-codex": { accessToken: "stale" } } }));
		const { ctx } = fakeContext(["fresh"]);
		await runSetup(ctx, [request], site(() => ok));
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
			sites: { "anyrouter.top": { type: "off" }, "relay.example.com": { accessToken: "fresh" } },
		});
	});
});
