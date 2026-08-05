# ASR Walkthrough (PHP + Nginx/Apache)

工程化场景下走查快速记录（一键录音-转文字-AI分析-导出）

Core point: this project works only when `app_config.json` is configured correctly.

## 1. Dependencies

- PHP 8.1+ with `curl` extension enabled
- Nginx or Apache
- HTTPS strongly recommended (mobile recording + geolocation)

## 2. Two paid services you need

1. Tencent Cloud ASR (speech-to-text)  
You need `SecretId` and `SecretKey`, and ASR service enabled in Tencent Cloud.
2. AI text-processing model  
The backend talks to any **OpenAI-compatible** Chat Completions endpoint, so you can pick one of:
   - **OpenAI / GPT relay** (e.g. an `api.openai.com/v1` relay). Official keys and third-party relays both work.
   - **Zhipu BigModel (GLM)** — domestic option, base URL `https://open.bigmodel.cn/api/paas/v4`, models like `glm-4`, `glm-4-plus`, `glm-4-flash`, `glm-4.5`, `glm-4.6`.
   
   See [§3 AI model configuration](#3-configuration-most-important) for how to fill the fields and switch between them.

## 3. Configuration (most important)

- Template file: `app_config.template.json`
- Runtime file: `app_config.json` (local/server only, do NOT commit)

### Recommended setup flow

1. Copy `app_config.template.json` to `app_config.json`.
2. Fill Tencent fields: `secretId`, `secretKey`, `region`.
3. Fill AI fields: `aiRelayEndpoint`, `aiApiKey`, `aiModel`, `aiPromptTemplate`.
4. Adjust ASR fields if needed: `engineModelType`, `channelNum`, `resTextFormat`, poll timeout values.

### AI model configuration & switching

All four AI fields use the **same keys** no matter which provider you choose — the backend forwards them to an OpenAI-compatible `/chat/completions` endpoint. Switching providers/models is just a matter of editing these values (you can also edit them live in `asr.html` and the changes sync to `app_config.json`):

| Field | GPT relay | GLM (BigModel) |
|---|---|---|
| `aiRelayEndpoint` | `https://your-relay.example.com/v1` | `https://open.bigmodel.cn/api/coding/paas/v4` (Coding Plan) |
| `aiApiKey` | OpenAI key (e.g. `sk-...`) or relay key | BigModel API key (e.g. `xxxxxxxx.xxxxxxxxxxxxxxxx`) |
| `aiModel` | `gpt-4o-mini`, `gpt-4o`, ... | `glm-4.6`, `glm-4.5`, `glm-4-flash`, ... |
| `aiPromptTemplate` | your prompt (see placeholders below) | same prompt works for both |

Endpoint resolution (handled by `api.php`): you only need to provide the **base URL**. The backend auto-appends `/chat/completions` when the path ends in a version segment such as `/v1` (OpenAI/relay) or `/api/coding/paas/v4` (BigModel). A full `.../chat/completions` URL is also accepted as-is.

#### Example A — GPT relay

```json
{
  "aiRelayEndpoint": "https://your-relay.example.com/v1",
  "aiApiKey": "sk-your-relay-key",
  "aiModel": "gpt-4o-mini"
}
```

#### Example B — Zhipu BigModel (GLM Coding Plan)

GLM Coding Plan 用的是**专属端点**，和普通按量付费端点不同，填错会调不通：

| 套餐类型 | `aiRelayEndpoint` |
|---|---|
| **GLM Coding Plan**（本项目默认推荐，按月订阅） | `https://open.bigmodel.cn/api/coding/paas/v4` |
| 普通按量付费（Token 计费） | `https://open.bigmodel.cn/api/paas/v4` |

1. 订阅 GLM Coding Plan 后，在 [个人编程套餐 > 套餐概览](https://bigmodel.cn/coding-plan/personal/overview) 新建 API Key（团队版则在 [团队编程套餐](https://bigmodel.cn/coding-plan?z_plan=team) 取 Key）。
2. 填配置（这里以 Coding Plan 为例）：

```json
{
  "aiRelayEndpoint": "https://open.bigmodel.cn/api/coding/paas/v4",
  "aiApiKey": "your-id.your-secret",
  "aiModel": "glm-4.6"
}
```

Notes:
- BigModel uses standard `Authorization: Bearer <key>` — the same auth header as OpenAI, so no code change is needed.
- **Coding Plan 的 Key 与平台普通 API Key 不通用**：团队套餐 Key 只能走团队额度，个人套餐 Key 走个人额度。请用对应套餐生成的 Key。
- Coding Plan 支持的模型见套餐文档，常用 `glm-4.6`、`glm-4.5`；若用普通按量付费，可用 `glm-4-flash`（有免费额度）。
- 高峰期（周一至周五 14:00–18:00 UTC+8）GLM-5 系列消耗 3 倍额度，走查类文本处理建议用 `glm-4.6` 更省额度。
- To switch back to GPT later, just overwrite the three fields with your relay values again.

#### Server-side API key (optional, more secure)

Instead of putting `aiApiKey` in `app_config.json`, you can supply it via an environment variable. Set `OPENAI_API_KEY` (works for any OpenAI-compatible provider including BigModel) and restart PHP — the backend will prefer it over the config value, keeping the key out of the web root.

### Prompt placeholders

`aiPromptTemplate` supports these placeholders (replaced by backend):

- `{{text}}`
- `{{asr_text}}` or `{{asrText}}`
- `{{datetime}}` or `{{date_time}}` or `{{dateTime}}`
- `{{location}}`

## 4. Pages

- `asr.html`: admin/debug page for config and manual testing
- `index.html`: simplified mobile page (press to record, release to stop, auto ASR + AI)

## 5. Privacy before pushing

This project now ignores:

- `app_config.json`

If `app_config.json` was already tracked before, run:

```bash
git rm --cached app_config.json
```

Run a quick secret scan before each push (excluding `app_config.json`):

```bash
rg -n "AKID|sk-[A-Za-z0-9_-]{16,}|secretKey|aiApiKey|OPENAI_API_KEY|TENCENT_SECRET" . --glob "!app_config.json"
```

## 6. Production security notes

1. Block direct public download of `app_config.json` in Nginx/Apache.
2. `api.php?route=config` is protected: remote access needs `X-Config-Token` equal to server `CONFIG_API_TOKEN`.
3. Recommended: move config file outside web root and set `ASR_CONFIG_FILE` env var.
4. `index.html` now has access-code protection backed by `api.php?route=auth`; successful login stores an `HttpOnly` auth cookie.
5. `api.php?route=asr` and `api.php?route=ai` now require that auth cookie, so direct unauthenticated calls will return `401`.
6. Optional env vars:
   - `APP_AUTH_CODE_HASH` (SHA-256 hex of access code)
   - `APP_AUTH_COOKIE_SECRET` (cookie signing key)

## 7. Quick start

1. Deploy with PHP + Nginx/Apache and ensure `curl` is enabled.
2. Fill `app_config.json` from template.
3. Open `asr.html` for admin validation.
4. Open `index.html` for end-user workflow.

## 8. Access code (current) and how to change

- Current access code: `500WClubMember`
- Backend does not store plaintext for verification. It verifies SHA-256 hash.

### Recommended way to change code (no source change)

1. Choose a new code, for example `MyNewCode123`.
2. Compute SHA-256 hex:
   - PowerShell:
     ```powershell
     $s='MyNewCode123'; $sha=[System.Security.Cryptography.SHA256]::Create(); $bytes=[System.Text.Encoding]::UTF8.GetBytes($s); $hash=$sha.ComputeHash($bytes); ($hash | ForEach-Object ToString x2) -join ''
     ```
   - Linux/macOS:
     ```bash
     printf 'MyNewCode123' | sha256sum
     ```
3. Set env var `APP_AUTH_CODE_HASH` to that hex value and restart PHP service.
4. (Strongly recommended) also set `APP_AUTH_COOKIE_SECRET` to a long random string.

### Alternative (edit source directly)

1. Open `api.php`.
2. Replace `APP_AUTH_CODE_HASH` constant with SHA-256 hex of your new code.
3. Redeploy/restart service.
