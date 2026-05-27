const player = document.querySelector("#player");
const fileInput = document.querySelector("#fileInput");
const chooseBtn = document.querySelector("#chooseBtn");
const playBtn = document.querySelector("#playBtn");
const unlockBtn = document.querySelector("#unlockBtn");
const syncBtn = document.querySelector("#syncBtn");
const seek = document.querySelector("#seek");
const currentTime = document.querySelector("#currentTime");
const duration = document.querySelector("#duration");
const trackName = document.querySelector("#trackName");
const trackMeta = document.querySelector("#trackMeta");
const statusEl = document.querySelector("#status");
const dropzone = document.querySelector("#dropzone");
const disc = document.querySelector("#disc");
const addressText = document.querySelector("#addressText");
const syncPanel = document.querySelector("#syncPanel");
const qualityText = document.querySelector("#qualityText");
const driftText = document.querySelector("#driftText");
const latencyText = document.querySelector("#latencyText");
const rateText = document.querySelector("#rateText");

let socket;
let isController = false;
let remoteUpdate = false;
let desiredPlaying = false;
let audioUnlocked = false;
let pendingPlayback = null;
let lastBroadcast = 0;
let clockOffsetMs = 0;
let roundTripMs = null;
let lastDriftMs = null;

addressText.textContent = `同一 Wi-Fi 下打开 ${location.origin} 加入播放。`;

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = String(total % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

function setStatus(text, online = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("online", online);
}

function wsUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}`;
}

function send(value) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(value));
  }
}

function connect() {
  socket = new WebSocket(wsUrl());
  socket.addEventListener("open", () => {
    setStatus("已连接", true);
    sendPing();
    send({ type: "sync-request" });
  });
  socket.addEventListener("close", () => {
    setStatus("重连中");
    setTimeout(connect, 900);
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "pong") applyPong(message);
    if (message.type === "state" || message.type === "audio") applyState(message);
    if (message.type === "playback") applyPlayback(message);
  });
}

function serverNowMs() {
  return Date.now() + clockOffsetMs;
}

function sendPing() {
  send({ type: "ping", clientTime: Date.now() });
}

function applyPong(message) {
  const receivedAt = Date.now();
  const sentAt = Number(message.clientTime);
  if (!Number.isFinite(sentAt)) return;

  const rtt = Math.max(0, receivedAt - sentAt);
  const offset = Number(message.serverTime) + rtt / 2 - receivedAt;
  roundTripMs = roundTripMs == null ? rtt : roundTripMs * 0.75 + rtt * 0.25;
  clockOffsetMs = clockOffsetMs * 0.8 + offset * 0.2;
  updateSyncMetrics();
}

function correctedPosition(message) {
  const elapsed = message.playing ? (serverNowMs() - message.serverTime) / 1000 : 0;
  return Math.max(0, (message.position || 0) + elapsed);
}

function syncClock(message, force = false) {
  const target = correctedPosition(message);
  const diff = target - player.currentTime;
  lastDriftMs = -diff * 1000;

  if (force || Math.abs(diff) > 0.12) {
    player.currentTime = target;
    player.playbackRate = 1;
    updateSyncMetrics();
    return;
  }

  player.playbackRate = message.playing
    ? Math.max(0.95, Math.min(1.05, 1 + diff * 0.35))
    : 1;
  updateSyncMetrics();
}

function qualityLabel() {
  if (isController) return ["主控基准", "good"];
  if (lastDriftMs == null) return ["等待同步", "idle"];
  const drift = Math.abs(lastDriftMs);
  if (drift < 35) return ["极好", "good"];
  if (drift < 80) return ["稳定", "good"];
  if (drift < 160) return ["校准中", "warn"];
  return ["偏差较大", "bad"];
}

function updateSyncMetrics() {
  const [label, level] = qualityLabel();
  qualityText.textContent = label;
  driftText.textContent = isController
    ? "0 ms"
    : lastDriftMs == null
      ? "-- ms"
      : `${Math.round(lastDriftMs)} ms`;
  latencyText.textContent = roundTripMs == null ? "-- ms" : `${Math.round(roundTripMs)} ms`;
  rateText.textContent = `${player.playbackRate.toFixed(3)}x`;

  syncPanel.classList.remove("quality-good", "quality-warn", "quality-bad", "quality-idle");
  syncPanel.classList.add(`quality-${level}`);
}

async function applyPlayback(message, force = false) {
  if (!player.src) return;
  remoteUpdate = true;
  desiredPlaying = message.playing;
  pendingPlayback = message;
  syncClock(message, force);

  try {
    if (message.playing) {
      await player.play();
      audioUnlocked = true;
      trackMeta.textContent = isController ? "主控播放中" : "正在跟随主控播放";
    } else {
      player.pause();
      player.playbackRate = 1;
    }
  } catch {
    audioUnlocked = false;
    desiredPlaying = false;
    trackMeta.textContent = "这台设备需要先点“启用声音”";
  }

  remoteUpdate = false;
  updateButtons();
  updateSyncMetrics();
}

function applyState(message) {
  if (message.audio) {
    const isNewTrack = player.getAttribute("src") !== message.audio.url;
    if (isNewTrack) {
      player.src = message.audio.url;
      audioUnlocked = false;
      lastDriftMs = null;
    }
    trackName.textContent = message.audio.name;
    if (isNewTrack) {
      trackMeta.textContent = isController ? "已上传，你是主控设备" : "已加载，请先点启用声音";
    }
    playBtn.disabled = !isController;
    unlockBtn.disabled = false;
    syncBtn.disabled = false;
    seek.disabled = !isController;
  }
  applyPlayback(message, true);
}

async function uploadFile(file) {
  if (!file) return;
  isController = true;
  lastDriftMs = 0;
  trackName.textContent = file.name;
  trackMeta.textContent = "上传中";
  chooseBtn.disabled = true;
  const response = await fetch("/upload", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name)
    },
    body: file
  });
  const message = await response.json();
  chooseBtn.disabled = false;
  applyState(message);
}

function broadcastPlayback(force = false) {
  if (!isController || !player.src || remoteUpdate) return;
  const now = Date.now();
  if (!force && now - lastBroadcast < 120) return;
  lastBroadcast = now;
  send({
    type: "playback",
    playing: !player.paused,
    position: player.currentTime
  });
}

function updateButtons() {
  const isPlaying = desiredPlaying || !player.paused;
  playBtn.textContent = isController ? (isPlaying ? "暂停" : "播放") : "跟随主控";
  disc.classList.toggle("playing", isPlaying);

  const needsUnlock = Boolean(player.src) && !audioUnlocked;
  unlockBtn.disabled = !player.src;
  unlockBtn.classList.toggle("needs-unlock", needsUnlock);
  unlockBtn.textContent = needsUnlock ? "启用声音" : "声音已启用";
}

chooseBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => uploadFile(fileInput.files[0]));

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("dragging");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragging");
  uploadFile(event.dataTransfer.files[0]);
});

playBtn.addEventListener("click", async () => {
  if (!isController) return;
  try {
    if (player.paused) {
      await player.play();
      audioUnlocked = true;
    } else {
      player.pause();
      player.playbackRate = 1;
    }
    desiredPlaying = !player.paused;
    broadcastPlayback(true);
  } catch {
    audioUnlocked = false;
    trackMeta.textContent = "请先点“启用声音”";
  }
  updateButtons();
  updateSyncMetrics();
});

unlockBtn.addEventListener("click", async () => {
  if (!player.src) return;
  try {
    if (pendingPlayback) syncClock(pendingPlayback, true);
    await player.play();
    audioUnlocked = true;
    desiredPlaying = true;
    trackMeta.textContent = isController ? "声音已启用，可以主控播放" : "声音已启用，正在跟随主控";
    if (!pendingPlayback?.playing && !isController) {
      player.pause();
      desiredPlaying = false;
    }
  } catch {
    audioUnlocked = false;
    trackMeta.textContent = "这台设备仍未授权声音，请再点一次";
  }
  send({ type: "sync-request" });
  updateButtons();
  updateSyncMetrics();
});

syncBtn.addEventListener("click", () => {
  sendPing();
  send({ type: "sync-request" });
});

seek.addEventListener("input", () => {
  if (!isController || !player.duration) return;
  player.currentTime = (Number(seek.value) / 1000) * player.duration;
  broadcastPlayback(true);
});

player.addEventListener("play", () => {
  desiredPlaying = true;
  updateButtons();
  updateSyncMetrics();
});
player.addEventListener("pause", () => {
  desiredPlaying = false;
  player.playbackRate = 1;
  updateButtons();
  updateSyncMetrics();
});
player.addEventListener("loadedmetadata", () => {
  duration.textContent = formatTime(player.duration);
});
player.addEventListener("timeupdate", () => {
  currentTime.textContent = formatTime(player.currentTime);
  duration.textContent = formatTime(player.duration);
  if (player.duration) seek.value = String(Math.round((player.currentTime / player.duration) * 1000));
});

setInterval(() => {
  if (!isController || !player.src || player.paused || remoteUpdate) return;
  broadcastPlayback(true);
}, 400);

setInterval(() => {
  if (isController || !pendingPlayback || !pendingPlayback.playing || player.paused) return;
  syncClock(pendingPlayback);
}, 250);

setInterval(sendPing, 1000);
updateSyncMetrics();
connect();
