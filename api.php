<?php
declare(strict_types=1);

const API_VERSION = '2019-06-14';
const API_SERVICE = 'asr';
const CONTENT_TYPE = 'application/json; charset=utf-8';
const AI_DEFAULT_CHAT_PATH = '/v1/chat/completions';

const DEFAULT_CONFIG = [
    'secretId' => '',
    'secretKey' => '',
    'apiEndpoint' => 'https://asr.tencentcloudapi.com',
    'region' => 'ap-shanghai',
    'proxyEndpoint' => 'api.php',
    'callbackUrl' => '',
    'engineModelType' => '16k_zh',
    'channelNum' => '1',
    'resTextFormat' => '0',
    'pollIntervalMs' => '2000',
    'pollTimeoutSec' => '600',
    'voiceUrl' => '',
    'taskId' => '',
    'aiRelayEndpoint' => '',
    'aiApiKey' => '',
    'aiModel' => 'codex-mini-latest',
    'aiPromptTemplate' => "You are an ASR post-processing assistant. Keep the original meaning, fix obvious typos, add punctuation, and format with clear paragraphs.\n\nOriginal text:\n{{text}}",
    'aiAutoPostProcess' => false,
];

send_cors_headers();

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

try {
    route_request();
} catch (Throwable $e) {
    send_json(500, ['message' => 'Internal server error: ' . $e->getMessage()]);
}

function route_request(): void
{
    $route = trim((string)($_GET['route'] ?? ''));
    if ($route === 'config') {
        handle_config_route();
        return;
    }
    if ($route === 'asr') {
        handle_asr_route();
        return;
    }
    if ($route === 'ai') {
        handle_ai_route();
        return;
    }

    send_json(404, ['message' => 'Not Found']);
}

function handle_config_route(): void
{
    if (!is_config_route_authorized()) {
        send_json(403, [
            'message' => 'Forbidden config access. Use loopback request or valid X-Config-Token (CONFIG_API_TOKEN).',
        ]);
        return;
    }

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method === 'GET') {
        send_json(200, read_config());
        return;
    }
    if ($method === 'POST') {
        $patch = read_json_body();
        if (!is_array($patch)) {
            send_json(400, ['message' => 'Config payload must be a JSON object']);
            return;
        }
        $saved = update_config($patch);
        send_json(200, $saved);
        return;
    }

    send_json(405, ['message' => 'Method Not Allowed']);
}

function is_config_route_authorized(): bool
{
    if (is_loopback_request()) {
        return true;
    }

    $expectedToken = trim((string)(getenv('CONFIG_API_TOKEN') ?: ''));
    if ($expectedToken === '') {
        return false;
    }

    $providedToken = trim((string)($_SERVER['HTTP_X_CONFIG_TOKEN'] ?? ''));
    if ($providedToken === '') {
        return false;
    }

    return hash_equals($expectedToken, $providedToken);
}

function is_loopback_request(): bool
{
    $remoteAddr = trim((string)($_SERVER['REMOTE_ADDR'] ?? ''));
    return in_array($remoteAddr, ['127.0.0.1', '::1', '::ffff:127.0.0.1'], true);
}

function handle_asr_route(): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        send_json(405, ['message' => 'Method Not Allowed']);
        return;
    }

    $request = read_json_body();
    if (!is_array($request)) {
        send_json(400, ['message' => 'Request body must be a JSON object']);
        return;
    }

    $action = trim((string)($request['action'] ?? ''));
    $payload = $request['payload'] ?? null;
    if ($action === '') {
        send_json(400, ['message' => 'Missing action']);
        return;
    }
    if (!is_array($payload)) {
        send_json(400, ['message' => 'payload must be a JSON object']);
        return;
    }

    $config = read_config();
    $payload = apply_asr_payload_defaults($action, $payload, $config);
    $endpoint = trim((string)($request['endpoint'] ?? $config['apiEndpoint']));
    $region = trim((string)($request['region'] ?? $config['region']));

    $secretId = getenv('TENCENT_SECRET_ID');
    if ($secretId === false || $secretId === '') {
        $secretId = trim((string)($request['secretId'] ?? $config['secretId']));
    }
    $secretKey = getenv('TENCENT_SECRET_KEY');
    if ($secretKey === false || $secretKey === '') {
        $secretKey = trim((string)($request['secretKey'] ?? $config['secretKey']));
    }

    if ($endpoint === '' || $region === '') {
        send_json(400, ['message' => 'Missing endpoint/region']);
        return;
    }
    if ($secretId === '' || $secretKey === '') {
        send_json(400, ['message' => 'Missing SecretId/SecretKey']);
        return;
    }

    $target = normalize_http_endpoint($endpoint);
    if ($target === null) {
        send_json(400, ['message' => 'Invalid endpoint URL']);
        return;
    }

    $body = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($body === false) {
        send_json(400, ['message' => 'payload contains non-encodable data']);
        return;
    }

    $timestamp = time();
    $authorization = build_authorization($secretId, $secretKey, $target['host'], $target['path'], $timestamp, $body);

    $headers = [
        'Authorization: ' . $authorization,
        'Content-Type: ' . CONTENT_TYPE,
        'Host: ' . $target['host'],
        'X-TC-Action: ' . $action,
        'X-TC-Version: ' . API_VERSION,
        'X-TC-Timestamp: ' . (string)$timestamp,
        'X-TC-Region: ' . $region,
    ];

    proxy_json_request($target['url'], $headers, $body, 30);
}

function apply_asr_payload_defaults(string $action, array $payload, array $config): array
{
    if ($action !== 'CreateRecTask') {
        return $payload;
    }

    if (!isset($payload['EngineModelType']) || trim((string)$payload['EngineModelType']) === '') {
        $payload['EngineModelType'] = trim((string)($config['engineModelType'] ?? '16k_zh'));
    }

    if (!isset($payload['ChannelNum']) || !is_numeric($payload['ChannelNum'])) {
        $payload['ChannelNum'] = (int)($config['channelNum'] ?? 1);
    }

    if (!isset($payload['ResTextFormat']) || !is_numeric($payload['ResTextFormat'])) {
        $payload['ResTextFormat'] = (int)($config['resTextFormat'] ?? 0);
    }

    if (!isset($payload['CallbackUrl']) || trim((string)$payload['CallbackUrl']) === '') {
        $callbackUrl = trim((string)($config['callbackUrl'] ?? ''));
        if ($callbackUrl !== '') {
            $payload['CallbackUrl'] = $callbackUrl;
        }
    }

    return $payload;
}

function handle_ai_route(): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        send_json(405, ['message' => 'Method Not Allowed']);
        return;
    }

    $request = read_json_body();
    if (!is_array($request)) {
        send_json(400, ['message' => 'Request body must be a JSON object']);
        return;
    }

    $config = read_config();
    $endpoint = trim((string)($request['endpoint'] ?? $config['aiRelayEndpoint']));
    $model = trim((string)($request['model'] ?? $config['aiModel']));
    $prompt = trim((string)($request['prompt'] ?? ''));
    if ($prompt === '') {
        $prompt = build_ai_prompt_from_template($request, $config);
    }

    $apiKey = getenv('OPENAI_API_KEY');
    if ($apiKey === false || $apiKey === '') {
        $apiKey = trim((string)($request['apiKey'] ?? $config['aiApiKey']));
    }

    if ($endpoint === '') {
        send_json(400, ['message' => 'Missing AI relay endpoint']);
        return;
    }
    if ($model === '') {
        send_json(400, ['message' => 'Missing AI model']);
        return;
    }
    if ($prompt === '') {
        send_json(400, ['message' => 'Missing prompt']);
        return;
    }
    if ($apiKey === '') {
        send_json(400, ['message' => 'Missing API key']);
        return;
    }

    $target = normalize_ai_chat_endpoint($endpoint);
    if ($target === null) {
        send_json(400, ['message' => 'Invalid AI relay endpoint URL']);
        return;
    }

    $requestBody = [
        'model' => $model,
        'messages' => [
            ['role' => 'user', 'content' => $prompt],
        ],
    ];

    $temperatureRaw = $request['temperature'] ?? null;
    if (is_numeric($temperatureRaw)) {
        $requestBody['temperature'] = (float)$temperatureRaw;
    }

    $body = json_encode($requestBody, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($body === false) {
        send_json(400, ['message' => 'Failed to encode AI request body']);
        return;
    }

    $headers = [
        'Authorization: Bearer ' . $apiKey,
        'Content-Type: ' . CONTENT_TYPE,
        'Accept: application/json',
        'Host: ' . $target['host'],
    ];

    $response = proxy_raw_request($target['url'], $headers, $body, 90);
    if (!$response['ok']) {
        send_json(502, ['message' => 'AI proxy request failed: ' . $response['error']]);
        return;
    }

    $decoded = json_decode($response['body'], true);
    if (!is_array($decoded)) {
        send_json($response['status'], ['raw' => $response['body']]);
        return;
    }

    send_json($response['status'], [
        'text' => extract_ai_text($decoded),
        'response' => $decoded,
    ]);
}

function build_ai_prompt_from_template(array $request, array $config): string
{
    $template = trim((string)($request['promptTemplate'] ?? $config['aiPromptTemplate'] ?? ''));
    if ($template === '') {
        return '';
    }

    $asrText = trim((string)($request['asrText'] ?? ''));
    $dateTime = trim((string)($request['dateTime'] ?? ''));
    $location = trim((string)($request['location'] ?? ''));
    $composedText = trim((string)($request['text'] ?? ''));
    if ($composedText === '') {
        $parts = [];
        if ($asrText !== '') {
            $parts[] = 'ASR Text: ' . $asrText;
        }
        if ($dateTime !== '') {
            $parts[] = 'DateTime: ' . $dateTime;
        }
        if ($location !== '') {
            $parts[] = 'Location: ' . $location;
        }
        $composedText = trim(implode("\n", $parts));
    }

    $replaced = str_replace(
        [
            '{{text}}',
            '{{asr_text}}',
            '{{asrText}}',
            '{{datetime}}',
            '{{date_time}}',
            '{{dateTime}}',
            '{{location}}',
        ],
        [
            $composedText,
            $asrText,
            $asrText,
            $dateTime,
            $dateTime,
            $dateTime,
            $location,
        ],
        $template
    );

    return trim($replaced);
}

function proxy_json_request(string $url, array $headers, string $body, int $timeoutSec): void
{
    $response = proxy_raw_request($url, $headers, $body, $timeoutSec);
    if (!$response['ok']) {
        send_json(502, ['message' => 'Proxy request failed: ' . $response['error']]);
        return;
    }

    $decoded = json_decode($response['body'], true);
    if (is_array($decoded)) {
        send_json($response['status'], $decoded);
        return;
    }

    send_json($response['status'], ['raw' => $response['body']]);
}

function proxy_raw_request(string $url, array $headers, string $body, int $timeoutSec): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_POSTFIELDS => $body,
        CURLOPT_TIMEOUT => $timeoutSec,
    ]);
    $responseBody = curl_exec($ch);
    if ($responseBody === false) {
        $error = curl_error($ch);
        curl_close($ch);
        return [
            'ok' => false,
            'error' => $error,
            'status' => 0,
            'body' => '',
        ];
    }
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    return [
        'ok' => true,
        'error' => '',
        'status' => $status > 0 ? $status : 200,
        'body' => $responseBody,
    ];
}

function normalize_http_endpoint(string $endpoint): ?array
{
    $parsed = parse_url($endpoint);
    if (!is_array($parsed)) {
        return null;
    }
    $scheme = strtolower((string)($parsed['scheme'] ?? ''));
    $host = strtolower((string)($parsed['host'] ?? ''));
    $port = isset($parsed['port']) ? (int)$parsed['port'] : null;
    if (($scheme !== 'https' && $scheme !== 'http') || $host === '') {
        return null;
    }

    $path = (string)($parsed['path'] ?? '/');
    if ($path === '') {
        $path = '/';
    }
    if ($path[0] !== '/') {
        $path = '/' . $path;
    }
    $query = isset($parsed['query']) ? '?' . $parsed['query'] : '';
    $hostWithPort = $host;
    if ($port !== null && $port > 0) {
        $hostWithPort .= ':' . $port;
    }

    return [
        'scheme' => $scheme,
        'host' => $hostWithPort,
        'path' => $path,
        'url' => $scheme . '://' . $hostWithPort . $path . $query,
    ];
}

function normalize_ai_chat_endpoint(string $endpoint): ?array
{
    $parsed = parse_url($endpoint);
    if (!is_array($parsed)) {
        return null;
    }
    $scheme = strtolower((string)($parsed['scheme'] ?? ''));
    $host = strtolower((string)($parsed['host'] ?? ''));
    $port = isset($parsed['port']) ? (int)$parsed['port'] : null;
    if (($scheme !== 'https' && $scheme !== 'http') || $host === '') {
        return null;
    }

    $path = (string)($parsed['path'] ?? '');
    if ($path === '' || $path === '/') {
        $path = AI_DEFAULT_CHAT_PATH;
    } elseif (preg_match('#/v1/?$#i', $path) === 1) {
        $path = rtrim($path, '/') . '/chat/completions';
    }

    if ($path[0] !== '/') {
        $path = '/' . $path;
    }
    $query = isset($parsed['query']) ? '?' . $parsed['query'] : '';
    $hostWithPort = $host;
    if ($port !== null && $port > 0) {
        $hostWithPort .= ':' . $port;
    }

    return [
        'scheme' => $scheme,
        'host' => $hostWithPort,
        'path' => $path,
        'url' => $scheme . '://' . $hostWithPort . $path . $query,
    ];
}

function extract_ai_text(array $payload): string
{
    $choices = $payload['choices'] ?? null;
    if (is_array($choices) && isset($choices[0]) && is_array($choices[0])) {
        $messageContent = $choices[0]['message']['content'] ?? null;
        if (is_string($messageContent) && trim($messageContent) !== '') {
            return trim($messageContent);
        }
        if (is_array($messageContent)) {
            $parts = [];
            foreach ($messageContent as $part) {
                if (is_string($part) && trim($part) !== '') {
                    $parts[] = trim($part);
                    continue;
                }
                if (is_array($part) && isset($part['text']) && is_string($part['text']) && trim($part['text']) !== '') {
                    $parts[] = trim($part['text']);
                }
            }
            if (count($parts) > 0) {
                return trim(implode("\n", $parts));
            }
        }
        $legacyText = $choices[0]['text'] ?? null;
        if (is_string($legacyText) && trim($legacyText) !== '') {
            return trim($legacyText);
        }
    }

    $outputText = $payload['output_text'] ?? null;
    if (is_string($outputText) && trim($outputText) !== '') {
        return trim($outputText);
    }

    $output = $payload['output'] ?? null;
    if (is_array($output)) {
        $parts = [];
        foreach ($output as $item) {
            if (!is_array($item)) {
                continue;
            }
            if (isset($item['text']) && is_string($item['text']) && trim($item['text']) !== '') {
                $parts[] = trim($item['text']);
            }
            $content = $item['content'] ?? null;
            if (!is_array($content)) {
                continue;
            }
            foreach ($content as $part) {
                if (!is_array($part)) {
                    continue;
                }
                $text = $part['text'] ?? null;
                if (is_string($text) && trim($text) !== '') {
                    $parts[] = trim($text);
                }
            }
        }
        if (count($parts) > 0) {
            return trim(implode("\n", $parts));
        }
    }

    return '';
}

function read_json_body()
{
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return [];
    }
    $decoded = json_decode($raw, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        send_json(400, ['message' => 'Request body must be valid JSON']);
        exit;
    }
    return $decoded;
}

function read_config(): array
{
    ensure_config_file();
    $raw = @file_get_contents(config_file_path());
    if ($raw === false || trim($raw) === '') {
        return normalize_config([]);
    }
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        return normalize_config([]);
    }
    return normalize_config($decoded);
}

function write_config(array $config): array
{
    $normalized = normalize_config($config);
    $json = json_encode($normalized, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($json === false) {
        throw new RuntimeException('Failed to encode config JSON');
    }
    $configPath = config_file_path();
    ensure_parent_dir_exists($configPath);
    $ok = file_put_contents($configPath, $json . PHP_EOL, LOCK_EX);
    if ($ok === false) {
        throw new RuntimeException('Failed to write config file');
    }
    return $normalized;
}

function update_config(array $patch): array
{
    $current = read_config();
    foreach (array_keys(DEFAULT_CONFIG) as $key) {
        if (array_key_exists($key, $patch) && $patch[$key] !== null) {
            $current[$key] = $patch[$key];
        }
    }
    return write_config($current);
}

function ensure_config_file(): void
{
    $configPath = config_file_path();
    if (file_exists($configPath)) {
        return;
    }
    write_config(DEFAULT_CONFIG);
}

function config_file_path(): string
{
    $envPath = trim((string)(getenv('ASR_CONFIG_FILE') ?: ''));
    if ($envPath !== '') {
        return $envPath;
    }
    return __DIR__ . DIRECTORY_SEPARATOR . 'app_config.json';
}

function ensure_parent_dir_exists(string $filePath): void
{
    $dir = dirname($filePath);
    if ($dir === '' || $dir === '.' || $dir === DIRECTORY_SEPARATOR) {
        return;
    }
    if (is_dir($dir)) {
        return;
    }
    if (!@mkdir($dir, 0700, true) && !is_dir($dir)) {
        throw new RuntimeException('Failed to create config directory: ' . $dir);
    }
}

function normalize_config(array $raw): array
{
    $merged = DEFAULT_CONFIG;
    foreach (array_keys(DEFAULT_CONFIG) as $key) {
        if (array_key_exists($key, $raw) && $raw[$key] !== null) {
            $merged[$key] = $raw[$key];
        }
    }
    return $merged;
}

function build_authorization(
    string $secretId,
    string $secretKey,
    string $host,
    string $path,
    int $timestamp,
    string $body
): string {
    $date = gmdate('Y-m-d', $timestamp);
    $signedHeaders = 'content-type;host';
    $hashedPayload = hash('sha256', $body);

    $canonicalHeaders = 'content-type:' . CONTENT_TYPE . "\n"
        . 'host:' . $host . "\n";

    $canonicalRequest = "POST\n"
        . $path . "\n\n"
        . $canonicalHeaders . "\n"
        . $signedHeaders . "\n"
        . $hashedPayload;

    $credentialScope = $date . '/' . API_SERVICE . '/tc3_request';
    $stringToSign = "TC3-HMAC-SHA256\n"
        . $timestamp . "\n"
        . $credentialScope . "\n"
        . hash('sha256', $canonicalRequest);

    $secretDate = hash_hmac('sha256', $date, 'TC3' . $secretKey, true);
    $secretService = hash_hmac('sha256', API_SERVICE, $secretDate, true);
    $secretSigning = hash_hmac('sha256', 'tc3_request', $secretService, true);
    $signature = hash_hmac('sha256', $stringToSign, $secretSigning);

    return 'TC3-HMAC-SHA256 '
        . 'Credential=' . $secretId . '/' . $credentialScope . ', '
        . 'SignedHeaders=' . $signedHeaders . ', '
        . 'Signature=' . $signature;
}

function send_cors_headers(): void
{
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Config-Token');
    header('Access-Control-Max-Age: 600');
}

function send_json(int $statusCode, array $payload): void
{
    http_response_code($statusCode);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}
