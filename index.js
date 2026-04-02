const CONTENT_TYPE = "application/json; charset=utf-8";
const STORAGE_KEY = "liubao-walkthrough-records-v1";
const PCM_WORKLET_FILE = "pcm-worklet.js";
const RECORDING_DATA_LIMIT = 5 * 1024 * 1024;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const RECORDING_SAFETY_TIMEOUT_MS = 2 * 60 * 1000;
const GEO_LOOKUP_TIMEOUT_MS = 8000;
const AUTH_SUBMIT_DEFAULT_TEXT = "\u9a8c\u8bc1\u5e76\u8fdb\u5165";

const refs = {
  authGate: document.getElementById("authGate"),
  mainApp: document.getElementById("mainApp"),
  recordBtn: document.getElementById("recordBtn"),
  recordHint: document.getElementById("recordHint"),
  status: document.getElementById("status"),
  exportBtn: document.getElementById("exportBtn"),
  clearBtn: document.getElementById("clearBtn"),
  recordList: document.getElementById("recordList"),
  emptyView: document.getElementById("emptyView"),
  authForm: document.getElementById("authForm"),
  authCodeInput: document.getElementById("authCodeInput"),
  authSubmitBtn: document.getElementById("authSubmitBtn"),
  authMessage: document.getElementById("authMessage"),
  logoutBtn: document.getElementById("logoutBtn")
};

const workflows = new Map();
let records = [];
let listGeneration = 0;

let isRecording = false;
let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let workletNode = null;
let processorNode = null;
let pcmChunks = [];
let activePointerId = null;
let isPressActive = false;
let isStartingRecording = false;
let pendingStopAfterStart = false;
let isFinalizingRecording = false;
let recordingSafetyTimerId = null;
let pendingRecordContext = null;
let appInitialized = false;
let isAuthSubmitting = false;

void bootstrap();

async function bootstrap() {
  bindAuthEvents();
  setAuthFormBusy(true);
  setAuthMessage("\u6b63\u5728\u68c0\u67e5\u6388\u6743\u72b6\u6001...", "");

  const authorized = await fetchAuthorizationStatus();
  setAuthFormBusy(false);

  if (authorized) {
    unlockApp();
    return;
  }

  lockApp("\u8bf7\u8f93\u5165\u6388\u6743\u7801\u4ee5\u7ee7\u7eed\u3002");
}

function init() {
  if (appInitialized) {
    return;
  }
  appInitialized = true;

  loadRecords();
  bindEvents();
  renderList();
  setStatus("\u5c31\u7eea\u3002", "");
}

function bindAuthEvents() {
  if (refs.authForm) {
    refs.authForm.addEventListener("submit", onAuthSubmit);
  }
  if (refs.logoutBtn) {
    refs.logoutBtn.addEventListener("click", onLogoutClick);
  }
}

async function fetchAuthorizationStatus() {
  try {
    const { response, json } = await requestPhpApi("auth", { method: "GET" });
    return response.ok && json?.authorized === true;
  } catch {
    setAuthMessage("\u6388\u6743\u72b6\u6001\u68c0\u67e5\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002", "error");
    return false;
  }
}

async function onAuthSubmit(event) {
  event.preventDefault();
  if (isAuthSubmitting) {
    return;
  }

  const code = String(refs.authCodeInput?.value || "").trim();
  if (!code) {
    setAuthMessage("\u8bf7\u8f93\u5165\u6388\u6743\u7801\u3002", "error");
    refs.authCodeInput?.focus();
    return;
  }

  isAuthSubmitting = true;
  setAuthFormBusy(true);
  setAuthMessage("\u6b63\u5728\u9a8c\u8bc1...", "");

  try {
    const { response, json } = await requestPhpApi("auth", {
      method: "POST",
      payload: {
        action: "login",
        code
      }
    });

    if (response.ok && json?.authorized === true) {
      unlockApp();
      return;
    }

    setAuthMessage(String(json?.message || "\u6388\u6743\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5\u3002"), "error");
    refs.authCodeInput?.focus();
    refs.authCodeInput?.select();
  } catch {
    setAuthMessage("\u7f51\u7edc\u5f02\u5e38\uff0c\u8bf7\u91cd\u8bd5\u3002", "error");
  } finally {
    isAuthSubmitting = false;
    setAuthFormBusy(false);
  }
}

async function onLogoutClick() {
  if (isRecording || isStartingRecording) {
    await requestStopRecording("manual_logout");
  }
  setAuthFormBusy(true);
  try {
    await requestPhpApi("auth", {
      method: "POST",
      payload: { action: "logout" }
    });
  } catch {
    // Ignore logout transport errors and force lock UI.
  } finally {
    setAuthFormBusy(false);
    lockApp("\u5df2\u9000\u51fa\u6388\u6743\uff0c\u8bf7\u91cd\u65b0\u8f93\u5165\u6388\u6743\u7801\u3002");
  }
}

function unlockApp() {
  document.body.classList.add("authed");
  refs.authGate?.setAttribute("hidden", "");
  refs.mainApp?.removeAttribute("hidden");
  if (refs.authCodeInput) {
    refs.authCodeInput.value = "";
  }
  setAuthMessage("", "");
  init();
}

function lockApp(message, type = "") {
  document.body.classList.remove("authed");
  refs.authGate?.removeAttribute("hidden");
  refs.mainApp?.setAttribute("hidden", "");
  setAuthMessage(message || "\u8bf7\u8f93\u5165\u6388\u6743\u7801\u4ee5\u7ee7\u7eed\u3002", type);
  if (refs.authCodeInput) {
    refs.authCodeInput.focus();
  }
}

function handleSessionExpired() {
  if (!document.body.classList.contains("authed")) {
    return;
  }
  if (isRecording || isStartingRecording) {
    void requestStopRecording("session_expired");
  }
  lockApp("\u6388\u6743\u72b6\u6001\u5df2\u5931\u6548\uff0c\u8bf7\u91cd\u65b0\u8f93\u5165\u6388\u6743\u7801\u3002", "error");
}

function setAuthFormBusy(isBusy) {
  if (refs.authCodeInput) {
    refs.authCodeInput.disabled = isBusy;
  }
  if (refs.authSubmitBtn) {
    refs.authSubmitBtn.disabled = isBusy;
    refs.authSubmitBtn.textContent = isBusy ? "\u9a8c\u8bc1\u4e2d..." : AUTH_SUBMIT_DEFAULT_TEXT;
  }
}

function bindEvents() {
  refs.recordBtn.addEventListener("pointerdown", onRecordPointerDown, { passive: false });
  refs.recordBtn.addEventListener("touchstart", onRecordTouchStart, { passive: false });
  refs.recordBtn.addEventListener("mousedown", onRecordMouseDown);
  refs.recordBtn.addEventListener("lostpointercapture", onPointerCaptureLost);
  refs.recordBtn.addEventListener("click", onRecordButtonClickFallback);

  window.addEventListener("pointerup", onGlobalPointerUp, true);
  window.addEventListener("pointercancel", onGlobalPointerCancel, true);
  window.addEventListener("touchend", onGlobalTouchEnd, true);
  window.addEventListener("touchcancel", onGlobalTouchCancel, true);
  window.addEventListener("mouseup", onGlobalMouseUp, true);
  window.addEventListener("blur", onWindowBlur, true);
  window.addEventListener("pagehide", onWindowPageHide, true);
  document.addEventListener("visibilitychange", onVisibilityChange, true);

  refs.exportBtn.addEventListener("click", onExportTxt);
  refs.clearBtn.addEventListener("click", onClearAll);
}

async function onRecordPointerDown(event) {
  if (event.button !== undefined && event.button !== 0) {
    return;
  }
  event.preventDefault();
  await beginPressToRecord("pointer", event.pointerId ?? null);
}

async function onRecordTouchStart(event) {
  if (window.PointerEvent) {
    return;
  }
  event.preventDefault();
  await beginPressToRecord("touch", null);
}

async function onRecordMouseDown(event) {
  if (window.PointerEvent) {
    return;
  }
  if (event.button !== undefined && event.button !== 0) {
    return;
  }
  event.preventDefault();
  await beginPressToRecord("mouse", null);
}

async function beginPressToRecord(inputType, pointerId) {
  if (isPressActive || isRecording || isStartingRecording || isFinalizingRecording) {
    return;
  }

  isPressActive = true;
  pendingStopAfterStart = false;
  activePointerId = pointerId;
  pendingRecordContext = createRecordContextAtPress();

  if (inputType === "pointer" && pointerId !== null) {
    try {
      refs.recordBtn.setPointerCapture(pointerId);
    } catch {
      // Ignore capture failure.
    }
  }

  isStartingRecording = true;
  try {
    await startRecording();
  } finally {
    isStartingRecording = false;
  }

  if (!isRecording) {
    resetPressSessionState();
    resetRecordButtonUi();
    return;
  }

  if (pendingStopAfterStart || !isPressActive) {
    await requestStopRecording("released_before_ready");
  }
}

async function requestStopRecording(reason) {
  if (isStartingRecording) {
    pendingStopAfterStart = true;
    isPressActive = false;
    return;
  }
  if (!isRecording || isFinalizingRecording) {
    isPressActive = false;
    return;
  }
  if (reason === "safety_timeout") {
    setStatus("\u5f55\u97f3\u8d85\u65f6\uff0c\u5df2\u81ea\u52a8\u505c\u6b62\u3002", "warn");
  } else if (["window_blur", "page_hide", "visibility_hidden"].includes(reason)) {
    setStatus("\u9875\u9762\u5207\u6362\uff0c\u5df2\u81ea\u52a8\u505c\u6b62\u5f55\u97f3\u3002", "warn");
  }
  isPressActive = false;
  await finalizeRecording();
}

async function onGlobalPointerUp(event) {
  if (!isPressActive && !isStartingRecording && !isRecording) {
    return;
  }
  if (activePointerId !== null && event.pointerId !== activePointerId) {
    return;
  }
  await requestStopRecording("pointer_up");
}

async function onGlobalPointerCancel(event) {
  if (!isPressActive && !isStartingRecording && !isRecording) {
    return;
  }
  if (activePointerId !== null && event.pointerId !== activePointerId) {
    return;
  }
  await requestStopRecording("pointer_cancel");
}

async function onGlobalTouchEnd() {
  if (!isPressActive && !isStartingRecording && !isRecording) {
    return;
  }
  await requestStopRecording("touch_end");
}

async function onGlobalTouchCancel() {
  if (!isPressActive && !isStartingRecording && !isRecording) {
    return;
  }
  await requestStopRecording("touch_cancel");
}

async function onGlobalMouseUp() {
  if (!isPressActive && !isStartingRecording && !isRecording) {
    return;
  }
  await requestStopRecording("mouse_up");
}

async function onPointerCaptureLost() {
  if (!isPressActive && !isStartingRecording && !isRecording) {
    return;
  }
  await requestStopRecording("lost_pointer_capture");
}

async function onRecordButtonClickFallback(event) {
  if (!isRecording && !isStartingRecording) {
    return;
  }
  event.preventDefault();
  await requestStopRecording("click_fallback");
}

async function onWindowBlur() {
  if (!isRecording && !isStartingRecording) {
    return;
  }
  await requestStopRecording("window_blur");
}

async function onWindowPageHide() {
  if (!isRecording && !isStartingRecording) {
    return;
  }
  await requestStopRecording("page_hide");
}

async function onVisibilityChange() {
  if (document.visibilityState !== "hidden") {
    return;
  }
  if (!isRecording && !isStartingRecording) {
    return;
  }
  await requestStopRecording("visibility_hidden");
}

async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u5f55\u97f3\u3002", "error");
    resetRecordButtonUi();
    return;
  }

  try {
    pcmChunks = [];
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume();
    sourceNode = audioContext.createMediaStreamSource(mediaStream);

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
    refs.recordBtn.classList.add("recording");
    refs.recordBtn.textContent = "\u6b63\u5728\u5f55\u97f3";
    refs.recordHint.textContent = "松手即为停止，如无响应，可再轻点一下以停止录制。";
    startRecordingSafetyTimer();
    setStatus("\u5f55\u97f3\u4e2d...", "warn");
  } catch (err) {
    setStatus(`\u5f00\u59cb\u5f55\u97f3\u5931\u8d25: ${normalizeErrorMessage(err)}`, "error");
    cleanupAudioGraph();
    stopRecordingSafetyTimer();
    resetRecordButtonUi();
  }
}

async function finalizeRecording() {
  if (isFinalizingRecording) {
    return;
  }
  isFinalizingRecording = true;

  try {
    if (!isRecording) {
      return;
    }

    isRecording = false;
    const sampleRate = audioContext ? audioContext.sampleRate : 16000;
    cleanupAudioGraph();
    stopRecordingSafetyTimer();
    resetRecordButtonUi();

    if (!pcmChunks.length) {
      setStatus("\u672a\u91c7\u96c6\u5230\u97f3\u9891\u3002", "error");
      return;
    }

    const blob = encodeWavBlob(pcmChunks, sampleRate);
    if (blob.size > RECORDING_DATA_LIMIT) {
      setStatus("\u97f3\u9891\u8d85\u8fc7 5MB\uff0c\u8bf7\u7f29\u77ed\u5f55\u97f3\u65f6\u957f\u3002", "error");
      return;
    }

    const context = consumeRecordContext();
    const id = createRecordId(context.createdAt);
    const generation = listGeneration;
    const locationPromise = context.locationPromise;

    const record = {
      id,
      createdAtIso: context.createdAtIso,
      createdAtLabel: context.createdAtLabel,
      location: "\u5b9a\u4f4d\u4e2d...",
      asrText: "",
      aiText: "",
      status: "processing",
      error: "",
      asrTaskId: ""
    };

    records.unshift(record);
    saveRecords();
    renderList();
    setStatus(`\u5df2\u63d0\u4ea4\u7b2c ${records.length} \u6761\u5de5\u4f5c\u6d41...`, "warn");

    const workflowPromise = runWorkflow({
      recordId: id,
      generation,
      blob,
      locationPromise
    })
      .catch((err) => {
        updateRecord(id, {
          status: "error",
          error: normalizeErrorMessage(err),
          location: resolveRecord(id)?.location || "\u672a\u77e5\u5730\u70b9"
        });
        setStatus(`\u4efb\u52a1\u5931\u8d25: ${normalizeErrorMessage(err)}`, "error");
      })
      .finally(() => {
        workflows.delete(id);
        saveRecords();
        renderList();
      });

    workflows.set(id, workflowPromise);
  } finally {
    resetPressSessionState();
    isFinalizingRecording = false;
  }
}

function startRecordingSafetyTimer() {
  stopRecordingSafetyTimer();
  recordingSafetyTimerId = setTimeout(() => {
    void requestStopRecording("safety_timeout");
  }, RECORDING_SAFETY_TIMEOUT_MS);
}

function stopRecordingSafetyTimer() {
  clearTimeout(recordingSafetyTimerId);
  recordingSafetyTimerId = null;
}

function resetRecordButtonUi() {
  refs.recordBtn.classList.remove("recording");
  refs.recordBtn.textContent = "\u6309\u4f4f\u5f55\u97f3";
  refs.recordHint.textContent = "松手即为停止，如无响应，可再轻点一下以停止录制。";
}

function resetPressSessionState() {
  isPressActive = false;
  pendingStopAfterStart = false;
  if (activePointerId !== null) {
    try {
      refs.recordBtn.releasePointerCapture(activePointerId);
    } catch {
      // Ignore capture release failure.
    }
  }
  activePointerId = null;
  pendingRecordContext = null;
}

function createRecordContextAtPress() {
  const createdAt = new Date();
  return {
    createdAt,
    createdAtIso: createdAt.toISOString(),
    createdAtLabel: formatDateTime(createdAt),
    locationPromise: getLocationLabel()
  };
}

function consumeRecordContext() {
  if (pendingRecordContext) {
    const context = pendingRecordContext;
    pendingRecordContext = null;
    return context;
  }
  return createRecordContextAtPress();
}

async function runWorkflow({ recordId, generation, blob, locationPromise }) {
  if (generation !== listGeneration) {
    return;
  }
  if (!resolveRecord(recordId)) {
    return;
  }

  const safeLocationPromise = Promise.resolve(locationPromise).catch(() => "\u5b9a\u4f4d\u5931\u8d25\u6216\u88ab\u62d2\u7edd");
  safeLocationPromise.then((location) => {
    if (generation !== listGeneration) {
      return;
    }
    if (!resolveRecord(recordId)) {
      return;
    }
    updateRecord(recordId, { location });
  });

  const createPayload = {
    SourceType: 1,
    DataLen: blob.size,
    Data: await blobToBase64(blob)
  };

  const createResp = await callAsr("CreateRecTask", createPayload);
  const taskId = createResp?.Response?.Data?.TaskId;
  if (!taskId) {
    throw new Error("ASR task id is missing");
  }
  updateRecord(recordId, { asrTaskId: String(taskId) });

  const finalResp = await pollAsrTask(taskId, recordId, generation);
  const asrText = extractText(finalResp?.Response?.Data || {});
  if (!asrText) {
    throw new Error("ASR returned empty text");
  }
  updateRecord(recordId, { asrText });

  const current = resolveRecord(recordId);
  if (!current) {
    return;
  }
  const location = await safeLocationPromise;
  if (!resolveRecord(recordId)) {
    return;
  }
  const aiResp = await callAi({
    asrText,
    dateTime: current.createdAtLabel,
    location
  });
  const aiText = extractAiResponseText(aiResp);
  if (!aiText) {
    throw new Error("AI returned empty result");
  }

  updateRecord(recordId, {
    aiText,
    status: "done",
    error: ""
  });
  setStatus("\u4e00\u6761\u8bb0\u5f55\u5df2\u5206\u6790\u5b8c\u6210\u3002", "ok");
}

function resolveRecord(recordId) {
  return records.find((item) => item.id === recordId) || null;
}

function updateRecord(recordId, patch) {
  const index = records.findIndex((item) => item.id === recordId);
  if (index < 0) {
    return;
  }
  records[index] = { ...records[index], ...patch };
  saveRecords();
  renderList();
}

async function pollAsrTask(taskId, recordId, generation) {
  const startedAt = Date.now();
  while (true) {
    if (generation !== listGeneration) {
      throw new Error("Task cancelled after list reset");
    }
    if (!resolveRecord(recordId)) {
      throw new Error("Task cancelled because record was removed");
    }

    const response = await callAsr("DescribeTaskStatus", { TaskId: taskId });
    const data = response?.Response?.Data || {};
    const statusCode = Number(data?.Status);

    if (statusCode === 2) {
      return response;
    }
    if (statusCode === 3) {
      const msg = data?.ErrorMsg || data?.FailedDescription || "ASR failed";
      throw new Error(msg);
    }
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      throw new Error("ASR polling timeout");
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function callAsr(action, payload) {
  const body = {
    action,
    payload
  };
  const { response, text, json } = await requestPhpApi("asr", {
    method: "POST",
    payload: body
  });
  if (!response.ok) {
    throw new Error(`ASR HTTP ${response.status}: ${json?.message || text || "request failed"}`);
  }
  const err = json?.Response?.Error;
  if (err?.Code) {
    throw new Error(`${err.Code}: ${err.Message || "ASR API error"}`);
  }
  return json;
}

async function callAi({ asrText, dateTime, location }) {
  const body = {
    asrText: asrText || "",
    dateTime: dateTime || "",
    location: location || ""
  };
  const { response, text, json } = await requestPhpApi("ai", {
    method: "POST",
    payload: body
  });
  if (!response.ok) {
    throw new Error(`AI HTTP ${response.status}: ${json?.message || text || "request failed"}`);
  }
  return json;
}

async function requestPhpApi(route, { method = "GET", payload = undefined } = {}) {
  const endpoint = buildApiEndpoint(route);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  try {
    const options = {
      method,
      headers: { "Content-Type": CONTENT_TYPE },
      credentials: "same-origin",
      signal: controller.signal
    };
    if (payload !== undefined) {
      options.body = JSON.stringify(payload);
    }
    const response = await fetch(endpoint, options);
    if (response.status === 401 && route !== "auth") {
      handleSessionExpired();
    }
    const text = await response.text();
    const json = safeJsonParse(text);
    return { response, text, json };
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildApiEndpoint(route) {
  const url = new URL("api.php", window.location.href);
  url.searchParams.set("route", route);
  return url.toString();
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
    const merged = content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (typeof item?.text === "string") {
          return item.text;
        }
        return "";
      })
      .join("")
      .trim();
    if (merged) {
      return merged;
    }
  }

  if (typeof response?.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }
  if (Array.isArray(response?.output)) {
    const parts = [];
    for (const item of response.output) {
      if (typeof item?.text === "string" && item.text.trim()) {
        parts.push(item.text.trim());
      }
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === "string" && part.text.trim()) {
            parts.push(part.text.trim());
          }
        }
      }
    }
    return parts.join("\n").trim();
  }

  return "";
}

async function getLocationLabel() {
  if (!navigator.geolocation) {
    return "\u672a\u5f00\u542f\u5b9a\u4f4d";
  }

  try {
    const pos = await getCurrentPosition({ enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 });
    const lat = Number(pos.coords.latitude);
    const lng = Number(pos.coords.longitude);
    const acc = Math.round(pos.coords.accuracy || 0);
    const coordsLabel = `lat=${lat.toFixed(6)}, lng=${lng.toFixed(6)}${acc > 0 ? `, \u00b1${acc}m` : ""}`;

    const adminLabel = await reverseLookupAdministrativeLabel(lat, lng);
    if (adminLabel) {
      return `${adminLabel} (${coordsLabel})`;
    }
    return coordsLabel;
  } catch {
    return "\u5b9a\u4f4d\u5931\u8d25\u6216\u88ab\u62d2\u7edd";
  }
}

function getCurrentPosition(options) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

async function reverseLookupAdministrativeLabel(lat, lng) {
  const primary = await reverseWithBigDataCloud(lat, lng);
  if (primary) {
    return primary;
  }
  const fallback = await reverseWithNominatim(lat, lng);
  if (fallback) {
    return fallback;
  }
  return "";
}

async function reverseWithBigDataCloud(lat, lng) {
  const url = new URL("https://api.bigdatacloud.net/data/reverse-geocode-client");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lng));
  url.searchParams.set("localityLanguage", "zh");

  const data = await fetchJsonWithTimeout(url.toString(), GEO_LOOKUP_TIMEOUT_MS);
  if (!data || typeof data !== "object") {
    return "";
  }

  const adminList = Array.isArray(data?.localityInfo?.administrative) ? data.localityInfo.administrative : [];
  const city = firstNonEmpty(
    toCleanText(data.city),
    toCleanText(data.locality),
    pickAdminNameByKeyword(adminList, ["city", "municipality", "prefecture"])
  );
  const district = firstNonEmpty(
    toCleanText(data.locality),
    pickAdminNameByKeyword(adminList, ["district", "county", "borough", "suburb"])
  );
  const province = firstNonEmpty(
    toCleanText(data.principalSubdivision),
    pickAdminNameByKeyword(adminList, ["province", "state", "region"])
  );

  return composeAdministrativeLabel({ province, city, district });
}

async function reverseWithNominatim(lat, lng) {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lng));
  url.searchParams.set("zoom", "18");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "zh-CN");

  const data = await fetchJsonWithTimeout(url.toString(), GEO_LOOKUP_TIMEOUT_MS, {
    "Accept-Language": "zh-CN"
  });
  if (!data || typeof data !== "object") {
    return "";
  }

  const addr = data.address && typeof data.address === "object" ? data.address : {};
  const city = firstNonEmpty(
    toCleanText(addr.city),
    toCleanText(addr.town),
    toCleanText(addr.municipality),
    toCleanText(addr.village)
  );
  const district = firstNonEmpty(
    toCleanText(addr.city_district),
    toCleanText(addr.county),
    toCleanText(addr.suburb),
    toCleanText(addr.township),
    toCleanText(addr.quarter)
  );
  const province = firstNonEmpty(
    toCleanText(addr.state),
    toCleanText(addr.province),
    toCleanText(addr.region)
  );

  return composeAdministrativeLabel({ province, city, district });
}

async function fetchJsonWithTimeout(url, timeoutMs, headers = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function pickAdminNameByKeyword(adminList, keywords) {
  if (!Array.isArray(adminList) || !adminList.length) {
    return "";
  }
  for (const item of adminList) {
    const name = toCleanText(item?.name);
    if (!name) {
      continue;
    }
    const desc = toCleanText(item?.description).toLowerCase();
    const haystack = `${name.toLowerCase()} ${desc}`;
    if (keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
      return name;
    }
  }
  return "";
}

function composeAdministrativeLabel({ province, city, district }) {
  const focusParts = [];
  pushUniqueLocationPart(focusParts, city);
  pushUniqueLocationPart(focusParts, district);
  pushUniqueLocationPart(focusParts, province);
  return focusParts.join(" ");
}

function pushUniqueLocationPart(target, value) {
  const text = toCleanText(value);
  if (!text) {
    return;
  }

  const normalized = normalizeLocationPart(text);
  if (!normalized) {
    return;
  }

  for (const current of target) {
    const currentNorm = normalizeLocationPart(current);
    if (!currentNorm) {
      continue;
    }
    if (
      currentNorm === normalized ||
      currentNorm.includes(normalized) ||
      normalized.includes(currentNorm)
    ) {
      return;
    }
  }

  target.push(text);
}

function normalizeLocationPart(value) {
  return toCleanText(value).toLowerCase().replaceAll(" ", "");
}

function toCleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function renderList() {
  refs.recordList.innerHTML = "";

  if (!records.length) {
    refs.emptyView.style.display = "block";
    return;
  }
  refs.emptyView.style.display = "none";

  for (const item of records) {
    const li = document.createElement("li");
    li.className = "item";

    const badgeClass = item.status === "done" ? "done" : item.status === "error" ? "error" : "processing";
    const badgeText =
      item.status === "done"
        ? "\u5b8c\u6210"
        : item.status === "error"
        ? "\u5931\u8d25"
        : "\u5904\u7406\u4e2d";

    li.innerHTML = `
      <div class="item-head">
        <div class="meta">
          <div>\u65f6\u95f4\uff1a${escapeHtml(item.createdAtLabel || "")}</div>
          <div>\u5730\u70b9\uff1a${escapeHtml(item.location || "")}</div>
        </div>
        <div class="badge ${badgeClass}">${badgeText}</div>
      </div>
      ${
        item.asrText
          ? `<div class="block"><div class="label">ASR</div><div class="text">${escapeHtml(item.asrText)}</div></div>`
          : ""
      }
      ${
        item.aiText
          ? `<div class="block"><div class="label">AI</div><div class="text">${escapeHtml(item.aiText)}</div></div>`
          : ""
      }
      ${
        item.error
          ? `<div class="block"><div class="label">\u9519\u8bef</div><div class="text">${escapeHtml(item.error)}</div></div>`
          : ""
      }
    `;
    refs.recordList.appendChild(li);
  }
}

function onExportTxt() {
  if (!records.length) {
    setStatus("\u6682\u65e0\u53ef\u5bfc\u51fa\u5185\u5bb9\u3002", "warn");
    return;
  }

  const lines = records.map((item) =>
    String(item.aiText || "")
      .replace(/\r\n/g, "\n")
      .replace(/\n+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );

  const text = lines.join("\n");
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `liubao_walkthrough_${dateStamp(new Date())}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setStatus("\u5df2\u5bfc\u51fa AI \u7ed3\u679c TXT\u3002", "ok");
}

function onClearAll() {
  if (!records.length) {
    setStatus("\u5217\u8868\u5df2\u7ecf\u4e3a\u7a7a\u3002", "warn");
    return;
  }
  const firstConfirm = window.confirm(
    "\u786e\u5b9a\u8981\u4e00\u952e\u6e05\u7a7a\u6240\u6709\u8bb0\u5f55\u5417\uff1f\u6b64\u64cd\u4f5c\u4e0d\u53ef\u64a4\u9500\u3002"
  );
  if (!firstConfirm) {
    return;
  }
  const secondConfirm = window.confirm(
    "\u8bf7\u518d\u6b21\u786e\u8ba4\uff1a\u6240\u6709\u8bb0\u5f55\u5c06\u88ab\u5f7b\u5e95\u5220\u9664\u3002"
  );
  if (!secondConfirm) {
    return;
  }

  listGeneration += 1;
  records = [];
  saveRecords();
  renderList();
  setStatus("\u5217\u8868\u5df2\u6e05\u7a7a\u3002", "ok");
}

function loadRecords() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    records = [];
    return;
  }
  const parsed = safeJsonParse(raw);
  if (!Array.isArray(parsed)) {
    records = [];
    return;
  }
  records = parsed
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      id: String(item.id || createRecordId(new Date())),
      createdAtIso: String(item.createdAtIso || new Date().toISOString()),
      createdAtLabel: String(item.createdAtLabel || formatDateTime(new Date())),
      location: String(item.location || "\u672a\u77e5\u5730\u70b9"),
      asrText: String(item.asrText || ""),
      aiText: String(item.aiText || ""),
      status: ["processing", "done", "error"].includes(item.status) ? item.status : "done",
      error: String(item.error || ""),
      asrTaskId: String(item.asrTaskId || "")
    }));
}

function saveRecords() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
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

function setAuthMessage(message, type = "") {
  if (!refs.authMessage) {
    return;
  }
  refs.authMessage.className = `auth-message ${type}`.trim();
  refs.authMessage.textContent = message || "";
}

function setStatus(message, type = "") {
  refs.status.className = `status ${type}`.trim();
  refs.status.textContent = message;
}

function normalizeErrorMessage(err) {
  if (err?.name === "AbortError") {
    return "request timeout";
  }
  return err?.message || "unknown error";
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function firstNonEmpty(...arr) {
  for (const item of arr) {
    if (typeof item === "string" && item.trim()) {
      return item;
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
  for (const b of blocks) {
    total += b.length;
  }
  const merged = new Float32Array(total);
  let offset = 0;
  for (const b of blocks) {
    merged.set(b, offset);
    offset += b.length;
  }
  return merged;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function createRecordId(now) {
  return `rec_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatDateTime(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function dateStamp(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${y}${m}${d}_${hh}${mm}${ss}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
