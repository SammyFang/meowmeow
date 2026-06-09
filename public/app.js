const state = {
  pc: null,
  dc: null,
  mediaStream: null,
  audioContext: null,
  analyser: null,
  animationFrame: null,
  analyzeTimer: null,
  connected: false,
  partialText: "",
  serverReady: false
};

const els = {
  connectionPill: document.querySelector("#connectionPill"),
  micLabel: document.querySelector("#micLabel"),
  levelText: document.querySelector("#levelText"),
  waveform: document.querySelector("#waveform"),
  startButton: document.querySelector("#startButton"),
  analyzeButton: document.querySelector("#analyzeButton"),
  stopButton: document.querySelector("#stopButton"),
  imageInput: document.querySelector("#imageInput"),
  imagePreview: document.querySelector("#imagePreview"),
  imageHint: document.querySelector("#imageHint"),
  analyzeImageButton: document.querySelector("#analyzeImageButton"),
  clearImageButton: document.querySelector("#clearImageButton"),
  realtimeStatus: document.querySelector("#realtimeStatus"),
  modelStatus: document.querySelector("#modelStatus"),
  locationInput: document.querySelector("#locationInput"),
  bodyInput: document.querySelector("#bodyInput"),
  notesInput: document.querySelector("#notesInput"),
  intentLabel: document.querySelector("#intentLabel"),
  confidenceFill: document.querySelector("#confidenceFill"),
  soundType: document.querySelector("#soundType"),
  confidenceText: document.querySelector("#confidenceText"),
  evidenceRow: document.querySelector("#evidenceRow"),
  checkList: document.querySelector("#checkList"),
  suggestedResponse: document.querySelector("#suggestedResponse"),
  lastEvent: document.querySelector("#lastEvent"),
  logOutput: document.querySelector("#logOutput"),
  clearLogButton: document.querySelector("#clearLogButton")
};

els.startButton.addEventListener("click", startListening);
els.stopButton.addEventListener("click", stopListening);
els.analyzeButton.addEventListener("click", () => requestAnalysis("manual"));
els.imageInput.addEventListener("change", handleImageSelected);
els.analyzeImageButton.addEventListener("click", analyzeImage);
els.clearImageButton.addEventListener("click", clearImage);
els.clearLogButton.addEventListener("click", () => {
  els.logOutput.textContent = "";
  els.lastEvent.textContent = "Log cleared";
});

init();

async function init() {
  drawIdleWaveform();
  try {
    const health = await fetch("/api/health").then(r => r.json());
    if (!health.hasApiKey) {
      state.serverReady = false;
      setConnection("error", "缺 API key");
      setStatus("需設定 key");
      els.startButton.disabled = true;
      els.startButton.textContent = "Set API key first";
    } else {
      state.serverReady = true;
      els.startButton.disabled = false;
      els.startButton.textContent = "Start listening";
    }
  } catch {
    state.serverReady = false;
    setConnection("error", "server error");
    els.startButton.disabled = true;
  }
}

async function startListening() {
  try {
    if (!state.serverReady) {
      throw new Error("Server is not ready. Set OPENAI_API_KEY and restart.");
    }
    setBusy(true);
    setConnection("", "連線中");
    setStatus("要求麥克風");

    const mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false
      }
    });

    state.mediaStream = mediaStream;
    setupMeter(mediaStream);

    const pc = new RTCPeerConnection();
    state.pc = pc;
    mediaStream.getAudioTracks().forEach(track => pc.addTrack(track, mediaStream));

    const dc = pc.createDataChannel("oai-events");
    state.dc = dc;
    dc.addEventListener("open", () => {
      state.connected = true;
      setConnection("connected", "已連線");
      setStatus("聆聽中");
      els.analyzeButton.disabled = false;
      els.stopButton.disabled = false;
      sendContextMessage();
      requestAnalysis("initial");
      state.analyzeTimer = window.setInterval(() => requestAnalysis("auto"), 6000);
    });
    dc.addEventListener("message", handleRealtimeMessage);
    dc.addEventListener("close", () => {
      if (state.connected) setConnection("", "已斷線");
      state.connected = false;
    });

    pc.addEventListener("connectionstatechange", () => {
      setStatus(pc.connectionState);
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        setConnection(pc.connectionState === "failed" ? "error" : "", pc.connectionState);
      }
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    setStatus("取得短效 token");
    const ephemeralKey = await getRealtimeToken();

    setStatus("建立 session");
    const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${ephemeralKey}`,
        "Content-Type": "application/sdp"
      }
    });

    if (!sdpResponse.ok) {
      const detail = await safeJson(sdpResponse);
      throw new Error(detail.detail || detail.error || `Session failed: ${sdpResponse.status}`);
    }

    const answer = {
      type: "answer",
      sdp: await sdpResponse.text()
    };
    await pc.setRemoteDescription(answer);
  } catch (error) {
    log(`ERROR ${error.message}`);
    setConnection("error", "連線失敗");
    setStatus(error.message);
    await stopListening({ keepMessage: true });
  } finally {
    setBusy(false);
  }
}

async function stopListening(options = {}) {
  window.clearInterval(state.analyzeTimer);
  state.analyzeTimer = null;
  window.cancelAnimationFrame(state.animationFrame);
  state.animationFrame = null;

  if (state.dc && state.dc.readyState !== "closed") state.dc.close();
  if (state.pc) state.pc.close();
  if (state.mediaStream) state.mediaStream.getTracks().forEach(track => track.stop());
  if (state.audioContext) await state.audioContext.close().catch(() => {});

  state.pc = null;
  state.dc = null;
  state.mediaStream = null;
  state.audioContext = null;
  state.analyser = null;
  state.connected = false;

  els.startButton.disabled = false;
  els.analyzeButton.disabled = true;
  els.stopButton.disabled = true;
  els.micLabel.textContent = options.keepMessage ? els.micLabel.textContent : "已停止";
  els.levelText.textContent = "0%";
  if (!options.keepMessage) {
    setConnection("", "未連線");
    setStatus("待命");
  }
  drawIdleWaveform();
}

function requestAnalysis(source) {
  if (!state.dc || state.dc.readyState !== "open") return;
  const context = getContext();
  const instructions = [
    "Return JSON only. Analyze the recent live microphone audio for common house-cat vocal intent.",
    "Use the cat context below. If the audio is mostly human speech, background noise, or silence, return unknown with low confidence.",
    `Context: ${JSON.stringify(context)}`
  ].join("\n");

  state.dc.send(
    JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["text"],
        instructions
      }
    })
  );
  log(`client.response.create ${source}`);
}

async function getRealtimeToken() {
  const response = await fetch("/api/realtime/token", {
    method: "POST",
    headers: {
      "X-CatSense-Context": encodeContextHeader(getContext())
    }
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || data.error || `Token failed: ${response.status}`);
  }
  const value = data.value || data.client_secret?.value;
  if (!value) {
    throw new Error("Realtime token response did not include a client secret.");
  }
  return value;
}

function sendContextMessage() {
  if (!state.dc || state.dc.readyState !== "open") return;
  state.dc.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `House-cat context for this listening session: ${JSON.stringify(getContext())}`
          }
        ]
      }
    })
  );
}

function handleRealtimeMessage(message) {
  let event;
  try {
    event = JSON.parse(message.data);
  } catch {
    log(`non-json event ${message.data}`);
    return;
  }

  els.lastEvent.textContent = event.type || "event";
  if (event.type) log(event.type);

  const deltas = [
    event.delta,
    event.text,
    event.transcript,
    event.item?.content?.[0]?.text
  ].filter(value => typeof value === "string");

  for (const delta of deltas) {
    state.partialText += delta;
    maybeRenderResult(state.partialText);
  }

  if (event.type === "response.done" || event.type === "response.completed") {
    const text = extractResponseText(event) || state.partialText;
    if (text) {
      maybeRenderResult(text, true);
      log(trimForLog(text));
    }
    state.partialText = "";
  }
}

function maybeRenderResult(text, final = false) {
  const parsed = parseFirstJson(text);
  if (!parsed) {
    if (final) log(`unparsed: ${trimForLog(text)}`);
    return;
  }

  const confidence = Number(parsed.confidence || 0);
  const normalizedConfidence = confidence > 1 ? Math.min(confidence, 100) : Math.round(confidence * 100);
  els.intentLabel.textContent = parsed.likely_intent || "unknown";
  els.soundType.textContent = `sound: ${parsed.sound_type || "unknown"}`;
  els.confidenceText.textContent = `confidence: ${normalizedConfidence}%`;
  els.confidenceFill.style.width = `${Math.max(0, Math.min(normalizedConfidence, 100))}%`;
  els.evidenceRow.textContent = parsed.acoustic_evidence || parsed.notes || "無足夠聲音證據";

  const checks = Array.isArray(parsed.what_to_check) && parsed.what_to_check.length
    ? parsed.what_to_check
    : ["再錄一段更清楚的貓叫聲"];
  els.checkList.replaceChildren(...checks.map(item => {
    const li = document.createElement("li");
    li.textContent = item;
    return li;
  }));

  const warning = Boolean(parsed.vet_warning);
  els.suggestedResponse.textContent = parsed.suggested_response || parsed.notes || "結果不取代獸醫診斷。";
  els.suggestedResponse.classList.toggle("warning", warning);
}

async function handleImageSelected() {
  const file = els.imageInput.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    log("ERROR selected file is not an image");
    return;
  }

  const dataUrl = await resizeImageToDataUrl(file, 1280, 0.82);
  els.imagePreview.src = dataUrl;
  els.imagePreview.hidden = false;
  els.imageHint.hidden = true;
  els.analyzeImageButton.disabled = false;
  els.clearImageButton.disabled = false;
}

async function analyzeImage() {
  const imageDataUrl = els.imagePreview.src;
  if (!imageDataUrl) return;

  els.analyzeImageButton.disabled = true;
  els.analyzeImageButton.textContent = "Analyzing...";
  try {
    const response = await fetch("/api/vision/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        image_data_url: imageDataUrl,
        context: getContext()
      })
    });
    const data = await safeJson(response);
    if (!response.ok) {
      throw new Error(data.detail || data.error || `Vision failed: ${response.status}`);
    }
    renderVisionResult(data);
    log("vision.analysis.done");
  } catch (error) {
    log(`ERROR ${error.message}`);
    els.evidenceRow.textContent = error.message;
  } finally {
    els.analyzeImageButton.disabled = false;
    els.analyzeImageButton.textContent = "Analyze image";
  }
}

function renderVisionResult(data) {
  const confidence = Number(data.confidence || 0);
  const normalizedConfidence = confidence > 1 ? Math.min(confidence, 100) : Math.round(confidence * 100);
  const title = data.primary_state || data.relationship || "unknown";
  els.intentLabel.textContent = `影像：${title}`;
  els.soundType.textContent = `cats: ${data.cat_count ?? "unknown"}`;
  els.confidenceText.textContent = `confidence: ${normalizedConfidence}%`;
  els.confidenceFill.style.width = `${Math.max(0, Math.min(normalizedConfidence, 100))}%`;
  els.evidenceRow.textContent = data.visible_evidence || "無足夠影像證據";

  const checks = Array.isArray(data.what_to_check) && data.what_to_check.length
    ? data.what_to_check
    : ["換一張更清楚、包含全身與尾巴/耳朵的照片"];
  els.checkList.replaceChildren(...checks.map(item => {
    const li = document.createElement("li");
    li.textContent = item;
    return li;
  }));

  const warning = Boolean(data.safety_warning);
  els.suggestedResponse.textContent = data.suggested_response || "影像判斷不取代獸醫或行為專家。";
  els.suggestedResponse.classList.toggle("warning", warning);
}

function clearImage() {
  els.imageInput.value = "";
  els.imagePreview.removeAttribute("src");
  els.imagePreview.hidden = true;
  els.imageHint.hidden = false;
  els.analyzeImageButton.disabled = true;
  els.clearImageButton.disabled = true;
}

function resizeImageToDataUrl(file, maxEdge, quality) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(image.src);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    image.onerror = () => reject(new Error("Could not read image."));
    image.src = URL.createObjectURL(file);
  });
}

function extractResponseText(event) {
  const chunks = [];
  const output = event.response?.output || event.output || [];
  for (const item of output) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
      if (typeof content.transcript === "string") chunks.push(content.transcript);
    }
  }
  return chunks.join("\n");
}

function parseFirstJson(text) {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function setupMeter(stream) {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  state.audioContext = audioContext;
  state.analyser = analyser;
  drawLiveWaveform();
}

function drawLiveWaveform() {
  const canvas = els.waveform;
  const ctx = canvas.getContext("2d");
  const data = new Uint8Array(state.analyser.frequencyBinCount);

  function frame() {
    if (!state.analyser) return;
    state.analyser.getByteTimeDomainData(data);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGrid(ctx, canvas);

    ctx.lineWidth = 4;
    ctx.strokeStyle = "#088c7f";
    ctx.beginPath();
    const slice = canvas.width / data.length;
    let level = 0;
    for (let i = 0; i < data.length; i += 1) {
      const value = data[i] / 128 - 1;
      level += Math.abs(value);
      const y = canvas.height / 2 + value * canvas.height * 0.38;
      const x = i * slice;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    const percent = Math.min(100, Math.round((level / data.length) * 240));
    els.levelText.textContent = `${percent}%`;
    els.micLabel.textContent = percent > 8 ? "偵測到聲音" : "聆聽中";

    state.animationFrame = window.requestAnimationFrame(frame);
  }

  frame();
}

function drawIdleWaveform() {
  const canvas = els.waveform;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid(ctx, canvas);
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#d5e2de";
  ctx.beginPath();
  for (let x = 0; x <= canvas.width; x += 18) {
    const y = canvas.height / 2 + Math.sin(x * 0.04) * 8;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawGrid(ctx, canvas) {
  ctx.fillStyle = "#fbfdfc";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#e5efec";
  ctx.lineWidth = 1;
  for (let x = 0; x < canvas.width; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += 48) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
}

function getContext() {
  return {
    location: els.locationInput.value,
    body_language: els.bodyInput.value,
    recent_changes: els.notesInput.value.trim(),
    timestamp: new Date().toISOString()
  };
}

function encodeContextHeader(context) {
  const json = JSON.stringify(context);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  bytes.forEach(byte => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function setBusy(isBusy) {
  els.startButton.disabled = isBusy || state.connected;
}

function setConnection(mode, text) {
  els.connectionPill.className = `connection-text ${mode || ""}`.trim();
  els.connectionPill.textContent = text;
}

function setStatus(text) {
  if (els.realtimeStatus) els.realtimeStatus.textContent = text;
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return { error: await response.text() };
  }
}

function log(line) {
  const time = new Date().toLocaleTimeString("zh-TW", { hour12: false });
  els.logOutput.textContent = `[${time}] ${line}\n${els.logOutput.textContent}`.slice(0, 7000);
}

function trimForLog(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, 900);
}
