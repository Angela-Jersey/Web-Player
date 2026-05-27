const player = document.querySelector("#player");
const fileInput = document.querySelector("#fileInput");
const chooseBtn = document.querySelector("#chooseBtn");
const prevBtn = document.querySelector("#prevBtn");
const playBtn = document.querySelector("#playBtn");
const nextBtn = document.querySelector("#nextBtn");
const unlockBtn = document.querySelector("#unlockBtn");
const syncBtn = document.querySelector("#syncBtn");
const modeButton = document.querySelector("#modeButton");
const eqOpenBtn = document.querySelector("#eqOpenBtn");
const seek = document.querySelector("#seek");
const volumeSlider = document.querySelector("#volumeSlider");
const volumeValue = document.querySelector("#volumeValue");
const currentTime = document.querySelector("#currentTime");
const duration = document.querySelector("#duration");
const trackName = document.querySelector("#trackName");
const trackMeta = document.querySelector("#trackMeta");
const statusEl = document.querySelector("#status");
const dropzone = document.querySelector("#dropzone");
const disc = document.querySelector("#disc");
const addressText = document.querySelector("#addressText");
const playlistEl = document.querySelector("#playlist");
const devicesEl = document.querySelector("#devices");
const claimControllerBtn = document.querySelector("#claimControllerBtn");
const syncPanel = document.querySelector("#syncPanel");
const qualityText = document.querySelector("#qualityText");
const driftText = document.querySelector("#driftText");
const latencyText = document.querySelector("#latencyText");
const rateText = document.querySelector("#rateText");
const eqModal = document.querySelector("#eqModal");
const eqCloseBtn = document.querySelector("#eqCloseBtn");
const eqCloseBackdrop = document.querySelector("#eqCloseBackdrop");
const eqResetBtn = document.querySelector("#eqResetBtn");
const presetButtons = [...document.querySelectorAll(".preset")];
const eqManual = document.querySelector("#eqManual");
const eqSliders = [...document.querySelectorAll(".eq-slider")];

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
let playlist = [];
let currentIndex = -1;
let playMode = "list";
let deviceId = null;
let controllerId = null;
let devices = [];
let autoPlayIndex = null;
let endedAtTail = false;
let localAudible = true;
let audioContext;
let mediaSource;
let filters;
let surroundDelay;
let surroundWet;
let dryGain;
let stereoPanner;
let eqPreset = "flat";

const playModes = [
  { value: "list", icon: "⇥", label: "列表" },
  { value: "sequence", icon: "⇉", label: "循环" },
  { value: "random", icon: "⤨", label: "随机" },
  { value: "repeat-one", icon: "①", label: "单曲" }
];

const eqPresets = {
  flat: { bass: 0, mid: 0, treble: 0, surround: 0, delay: 0.028, pan: 0 },
  megaBass: { bass: 10, mid: -2, treble: 3, surround: 0.04, delay: 0.03, pan: 0 },
  acoustic: { bass: 2, mid: 5, treble: 3, surround: 0.03, delay: 0.025, pan: 0 },
  hifiLive: { bass: 4, mid: 1, treble: 5, surround: 0.18, delay: 0.045, pan: 0.08 },
  surround3d: { bass: 3, mid: -1, treble: 4, surround: 0.28, delay: 0.034, pan: 0.22 },
  manual: { bass: 0, mid: 0, treble: 0, surround: 0, delay: 0.028, pan: 0 }
};

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
    if (message.type === "hello") deviceId = message.deviceId;
    if (message.type === "devices") applyDevices(message);
    if (message.type === "pong") applyPong(message);
    if (message.type === "mode") applyMode(message);
    if (message.type === "state" || message.type === "audio" || message.type === "playlist") applyState(message);
    if (message.type === "playback") applyPlayback(message);
  });
}

function applyDevices(message) {
  devices = message.devices || [];
  const controller = devices.find((device) => device.controller);
  if (controller) {
    controllerId = controller.id;
    isController = controllerId === deviceId;
  } else {
    controllerId = null;
    isController = false;
  }
  renderDevices();
  updateButtons();
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

function initEqualizer() {
  if (audioContext) return;
  audioContext = new AudioContext();
  mediaSource = audioContext.createMediaElementSource(player);
  filters = {
    bass: audioContext.createBiquadFilter(),
    mid: audioContext.createBiquadFilter(),
    treble: audioContext.createBiquadFilter()
  };
  filters.bass.type = "lowshelf";
  filters.bass.frequency.value = 120;
  filters.mid.type = "peaking";
  filters.mid.frequency.value = 1000;
  filters.mid.Q.value = 1.1;
  filters.treble.type = "highshelf";
  filters.treble.frequency.value = 6000;
  stereoPanner = audioContext.createStereoPanner();
  dryGain = audioContext.createGain();
  surroundDelay = audioContext.createDelay(0.12);
  surroundWet = audioContext.createGain();
  mediaSource.connect(filters.bass);
  filters.bass.connect(filters.mid);
  filters.mid.connect(filters.treble);
  filters.treble.connect(stereoPanner);
  stereoPanner.connect(dryGain);
  stereoPanner.connect(surroundDelay);
  surroundDelay.connect(surroundWet);
  dryGain.connect(audioContext.destination);
  surroundWet.connect(audioContext.destination);
  applyEqualizer();
}

function sliderValues() {
  return Object.fromEntries(eqSliders.map((slider) => [slider.dataset.band, Number(slider.value)]));
}

function setSliders(values) {
  for (const slider of eqSliders) {
    slider.value = values[slider.dataset.band] ?? 0;
    document.querySelector(`#${slider.dataset.band}Value`).textContent = `${slider.value} dB`;
  }
}

function applyEqualizer() {
  const preset = eqPreset === "manual" ? { ...eqPresets.manual, ...sliderValues() } : eqPresets[eqPreset];
  setSliders(preset);
  if (!filters) return;
  filters.bass.gain.value = preset.bass || 0;
  filters.mid.gain.value = preset.mid || 0;
  filters.treble.gain.value = preset.treble || 0;
  stereoPanner.pan.value = preset.pan || 0;
  surroundDelay.delayTime.value = preset.delay || 0.028;
  surroundWet.gain.value = preset.surround || 0;
  dryGain.gain.value = Math.max(0.78, 1 - (preset.surround || 0) * 0.35);
}

function selectPreset(name) {
  eqPreset = name;
  eqManual.classList.toggle("hidden", name !== "manual");
  for (const button of presetButtons) {
    button.classList.toggle("active", button.dataset.preset === name);
  }
  if (name !== "manual") setSliders(eqPresets[name]);
  applyEqualizer();
}

function updateModeButton() {
  const mode = playModes.find((item) => item.value === playMode) || playModes[0];
  modeButton.textContent = `${mode.icon} ${mode.label}`;
  modeButton.title = `播放模式：${mode.label}`;
}

function renderPlaylist() {
  playlistEl.innerHTML = "";
  if (!playlist.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "上传后的音频会出现在这里";
    playlistEl.append(empty);
    return;
  }

  playlist.forEach((track, index) => {
    const row = document.createElement("div");
    row.className = index === currentIndex ? "track active" : "track";

    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.className = "track-main";
    selectButton.disabled = !isController;
    selectButton.innerHTML = `<span>${index + 1}</span><strong></strong>`;
    selectButton.querySelector("strong").textContent = track.name;
    selectButton.addEventListener("click", () => selectTrack(index, true));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "track-delete";
    deleteButton.textContent = "删除";
    deleteButton.disabled = !isController;
    deleteButton.addEventListener("click", () => send({ type: "delete-track", index }));

    const upButton = document.createElement("button");
    upButton.type = "button";
    upButton.className = "track-move";
    upButton.textContent = "上移";
    upButton.disabled = !isController || index === 0;
    upButton.addEventListener("click", () => send({ type: "reorder-track", from: index, to: index - 1 }));

    const downButton = document.createElement("button");
    downButton.type = "button";
    downButton.className = "track-move";
    downButton.textContent = "下移";
    downButton.disabled = !isController || index === playlist.length - 1;
    downButton.addEventListener("click", () => send({ type: "reorder-track", from: index, to: index + 1 }));

    const actions = document.createElement("div");
    actions.className = "track-actions";
    actions.append(upButton, downButton, deleteButton);

    row.append(selectButton, actions);
    playlistEl.append(row);
  });
}

function renderDevices() {
  devicesEl.innerHTML = "";
  if (!devices.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "暂无在线设备";
    devicesEl.append(empty);
    return;
  }

  for (const device of devices) {
    const label = document.createElement("label");
    label.className = device.id === deviceId ? "device self" : "device";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = device.enabled;
    checkbox.addEventListener("change", () => {
      send({ type: "device-enabled", id: device.id, enabled: checkbox.checked });
    });
    const name = document.createElement("strong");
    name.textContent = device.id === deviceId ? `${device.name}（本机）` : device.name;
    const state = document.createElement("span");
    state.textContent = device.controller ? "主控" : device.enabled ? "参与播放" : "已静音";
    label.append(checkbox, name, state);
    devicesEl.append(label);
  }
}

function applyMode(message) {
  if (message.playMode) {
    playMode = message.playMode;
    updateModeButton();
  }
  if (message.playlist) {
    playlist = message.playlist;
    currentIndex = message.currentIndex ?? currentIndex;
    renderPlaylist();
  }
}

async function applyPlayback(message, force = false) {
  if (!player.src) return;
  remoteUpdate = true;
  localAudible = message.audible !== false;
  player.muted = !localAudible;
  desiredPlaying = message.playing;
  if (message.playing) endedAtTail = false;
  pendingPlayback = message;
  syncClock(message, force);

  try {
    if (message.playing) {
      initEqualizer();
      await audioContext?.resume();
      await player.play();
      audioUnlocked = true;
      trackMeta.textContent = !localAudible
        ? "本机未参与播放，已静音跟随"
        : isController
          ? "主控播放中"
          : "正在跟随主控播放";
    } else {
      player.pause();
      player.playbackRate = 1;
    }
  } catch {
    audioUnlocked = false;
    desiredPlaying = message.playing && !localAudible;
    trackMeta.textContent = localAudible ? "这台设备需要先点“启用声音”" : "本机已静音，等待浏览器允许跟随";
  }

  remoteUpdate = false;
  updateButtons();
  updateSyncMetrics();
}

function applyState(message) {
  playlist = message.playlist || playlist;
  devices = message.devices || devices;
  controllerId = message.controllerId ?? controllerId;
  isController = Boolean(deviceId && controllerId === deviceId);
  currentIndex = Number.isInteger(message.currentIndex) ? message.currentIndex : currentIndex;
  playMode = message.playMode || playMode;
  updateModeButton();

  if (message.audio) {
    const isNewTrack = player.getAttribute("src") !== message.audio.url;
    if (isNewTrack) {
      player.src = message.audio.url;
      audioUnlocked = false;
      lastDriftMs = null;
    }
    trackName.textContent = message.audio.name;
    if (isNewTrack) {
      trackMeta.textContent = isController ? "已加载，你是主控设备" : "已加载，请先点启用声音";
    }
  }

  updateControlsAvailability();
  renderPlaylist();
  renderDevices();
  applyPlayback(message, true);

  if (autoPlayIndex != null && autoPlayIndex === currentIndex) {
    autoPlayIndex = null;
    setTimeout(() => playAsController(), 120);
  }
}

async function uploadFile(file) {
  if (!file) return;
  send({ type: "claim-controller" });
  isController = true;
  lastDriftMs = 0;
  trackName.textContent = file.name;
  trackMeta.textContent = "上传中";
  const response = await fetch("/upload", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name)
    },
    body: file
  });
  const message = await response.json();
  applyState(message);
}

async function uploadFiles(files) {
  const list = [...files].filter((file) => file.type.startsWith("audio/") || /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(file.name));
  if (!list.length) return;
  chooseBtn.disabled = true;
  for (const file of list) {
    await uploadFile(file);
  }
  chooseBtn.disabled = false;
  trackMeta.textContent = `${list.length} 首已加入播放列表`;
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

function updateControlsAvailability() {
  const hasTrack = currentIndex >= 0 && playlist.length > 0;
  prevBtn.disabled = !isController || !hasTrack;
  playBtn.disabled = !isController || !hasTrack;
  nextBtn.disabled = !isController || !hasTrack;
  modeButton.disabled = !isController;
  claimControllerBtn.disabled = isController;
  claimControllerBtn.textContent = isController ? "当前主控" : "接管主控";
  unlockBtn.disabled = !hasTrack;
  syncBtn.disabled = !hasTrack;
  seek.disabled = !isController || !hasTrack;
}

function updateButtons() {
  const isPlaying = desiredPlaying || !player.paused;
  playBtn.textContent = isController ? (isPlaying ? "暂停" : "播放") : "跟随主控";
  disc.classList.toggle("playing", isPlaying);
  const needsUnlock = Boolean(player.src) && !audioUnlocked;
  unlockBtn.disabled = !player.src;
  unlockBtn.classList.toggle("needs-unlock", needsUnlock);
  unlockBtn.textContent = needsUnlock ? "启用声音" : "声音已启用";
  updateControlsAvailability();
}

function applyVolume() {
  const volume = Number(volumeSlider.value) / 100;
  player.volume = Math.max(0, Math.min(1, volume));
  volumeValue.textContent = `${Math.round(player.volume * 100)}%`;
}

function selectTrack(index, autoPlay = false) {
  if (!isController || index < 0 || index >= playlist.length) return;
  endedAtTail = false;
  autoPlayIndex = autoPlay ? index : null;
  send({ type: "select-track", index });
}

function nextIndex(direction = 1) {
  if (!playlist.length) return -1;
  if (playMode === "repeat-one") return currentIndex;
  if (playMode === "random" && playlist.length > 1) {
    let index = currentIndex;
    while (index === currentIndex) {
      index = Math.floor(Math.random() * playlist.length);
    }
    return index;
  }
  return (currentIndex + direction + playlist.length) % playlist.length;
}

function listModeNextIndex(direction = 1) {
  const index = currentIndex + direction;
  return index >= 0 && index < playlist.length ? index : -1;
}

async function playAsController() {
  if (!isController || !player.src) return;
  try {
    initEqualizer();
    await audioContext?.resume();
    if (endedAtTail || (player.duration && player.currentTime >= player.duration - 0.05)) {
      player.currentTime = 0;
      endedAtTail = false;
    }
    await player.play();
    audioUnlocked = true;
    desiredPlaying = true;
    broadcastPlayback(true);
  } catch {
    audioUnlocked = false;
    trackMeta.textContent = "请先点“启用声音”";
  }
  updateButtons();
  updateSyncMetrics();
}

chooseBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => uploadFiles(fileInput.files));

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("dragging");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("dragging");
  uploadFiles(event.dataTransfer.files);
});

prevBtn.addEventListener("click", () => selectTrack(nextIndex(-1), true));
nextBtn.addEventListener("click", () => selectTrack(nextIndex(1), true));

playBtn.addEventListener("click", async () => {
  if (!isController) return;
  if (player.paused) {
    await playAsController();
  } else {
    player.pause();
    player.playbackRate = 1;
    desiredPlaying = false;
    broadcastPlayback(true);
  }
  updateButtons();
});

unlockBtn.addEventListener("click", async () => {
  if (!player.src) return;
  try {
    initEqualizer();
    await audioContext?.resume();
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

claimControllerBtn.addEventListener("click", () => {
  send({ type: "claim-controller" });
});

modeButton.addEventListener("click", () => {
  if (!isController) return;
  const index = playModes.findIndex((item) => item.value === playMode);
  playMode = playModes[(index + 1) % playModes.length].value;
  updateModeButton();
  send({ type: "play-mode", mode: playMode });
});

seek.addEventListener("input", () => {
  if (!isController || !player.duration) return;
  endedAtTail = false;
  player.currentTime = (Number(seek.value) / 1000) * player.duration;
  broadcastPlayback(true);
});

volumeSlider.addEventListener("input", applyVolume);

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
player.addEventListener("ended", () => {
  if (!isController) return;
  if (playMode === "repeat-one") {
    player.currentTime = 0;
    playAsController();
    return;
  }
  if (playMode === "list") {
    const index = listModeNextIndex(1);
    if (index === -1) {
      endedAtTail = true;
      desiredPlaying = false;
      player.pause();
      player.currentTime = player.duration || player.currentTime;
      broadcastPlayback(true);
      updateButtons();
      return;
    }
    selectTrack(index, true);
    return;
  }
  selectTrack(nextIndex(1), true);
});
player.addEventListener("loadedmetadata", () => {
  duration.textContent = formatTime(player.duration);
});
player.addEventListener("timeupdate", () => {
  currentTime.textContent = formatTime(player.currentTime);
  duration.textContent = formatTime(player.duration);
  if (player.duration) seek.value = String(Math.round((player.currentTime / player.duration) * 1000));
});

for (const slider of eqSliders) {
  slider.addEventListener("input", () => {
    eqPreset = "manual";
    selectPreset("manual");
  });
}
eqResetBtn.addEventListener("click", () => {
  if (eqPreset === "manual") {
    for (const slider of eqSliders) slider.value = 0;
    applyEqualizer();
  } else {
    selectPreset("flat");
  }
});

function openEqualizer() {
  eqModal.classList.remove("hidden");
  initEqualizer();
}

function closeEqualizer() {
  eqModal.classList.add("hidden");
}

eqOpenBtn.addEventListener("click", openEqualizer);
eqCloseBtn.addEventListener("click", closeEqualizer);
eqCloseBackdrop.addEventListener("click", closeEqualizer);

for (const button of presetButtons) {
  button.addEventListener("click", () => selectPreset(button.dataset.preset));
}

setInterval(() => {
  if (!isController || !player.src || player.paused || remoteUpdate) return;
  broadcastPlayback(true);
}, 400);

setInterval(() => {
  if (isController || !pendingPlayback || !pendingPlayback.playing || player.paused) return;
  syncClock(pendingPlayback);
}, 250);

setInterval(sendPing, 1000);
applyVolume();
selectPreset("flat");
updateModeButton();
updateSyncMetrics();
connect();
