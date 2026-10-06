/**
 * `quota.json` in pi's agent directory: overrides for the cases auto-detection
 * cannot cover, per site or per provider.
 *
 * ```jsonc
 * {
 *   "sites": {
 *     // every provider whose requests go to this host
 *     "new-api.example.com": { "accessToken": "!security find-generic-password -ws newapi" },
 *     "anyrouter.top": { "type": "off" }
 *   },
 *   "providers": {
 *     // one provider; wins over its site
 *     "local-llm": { "type": "off" }
 *   }
 * }
 * ```
 *
 * The file is optional. A file that does not parse is reported, not fatal:
 * every provider without an override still gets queried. `/quota` writes
 * `sites` entries itself when the user fills in a credential from the panel.
 */

import { execSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { hostOf, obj } from "./http.js";
import type { ProviderSettings } from "./types.js";

export interface QuotaConfig {
	/** Keyed by host, lowercase, with the port when the URL has one. */
	sites: Record<string, ProviderSettings>;
	providers: Record<string, ProviderSettings>;
	/** Why the file was ignored, when it was. */
	error?: string;
}

const SETTING_KEYS = ["type", "userId", "accessToken", "baseUrl"] as const;

export function getConfigPath(): string {
	return join(getAgentDir(), "quota.json");
}

export function loadConfig(path = getConfigPath()): QuotaConfig {
	if (!existsSync(path)) return { sites: {}, providers: {} };
	try {
		return parseConfig(readFileSync(path, "utf8"));
	} catch (error) {
		return { sites: {}, providers: {}, error: `${path} 解析失败：${error instanceof Error ? error.message : String(error)}` };
	}
}

/** A JSONC file in pi's agent directory, or undefined when it is missing or does not parse. */
export function readAgentJson(name: string): Record<string, unknown> | undefined {
	const path = join(getAgentDir(), name);
	if (!existsSync(path)) return undefined;
	try {
		return obj(JSON.parse(stripJsonComments(readFileSync(path, "utf8"))));
	} catch {
		return undefined;
	}
}

export function parseConfig(text: string): QuotaConfig {
	const root = obj(JSON.parse(stripJsonComments(text)));
	if (!root) throw new Error("顶层必须是对象");
	const sites: Record<string, ProviderSettings> = {};
	for (const [host, raw] of Object.entries(obj(root.sites) ?? {})) {
		const entry = obj(raw);
		if (entry) sites[siteKey(host)] = parseSettings(entry);
	}
	const providers: Record<string, ProviderSettings> = {};
	for (const [id, raw] of Object.entries(obj(root.providers) ?? {})) {
		const entry = obj(raw);
		if (entry) providers[id] = parseSettings(entry);
	}
	return { sites, providers };
}

function parseSettings(entry: Record<string, unknown>): ProviderSettings {
	const settings: ProviderSettings = {};
	if (typeof entry.type === "string") settings.type = entry.type.trim().toLowerCase();
	if (typeof entry.userId === "number" || typeof entry.userId === "string") settings.userId = entry.userId;
	if (typeof entry.accessToken === "string") settings.accessToken = entry.accessToken;
	if (typeof entry.baseUrl === "string") settings.baseUrl = entry.baseUrl;
	return settings;
}

/** The `sites` key for a URL or a bare host: the host, lowercase. */
export function siteKey(urlOrHost: string): string {
	return (urlOrHost.includes("://") ? hostOf(urlOrHost) : urlOrHost).trim().toLowerCase();
}

/** A provider's settings: its site's, with its own on top. */
export function settingsFor(config: QuotaConfig, provider: string, baseUrl: string): ProviderSettings {
	return { ...config.sites[siteKey(baseUrl)], ...config.providers[provider] };
}

/**
 * quota.json's text with `patch` merged into `sites[site]`. The same keys are
 * taken out of the named providers' own entries, which would otherwise win
 * over the site. JSON has no comments, so a file with `//` comments loses
 * them; `dropsComments` says so before anything is written.
 */
export function siteUpdate(
	text: string | undefined,
	site: string,
	patch: ProviderSettings,
	providers: string[],
): { text: string; dropsComments: boolean } {
	const root = text?.trim() ? obj(JSON.parse(stripJsonComments(text))) : {};
	if (!root) throw new Error("quota.json 顶层必须是对象");
	const sites = obj(root.sites) ?? {};
	sites[siteKey(site)] = { ...obj(sites[siteKey(site)]), ...patch };
	root.sites = sites;

	const own = obj(root.providers);
	for (const id of providers) {
		const entry = obj(own?.[id]);
		if (!entry || !own) continue;
		for (const key of SETTING_KEYS) if (key in patch) delete entry[key];
		if (Object.keys(entry).length === 0) delete own[id];
	}
	if (own && Object.keys(own).length === 0) delete root.providers;

	return { text: `${JSON.stringify(root, null, 2)}\n`, dropsComments: text !== undefined && hasComments(text) };
}

export function readConfigText(path = getConfigPath()): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Owner-only, like pi's auth.json, since it can hold access tokens. */
export function writeConfigText(text: string, path = getConfigPath()): void {
	writeFileSync(path, text, { mode: 0o600 });
	chmodSync(path, 0o600);
}

/**
 * Resolve a config value the way pi resolves `apiKey`: `!cmd` runs a command
 * and takes its stdout, `$NAME` / `${NAME}` reads the environment, anything
 * else is the literal value.
 */
export function resolveConfigValue(value: string | undefined): string | undefined {
	const raw = value?.trim();
	if (!raw) return undefined;
	if (raw.startsWith("!")) {
		try {
			const out = execSync(raw.slice(1), { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
			return out.trim() || undefined;
		} catch {
			return undefined;
		}
	}
	const env = raw.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
	if (env) return process.env[env[1]!] || undefined;
	return raw;
}

function hasComments(text: string): boolean {
	return text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : "")) !== text;
}

/** Strip `//` comments and trailing commas outside string literals, as pi does for models.json. */
function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}
