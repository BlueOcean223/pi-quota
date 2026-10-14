/**
 * pi-quota — `/quota`, how much of each subscription window and API balance is
 * left, for every provider pi has credentials for.
 *
 * `/quota` asks all of them at once; `/quota <provider>` asks one. Logged-in
 * subscriptions (Claude Pro/Max, ChatGPT, Copilot, Kimi, SuperGrok) report
 * their rate windows; API keys report balances, or a plan's windows, where the
 * vendor has an endpoint for it; custom providers in models.json are probed
 * as NewAPI, Sub2API or OpenAI-compatible relays.
 *
 * It is a command and not a tool, so only the user can run it, and the answer
 * goes to the panel or the terminal, never into the session: the model does
 * not see it and the next request carries the same context it would have
 * carried anyway.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { createHttp } from "./http.ts";
import { createPanel, type PanelResult } from "./panel.ts";
import { type QueryState, startQuery } from "./query.ts";
import { bodyLines, headerLine, plainStyle } from "./render.ts";
import { runSetup } from "./setup.ts";
import { type CandidateContext, providerIds } from "./targets.ts";

const PLAIN_WIDTH = 100;

export default function quota(pi: ExtensionAPI) {
	// Argument completion gets no context of its own; the registry from the
	// latest session start is the same one every command sees.
	let completionContext: CandidateContext | undefined;
	pi.on("session_start", (_event, ctx) => {
		completionContext = { modelRegistry: ctx.modelRegistry, model: ctx.model };
	});

	pi.registerCommand("quota", {
		description: "查询订阅限额和 API key 余额",
		getArgumentCompletions: (prefix: string) => {
			if (!completionContext) return null;
			try {
				const query = prefix.trim().toLowerCase();
				const items = providerIds(completionContext)
					.filter((id) => id.toLowerCase().startsWith(query))
					.map((id) => ({ value: id, label: id }));
				return items.length > 0 ? items : null;
			} catch {
				return null;
			}
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const only = args.trim() || undefined;
			if (ctx.mode === "tui") {
				await showPanel(ctx, only);
				return;
			}
			await printOnce(ctx, only);
		},
	});
}

async function showPanel(ctx: ExtensionCommandContext, only: string | undefined): Promise<void> {
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};
	let controller = new AbortController();
	const start = (): QueryState => {
		controller.abort();
		controller = new AbortController();
		// Re-read on every run so an edit to quota.json shows on the next `r`.
		return startQuery({
			ctx,
			config: loadConfig(),
			...(only ? { only } : {}),
			http: createHttp(controller.signal),
			signal: controller.signal,
			onChange: notify,
		}).state;
	};
	let state = start();

	try {
		// `c` leaves the panel to ask for a credential, then comes back to it:
		// with a fresh query when one was saved, as it was otherwise.
		for (;;) {
			const result = await ctx.ui.custom<PanelResult>(
				createPanel({
					state: () => state,
					subscribe: (onChange) => {
						listeners.add(onChange);
						return () => listeners.delete(onChange);
					},
					refresh: () => {
						state = start();
					},
				}),
			);
			if (!result) return;
			if (await runSetup(ctx, result.setup, createHttp())) state = start();
		}
	} finally {
		controller.abort();
	}
}

/**
 * Print, JSON and RPC modes: wait for every answer, then write it once.
 *
 * Print mode's stdout is the answer to the prompt, and here the report is
 * that answer. JSON mode's stdout is an event stream, so the report goes to
 * stderr. RPC clients get it as a notification.
 */
async function printOnce(ctx: ExtensionCommandContext, only: string | undefined): Promise<void> {
	const controller = new AbortController();
	const { state, finished } = startQuery({
		ctx,
		config: loadConfig(),
		...(only ? { only } : {}),
		http: createHttp(controller.signal),
		signal: controller.signal,
		onChange: () => {},
	});
	await finished;
	const width = process.stdout.columns || PLAIN_WIDTH;
	const text = [headerLine(state, plainStyle), ...bodyLines(state, width, plainStyle)].join("\n");
	if (ctx.mode === "rpc" && ctx.hasUI) {
		ctx.ui.notify(text, "info");
		return;
	}
	(ctx.mode === "print" ? process.stdout : process.stderr).write(`${text}\n`);
}
