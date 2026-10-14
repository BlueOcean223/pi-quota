/**
 * One `/quota` run: pick a source per provider, resolve credentials, ask every
 * source at once, and report each answer as it lands.
 *
 * Providers that resolve to the same source, origin and credential become one
 * row. Two models.json entries for the same relay key (one per API shape, say)
 * would otherwise query the same account twice and show the same numbers
 * twice under different names.
 */

import { createHash } from "node:crypto";
import type { QuotaConfig } from "./config.ts";
import { hostOf } from "./http.ts";
import { pickSource } from "./sources/index.ts";
import { type CandidateContext, listCandidates, resolveTarget } from "./targets.ts";
import type { AuthKind, Http, Report, Source, Target } from "./types.ts";

export type RowState = { kind: "loading" } | { kind: "ok"; report: Report } | { kind: "error"; message: string };

export interface Row {
	/** Provider ids this row answers for; several when they share a credential. */
	providers: string[];
	names: string[];
	source: Source;
	auth: AuthKind;
	host: string;
	current: boolean;
	state: RowState;
}

export interface Skipped {
	provider: string;
	name: string;
	reason: string;
}

export interface QueryState {
	phase: "resolving" | "fetching" | "done";
	rows: Row[];
	skipped: Skipped[];
	/** Problems with the run itself, such as a quota.json that did not parse. */
	notes: string[];
	finishedAt?: number;
}

export interface QueryDeps {
	ctx: CandidateContext;
	config: QuotaConfig;
	only?: string;
	http: Http;
	signal: AbortSignal;
	onChange(): void;
}

interface Planned {
	row: Row;
	target?: Target;
}

export function startQuery(deps: QueryDeps): { state: QueryState; finished: Promise<void> } {
	const state: QueryState = { phase: "resolving", rows: [], skipped: [], notes: deps.config.error ? [deps.config.error] : [] };
	const finished = run(deps, state).catch((error) => {
		if (deps.signal.aborted) return;
		state.notes.push(`查询失败：${messageOf(error)}`);
		state.phase = "done";
		state.finishedAt = Date.now();
		deps.onChange();
	});
	return { state, finished };
}

async function run(deps: QueryDeps, state: QueryState): Promise<void> {
	const candidates = listCandidates(deps.ctx, deps.config, deps.only);
	if (deps.only && candidates.length === 0) state.notes.push(`没有叫 ${deps.only} 的 provider`);

	const picked: Array<{ candidate: (typeof candidates)[number]; source: Source }> = [];
	for (const candidate of candidates) {
		if (!candidate.configured) {
			state.skipped.push({ provider: candidate.provider, name: candidate.name, reason: "还没有凭据，先 /login 或在 models.json 里配 key" });
			continue;
		}
		const pick = pickSource({
			provider: candidate.provider,
			auth: candidate.auth,
			baseUrl: candidate.settings.baseUrl ?? candidate.model.baseUrl,
			custom: candidate.custom,
			settings: candidate.settings,
		});
		if ("off" in pick) continue;
		if ("unsupported" in pick) {
			state.skipped.push({ provider: candidate.provider, name: candidate.name, reason: pick.unsupported });
			continue;
		}
		picked.push({ candidate, source: pick.source });
	}

	const resolved = await Promise.all(
		picked.map(async ({ candidate, source }) => {
			try {
				return { candidate, source, target: await resolveTarget(deps.ctx.modelRegistry, candidate) };
			} catch (error) {
				return { candidate, source, error: messageOf(error) };
			}
		}),
	);
	if (deps.signal.aborted) return;

	const groups = new Map<string, Planned>();
	for (const entry of resolved) {
		const { candidate, source } = entry;
		const key = entry.target ? groupKey(source, entry.target) : `unresolved|${candidate.provider}`;
		const existing = groups.get(key);
		if (existing) {
			existing.row.providers.push(candidate.provider);
			existing.row.names.push(candidate.name);
			existing.row.current ||= candidate.current;
			continue;
		}
		groups.set(key, {
			row: {
				providers: [candidate.provider],
				names: [candidate.name],
				source,
				auth: candidate.auth,
				host: hostOf(entry.target?.baseUrl ?? candidate.model.baseUrl),
				current: candidate.current,
				state: "error" in entry ? { kind: "error", message: entry.error! } : { kind: "loading" },
			},
			...(entry.target ? { target: entry.target } : {}),
		});
	}

	const planned = [...groups.values()].sort((a, b) => order(a.row) - order(b.row) || a.row.names[0]!.localeCompare(b.row.names[0]!));
	state.rows = planned.map((entry) => entry.row);
	state.skipped.sort((a, b) => a.name.localeCompare(b.name));
	state.phase = "fetching";
	deps.onChange();

	await Promise.all(
		planned.map(async ({ row, target }) => {
			if (!target || row.state.kind !== "loading") return;
			try {
				row.state = { kind: "ok", report: await row.source.fetch(target, deps.http) };
			} catch (error) {
				if (deps.signal.aborted) return;
				row.state = { kind: "error", message: messageOf(error) };
			}
			deps.onChange();
		}),
	);
	if (deps.signal.aborted) return;
	state.phase = "done";
	state.finishedAt = Date.now();
	deps.onChange();
}

/**
 * Same source, origin, credential and quota.json settings: the same query.
 * The settings count because they change what is asked (an access token adds
 * the account balance). Hashed so the key holds no secret.
 */
function groupKey(source: Source, target: Target): string {
	const credential = target.token ?? JSON.stringify(Object.entries(target.headers).sort());
	const digest = createHash("sha256").update(credential).update(JSON.stringify(target.settings)).digest("hex").slice(0, 16);
	let origin = target.baseUrl;
	try {
		origin = new URL(target.baseUrl).origin;
	} catch {
		// An unparseable base URL fails in the source; group it by the raw text.
	}
	return `${source.id}|${origin}|${digest}`;
}

/** The session's provider first, then everything else in name order. */
function order(row: Row): number {
	return row.current ? 0 : 1;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
