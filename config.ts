/**
 * `quota.json` in pi's agent directory: per-provider overrides for the cases
 * auto-detection cannot cover.
 *
 * ```jsonc
 * {
 *   "providers": {
 *     // NewAPI account balance, which the API key alone cannot read
 *     "my-relay": { "type": "newapi", "userId": 1234, "accessToken": "!security find-generic-password -ws newapi" },
 *     // leave a provider out of /quota
 *     "local-llm": { "type": "off" }
 *   }
 * }
 * ```
 *
 * The file is optional. A file that does not parse is reported, not fatal:
 * every provider without an override still gets queried.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { obj } from "./http.js";
import type { ProviderSettings } from "./types.js";

export interface QuotaConfig {
	providers: Record<string, ProviderSettings>;
	/** Why the file was ignored, when it was. */
	error?: string;
}

export function getConfigPath(): string {
	return join(getAgentDir(), "quota.json");
}

export function loadConfig(path = getConfigPath()): QuotaConfig {
	if (!existsSync(path)) return { providers: {} };
	try {
		return parseConfig(readFileSync(path, "utf8"));
	} catch (error) {
		return { providers: {}, error: `${path} 解析失败：${error instanceof Error ? error.message : String(error)}` };
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
	const providers: Record<string, ProviderSettings> = {};
	for (const [id, raw] of Object.entries(obj(root.providers) ?? {})) {
		const entry = obj(raw);
		if (!entry) continue;
		const settings: ProviderSettings = {};
		if (typeof entry.type === "string") settings.type = entry.type.trim().toLowerCase();
		if (typeof entry.userId === "number" || typeof entry.userId === "string") settings.userId = entry.userId;
		if (typeof entry.accessToken === "string") settings.accessToken = entry.accessToken;
		if (typeof entry.baseUrl === "string") settings.baseUrl = entry.baseUrl;
		providers[id] = settings;
	}
	return { providers };
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

/** Strip `//` comments and trailing commas outside string literals, as pi does for models.json. */
function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}
