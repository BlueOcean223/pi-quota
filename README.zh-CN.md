# pi-quota

[English](README.md) | **简体中文**

给 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 加一个 `/quota`：订阅还剩多少限额、API key 还剩多少余额，一条命令全查。

```text
额度 · 3 项 · 11:47 更新
──────────────────────────────────────────────────────────────────────
Anthropic（当前）  Claude 订阅 · max · OAuth
  5 小时        ████████░░░░░░░░░░░░  42%  2 小时 13 分后重置
  7 天          ███░░░░░░░░░░░░░░░░░  17%  3 天 5 小时后重置（10/09 16:47）
  7 天 · Fable  ███████████████░░░░░  76%  3 天 5 小时后重置（10/09 16:47）

DeepSeek  DeepSeek · API key
  余额  ¥12.79

tw-anthropic · tw-codex  new-api.example.com · NewAPI
  账户余额  ¥119.10  已用 ¥130.90 · 分组 default
  令牌 pi   不限额  已用 ¥130.90

查不了
  OpenAI：OpenAI API key 查不了余额
──────────────────────────────────────────────────────────────────────
Esc 关闭  ·  r 刷新
```

`/quota` 查所有配了凭据的 provider，`/quota <provider>` 只查一个。结果只出现在面板里，不进会话，模型看不见，下一次请求的上下文也不变。

## 能查什么

**订阅（`/login` 登录的）**

| provider | 显示 |
| --- | --- |
| `anthropic`（Claude Pro/Max） | 5 小时、7 天窗口，Fable 的周限额，额外用量 |
| `openai-codex`（ChatGPT Plus/Pro） | 5 小时、7 天窗口，单独计量的模型，credits |
| `github-copilot` | 高级请求、Chat、补全的月度额度 |
| `kimi-coding` | 5 小时速率窗口、7 天额度（OAuth 和 API key 都行） |
| `xai`（SuperGrok / X Premium） | 当前周期（一般是 7 天）的用量，多个产品都用过时分产品显示；有月度额度、按需上限或预付余额时一并显示 |

**API key**（按请求实际发往的域名识别）

| 域名 | 显示 |
| --- | --- |
| `api.z.ai`、`open.bigmodel.cn` | GLM Coding Plan 的 5 小时窗口和 MCP 月度次数；bigmodel.cn 上还有按量余额 |
| `api.minimax.io`、`api.minimaxi.com` | Coding / Token Plan 的周期和周额度 |
| `api.deepseek.com` | 余额 |
| `api.moonshot.cn`、`api.moonshot.ai` | 余额 |
| `openrouter.ai` | 账户 credits、key 自己的限额 |
| `api.siliconflow.cn`、`.com` | 余额 |
| `opencode.ai/zen/go`（OpenCode Go） | 5 小时、7 天、本月窗口 |

**中转站 / 聚合平台**：models.json 里自定义 `baseUrl` 的 provider，按顺序探测：

1. **NewAPI**：`/api/usage/token/` 读令牌额度，`/api/status` 读站点的换算比例和显示货币（USD、CNY、tokens、自定义货币）
2. **Sub2API**：`/v1/usage`，包括订阅的日/周/月限额和速率窗口
3. **OpenAI 兼容账单**：`/v1/dashboard/billing/subscription` 和 `/usage`。OneAPI 和各种 NewAPI 分支都有；`/api/*` 被反爬挡住的站点，这条通常还能用

两个 provider 用同一个 key 指向同一个站点时（比如一个走 Anthropic 协议、一个走 OpenAI 协议），只查一次，合成一行显示。

**查不了的**会单独列出来并写明原因：Anthropic / OpenAI / xAI 的普通 API key 没有余额接口，上面没列出的订阅没有公开的额度接口，本地服务没有额度。

## NewAPI 的账户余额

NewAPI 的令牌经常设成"无限额度"。这时令牌本身没有上限，真正的上限是账户余额。

站点关掉了"按令牌统计"时，用 API key 就能查到账户余额，什么都不用配。大多数站点开着这个选项，这时那一行会提示"按 c 填写访问令牌"：在 NewAPI 控制台「个人设置」里生成一个系统访问令牌，在面板里按 `c` 粘贴进去。令牌会先拿到站点上验证，通过了才保存；站点版本较旧、还要用户 ID 的，会接着问。保存后面板自动刷新。

令牌按站点域名存进 pi 配置目录下的 `quota.json`，这个站点上的所有 provider 共用，和 pi 的 auth.json 一样只有你自己能读（0600）。也可以手动写，比如放进钥匙串：

```jsonc
// ~/.pi/agent/quota.json
{
  "sites": {
    "new-api.example.com": {
      "accessToken": "!security find-generic-password -ws newapi",  // 也可以是 "$ENV_NAME" 或明文
      "userId": 1234                                               // 只有 2026 年中以前的版本要
    }
  }
}
```

`accessToken` 的写法和 models.json 的 `apiKey` 一样：`!` 开头执行命令取输出，`$NAME` 读环境变量，其他当明文。系统访问令牌能管理整个账户，不只是读余额，所以别把它放进会同步或提交的地方。

## quota.json

`sites` 按请求发往的域名配置，对这个域名上的所有 provider 生效；`providers` 按 provider id 配置，只对这一个生效，并且优先于 `sites`。两边能写的字段一样：

| 字段 | 作用 |
| --- | --- |
| `type` | 指定用哪种方式查：`newapi`、`sub2api`、`billing`、`relay`（自动探测）、`deepseek`、`zai` 等；`"off"` 不查 |
| `accessToken`、`userId` | NewAPI 的账户余额，见上一节 |
| `baseUrl` | 额度接口和请求接口不在一个域名时，单独指定 |

```jsonc
{
  "sites": { "anyrouter.top": { "type": "off" } },   // 这个站点上的 provider 都不查
  "providers": { "local-llm": { "type": "off" } }     // 只有这一个不查
}
```

改完按 `r` 就会重新读取。

## 按键

| 键 | |
| --- | --- |
| `Esc` / `Enter` / `Space` / `q` | 关闭（还没返回的请求会取消） |
| `r` | 重新查询 |
| `c` | 给需要的 NewAPI 站点填系统访问令牌（有这样的站点时才出现） |
| `↑` / `↓`、`PgUp` / `PgDn` | 内容超出屏幕时滚动 |

## 安装

```bash
pi package add @blueocean223/pi-quota
```

或者直接指向本地目录：

```bash
pi --extension ./index.ts
```

## 几点说明

- **凭据走 pi 自己的解析。** auth.json、models.json 的 `apiKey`、`!command`、环境变量都和真实请求一样处理，过期的 OAuth token 也会照常刷新。唯一直接读 auth.json 的是 Copilot：额度接口要 GitHub token，pi 把它存成了 refresh token。
- **非交互模式也能用。** `pi -p /quota` 把结果打到 stdout；`json` 模式打到 stderr，不打乱事件流；`rpc` 模式作为一条通知发出去。
- **Claude 的额度接口有限流**，连着刷新可能返回 429，等一会儿再查。
- **NewAPI 的金额按站点自己的设置换算。** 站点没公开 `/api/status` 时，按默认的 500000 点 = $1 换算，面板上会注明。
- **对账户只读。** 所有请求都是 GET，不会改动任何账户。唯一会写的文件是按 `c` 保存访问令牌时的 `quota.json`；文件里原有的 `//` 注释会丢，保存前会先问。

## 开发

```bash
bun test
bun run typecheck
```
