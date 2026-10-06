# pi-quota

**English** | [简体中文](README.zh-CN.md)

`/quota` for [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): how much of each subscription's rate limits and each API key's balance is left, in one command.

```text
额度 · 3 项 · 15:07 更新
──────────────────────────────────────────────────────────────────────
Anthropic（当前）  Claude 订阅 · max · OAuth
  5 小时       ████████░░░░░░░░░░░░  42%  2 小时 13 分后重置
  7 天         ███░░░░░░░░░░░░░░░░░  17%  3 天 5 小时后重置（10/09 16:47）
  7 天 · Opus  ███████████████░░░░░  76%  3 天 5 小时后重置（10/09 16:47）

DeepSeek  DeepSeek · API key
  余额  ¥12.79  充值 ¥12.79

tw-anthropic · tw-codex  new-api.example.com · NewAPI
  账户余额  ¥119.10  已用 ¥130.90 · 分组 default
  令牌 pi   不限额  已用 ¥130.90

查不了
  OpenAI：OpenAI API key 查不了余额
──────────────────────────────────────────────────────────────────────
Esc 关闭  ·  r 刷新
```

The interface is in Chinese.

`/quota` asks every provider pi has credentials for; `/quota <provider>` asks one. The answer goes to the panel only. It never enters the session, the model never sees it, and the next request carries the same context it would have anyway.

## What it reads

**Subscriptions (signed in with `/login`)**

| Provider | Shows |
| --- | --- |
| `anthropic` (Claude Pro/Max) | 5-hour, 7-day, 7-day Opus/Sonnet windows; extra usage |
| `openai-codex` (ChatGPT Plus/Pro) | 5-hour and 7-day windows, separately metered models, credits |
| `github-copilot` | Monthly premium requests, chat, completions |
| `kimi-coding` | 5-hour rate window, 7-day allowance (OAuth or API key) |
| `xai` (SuperGrok / X Premium) | Usage in the current period (usually 7 days), split by product when more than one has been used; a monthly allowance, on-demand cap or prepaid balance when the account has one |

**API keys**, recognized by the host the request goes to:

| Host | Shows |
| --- | --- |
| `api.z.ai`, `open.bigmodel.cn` | GLM Coding Plan 5-hour window and monthly MCP calls; pay-as-you-go balance on bigmodel.cn |
| `api.minimax.io`, `api.minimaxi.com` | Coding / Token Plan interval and weekly allowance |
| `api.deepseek.com` | Balance |
| `api.moonshot.cn`, `api.moonshot.ai` | Balance |
| `openrouter.ai` | Account credits and the key's own limit |
| `api.siliconflow.cn`, `.com` | Balance |

**Relays and aggregators**: a provider with its own `baseUrl` in models.json is probed in this order:

1. **NewAPI**: `/api/usage/token/` for the token's allowance, `/api/status` for the site's conversion rate and display currency (USD, CNY, tokens, or a custom one)
2. **Sub2API**: `/v1/usage`, including daily/weekly/monthly subscription caps and rate windows
3. **OpenAI-compatible billing**: `/v1/dashboard/billing/subscription` and `/usage`. OneAPI and the NewAPI forks serve these, and they usually stay reachable on sites whose anti-bot layer blocks `/api/*`

Providers that send the same key to the same site (one speaking the Anthropic API and one the OpenAI API, say) are queried once and shown as one row.

Providers that cannot be queried are listed with the reason: ordinary Anthropic, OpenAI and xAI API keys have no balance endpoint, subscriptions not listed above publish no quota endpoint, and local servers have no quota.

## NewAPI account balance

NewAPI tokens are often created with unlimited quota. The token then has no cap of its own and the real cap is the account balance.

Sites that turn off per-token stats report the account to the API key, and the balance shows with nothing to configure. Most sites leave them on. There, create a system access token under the NewAPI console's personal settings and add it to `quota.json` in pi's agent directory:

```jsonc
// ~/.pi/agent/quota.json
{
  "providers": {
    "tw-codex": {
      "accessToken": "!security find-generic-password -ws newapi",  // or "$ENV_NAME", or the literal token
      "userId": 1234                                               // only builds from before mid-2026 need it: the user id the console shows
    }
  }
}
```

A system access token can manage the whole account, not just read the balance, so keep it in the keychain or an environment variable rather than in plain text.

`accessToken` resolves like `apiKey` in models.json: a leading `!` runs a command and takes its output, `$NAME` reads an environment variable, anything else is literal.

Other `quota.json` fields:

| Field | Effect |
| --- | --- |
| `type` | Force a source: `newapi`, `sub2api`, `billing`, `relay` (auto-probe), `deepseek`, `zai`, … ; `"off"` leaves the provider out |
| `baseUrl` | Query a different origin when the quota API is not on the request host |

Press `r` after editing; the file is read again on every run.

## Keys

| Key | |
| --- | --- |
| `Esc` / `Enter` / `Space` / `q` | Close (requests still in flight are cancelled) |
| `r` | Query again |
| `↑` / `↓`, `PgUp` / `PgDn` | Scroll when the panel does not fit |

## Install

```bash
pi package add @blueocean223/pi-quota
```

Or point pi at a local checkout:

```bash
pi --extension ./index.ts
```

## Notes

- **Credentials resolve the way pi resolves them.** auth.json, models.json `apiKey`, `!command` and environment variables all behave as they do for real requests, and an expired OAuth token is refreshed the same way. Copilot is the one case that reads auth.json directly: its quota endpoint wants the GitHub token, which pi stores as the refresh token.
- **Works outside the TUI.** `pi -p /quota` prints to stdout; `json` mode prints to stderr so the event stream stays intact; `rpc` mode sends it as a notification.
- **Claude's usage endpoint is rate limited.** Refreshing in quick succession can return 429; wait a bit.
- **NewAPI amounts follow the site's own settings.** When a site does not expose `/api/status`, the stock 500000 points = $1 is assumed and the panel says so.
- **Read-only.** Every request is a GET; nothing about any account or config is changed.

## Development

```bash
bun test
bun run typecheck
```
