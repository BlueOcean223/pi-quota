/**
 * Which source answers for a provider.
 *
 * Subscriptions are recognized by provider id, since an OAuth token only works
 * against its vendor. API keys are recognized by the host they are sent to, so
 * a built-in provider pointed at a relay through models.json is treated as the
 * relay, and a custom provider pointed at a vendor's official endpoint is
 * treated as that vendor. A custom endpoint nobody recognizes is probed as a
 * relay; a built-in one nobody recognizes has no balance API to ask.
 */

import { hostOf } from "../http.ts";
import type { AuthKind, ProviderSettings, Source } from "../types.ts";
import { deepseek, moonshot, openrouter, siliconflow } from "./balance.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { copilot } from "./copilot.ts";
import { grok } from "./grok.ts";
import { kimi } from "./kimi.ts";
import { minimax } from "./minimax.ts";
import { opencodeGo } from "./opencode.ts";
import { billing, newapi, relay, sub2api } from "./relay.ts";
import { zai } from "./zai.ts";

export const SOURCES: Record<string, Source> = Object.fromEntries(
	[claude, codex, copilot, grok, kimi, zai, minimax, opencodeGo, deepseek, moonshot, openrouter, siliconflow, newapi, sub2api, billing, relay].map(
		(source) => [source.id, source],
	),
);

/** Sources that front someone else's models, whose host is worth showing. */
export const RELAY_SOURCES = new Set(["relay", "newapi", "sub2api", "billing"]);

const OAUTH_SOURCES: Record<string, Source> = {
	anthropic: claude,
	"openai-codex": codex,
	"github-copilot": copilot,
	"kimi-coding": kimi,
	// pi signs in with the Grok CLI's OAuth client, whose token grok.com's billing accepts.
	xai: grok,
	// OpenRouter's OAuth hands out an ordinary API key.
	openrouter,
};

/** Subscriptions whose vendor says outright where usage is shown instead. */
const OAUTH_ELSEWHERE: Record<string, string> = {
	// Sign in with ChatGPT: OpenAI documents no usage API for these tokens, only the settings page.
	openai: "ChatGPT 登录没有额度接口，用量在 chatgpt.com/settings/usage 看",
};

const HOST_SOURCES: Array<[RegExp, Source]> = [
	[/(^|\.)api\.kimi\.com$/, kimi],
	[/(^|\.)deepseek\.com$/, deepseek],
	[/(^|\.)moonshot\.(cn|ai)$/, moonshot],
	[/(^|\.)openrouter\.ai$/, openrouter],
	[/(^|\.)siliconflow\.(cn|com)$/, siliconflow],
	[/(^|\.)(api\.z\.ai|bigmodel\.cn)$/, zai],
	[/(^|\.)minimaxi?\.(com|io|chat)$/, minimax],
];

/** Hosts that sell more than one product, told apart by path. Matched against `host/path`. */
const PATH_SOURCES: Array<[RegExp, Source]> = [[/^opencode\.ai\/zen\/go(\/|$)/, opencodeGo]];

/** Official endpoints where an ordinary key cannot read a balance. */
const NO_BALANCE_API: Array<[RegExp, string]> = [
	[/(^|\.)anthropic\.com$/, "Anthropic API key 查不了余额（要 Admin key）"],
	[/(^|\.)openai\.com$/, "OpenAI API key 查不了余额"],
	[/(^|\.)x\.ai$/, "xAI API key 查不了余额（要 Management key）"],
	[/(^|\.)googleapis\.com$/, "Google 的 key 没有余额接口"],
];

export type Pick = { source: Source } | { unsupported: string } | { off: true };

export interface PickInput {
	provider: string;
	auth: AuthKind;
	baseUrl: string;
	/** True when models.json gives the provider its own base URL. */
	custom: boolean;
	settings: ProviderSettings;
}

export function pickSource(input: PickInput): Pick {
	const forced = input.settings.type;
	if (forced === "off") return { off: true };
	if (forced) {
		const source = SOURCES[forced];
		return source ? { source } : { unsupported: `quota.json 里的 type "${forced}" 不认识` };
	}

	if (input.auth === "oauth") {
		const source = OAUTH_SOURCES[input.provider];
		return source ? { source } : { unsupported: OAUTH_ELSEWHERE[input.provider] ?? "这个订阅没有公开的额度接口" };
	}

	const host = hostOf(input.baseUrl).replace(/:\d+$/, "").toLowerCase();
	const hostPath = `${host}${pathOf(input.baseUrl)}`;
	for (const [pattern, source] of PATH_SOURCES) if (pattern.test(hostPath)) return { source };
	for (const [pattern, source] of HOST_SOURCES) if (pattern.test(host)) return { source };
	for (const [pattern, reason] of NO_BALANCE_API) if (pattern.test(host)) return { unsupported: reason };
	if (isLocal(host)) return { unsupported: "本地服务，没有额度" };
	if (input.custom) return { source: relay };
	return { unsupported: "没有已知的余额接口" };
}

function pathOf(url: string): string {
	try {
		return new URL(url).pathname.toLowerCase();
	} catch {
		return "";
	}
}

function isLocal(host: string): boolean {
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host === "[::1]" ||
		/^127\./.test(host) ||
		/^10\./.test(host) ||
		/^192\.168\./.test(host) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(host)
	);
}
