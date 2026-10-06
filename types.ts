/**
 * What a quota lookup works with and what it hands back.
 *
 * A `Target` is one credential as pi would send it: the provider ids that use
 * it, the bearer token, the endpoint. A `Source` knows one vendor's quota API
 * and turns a target into a `Report`. Nothing here holds rendering state, so
 * the panel and the plain-text printer read the same reports.
 */

export type AuthKind = "oauth" | "api_key";

/** Per-provider overrides read from `quota.json`. */
export interface ProviderSettings {
	/** Force a source by id, or `"off"` to leave the provider out. */
	type?: string;
	/** NewAPI: the user id, sent as `New-Api-User`, for the account balance. */
	userId?: number | string;
	/** NewAPI: a system access token for `/api/user/self`. `!cmd` and `$ENV` resolve like models.json. */
	accessToken?: string;
	/** Query this origin instead of the provider's base URL. */
	baseUrl?: string;
}

export interface Target {
	/** The pi provider this credential was resolved for. */
	provider: string;
	/** pi's display name for the provider. */
	name: string;
	auth: AuthKind;
	/** API key or OAuth access token, when the credential is a bearer token. */
	token?: string;
	/** Headers pi would send, already resolved. Kimi's OAuth puts its token here. */
	headers: Record<string, string>;
	baseUrl: string;
	/** The stored OAuth credential, for the fields a token alone does not carry. */
	credential?: Record<string, unknown>;
	settings: ProviderSettings;
}

/** A money amount, or a count in a unit that is not money. */
export interface Amount {
	value: number;
	/** ISO code (`USD`, `CNY`), `tokens`, `credits`, or a site's own symbol. */
	unit: string;
}

/** A rolling or calendar window measured in percent used. */
export interface Meter {
	label: string;
	/** 0–100. Values past 100 mean the window is overdrawn. */
	usedPercent: number;
	/** Epoch milliseconds. */
	resetsAt?: number;
	/** Counts behind the percent, e.g. `120 / 1500 次`. */
	detail?: string;
}

/** A balance or allowance measured in an amount rather than a percent. */
export interface Balance {
	label: string;
	/** `"unlimited"` for allowances the site does not cap. */
	value: Amount | "unlimited";
	detail?: string;
}

export interface Note {
	text: string;
	tone: "muted" | "warning";
}

export interface Report {
	plan?: string;
	meters: Meter[];
	balances: Balance[];
	notes: Note[];
}

export interface Http {
	getJson(url: string, init?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<HttpResult>;
}

export interface HttpResult {
	status: number;
	/** Parsed body, or undefined when the body is not JSON. */
	json: unknown;
	text: string;
	contentType: string;
}

export interface Source {
	id: string;
	/** Shown after the provider name, e.g. `Claude 订阅`. */
	label: string;
	fetch(target: Target, http: Http): Promise<Report>;
}

export function emptyReport(): Report {
	return { meters: [], balances: [], notes: [] };
}
