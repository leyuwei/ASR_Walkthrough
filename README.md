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
2. ChatGPT API  
Official API key is supported, and relay endpoints are also supported.  
You can choose your own channel (for example, cheaper relay options from Xianyu), but please evaluate stability and account security risks.

## 3. Configuration (most important)

- Template file: `app_config.template.json`
- Runtime file: `app_config.json` (local/server only, do NOT commit)

### Recommended setup flow

1. Copy `app_config.template.json` to `app_config.json`.
2. Fill Tencent fields: `secretId`, `secretKey`, `region`.
3. Fill AI fields: `aiRelayEndpoint`, `aiApiKey`, `aiModel`, `aiPromptTemplate`.
4. Adjust ASR fields if needed: `engineModelType`, `channelNum`, `resTextFormat`, poll timeout values.

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
