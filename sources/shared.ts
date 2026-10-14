import { formatCount } from "../format.ts";
import { QuotaError } from "../http.ts";
import type { Target } from "../types.ts";

/** The bearer token pi would send: the API key, or the token inside an `Authorization` header. */
export function bearer(target: Target): string {
	if (target.token) return target.token;
	for (const [name, value] of Object.entries(target.headers)) {
		if (name.toLowerCase() !== "authorization") continue;
		const match = value.match(/^Bearer\s+(.+)$/i);
		if (match) return match[1]!.trim();
	}
	throw new QuotaError("没有可用的凭据");
}

/** Label for a window given in minutes: `5 小时`, `7 天`, `30 分钟`. */
export function windowLabel(minutes: number | undefined): string | undefined {
	if (!minutes || minutes <= 0) return undefined;
	if (minutes % (60 * 24 * 7) === 0) {
		const weeks = minutes / (60 * 24 * 7);
		return weeks === 1 ? "7 天" : `${weeks} 周`;
	}
	if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)} 天`;
	if (minutes % 60 === 0) return `${minutes / 60} 小时`;
	return `${minutes} 分钟`;
}

/** Percent used from a limit and a used count, or from a limit and what remains. */
export function percentOf(limit: number | undefined, used: number | undefined, remaining?: number): number | undefined {
	if (!limit || limit <= 0) return undefined;
	const spent = used ?? (remaining !== undefined ? limit - remaining : undefined);
	if (spent === undefined) return undefined;
	return (Math.max(0, spent) / limit) * 100;
}

export function countDetail(used: number | undefined, limit: number | undefined, unit = ""): string | undefined {
	if (used === undefined || limit === undefined) return undefined;
	return `${formatCount(used)} / ${formatCount(limit)}${unit ? ` ${unit}` : ""}`;
}
