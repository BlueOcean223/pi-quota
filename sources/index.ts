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

import { hostOf } from "../http.js";
import type { AuthKind, ProviderSettings, Source } from "../types.js";
import { deepseek, moonshot, openrouter, siliconflow } from "./balance.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { copilot } from "./copilot.js";
import { grok } from "./grok.js";
import { kimi } from "./kimi.js";
import { minimax } from "./minimax.js";
import { billing, newapi, relay, sub2api } from "./relay.js";
import { zai } from "./zai.js";

export const SOURCES: Record<string, Source> = Object.fromEntries(
	[claude, codex, copilot, grok, kimi, zai, minimax, deepseek, moonshot, openrouter, siliconflow, newapi, sub2api, billing, relay].map(
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

const HOST_SOURCES: Array<[RegExp, Source]> = [
	[/(^|\.)api\.kimi\.com$/, kimi],
	[/(^|\.)deepseek\.com$/, deepseek],
	[/(^|\.)moonshot\.(cn|ai)$/, moonshot],
	[/(^|\.)openrouter\.ai$/, openrouter],
	[/(^|\.)siliconflow\.(cn|com)$/, siliconflow],
	[/(^|\.)(api\.z\.ai|bigmodel\.cn)$/, zai],
	[/(^|\.)minimaxi?\.(com|io|chat)$/, minimax],
];

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
		return source ? { source } : { unsupported: "这个订阅没有公开的额度接口" };
	}

	const host = hostOf(input.baseUrl).replace(/:\d+$/, "").toLowerCase();
	for (const [pattern, source] of HOST_SOURCES) if (pattern.test(host)) return { source };
	for (const [pattern, reason] of NO_BALANCE_API) if (pattern.test(host)) return { unsupported: reason };
	if (isLocal(host)) return { unsupported: "本地服务，没有额度" };
	if (input.custom) return { source: relay };
	return { unsupported: "没有已知的余额接口" };
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
