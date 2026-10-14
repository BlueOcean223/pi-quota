/**
 * The providers to ask about, and the credential pi would use for each.
 *
 * Everything goes through pi's model registry, so a key from `/login`,
 * models.json, `!command` or the environment resolves exactly as it would for
 * a real request, and an expired OAuth token is refreshed the same way. The
 * one thing the registry does not hand out is the stored OAuth credential
 * itself, which Copilot needs (its GitHub token is the refresh token); that is
 * read from auth.json directly.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type QuotaConfig, readAgentJson, settingsFor, siteKey } from "./config.ts";
import { obj, QuotaError, str } from "./http.ts";
import type { AuthKind, ProviderSettings, Target } from "./types.ts";

type Registry = ExtensionContext["modelRegistry"];

export interface Candidate {
	provider: string;
	name: string;
	model: Model<Api>;
	auth: AuthKind;
	/** pi has a credential for it. Only false for a provider asked for by name. */
	configured: boolean;
	/** models.json gives this provider its own base URL. */
	custom: boolean;
	/** The provider of the model the session is using. */
	current: boolean;
	/** The quota.json `sites` key: the host the provider's requests go to. */
	site: string;
	settings: ProviderSettings;
}

export interface CandidateContext {
	modelRegistry: Registry;
	model: Model<Api> | undefined;
}

/**
 * Every provider with configured auth, one model each. With `only`, that
 * provider whether or not it has auth, so asking for it by name says why it
 * cannot be queried rather than showing nothing.
 */
export function listCandidates(ctx: CandidateContext, config: QuotaConfig, only?: string): Candidate[] {
	const registry = ctx.modelRegistry;
	const pool = only ? registry.getAll() : registry.getAvailable();
	const byProvider = new Map<string, Model<Api>>();
	for (const model of pool) if (!byProvider.has(model.provider)) byProvider.set(model.provider, model);
	// The session's own model stands for its provider; its base URL is the one in use.
	if (ctx.model && byProvider.has(ctx.model.provider)) byProvider.set(ctx.model.provider, ctx.model);

	const modelsJson = obj(readAgentJson("models.json")?.providers) ?? {};
	const wanted = only?.toLowerCase();
	const candidates: Candidate[] = [];
	for (const [provider, model] of byProvider) {
		if (wanted && provider.toLowerCase() !== wanted) continue;
		candidates.push({
			provider,
			name: registry.getProviderDisplayName(provider),
			model,
			auth: registry.isUsingOAuth(model) ? "oauth" : "api_key",
			configured: registry.hasConfiguredAuth(model),
			custom: str(obj(modelsJson[provider])?.baseUrl) !== undefined,
			current: ctx.model?.provider === provider,
			site: siteKey(model.baseUrl),
			settings: settingsFor(config, provider, model.baseUrl),
		});
	}
	return candidates;
}

/** Provider ids worth completing after `/quota `. */
export function providerIds(ctx: CandidateContext): string[] {
	const ids = new Set(ctx.modelRegistry.getAvailable().map((model) => model.provider));
	return [...ids].sort();
}

export async function resolveTarget(registry: Registry, candidate: Candidate): Promise<Target> {
	const auth = await registry.getApiKeyAndHeaders(candidate.model);
	if (!auth.ok) throw new QuotaError(`取不到凭据：${auth.error}`);
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(auth.headers ?? {})) if (typeof value === "string") headers[name] = value;
	if (!auth.apiKey && Object.keys(headers).length === 0) throw new QuotaError("没有配置凭据");

	const credential = candidate.auth === "oauth" ? storedCredential(candidate.provider) : undefined;
	return {
		provider: candidate.provider,
		name: candidate.name,
		auth: candidate.auth,
		...(auth.apiKey ? { token: auth.apiKey } : {}),
		headers,
		baseUrl: candidate.settings.baseUrl ?? auth.baseUrl ?? candidate.model.baseUrl,
		site: candidate.site,
		...(credential ? { credential } : {}),
		settings: candidate.settings,
	};
}

/**
 * The OAuth entry in auth.json. Read after `getApiKeyAndHeaders`, which has
 * already refreshed and saved an expired one.
 */
function storedCredential(provider: string): Record<string, unknown> | undefined {
	const entry = obj(readAgentJson("auth.json")?.[provider]);
	return entry?.type === "oauth" ? entry : undefined;
}
