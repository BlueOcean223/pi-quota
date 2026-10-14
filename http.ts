/**
 * One JSON GET with a timeout, plus the loose readers every source parses with.
 *
 * pi installs an undici dispatcher that honors HTTP(S)_PROXY before extensions
 * load, so the global `fetch` already goes through the user's proxy.
 */

import type { Http, HttpResult } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT = "pi-quota/0.1";

/** A failure whose message is fit to show the user as is. */
export class QuotaError extends Error {
	override name = "QuotaError";
}

export function createHttp(signal?: AbortSignal): Http {
	return {
		async getJson(url, init = {}) {
			const timeout = AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
			const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
			let response: Response;
			try {
				response = await fetch(url, {
					headers: { accept: "application/json", "user-agent": USER_AGENT, ...init.headers },
					signal: combined,
				});
			} catch (error) {
				if (signal?.aborted) throw error;
				if (timeout.aborted) throw new QuotaError(`请求超时：${hostOf(url)}`);
				throw new QuotaError(`网络错误：${causeText(error)}`);
			}
			const text = await response.text();
			let json: unknown;
			try {
				json = JSON.parse(text);
			} catch {
				json = undefined;
			}
			return { status: response.status, json, text, contentType: response.headers.get("content-type") ?? "" };
		},
	};
}

/** Throw a readable error for anything but a 2xx JSON body. */
export function expectJson(result: HttpResult, what: string): Record<string, unknown> {
	if (result.status === 401 || result.status === 403) {
		throw new QuotaError(`${what}拒绝了凭据（HTTP ${result.status}）${suffix(serverMessage(result))}`);
	}
	if (result.status === 429) throw new QuotaError(`${what}限流了，稍后再试（HTTP 429）`);
	if (result.status < 200 || result.status >= 300) {
		throw new QuotaError(`${what}返回 HTTP ${result.status}${suffix(serverMessage(result))}`);
	}
	const body = obj(result.json);
	if (!body) {
		const hint = /text\/html/i.test(result.contentType) ? "（返回的是网页，可能被反爬或登录页拦截）" : "";
		throw new QuotaError(`${what}返回的不是 JSON${hint}`);
	}
	return body;
}

/** The error text a server put in its body, in the shapes relays and vendors use. */
export function serverMessage(result: HttpResult): string | undefined {
	const body = obj(result.json);
	if (body) {
		const error = body.error;
		const nested = typeof error === "string" ? error : str(obj(error)?.message);
		const message = nested ?? str(body.message) ?? str(body.msg) ?? str(obj(body.base_resp)?.status_msg);
		if (message) return clip(message);
	}
	if (result.text && !/^\s*</.test(result.text)) return clip(result.text);
	return undefined;
}

export function obj(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function arr(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** A finite number, accepting the numeric strings several vendors send. */
export function num(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

export function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Epoch milliseconds from the timestamp shapes in use: ISO strings, epoch
 * seconds and epoch milliseconds, as numbers or numeric strings.
 */
export function epochMs(value: unknown): number | undefined {
	const n = num(value);
	if (n !== undefined) {
		if (n <= 0) return undefined;
		return n < 1e12 ? n * 1000 : n;
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

export function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		throw new QuotaError(`base URL 无效：${url}`);
	}
}

export function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

function suffix(message: string | undefined): string {
	return message ? `：${message}` : "";
}

function clip(text: string, max = 160): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function causeText(error: unknown): string {
	if (error instanceof Error) {
		const cause = (error as Error & { cause?: unknown }).cause;
		if (cause instanceof Error && cause.message) return cause.message;
		return error.message;
	}
	return String(error);
}
