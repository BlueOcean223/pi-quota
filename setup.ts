/**
 * Filling in a NewAPI system access token from the panel, so the account
 * balance shows without editing quota.json by hand.
 *
 * The token is checked against the site before anything is written, and the
 * user id is asked for only when the site's version turns out to want it. It
 * is saved under the site's host in `sites`, which every provider on that site
 * reads, so providers sharing a relay key stay one row.
 */

import { homedir } from "node:os";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getConfigPath, readConfigText, siteUpdate, writeConfigText } from "./config.ts";
import { formatAmount } from "./format.ts";
import type { SetupRequest } from "./panel.ts";
import { checkAccount, NeedsUserId } from "./sources/relay.ts";
import type { Balance, Http, ProviderSettings } from "./types.ts";

const STATUS_KEY = "quota";

/** Returns true when quota.json was written. */
export async function runSetup(ctx: ExtensionCommandContext, requests: SetupRequest[], http: Http): Promise<boolean> {
	const request = await pick(ctx, requests);
	if (!request) return false;
	const { site, origin } = request.setup;

	// pi's input dialog shows no placeholder, so the hint goes in the title.
	const token = (await ctx.ui.input(`${site} 的系统访问令牌（NewAPI 控制台「个人设置」里生成）`))?.trim();
	if (!token) return false;
	const patch: ProviderSettings = { accessToken: token };

	let balance: Balance;
	try {
		balance = await checking(ctx, () => checkAccount(http, origin, token));
	} catch (error) {
		if (!(error instanceof NeedsUserId)) return fail(ctx, `令牌没通过验证：${messageOf(error)}`);
		const userId = (await ctx.ui.input(`${site} 的用户 ID（这个站点的版本还要它，控制台「个人设置」里能看到）`))?.trim();
		if (!userId) return false;
		if (!/^\d+$/.test(userId)) return fail(ctx, "用户 ID 是一串数字");
		try {
			balance = await checking(ctx, () => checkAccount(http, origin, token, Number(userId)));
		} catch (retry) {
			return fail(ctx, `令牌没通过验证：${messageOf(retry)}`);
		}
		patch.userId = Number(userId);
	}

	let update: ReturnType<typeof siteUpdate>;
	try {
		update = siteUpdate(readConfigText(), site, patch, request.providers);
	} catch (error) {
		return fail(ctx, `quota.json 解析失败，先修好再试：${messageOf(error)}`);
	}
	if (update.dropsComments && !(await ctx.ui.confirm("保存访问令牌", "quota.json 里的注释会被去掉，继续吗？"))) return false;
	writeConfigText(update.text);
	const amount = balance.value === "unlimited" ? "不限额" : formatAmount(balance.value);
	ctx.ui.notify(`已保存到 ${displayPath(getConfigPath())}，账户余额 ${amount}`, "info");
	return true;
}

async function pick(ctx: ExtensionCommandContext, requests: SetupRequest[]): Promise<SetupRequest | undefined> {
	if (requests.length <= 1) return requests[0];
	const labels = requests.map((request) => `${request.setup.site}（${request.names.join("、")}）`);
	const choice = await ctx.ui.select("给哪个站点填访问令牌？", labels);
	return choice === undefined ? undefined : requests[labels.indexOf(choice)];
}

/** The editor is back while the site answers, so say something is happening. */
async function checking<T>(ctx: ExtensionCommandContext, run: () => Promise<T>): Promise<T> {
	ctx.ui.setStatus(STATUS_KEY, "验证访问令牌…");
	try {
		return await run();
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

function fail(ctx: ExtensionCommandContext, message: string): false {
	ctx.ui.notify(message, "error");
	return false;
}

function displayPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
