const STORAGE_KEY = "tencent-asr-config-v4";
const CONTENT_TYPE = "application/json; charset=utf-8";
const RECORDING_DATA_LIMIT = 5 * 1024 * 1024;
const CONFIG_SYNC_DEBOUNCE_MS = 600;
const PCM_WORKLET_FILE = "pcm-worklet.js";

const DEFAULT_CONFIG = {
  secretId: "",
  secretKey: "",
  apiEndpoint: "https://asr.tencentcloudapi.com",
  region: "ap-shanghai",
  proxyEndpoint: "api.php",
  configApiToken: "",
  callbackUrl: "",
  engineModelType: "16k_zh",
  channelNum: "1",
  resTextFormat: "0",
  pollIntervalMs: "2000",
  pollTimeoutSec: "600",
  voiceUrl: "",
  taskId: "",
  aiRelayEndpoint: "",
  aiApiKey: "",
  aiModel: "codex-mini-latest",
  aiPromptTemplate:
    "You are an ASR post-processing assistant. Keep the original meaning, fix obvious typos, add punctuation, and format with clear paragraphs.\n\nOriginal text:\n{{text}}",
  aiAutoPostProcess: false
};

const TASK_STATUS_MAP = {
  0: "Queued",
  1: "Processing",
  2: "Succeeded",
  3: "Failed"
};

const refs = {
  secretId: document.getElementById("secretId"),
  secretKey: document.getElementById("secretKey"),
  apiEndpoint: document.getElementById("apiEndpoint"),
  region: document.getElementById("region"),
  proxyEndpoint: document.getElementById("proxyEndpoint"),
  configApiToken: document.getElementById("configApiToken"),
  loadConfigFileBtn: document.getElementById("loadConfigFileBtn"),
  saveConfigFileBtn: document.getElementById("saveConfigFileBtn"),
  callbackUrl: document.getElementById("callbackUrl"),
  engineModelType: document.getElementById("engineModelType"),
  channelNum: document.getElementById("channelNum"),
  resTextFormat: document.getElementById("resTextFormat"),
  pollIntervalMs: document.getElementById("pollIntervalMs"),
  pollTimeoutSec: document.getElementById("pollTimeoutSec"),
  voiceUrl: document.getElementById("voiceUrl"),
  taskId: document.getElementById("taskId"),
  recordBtn: document.getElementById("recordBtn"),
  recordTimer: document.getElementById("recordTimer"),
  audioPreview: document.getElementById("audioPreview"),
  clearAudioBtn: document.getElementById("clearAudioBtn"),
  transcribeBtn: document.getElementById("transcribeBtn"),
  queryTaskBtn: document.getElementById("queryTaskBtn"),
  status: document.getElementById("status"),
  aiRelayEndpoint: document.getElementById("aiRelayEndpoint"),
  aiApiKey: document.getElementById("aiApiKey"),
  aiModel: document.getElementById("aiModel"),
  aiPromptTemplate: document.getElementById("aiPromptTemplate"),
  aiAutoPostProcess: document.getElementById("aiAutoPostProcess"),
  runAiBtn: document.getElementById("runAiBtn"),
  resultText: document.getElementById("resultText"),
  aiResultText: document.getElementById("aiResultText"),
  rawJson: document.getElementById("rawJson"),
  aiRawJson: document.getElementById("aiRawJson")
};

let isRecording = false;
let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let workletNode = null;
let processorNode = null;
let pcmChunks = [];
let currentRecordingBlob = null;
let currentRecordingUrl = "";
let recordTimerId = null;
let recordStartMs = 0;
let saveConfigTimerId = null;

init();

async function init() {
  loadConfig();
  bindEvents();
  refs.audioPreview.style.display = "none";
  setStatus("Ready. Confirm Apache/PHP is reachable, then start.");
  await pullConfigFromFile({ silent: true });
}

function bindEvents() {
  [
    refs.secretId,
    refs.secretKey,
    refs.apiEndpoint,
    refs.region,
    refs.proxyEndpoint,
    refs.configApiToken,
    refs.callbackUrl,
    refs.engineModelType,
    refs.channelNum,
    refs.resTextFormat,
    refs.pollIntervalMs,
    refs.pollTimeoutSec,
    refs.voiceUrl,
    refs.taskId,
    refs.aiRelayEndpoint,
    refs.aiApiKey,
    refs.aiModel,
    refs.aiPromptTemplate,
    refs.aiAutoPostProcess
  ].forEach((el) => {
    if (!el) {
      return;
    }
    el.addEventListener("input", saveConfig);
    el.addEventListener("change", saveConfig);
  });

  refs.recordBtn.addEventListener("click", async () => {
    if (isRecording) {
      await stopRecording();
    } else {
      await startRecording();
    }
  });

  refs.clearAudioBtn.addEventListener("click", () => {
    clearRecording();
    setStatus("Recording cleared.");
  });

  refs.transcribeBtn.addEventListener("click", async () => {
    await submitAndPoll();
  });

  refs.queryTaskBtn.addEventListener("click", async () => {
    await queryTaskOnly();
  });

  refs.runAiBtn.addEventListener("click", async () => {
    try {
      await runAiPostProcess();
    } catch (err) {
      setStatus(normalizeErrorMessage(err), "error");
    }
  });

  refs.loadConfigFileBtn.addEventListener("click", async () => {
    try {
      await pullConfigFromFile({ silent: false });
    } catch (err) {
      setStatus(normalizeErrorMessage(err), "error");
    }
  });

  refs.saveConfigFileBtn.addEventListener("click", async () => {
    try {
      const config = collectConfigFromRefs();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      await pushConfigToFile(config, { silent: false });
      setStatus("Config written to app_config.json.", "ok");
    } catch (err) {
      setStatus(normalizeErrorMessage(err), "error");
    }
  });
}

function loadConfig() {
  const raw = localStorage.getItem(STORAGE_KEY);
  const config = raw ? { ...DEFAULT_CONFIG, ...safeJsonParse(raw) } : DEFAULT_CONFIG;
  applyConfigToRefs(config);
}

function saveConfig() {
  const config = collectConfigFromRefs();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  queueConfigFileSync(config);
}

function collectConfigFromRefs() {
  return {
    secretId: refs.secretId.value.trim(),
    secretKey: refs.secretKey.value.trim(),
    apiEndpoint: refs.apiEndpoint.value.trim(),
    region: refs.region.value.trim(),
    proxyEndpoint: normalizeProxyEndpoint(refs.proxyEndpoint.value.trim()),
    configApiToken: refs.configApiToken.value.trim(),
    callbackUrl: refs.callbackUrl.value.trim(),
    engineModelType: refs.engineModelType.value,
    channelNum: refs.channelNum.value,
    resTextFormat: refs.resTextFormat.value,
    pollIntervalMs: refs.pollIntervalMs.value.trim(),
    pollTimeoutSec: refs.pollTimeoutSec.value.trim(),
    voiceUrl: refs.voiceUrl.value.trim(),
    taskId: refs.taskId.value.trim(),
    aiRelayEndpoint: refs.aiRelayEndpoint.value.trim(),
    aiApiKey: refs.aiApiKey.value.trim(),
    aiModel: refs.aiModel.value.trim(),
    aiPromptTemplate: refs.aiPromptTemplate.value,
    aiAutoPostProcess: refs.aiAutoPostProcess.checked
  };
}

function applyConfigToRefs(config) {
  refs.secretId.value = config.secretId ?? DEFAULT_CONFIG.secretId;
  refs.secretKey.value = config.secretKey ?? DEFAULT_CONFIG.secretKey;
  refs.apiEndpoint.value = config.apiEndpoint ?? DEFAULT_CONFIG.apiEndpoint;
  refs.region.value = config.region ?? DEFAULT_CONFIG.region;
  refs.proxyEndpoint.value = normalizeProxyEndpoint(config.proxyEndpoint ?? DEFAULT_CONFIG.proxyEndpoint);
  refs.configApiToken.value = config.configApiToken ?? DEFAULT_CONFIG.configApiToken;
  refs.callbackUrl.value = config.callbackUrl ?? DEFAULT_CONFIG.callbackUrl;
  refs.engineModelType.value = config.engineModelType ?? DEFAULT_CONFIG.engineModelType;
  refs.channelNum.value = config.channelNum ?? DEFAULT_CONFIG.channelNum;
  refs.resTextFormat.value = config.resTextFormat ?? DEFAULT_CONFIG.resTextFormat;
  refs.pollIntervalMs.value = config.pollIntervalMs ?? DEFAULT_CONFIG.pollIntervalMs;
  refs.pollTimeoutSec.value = config.pollTimeoutSec ?? DEFAULT_CONFIG.pollTimeoutSec;
  refs.voiceUrl.value = config.voiceUrl ?? DEFAULT_CONFIG.voiceUrl;
  refs.taskId.value = config.taskId ?? DEFAULT_CONFIG.taskId;
  refs.aiRelayEndpoint.value = config.aiRelayEndpoint ?? DEFAULT_CONFIG.aiRelayEndpoint;
  refs.aiApiKey.value = config.aiApiKey ?? DEFAULT_CONFIG.aiApiKey;
  refs.aiModel.value = config.aiModel ?? DEFAULT_CONFIG.aiModel;
  refs.aiPromptTemplate.value = config.aiPromptTemplate ?? DEFAULT_CONFIG.aiPromptTemplate;
  refs.aiAutoPostProcess.checked = toBoolean(config.aiAutoPostProcess, DEFAULT_CONFIG.aiAutoPostProcess);
}

function normalizeProxyEndpoint(input) {
  const raw = (input || "").trim();
  if (!raw) {
    return DEFAULT_CONFIG.proxyEndpoint;
  }
  if (raw === "/api.php") {
    return "api.php";
  }
  try {
    const url = new URL(raw, window.location.href);
    if (/\/api\/(asr|config|ai)\/?$/i.test(url.pathname)) {
      url.pathname = "/api.php";
      url.search = "";
    }
    if (/^https?:\/\//i.test(raw)) {
      if (url.origin === window.location.origin && url.pathname === "/api.php") {
        return "api.php";
      }
      return url.toString();
    }
    if (raw.startsWith("/")) {
      return `${url.pathname}${url.search}`;
    }
    return raw;
  } catch {
    return DEFAULT_CONFIG.proxyEndpoint;
  }
}

function queueConfigFileSync(config) {
  clearTimeout(saveConfigTimerId);
  saveConfigTimerId = setTimeout(async () => {
    try {
      await pushConfigToFile(config, { silent: true });
    } catch {
      // ignore silent sync failures
    }
  }, CONFIG_SYNC_DEBOUNCE_MS);
}

function isLocalBrowserSession() {
  const host = window.location.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function canAccessConfigRouteFromBrowser() {
  if (isLocalBrowserSession()) {
    return true;
  }
  return Boolean((refs.configApiToken?.value || "").trim());
}

function configRouteDeniedMessage() {
  return "Config route is protected. Fill 'Config API Token' to access route=config from remote browser.";
}

function buildServerConfigPayload(config) {
  const payload = { ...config };
  delete payload.configApiToken;
  return payload;
}

function buildPhpApiEndpointCandidates(route) {
  const proxyEndpoint = refs.proxyEndpoint.value.trim();
  if (!proxyEndpoint) {
    throw new Error("PHP API Endpoint cannot be empty.");
  }
  const normalized = normalizeProxyEndpoint(proxyEndpoint);
  const candidates = [];

  const pushCandidate = (baseEndpoint) => {
    try {
      const url = new URL(baseEndpoint, window.location.href);
      url.searchParams.set("route", route);
      const full = url.toString();
      if (!candidates.includes(full)) {
        candidates.push(full);
      }
    } catch {
      // ignore invalid candidate
    }
  };

  pushCandidate(normalized);
  pushCandidate("api.php");
  pushCandidate("/api.php");

  if (!candidates.length) {
    throw new Error("PHP API Endpoint is not a valid URL.");
  }
  return candidates;
}

async function requestPhpApi(route, { method = "GET", payload = undefined } = {}) {
  const endpoints = buildPhpApiEndpointCandidates(route);
  let lastTypeError = null;
  let lastNotFound = null;

  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      const headers = { "Content-Type": CONTENT_TYPE };
      if (route === "config") {
        const token = (refs.configApiToken?.value || "").trim();
        if (token) {
          headers["X-Config-Token"] = token;
        }
      }
      const requestOptions = {
        method,
        headers,
        signal: controller.signal
      };
      if (payload !== undefined) {
        requestOptions.body = JSON.stringify(payload);
      }
      const response = await fetch(endpoint, requestOptions);
      const text = await response.text();
      const json = safeJsonParse(text);

      if (response.status === 404) {
        lastNotFound = { endpoint, text, json };
        continue;
      }
      return { endpoint, response, text, json };
    } catch (err) {
      if (err?.name === "AbortError") {
        throw err;
      }
      if (err instanceof TypeError) {
        lastTypeError = err;
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (lastTypeError) {
    throw lastTypeError;
  }
  if (lastNotFound) {
    const message = lastNotFound.json?.message || lastNotFound.text || `Endpoint not found: ${lastNotFound.endpoint}`;
    throw new Error(`HTTP 404: ${message}`);
  }
  throw new Error("PHP API request failed.");
}

async function pullConfigFromFile({ silent = false } = {}) {
  if (!canAccessConfigRouteFromBrowser()) {
    if (silent) {
      return false;
    }
    throw new Error(configRouteDeniedMessage());
  }

  try {
    const { response, text, json } = await requestPhpApi("config", { method: "GET" });
    if (!response.ok) {
      const message = json?.message || text || "Failed to read config file";
      if (silent) {
        return false;
      }
      throw new Error(`Read config failed: ${message}`);
    }

    const currentToken = (refs.configApiToken?.value || "").trim();
    const config = { ...DEFAULT_CONFIG, ...json, configApiToken: currentToken };
    applyConfigToRefs(config);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    if (!silent) {
      setStatus("Config loaded from file.", "ok");
    }
    return true;
  } catch (err) {
    if (silent) {
      return false;
    }
    if (err instanceof TypeError) {
      throw new Error("Cannot connect to PHP API while reading config.");
    }
    throw err;
  }
}

async function pushConfigToFile(config, { silent = true } = {}) {
  if (!canAccessConfigRouteFromBrowser()) {
    if (silent) {
      return false;
    }
    throw new Error(configRouteDeniedMessage());
  }

  try {
    const payload = buildServerConfigPayload(config);
    const { response, text, json } = await requestPhpApi("config", {
      method: "POST",
      payload
    });
    if (!response.ok) {
      const message = json?.message || text || "Failed to write config file";
      if (silent) {
        return false;
      }
      throw new Error(`Write config failed: ${message}`);
    }
    return true;
  } catch (err) {
    if (silent) {
      return false;
    }
    if (err instanceof TypeError) {
      throw new Error("Cannot connect to PHP API while writing config.");
    }
    throw err;
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function setStatus(message, type = "") {
  refs.status.className = `status ${type}`.trim();
  refs.status.textContent = message;
}

function updateRecordTimer() {
  const elapsed = Math.floor((Date.now() - recordStartMs) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  refs.recordTimer.textContent = `${mm}:${ss}`;
}

function startRecordTimer() {
  recordStartMs = Date.now();
  updateRecordTimer();
  recordTimerId = setInterval(updateRecordTimer, 1000);
}

function stopRecordTimer() {
  clearInterval(recordTimerId);
  recordTimerId = null;
  refs.recordTimer.textContent = "00:00";
}

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("This browser does not support recording. Use latest Chrome/Safari.", "error");
    return;
  }

  try {
    clearRecording();
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume();
    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    pcmChunks = [];

    let usingFallbackProcessor = true;
    if (audioContext.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      try {
        const workletUrl = new URL(PCM_WORKLET_FILE, window.location.href).toString();
        await audioContext.audioWorklet.addModule(workletUrl);
        workletNode = new AudioWorkletNode(audioContext, "pcm-recorder", {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 1
        });
        workletNode.port.onmessage = (evt) => {
          const samples = evt?.data?.samples;
          if (samples) {
            pcmChunks.push(new Float32Array(samples));
          }
        };
        sourceNode.connect(workletNode);
        usingFallbackProcessor = false;
      } catch {
        workletNode = null;
      }
    }

    if (usingFallbackProcessor) {
      processorNode = audioContext.createScriptProcessor(4096, 1, 1);
      processorNode.onaudioprocess = (evt) => {
        const input = evt.inputBuffer.getChannelData(0);
        pcmChunks.push(new Float32Array(input));
      };
      sourceNode.connect(processorNode);
      processorNode.connect(audioContext.destination);
    }

    isRecording = true;
    refs.recordBtn.textContent = "Stop Recording";
    refs.recordBtn.classList.add("recording");
    startRecordTimer();
    setStatus("Recording... click again to stop.");
  } catch (err) {
    setStatus(`Cannot start recording: ${err.message}`, "error");
    cleanupAudioGraph();
  }
}

async function stopRecording() {
  if (!isRecording) {
    return;
  }
  isRecording = false;

  const sampleRate = audioContext ? audioContext.sampleRate : 16000;
  cleanupAudioGraph();
  stopRecordTimer();

  if (!pcmChunks.length) {
    setRecordUiIdle();
    setStatus("No audio data captured. Please retry.", "error");
    return;
  }

  currentRecordingBlob = encodeWavBlob(pcmChunks, sampleRate);
  currentRecordingUrl = URL.createObjectURL(currentRecordingBlob);
  refs.audioPreview.src = currentRecordingUrl;
  refs.audioPreview.style.display = "block";

  setRecordUiIdle();
  setStatus("Recording completed. WAV generated.");
}

function setRecordUiIdle() {
  refs.recordBtn.textContent = "Start Recording";
  refs.recordBtn.classList.remove("recording");
}

function cleanupAudioGraph() {
  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }
  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
}

function clearRecording() {
  if (isRecording) {
    cleanupAudioGraph();
    stopRecordTimer();
    isRecording = false;
    setRecordUiIdle();
  }
  currentRecordingBlob = null;
  if (currentRecordingUrl) {
    URL.revokeObjectURL(currentRecordingUrl);
    currentRecordingUrl = "";
  }
  refs.audioPreview.removeAttribute("src");
  refs.audioPreview.load();
  refs.audioPreview.style.display = "none";
}

async function submitAndPoll() {
  refs.transcribeBtn.disabled = true;
  refs.queryTaskBtn.disabled = true;
  refs.runAiBtn.disabled = true;
  refs.resultText.value = "";
  refs.aiResultText.value = "";
  refs.rawJson.value = "";
  refs.aiRawJson.value = "";

  try {
    const payload = await buildCreateTaskPayload();
    setStatus("Submitting ASR task (CreateRecTask)...");

    const createResponse = await callTencentAsr("CreateRecTask", payload);
    const taskId = createResponse?.Response?.Data?.TaskId;
    if (!taskId) {
      throw new Error("CreateRecTask succeeded but TaskId is missing.");
    }

    refs.taskId.value = String(taskId);
    saveConfig();
    setStatus(`Task submitted, TaskId=${taskId}. Polling...`);

    const pollingResult = await pollUntilFinished(taskId);
    const recognizedText = renderTaskResult(pollingResult.finalResponse, {
      createResponse,
      pollTrace: pollingResult.pollTrace
    });

    if (refs.aiAutoPostProcess.checked && recognizedText) {
      try {
        await runAiPostProcess({
          sourceText: recognizedText,
          silentStatus: false
        });
      } catch (aiErr) {
        setStatus(`ASR succeeded but AI post-process failed: ${normalizeErrorMessage(aiErr)}`, "warn");
      }
    }
  } catch (err) {
    setStatus(normalizeErrorMessage(err), "error");
  } finally {
    refs.transcribeBtn.disabled = false;
    refs.queryTaskBtn.disabled = false;
    refs.runAiBtn.disabled = false;
  }
}

async function queryTaskOnly() {
  refs.queryTaskBtn.disabled = true;
  refs.transcribeBtn.disabled = true;

  try {
    const taskId = parseTaskId(refs.taskId.value.trim());
    setStatus(`Querying TaskId=${taskId} (DescribeTaskStatus)...`);
    const response = await callTencentAsr("DescribeTaskStatus", { TaskId: taskId });
    renderTaskResult(response);
  } catch (err) {
    setStatus(normalizeErrorMessage(err), "error");
  } finally {
    refs.queryTaskBtn.disabled = false;
    refs.transcribeBtn.disabled = false;
  }
}

async function buildCreateTaskPayload() {
  assertBaseConfigReady();

  const payload = {
    EngineModelType: refs.engineModelType.value,
    ChannelNum: Number(refs.channelNum.value),
    ResTextFormat: Number(refs.resTextFormat.value)
  };

  const callbackUrl = refs.callbackUrl.value.trim();
  if (callbackUrl) {
    payload.CallbackUrl = callbackUrl;
  }

  const voiceUrl = refs.voiceUrl.value.trim();
  if (voiceUrl) {
    payload.SourceType = 0;
    payload.Url = voiceUrl;
    return payload;
  }

  if (!currentRecordingBlob) {
    throw new Error("Please record first, or provide VoiceUrl.");
  }

  if (currentRecordingBlob.size > RECORDING_DATA_LIMIT) {
    throw new Error("Recording exceeds 5MB. Please use VoiceUrl mode.");
  }

  setStatus("Converting recording to Base64...");
  payload.SourceType = 1;
  payload.DataLen = currentRecordingBlob.size;
  payload.Data = await blobToBase64(currentRecordingBlob);
  return payload;
}

function assertBaseConfigReady() {
  const proxyEndpoint = refs.proxyEndpoint.value.trim();
  const apiEndpoint = refs.apiEndpoint.value.trim();
  const region = refs.region.value.trim();

  if (!proxyEndpoint) {
    throw new Error("PHP API Endpoint is required.");
  }
  try {
    new URL(proxyEndpoint, window.location.href);
  } catch {
    throw new Error("PHP API Endpoint is not a valid URL.");
  }

  if (!apiEndpoint || !region) {
    throw new Error("Please provide ASR API Endpoint and Region.");
  }
  try {
    new URL(apiEndpoint);
  } catch {
    throw new Error("ASR API Endpoint is not a valid URL.");
  }
}

async function pollUntilFinished(taskId) {
  const pollIntervalMs = Math.max(500, safePositiveInt(refs.pollIntervalMs.value, 2000));
  const pollTimeoutMs = Math.max(10000, safePositiveInt(refs.pollTimeoutSec.value, 600) * 1000);
  const startedAt = Date.now();
  const pollTrace = [];

  while (true) {
    const response = await callTencentAsr("DescribeTaskStatus", { TaskId: taskId });
    const data = response?.Response?.Data || {};
    const statusCode = Number(data?.Status);
    const statusLabel = statusText(data);

    pollTrace.push({
      at: new Date().toISOString(),
      status: Number.isNaN(statusCode) ? null : statusCode,
      statusStr: data?.StatusStr || ""
    });

    if (statusCode === 2) {
      setStatus(`Task ${taskId} completed.`, "ok");
      return { finalResponse: response, pollTrace };
    }

    if (statusCode === 3) {
      const errMsg = data?.ErrorMsg || data?.FailedDescription || "ASR task failed";
      throw new Error(`Task ${taskId} failed: ${errMsg}`);
    }

    if (Date.now() - startedAt > pollTimeoutMs) {
      throw new Error(`Task ${taskId} timed out. Query with TaskId later.`);
    }

    setStatus(`Task ${taskId} status: ${statusLabel}. Retry in ${Math.round(pollIntervalMs / 1000)}s...`, "warn");
    await sleep(pollIntervalMs);
  }
}

function renderTaskResult(response, extra = null) {
  const data = response?.Response?.Data || {};
  const statusCode = Number(data?.Status);
  const text = extractText(data);

  refs.resultText.value = text || "";

  if (statusCode === 2) {
    setStatus("ASR succeeded.", "ok");
  } else if (statusCode === 3) {
    setStatus(`ASR failed: ${data?.ErrorMsg || "Unknown error"}`, "error");
  } else {
    setStatus(`Task state: ${statusText(data)}. You can continue querying.`, "warn");
  }

  if (extra) {
    refs.rawJson.value = JSON.stringify(
      {
        createResponse: extra.createResponse,
        finalStatusResponse: response,
        pollTrace: extra.pollTrace
      },
      null,
      2
    );
  } else {
    refs.rawJson.value = JSON.stringify(response, null, 2);
  }

  return text;
}

function statusText(taskData) {
  const code = Number(taskData?.Status);
  const label = taskData?.StatusStr || TASK_STATUS_MAP[code] || "Unknown";
  if (Number.isNaN(code)) {
    return label;
  }
  return `${label} (${code})`;
}

function extractText(taskData) {
  const result = typeof taskData?.Result === "string" ? taskData.Result.trim() : "";
  if (result) {
    return result;
  }

  if (!Array.isArray(taskData?.ResultDetail)) {
    return "";
  }

  const lines = [];
  for (const item of taskData.ResultDetail) {
    const sentence = firstNonEmpty(
      item?.FinalSentence,
      item?.SliceSentence,
      item?.Sentence,
      item?.Text
    );
    if (!sentence) {
      continue;
    }
    if (typeof item?.SpeakerId === "number") {
      lines.push(`[spk${item.SpeakerId}] ${sentence.trim()}`);
    } else {
      lines.push(sentence.trim());
    }
  }

  return lines.join("\n");
}

function firstNonEmpty(...arr) {
  for (const value of arr) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

async function callTencentAsr(action, payload) {
  assertBaseConfigReady();
  return callTencentAsrViaPhp(action, payload);
}

async function callTencentAsrViaPhp(action, payload) {
  const requestBody = {
    action,
    payload,
    endpoint: refs.apiEndpoint.value.trim(),
    region: refs.region.value.trim(),
    secretId: refs.secretId.value.trim() || undefined,
    secretKey: refs.secretKey.value.trim() || undefined
  };

  const { response, text, json } = await requestPhpApi("asr", {
    method: "POST",
    payload: requestBody
  });
  if (!response.ok) {
    const message = json?.message || text || "PHP API request failed";
    throw new Error(`HTTP ${response.status}: ${message}`);
  }

  const err = json?.Response?.Error;
  if (err?.Code) {
    throw new Error(`[${err.Code}] ${err.Message || "ASR API failed"}`);
  }

  return json;
}

async function runAiPostProcess({ sourceText = "", silentStatus = false } = {}) {
  const textToProcess = (sourceText || refs.resultText.value || "").trim();
  if (!textToProcess) {
    throw new Error("No ASR text available for AI post-processing.");
  }

  assertAiConfigReady();

  const template = refs.aiPromptTemplate.value || "";
  const prompt = buildAiPrompt(template, textToProcess);
  const requestBody = {
    endpoint: refs.aiRelayEndpoint.value.trim(),
    apiKey: refs.aiApiKey.value.trim() || undefined,
    model: refs.aiModel.value.trim(),
    prompt
  };

  const previousDisabled = refs.runAiBtn.disabled;
  refs.runAiBtn.disabled = true;

  if (!silentStatus) {
    setStatus("Calling CODEX API for post-processing...");
  }

  try {
    const { response, text, json } = await requestPhpApi("ai", {
      method: "POST",
      payload: requestBody
    });
    if (!response.ok) {
      const message = json?.message || text || "AI request failed";
      throw new Error(`HTTP ${response.status}: ${message}`);
    }

    const aiText = extractAiResponseText(json);
    if (!aiText) {
      throw new Error("AI returned no parseable text.");
    }

    refs.aiResultText.value = aiText;
    refs.aiRawJson.value = JSON.stringify(json, null, 2);
    setStatus("AI post-processing completed.", "ok");
    return aiText;
  } finally {
    refs.runAiBtn.disabled = previousDisabled;
  }
}

function assertAiConfigReady() {
  const endpoint = refs.aiRelayEndpoint.value.trim();
  const model = refs.aiModel.value.trim();
  const promptTemplate = refs.aiPromptTemplate.value.trim();

  if (!endpoint) {
    throw new Error("AI relay endpoint is required.");
  }
  try {
    new URL(endpoint);
  } catch {
    throw new Error("AI relay endpoint is not a valid URL.");
  }

  if (!model) {
    throw new Error("AI model is required.");
  }

  if (!promptTemplate) {
    throw new Error("AI prompt template is required.");
  }
}

function buildAiPrompt(template, text) {
  if (template.includes("{{text}}")) {
    return template.split("{{text}}").join(text);
  }
  const base = template.trim();
  return `${base}\n\nOriginal ASR text:\n${text}`;
}

function extractAiResponseText(payload) {
  if (typeof payload?.text === "string" && payload.text.trim()) {
    return payload.text.trim();
  }

  const response = payload?.response || payload;
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (typeof part?.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("")
      .trim();
    if (text) {
      return text;
    }
  }

  const legacyText = response?.choices?.[0]?.text;
  if (typeof legacyText === "string" && legacyText.trim()) {
    return legacyText.trim();
  }

  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  if (Array.isArray(response?.output)) {
    const chunks = [];
    for (const item of response.output) {
      if (typeof item?.text === "string" && item.text.trim()) {
        chunks.push(item.text.trim());
      }
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === "string" && part.text.trim()) {
            chunks.push(part.text.trim());
          }
        }
      }
    }
    if (chunks.length) {
      return chunks.join("\n");
    }
  }

  return "";
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  return arrayBufferToBase64(buffer);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function parseTaskId(input) {
  const taskId = Number(input);
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new Error("TaskId must be a positive integer.");
  }
  return taskId;
}

function safePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.floor(n);
}

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off", ""].includes(normalized)) {
      return false;
    }
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  return Boolean(fallback);
}

function normalizeErrorMessage(err) {
  if (err?.name === "AbortError") {
    return "Request timed out. Check network and retry.";
  }
  if (typeof err?.message === "string" && err.message.includes("Forbidden config access")) {
    return "Config API is protected. Set 'Config API Token' to match server CONFIG_API_TOKEN.";
  }
  if (typeof err?.message === "string" && err.message.includes("HTTP 404")) {
    return "Cannot find api.php. Check PHP API Endpoint path.";
  }
  if (err instanceof TypeError) {
    return "Cannot connect to PHP API. Confirm Apache/PHP and api.php.";
  }
  return err?.message || "Unknown error";
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function encodeWavBlob(floatBlocks, sampleRate) {
  const samples = mergeFloat32(floatBlocks);
  const pcm16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    pcm16[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }

  const dataSize = pcm16.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < pcm16.length; i += 1) {
    view.setInt16(offset, pcm16[i], true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function mergeFloat32(blocks) {
  let total = 0;
  for (const block of blocks) {
    total += block.length;
  }
  const merged = new Float32Array(total);
  let offset = 0;
  for (const block of blocks) {
    merged.set(block, offset);
    offset += block.length;
  }
  return merged;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
