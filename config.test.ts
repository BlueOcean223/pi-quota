/**
 * quota.json: reading sites and providers, and the edits the panel makes.
 */

import { describe, expect, test } from "bun:test";
import { parseConfig, settingsFor, siteUpdate } from "./config.js";

describe("parseConfig", () => {
	test("reads sites by host, accepting a URL for the key", () => {
		const config = parseConfig(`{
			// comments and trailing commas, as in models.json
			"sites": { "https://New-API.example.com/v1": { "accessToken": "t" }, "anyrouter.top": { "type": "OFF" }, },
			"providers": { "tw-codex": { "userId": 7 } },
		}`);
		expect(config.sites).toEqual({ "new-api.example.com": { accessToken: "t" }, "anyrouter.top": { type: "off" } });
		expect(config.providers).toEqual({ "tw-codex": { userId: 7 } });
	});
});

describe("settingsFor", () => {
	const config = parseConfig(
		JSON.stringify({ sites: { "relay.example.com": { accessToken: "site", userId: 1 } }, providers: { "tw-codex": { userId: 2 } } }),
	);

	test("a provider gets its site's settings with its own on top", () => {
		expect(settingsFor(config, "tw-anthropic", "https://relay.example.com")).toEqual({ accessToken: "site", userId: 1 });
		expect(settingsFor(config, "tw-codex", "https://relay.example.com/v1")).toEqual({ accessToken: "site", userId: 2 });
		expect(settingsFor(config, "deepseek", "https://api.deepseek.com")).toEqual({});
	});
});

describe("siteUpdate", () => {
	test("creates the file's content from nothing", () => {
		const { text, dropsComments } = siteUpdate(undefined, "relay.example.com", { accessToken: "t" }, ["tw-codex"]);
		expect(JSON.parse(text)).toEqual({ sites: { "relay.example.com": { accessToken: "t" } } });
		expect(dropsComments).toBe(false);
	});

	test("merges into the site and takes the same keys out of the row's providers, leaving the rest", () => {
		const before = JSON.stringify({
			$schema: "x",
			sites: { "relay.example.com": { type: "newapi", accessToken: "old" }, "other.example.com": { type: "off" } },
			providers: { "tw-codex": { accessToken: "stale", baseUrl: "https://b" }, "tw-anthropic": { accessToken: "stale" }, deepseek: { type: "off" } },
		});
		const { text } = siteUpdate(before, "Relay.Example.com", { accessToken: "new" }, ["tw-codex", "tw-anthropic"]);
		expect(JSON.parse(text)).toEqual({
			$schema: "x",
			sites: { "relay.example.com": { type: "newapi", accessToken: "new" }, "other.example.com": { type: "off" } },
			providers: { "tw-codex": { baseUrl: "https://b" }, deepseek: { type: "off" } },
		});
	});

	test("says when the rewrite drops comments, but not for a // inside a string", () => {
		expect(siteUpdate('{ "sites": { "a": { "baseUrl": "https://a" } } }', "a", { accessToken: "t" }, []).dropsComments).toBe(false);
		expect(siteUpdate('{\n  // mine\n  "sites": {}\n}', "a", { accessToken: "t" }, []).dropsComments).toBe(true);
	});

	test("refuses a file that does not parse", () => {
		expect(() => siteUpdate("{ nope", "a", { accessToken: "t" }, [])).toThrow();
	});
});
