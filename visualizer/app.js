"use strict";

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/* ---------------- Settings ---------------- */

const STORE = "pulse-settings-v1";
const DEFAULTS = {
  mode: "bars",
  palette: "neon",
  hueShift: 0,
  colorCycle: 0,
  sensitivity: 1,
  autoGain: true,
  smoothing: 0.75,
  beatSens: 5,
  bars: 64,
  mirror: true,
  glow: 0.6,
  trails: 0.2,
  beatPulse: true,
  beatFlash: false,
  speed: 1,
  autoCycle: false,
  cycleSecs: 30,
  keepAwake: true,
  showFps: false,
};
let S = { ...DEFAULTS };
try { Object.assign(S, JSON.parse(localStorage.getItem(STORE) || "{}")); } catch (e) { /* storage unavailable */ }
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* ignore */ } };

/* ---------------- Palettes ---------------- */

// Stops are [hue, saturation, lightness]; hues may run past 0/360 so linear interpolation goes the intended way.
const PALETTES = {
  neon:    { name: "Neon",    stops: [[185, 100, 55], [265, 100, 62], [315, 100, 60]] },
  sunset:  { name: "Sunset",  stops: [[45, 100, 62], [15, 100, 60], [-20, 80, 55], [-85, 60, 45]] },
  ocean:   { name: "Ocean",   stops: [[165, 100, 55], [200, 100, 55], [232, 80, 55]] },
  fire:    { name: "Fire",    stops: [[55, 100, 70], [32, 100, 55], [5, 100, 52], [-10, 90, 38]] },
  aurora:  { name: "Aurora",  stops: [[145, 100, 58], [175, 85, 50], [255, 100, 68]] },
  candy:   { name: "Candy",   stops: [[330, 100, 70], [280, 90, 72], [195, 100, 70]] },
  rainbow: { name: "Rainbow", stops: [[0, 100, 60], [120, 100, 55], [240, 100, 65], [330, 100, 62]] },
  mono:    { name: "Mono",    stops: [[210, 10, 96], [210, 30, 62]] },
};
let hueOffset = 0;

function palHSL(t) {
  const st = PALETTES[S.palette]?.stops || PALETTES.neon.stops;
  t = clamp(t, 0, 1) * (st.length - 1);
  const i = Math.min(Math.floor(t), st.length - 2);
  const f = t - i, a = st[i], b = st[i + 1];
  return [lerp(a[0], b[0], f) + hueOffset, lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
}
function col(t, alpha = 1, lAdd = 0) {
  const [h, s, l] = palHSL(t);
  return `hsla(${((h % 360) + 360) % 360},${s}%,${clamp(l + lAdd, 0, 100)}%,${alpha})`;
}
function gradient(ctx, x0, y0, x1, y1, alpha = 1) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (let i = 0; i <= 4; i++) g.addColorStop(i / 4, col(i / 4, alpha));
  return g;
}

/* ---------------- Audio ---------------- */

// iOS Safari is picky about audio, so the mic and the file player each get their
// own AudioContext ("graph"):
// - the mic graph is created *after* the microphone is granted, so it runs at the
//   mic's sample rate and in the play-and-record session (one created earlier can
//   end up analysing silence once iOS switches the session for the mic);
// - the file graph is created inside a tap, after the session is set to playback;
// - the iOS audio session type is only changed while no graph is running, since
//   changing it underneath a running context can interrupt it;
// - each analyser feeds a muted gain into the speakers, because WebKit only
//   processes nodes that lead to the destination.
const AC = window.AudioContext || window.webkitAudioContext;
const audioEl = $("#audio");
let micGraph = null, fileGraph = null, micStream = null;
let actx = null, analyser = null; // whichever graph is active
let freqBytes, timeFloats, bandMap = null;
let source = null; // "mic" | "file"

function makeGraph() {
  const ctx = new AC();
  const an = ctx.createAnalyser();
  an.fftSize = 4096;
  an.minDecibels = -90;
  an.maxDecibels = -20;
  an.smoothingTimeConstant = S.smoothing;
  const mute = ctx.createGain();
  mute.gain.value = 0;
  an.connect(mute);
  mute.connect(ctx.destination);
  ctx.onstatechange = () => { if (ctx === actx && ctx.state !== "running" && ctx.state !== "closed") resumeAudio(); };
  return { ctx, an };
}

function activate(graph) {
  actx = graph.ctx;
  analyser = graph.an;
  freqBytes = new Uint8Array(analyser.frequencyBinCount);
  timeFloats = new Float32Array(analyser.fftSize);
  bandMap = null;
  bassHist.length = 0;
  resumeAudio();
}

function resumeAudio() {
  if (actx && actx.state !== "running" && actx.state !== "closed") actx.resume().catch(() => {});
}

function setAudioSessionType(type) {
  // Safari 16.4+: "playback" lets file audio play with the silent switch on;
  // "auto" lets Safari pick play-and-record while the microphone is on.
  try { if (navigator.audioSession && navigator.audioSession.type !== type) navigator.audioSession.type = type; } catch (e) { /* unsupported */ }
}

async function useMic() {
  if (source === "mic" && micStream) return true;
  audioEl.pause();
  if (fileGraph) fileGraph.ctx.suspend().catch(() => {});
  setAudioSessionType("auto");
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("unsupported");
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    showMicError(err);
    if (source === "file" && fileGraph) resumeAudio();
    return false;
  }
  micGraph = makeGraph();
  micGraph.ctx.createMediaStreamSource(micStream).connect(micGraph.an); // analysed only, never played back
  activate(micGraph);
  micStream.getAudioTracks().forEach((t) => t.addEventListener("ended", () => {
    if (source === "mic") toast("Microphone stopped — tap 🎤 to restart");
  }));
  setSource("mic");
  return true;
}

function stopMic() {
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (micGraph) micGraph.ctx.close().catch(() => {});
  micStream = micGraph = null;
}

// Must run inside a tap so iOS lets the context start.
function prepareFileAudio() {
  if (source === "mic") stopMic();
  setAudioSessionType("playback");
  if (!fileGraph) {
    fileGraph = makeGraph();
    const src = fileGraph.ctx.createMediaElementSource(audioEl);
    src.connect(fileGraph.an);
    src.connect(fileGraph.ctx.destination);
  }
  activate(fileGraph);
}

function setSource(kind) {
  source = kind;
  silentSince = 0;
  $("#no-sound").hidden = true;
  $("#btn-source").textContent = kind === "mic" ? "🎤" : "🎵";
  $("#player").hidden = $("#file-btns").hidden = kind !== "file";
  requestWakeLock();
}

function showMicError(err) {
  const name = err && err.name;
  let msg = `Pulse couldn't access the microphone${name ? ` (${name})` : ""}.`;
  if (name === "NotAllowedError") {
    msg = "Microphone access was denied. On iPhone, tap “aA” in the address bar → Website Settings → Microphone → Allow (or Settings → Apps → Safari → Microphone), then try again.";
  } else if (!navigator.mediaDevices) {
    msg = "This browser doesn't support microphone input here. Make sure the page is opened over https.";
  }
  $("#mic-error-text").textContent = msg;
  $("#mic-error").hidden = false;
}

/* ---- File playlist ---- */

let playlist = [], trackIdx = 0, objectUrl = null;

function openFiles() { prepareFileAudio(); $("#file-input").click(); }

$("#file-input").addEventListener("change", (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  playlist = files;
  setSource("file");
  hideStart();
  playTrack(0);
});

function trackName(f) { return f.name.replace(/\.[^.]+$/, ""); }

function playTrack(i) {
  if (!playlist.length) return;
  trackIdx = (i + playlist.length) % playlist.length;
  const f = playlist[trackIdx];
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(f);
  audioEl.src = objectUrl;
  playAudio();
  $("#track-title").textContent = trackName(f);
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: trackName(f), artist: "Pulse Visualizer" });
  }
  showControls();
}

function playAudio() {
  resumeAudio();
  // iOS may refuse to start playback outside a tap (e.g. right after the file picker)
  audioEl.play().catch(() => { showControls(); toast("Tap ▶︎ to start"); });
}

function togglePlay() {
  if (source !== "file") return;
  if (audioEl.paused) playAudio();
  else audioEl.pause();
}

audioEl.addEventListener("ended", () => { if (trackIdx < playlist.length - 1) playTrack(trackIdx + 1); });
audioEl.addEventListener("play", () => { $("#btn-play").textContent = "⏸"; });
audioEl.addEventListener("pause", () => { $("#btn-play").textContent = "▶︎"; });

const fmtTime = (s) => (isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "0:00");
let seeking = false;
audioEl.addEventListener("timeupdate", () => {
  $("#track-time").textContent = `${fmtTime(audioEl.currentTime)} / ${fmtTime(audioEl.duration)}`;
  if (!seeking && audioEl.duration) $("#seek").value = (audioEl.currentTime / audioEl.duration) * 1000;
});
$("#seek").addEventListener("input", () => { seeking = true; });
$("#seek").addEventListener("change", () => {
  if (audioEl.duration) audioEl.currentTime = ($("#seek").value / 1000) * audioEl.duration;
  seeking = false;
});

if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler("play", () => playAudio());
  ms.setActionHandler("pause", () => audioEl.pause());
  ms.setActionHandler("previoustrack", () => playTrack(trackIdx - 1));
  ms.setActionHandler("nexttrack", () => playTrack(trackIdx + 1));
}

/* ---------------- Analysis ---------------- */

const MAX_BARS = 128;
const bars = new Float32Array(MAX_BARS);
const peaks = new Float32Array(MAX_BARS);
const A = { level: 0, bass: 0, mid: 0, treble: 0, beat: 0, beatCount: 0, lastBeat: 0 };
let autoPeak = 0.3, rawLevel = 0, silentSince = 0;
const bassHist = [];

function buildBandMap(n) {
  const binHz = actx.sampleRate / analyser.fftSize;
  const fMin = 35, fMax = Math.min(16000, actx.sampleRate / 2);
  const map = [];
  for (let i = 0; i < n; i++) {
    const lo = fMin * Math.pow(fMax / fMin, i / n);
    const hi = fMin * Math.pow(fMax / fMin, (i + 1) / n);
    map.push({ lo: lo / binHz, hi: hi / binHz, c: Math.sqrt(lo * hi) / binHz, tilt: 1 + (i / n) * 0.5 });
  }
  return { n, binHz, map };
}

function analyse(now) {
  const n = S.bars;
  if (!analyser) { bars.fill(0); return; }
  if (!bandMap || bandMap.n !== n) bandMap = buildBandMap(n);
  analyser.smoothingTimeConstant = S.smoothing;
  analyser.getByteFrequencyData(freqBytes);
  analyser.getFloatTimeDomainData(timeFloats);

  const d = freqBytes;
  let sum = 0;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const b = bandMap.map[i];
    let v;
    if (b.hi - b.lo < 1) {
      // narrower than one FFT bin: interpolate at the band centre
      const k = Math.floor(b.c), f = b.c - k;
      v = lerp(d[k], d[k + 1], f);
    } else {
      v = 0;
      for (let k = Math.floor(b.lo); k < Math.ceil(b.hi); k++) if (d[k] > v) v = d[k];
    }
    v = Math.pow(v / 255, 1.5) * b.tilt;
    raw[i] = v;
    sum += v;
  }
  const level = sum / n;
  rawLevel = level;
  checkSilence(level, now);

  // Auto gain keeps quiet rooms and loud speakers both filling the screen.
  autoPeak = Math.max(level, autoPeak * 0.997, 0.04);
  const gain = S.sensitivity * (S.autoGain ? clamp(0.32 / autoPeak, 0.7, 6) : 1.4);

  let bass = 0, mid = 0, tre = 0;
  for (let i = 0; i < n; i++) {
    const v = clamp(raw[i] * gain, 0, 1);
    bars[i] = v > bars[i] ? v : bars[i] + (v - bars[i]) * 0.3;
    peaks[i] = Math.max(bars[i], peaks[i] - 0.008 * S.speed);
    const r = i / n;
    if (r < 0.2) bass += bars[i]; else if (r < 0.6) mid += bars[i]; else tre += bars[i];
  }
  A.bass = bass / Math.max(1, Math.round(n * 0.2));
  A.mid = mid / Math.max(1, Math.round(n * 0.4));
  A.treble = tre / Math.max(1, n - Math.round(n * 0.6));
  A.level = clamp(level * gain, 0, 1);
  A.gain = gain;

  // Beat detection: low-frequency energy spiking above its recent average.
  const lo = Math.floor(40 / bandMap.binHz), hi = Math.ceil(150 / bandMap.binHz);
  let e = 0;
  for (let k = lo; k <= hi; k++) e += d[k] / 255;
  e /= hi - lo + 1;
  bassHist.push(e);
  if (bassHist.length > 50) bassHist.shift();
  const avg = bassHist.reduce((a, b) => a + b, 0) / bassHist.length;
  const thresh = lerp(1.45, 1.06, (S.beatSens - 1) / 9);
  A.beat *= 0.88;
  if (e > avg * thresh && e > 0.18 && now - A.lastBeat > 260) {
    A.beat = 1;
    A.beatCount++;
    A.lastBeat = now;
    onBeat();
  }
}

// If nothing reaches the analyser for a while, say so instead of sitting there flat.
function checkSilence(level, now) {
  const expectSound = source === "mic" || (source === "file" && !audioEl.paused);
  if (!expectSound || level > 0.002) {
    silentSince = 0;
    if (!$("#no-sound").hidden && level > 0.002) $("#no-sound").hidden = true;
    return;
  }
  if (!silentSince) silentSince = now;
  if (now - silentSince > 4000 && $("#no-sound").hidden) {
    $("#no-sound-text").textContent = source === "mic"
      ? "No sound is reaching the microphone. Turn the music up and hold the phone near the speaker, or tap here to restart the mic."
      : "The song is playing but no sound is reaching the visualizer. Tap here to retry.";
    $("#no-sound").hidden = false;
  }
}

$("#no-sound").addEventListener("click", async () => {
  $("#no-sound").hidden = true;
  silentSince = 0;
  if (source === "mic") { stopMic(); source = null; await useMic(); }
  else { resumeAudio(); if (audioEl.paused) playAudio(); }
});

/* ---------------- Canvas ---------------- */

const stage = $("#stage");
const dctx = stage.getContext("2d");
const scene = document.createElement("canvas");
const sctx = scene.getContext("2d");
const glowC = document.createElement("canvas");
const gctx = glowC.getContext("2d");
let W = 0, H = 0, DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  for (const c of [stage, scene]) { c.width = Math.round(W * DPR); c.height = Math.round(H * DPR); }
  glowC.width = Math.max(1, Math.round(W / 6));
  glowC.height = Math.max(1, Math.round(H / 6));
  sctx.fillStyle = "#05060a";
  sctx.fillRect(0, 0, scene.width, scene.height);
}
window.addEventListener("resize", resize);
resize();

/* ---------------- Visualizations ---------------- */

const BG = "5,6,10";
const ridgeHist = [];
let particles = [];
let rings = [];
let rot = 0;

function onBeat() {
  if (S.mode === "rings") spawnRing();
  if (S.mode === "particles") burst(40);
}

const MODES = [
  { id: "bars", name: "Bars", draw: drawBars },
  { id: "radial", name: "Radial", draw: drawRadial },
  { id: "wave", name: "Waveform", draw: drawWave },
  { id: "particles", name: "Particles", draw: drawParticles },
  { id: "rings", name: "Rings", draw: drawRings },
  { id: "ridges", name: "Ridges", draw: drawRidges },
];

function pulse() { return S.beatPulse ? A.beat : 0; }

function drawBars(c, dt) {
  const n = S.bars;
  const count = S.mirror ? n * 2 : n;
  const bw = W / count;
  const gap = Math.max(1, bw * 0.22);
  const base = H * 0.8;
  const maxH = H * 0.66 * (1 + pulse() * 0.12);
  const r = Math.min((bw - gap) / 2, 6);
  for (let j = 0; j < count; j++) {
    const i = S.mirror ? (j < n ? n - 1 - j : j - n) : j;
    const v = bars[i];
    const h = Math.max(2, v * maxH);
    const x = j * bw + gap / 2;
    const w = bw - gap;
    c.fillStyle = col(i / (n - 1), 1, v * 12);
    roundRect(c, x, base - h, w, h, r);
    // reflection
    c.fillStyle = col(i / (n - 1), 0.18);
    c.fillRect(x, base + 3, w, h * 0.3);
    // falling peak caps
    c.fillStyle = col(i / (n - 1), 0.9, 25);
    c.fillRect(x, base - peaks[i] * maxH - 6, w, 3);
  }
}

function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, h / 2, w / 2);
  c.beginPath();
  c.moveTo(x, y + h);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h);
  c.closePath();
  c.fill();
}

function drawRadial(c, dt) {
  const n = S.bars;
  const cx = W / 2, cy = H / 2;
  const m = Math.min(W, H);
  const baseR = m * 0.16 * (1 + pulse() * 0.18 + A.bass * 0.15);
  rot += dt * 0.12 * S.speed * (1 + A.level);
  const count = S.mirror ? n * 2 : n;
  const lw = Math.max(1.5, ((Math.PI * 2 * baseR) / count) * 0.6);
  c.lineCap = "round";
  c.lineWidth = lw;
  for (let j = 0; j < count; j++) {
    const i = S.mirror ? (j < n ? j : count - 1 - j) : j;
    const v = bars[i];
    const a = rot + (j / count) * Math.PI * 2 - Math.PI / 2;
    const len = 4 + v * m * 0.32;
    const cos = Math.cos(a), sin = Math.sin(a);
    c.strokeStyle = col(i / (n - 1), 1, v * 15);
    c.beginPath();
    c.moveTo(cx + cos * baseR, cy + sin * baseR);
    c.lineTo(cx + cos * (baseR + len), cy + sin * (baseR + len));
    c.stroke();
  }
  // core
  const g = c.createRadialGradient(cx, cy, 0, cx, cy, baseR * 0.92);
  g.addColorStop(0, col(0.5, 0.25 + A.bass * 0.5, 20));
  g.addColorStop(1, col(0, 0.05));
  c.fillStyle = g;
  c.beginPath();
  c.arc(cx, cy, baseR * 0.92, 0, Math.PI * 2);
  c.fill();
  c.lineWidth = 2;
  c.strokeStyle = col(0.2, 0.8);
  c.stroke();
}

function drawWave(c, dt) {
  const td = timeFloats;
  if (!td) return;
  const cy = H / 2;
  const amp = H * 0.32 * (A.gain || 1) * 0.5 * (1 + pulse() * 0.2);
  // align on a rising zero crossing so the wave doesn't jitter sideways
  let start = 0;
  for (let i = 1; i < td.length / 2; i++) if (td[i - 1] < 0 && td[i] >= 0) { start = i; break; }
  const len = Math.min(1600, td.length - start);
  const step = Math.max(1, Math.floor(len / 400));
  const layers = S.mirror ? [[1, 1, 3], [-1, 0.35, 2]] : [[1, 1, 3]];
  c.lineJoin = "round";
  for (const [sign, alpha, w] of layers) {
    c.strokeStyle = gradient(c, 0, 0, W, 0, alpha);
    c.lineWidth = w + A.bass * 3;
    c.beginPath();
    for (let i = 0; i <= len; i += step) {
      const x = (i / len) * W;
      const y = cy + sign * clamp(td[start + i] * amp, -H * 0.45, H * 0.45);
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
  }
  // faint frequency floor
  const n = S.bars, bw = W / n;
  for (let i = 0; i < n; i++) {
    c.fillStyle = col(i / (n - 1), 0.12);
    const h = bars[i] * H * 0.25;
    c.fillRect(i * bw, H - h, bw - 1, h);
  }
}

function burst(k) {
  const n = S.bars;
  for (let j = 0; j < k; j++) {
    const i = Math.floor(Math.random() * n);
    const a = Math.random() * Math.PI * 2;
    const sp = (1.5 + Math.random() * 3 + bars[i] * 6) * S.speed;
    particles.push({ x: W / 2, y: H / 2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: i / (n - 1), size: 1 + bars[i] * 4 + Math.random() * 2, life: 1 });
  }
  if (particles.length > 900) particles.splice(0, particles.length - 900);
}

function drawParticles(c, dt) {
  const f = dt * 60;
  burst(Math.floor(A.level * 10 * S.speed + Math.random()));
  const cx = W / 2, cy = H / 2;
  const diag = Math.hypot(W, H) / 2;
  c.globalCompositeOperation = "lighter";
  const boost = 1 + A.level * 0.06;
  particles = particles.filter((p) => {
    p.vx *= Math.pow(1.012 * boost, f);
    p.vy *= Math.pow(1.012 * boost, f);
    p.x += p.vx * f;
    p.y += p.vy * f;
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d > diag + 20) return false;
    const s = p.size * (0.6 + d / diag);
    c.fillStyle = col(p.t, clamp(0.25 + d / diag, 0, 1), 10);
    c.beginPath();
    c.arc(p.x, p.y, s, 0, Math.PI * 2);
    c.fill();
    return true;
  });
  c.globalCompositeOperation = "source-over";
  const r = Math.min(W, H) * (0.05 + A.bass * 0.08 + pulse() * 0.04);
  const g = c.createRadialGradient(cx, cy, 0, cx, cy, r * 2.5);
  g.addColorStop(0, col(0.1, 0.9, 30));
  g.addColorStop(0.4, col(0.5, 0.35));
  g.addColorStop(1, col(1, 0));
  c.fillStyle = g;
  c.beginPath();
  c.arc(cx, cy, r * 2.5, 0, Math.PI * 2);
  c.fill();
}

let lastRing = 0;
function spawnRing() {
  rings.push({ r: Math.min(W, H) * 0.08, t: (A.beatCount % 8) / 7, w: 2 + A.bass * 6, spin: Math.random() * Math.PI });
  if (rings.length > 40) rings.shift();
  lastRing = performance.now();
}

function drawRings(c, dt) {
  const f = dt * 60;
  const n = S.bars;
  const cx = W / 2, cy = H / 2;
  const maxR = Math.hypot(W, H) / 2;
  // keep it alive even without a detectable beat
  if (A.level > 0.06 && performance.now() - lastRing > 900) spawnRing();
  const pts = 96;
  rings = rings.filter((ring) => {
    ring.r += (1.5 + A.level * 7) * S.speed * f * (0.6 + ring.r / maxR);
    if (ring.r > maxR + 40) return false;
    const fade = 1 - ring.r / maxR;
    c.strokeStyle = col(ring.t, clamp(fade, 0, 1));
    c.lineWidth = ring.w * (0.5 + fade);
    shapePath(c, cx, cy, ring.r, 0.18, pts, ring.spin);
    c.stroke();
    return true;
  });
  // live spectrum blob in the centre
  const baseR = Math.min(W, H) * (0.12 + pulse() * 0.03);
  c.fillStyle = col(0.15, 0.25);
  c.strokeStyle = col(0.15, 1, 15);
  c.lineWidth = 3;
  shapePath(c, cx, cy, baseR, 0.6, pts, rot);
  c.fill();
  c.stroke();
  rot += dt * 0.3 * S.speed;

  function shapePath(c, cx, cy, r, depth, pts, spin) {
    c.beginPath();
    for (let k = 0; k <= pts; k++) {
      const u = k / pts;
      // mirror the spectrum around the circle so the shape closes smoothly
      const bi = Math.floor((u < 0.5 ? u * 2 : (1 - u) * 2) * (n - 1));
      const rr = r * (1 + bars[bi] * depth);
      const a = spin + u * Math.PI * 2;
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (k === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.closePath();
  }
}

let ridgeTimer = 0;
function drawRidges(c, dt) {
  const n = S.bars;
  ridgeTimer += dt * S.speed;
  if (ridgeTimer > 0.05 || !ridgeHist.length) {
    ridgeTimer = 0;
    ridgeHist.push(Float32Array.from(bars.subarray(0, n)));
    if (ridgeHist.length > 32) ridgeHist.shift();
  }
  const rows = ridgeHist.length;
  const top = H * 0.18, bottom = H * 0.82;
  const spacing = (bottom - top) / 32;
  const amp = H * 0.15 * (1 + pulse() * 0.15);
  const left = W * 0.08, width = W * 0.84;
  const pts = S.mirror ? n * 2 : n;
  c.lineWidth = 1.6;
  c.lineJoin = "round";
  for (let r = 0; r < rows; r++) {
    const snap = ridgeHist[r];
    if (snap.length !== n) continue;
    const y0 = top + (32 - rows + r) * spacing;
    const age = r / Math.max(1, rows - 1);
    c.beginPath();
    c.moveTo(left, y0);
    for (let k = 0; k < pts; k++) {
      const i = S.mirror ? (k < n ? n - 1 - k : k - n) : k;
      const x = left + (k / (pts - 1)) * width;
      const env = Math.sin((k / (pts - 1)) * Math.PI); // taper edges
      c.lineTo(x, y0 - snap[i] * amp * (0.3 + 0.7 * env));
    }
    c.lineTo(left + width, y0);
    c.fillStyle = `rgb(${BG})`;
    c.fill();
    c.strokeStyle = col(age, 0.25 + age * 0.75, age * 10);
    c.stroke();
  }
}

/* ---------------- Render loop ---------------- */

let cycleHue = 0, lastT = performance.now(), modeTimer = 0, fpsAcc = 0, fpsFrames = 0, fps = 0, pendingCycle = false;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  analyse(now);
  cycleHue = (cycleHue + S.colorCycle * dt) % 360;
  hueOffset = S.hueShift + cycleHue;

  if (S.autoCycle && source) {
    modeTimer += dt;
    if (modeTimer > S.cycleSecs) pendingCycle = true;
    // switch on a beat if possible, otherwise give up waiting after 4s
    if (pendingCycle && (A.beat === 1 || modeTimer > S.cycleSecs + 4)) {
      pendingCycle = false;
      modeTimer = 0;
      stepMode(1);
    }
  }

  const sw = scene.width, sh = scene.height;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.globalCompositeOperation = "source-over";
  sctx.globalAlpha = 1;
  sctx.fillStyle = `rgba(${BG},${1 - S.trails * 0.92})`;
  sctx.fillRect(0, 0, sw, sh);
  sctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  const mode = MODES.find((m) => m.id === S.mode) || MODES[0];
  mode.draw(sctx, dt);

  if (S.beatFlash && A.beat > 0.05) {
    sctx.fillStyle = col(0.5, A.beat * 0.22, 30);
    sctx.fillRect(0, 0, W, H);
  }

  dctx.globalCompositeOperation = "source-over";
  dctx.globalAlpha = 1;
  dctx.drawImage(scene, 0, 0);
  if (S.glow > 0) {
    gctx.imageSmoothingQuality = "high";
    gctx.clearRect(0, 0, glowC.width, glowC.height);
    gctx.drawImage(scene, 0, 0, glowC.width, glowC.height);
    dctx.globalCompositeOperation = "lighter";
    dctx.globalAlpha = S.glow;
    dctx.imageSmoothingQuality = "high";
    dctx.drawImage(glowC, 0, 0, stage.width, stage.height);
    dctx.globalAlpha = 1;
    dctx.globalCompositeOperation = "source-over";
  }

  if (S.showFps) {
    fpsAcc += dt; fpsFrames++;
    if (fpsAcc > 0.5) { fps = Math.round(fpsFrames / fpsAcc); fpsAcc = 0; fpsFrames = 0; }
    $("#hud").textContent = `${fps} fps\nsource ${source || "none"}\naudio ${actx ? `${actx.state} ${actx.sampleRate}Hz` : "off"}\ninput ${rawLevel.toFixed(3)}\nlevel ${A.level.toFixed(2)}\ngain ×${(A.gain || 0).toFixed(1)}\nbeats ${A.beatCount}`;
  }
}
requestAnimationFrame(frame);

/* ---------------- UI ---------------- */

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 1400);
}

function setMode(id, announce = true) {
  S.mode = id;
  save();
  particles = []; rings = []; ridgeHist.length = 0;
  const m = MODES.find((x) => x.id === id) || MODES[0];
  $("#mode-label").textContent = m.name;
  if (announce) toast(m.name);
  syncSettingsUI();
}
function stepMode(d) {
  const i = MODES.findIndex((m) => m.id === S.mode);
  setMode(MODES[(i + d + MODES.length) % MODES.length].id);
}

let hideTimer;
function showControls() {
  $("#controls").classList.remove("hidden");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { if (!sheetOpen()) $("#controls").classList.add("hidden"); }, 4000);
}
function toggleControls() {
  if ($("#controls").classList.contains("hidden")) showControls();
  else { clearTimeout(hideTimer); $("#controls").classList.add("hidden"); }
}

const sheetOpen = () => !$("#settings-sheet").hidden || !$("#source-sheet").hidden;
function openSheet(id) {
  closeSheets();
  $(id).hidden = false;
  $("#scrim").hidden = false;
  clearTimeout(hideTimer);
}
function closeSheets() {
  $("#settings-sheet").hidden = true;
  $("#source-sheet").hidden = true;
  $("#scrim").hidden = true;
  showControls();
}

function hideStart() { $("#start").hidden = true; showControls(); }

// gestures on the canvas: tap toggles controls, horizontal swipe changes mode
let touch0 = null;
stage.addEventListener("pointerdown", (e) => { touch0 = { x: e.clientX, y: e.clientY, t: performance.now() }; });
stage.addEventListener("pointerup", (e) => {
  if (!touch0) return;
  const dx = e.clientX - touch0.x, dy = e.clientY - touch0.y;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) stepMode(dx < 0 ? 1 : -1);
  else if (Math.hypot(dx, dy) < 12) toggleControls();
  touch0 = null;
});

$("#start-mic").addEventListener("click", async () => { if (await useMic()) hideStart(); });
$("#start-file").addEventListener("click", openFiles);
$("#mic-error-ok").addEventListener("click", () => { $("#mic-error").hidden = true; });
$("#btn-source").addEventListener("click", () => openSheet("#source-sheet"));
$("#src-mic").addEventListener("click", async () => { if (await useMic()) closeSheets(); });
$("#src-file").addEventListener("click", () => { closeSheets(); openFiles(); });
$("#btn-prev-mode").addEventListener("click", () => { stepMode(-1); showControls(); });
$("#btn-next-mode").addEventListener("click", () => { stepMode(1); showControls(); });
$("#btn-mode").addEventListener("click", () => { stepMode(1); showControls(); });
$("#btn-play").addEventListener("click", () => { togglePlay(); showControls(); });
$("#btn-prev-track").addEventListener("click", () => {
  if (audioEl.currentTime > 3) audioEl.currentTime = 0; else playTrack(trackIdx - 1);
});
$("#btn-next-track").addEventListener("click", () => playTrack(trackIdx + 1));
$("#btn-settings").addEventListener("click", () => openSheet("#settings-sheet"));
$("#scrim").addEventListener("click", closeSheets);
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeSheets));
$("#controls").addEventListener("pointerdown", showControls);

/* ---- Settings sheet ---- */

const pct = (v) => `${Math.round(v * 100)}%`;
const SCHEMA = [
  { group: "Visualization" },
  { key: "mode", type: "chips", options: () => MODES.map((m) => [m.id, m.name]), onChange: (v) => setMode(v, false) },
  { group: "Colors" },
  { key: "palette", type: "chips", swatch: true, options: () => Object.entries(PALETTES).map(([k, p]) => [k, p.name]) },
  { key: "hueShift", label: "Hue shift", type: "range", min: 0, max: 359, step: 1, fmt: (v) => `${v}°` },
  { key: "colorCycle", label: "Color cycling", type: "range", min: 0, max: 90, step: 1, fmt: (v) => (v ? `${v}°/s` : "Off") },
  { group: "Audio response" },
  { key: "sensitivity", label: "Sensitivity", type: "range", min: 0.3, max: 3, step: 0.05, fmt: (v) => `×${v.toFixed(2)}` },
  { key: "autoGain", label: "Auto level", type: "toggle", hint: "Adapts to quiet or loud rooms. Turn off for raw levels." },
  { key: "smoothing", label: "Smoothing", type: "range", min: 0, max: 0.95, step: 0.05, fmt: pct },
  { key: "beatSens", label: "Beat sensitivity", type: "range", min: 1, max: 10, step: 1, fmt: (v) => `${v}` },
  { group: "Look" },
  { key: "bars", label: "Detail (bands)", type: "range", min: 16, max: MAX_BARS, step: 8, fmt: (v) => `${v}` },
  { key: "mirror", label: "Mirror / symmetry", type: "toggle" },
  { key: "glow", label: "Glow", type: "range", min: 0, max: 1.5, step: 0.05, fmt: (v) => (v ? pct(v) : "Off") },
  { key: "trails", label: "Motion trails", type: "range", min: 0, max: 0.95, step: 0.05, fmt: (v) => (v ? pct(v) : "Off") },
  { key: "speed", label: "Motion speed", type: "range", min: 0.25, max: 3, step: 0.05, fmt: (v) => `×${v.toFixed(2)}` },
  { key: "beatPulse", label: "Pulse on beat", type: "toggle" },
  { key: "beatFlash", label: "Flash on beat", type: "toggle", hint: "Avoid if you're sensitive to flashing lights." },
  { group: "Behavior" },
  { key: "autoCycle", label: "Auto-switch visualizations", type: "toggle" },
  { key: "cycleSecs", label: "Switch every", type: "range", min: 5, max: 120, step: 5, fmt: (v) => `${v}s` },
  { key: "keepAwake", label: "Keep screen awake", type: "toggle", onChange: () => requestWakeLock() },
  { key: "showFps", label: "Show stats", type: "toggle", onChange: (v) => { $("#hud").hidden = !v; } },
];

const controls = {};
function buildSettings() {
  const body = $("#settings-body");
  body.innerHTML = "";
  for (const item of SCHEMA) {
    if (item.group) {
      const h = document.createElement("div");
      h.className = "group-title";
      h.textContent = item.group;
      body.appendChild(h);
      continue;
    }
    const set = (v) => {
      S[item.key] = v;
      save();
      if (item.onChange) item.onChange(v);
      syncSettingsUI();
    };
    let el;
    if (item.type === "chips") {
      el = document.createElement("div");
      el.className = "chips";
      for (const [val, name] of item.options()) {
        const b = document.createElement("button");
        b.className = "chip";
        b.dataset.val = val;
        if (item.swatch) {
          const sw = document.createElement("span");
          sw.className = "swatch";
          sw.style.background = `linear-gradient(90deg, ${PALETTES[val].stops.map(([h, s, l]) => `hsl(${((h % 360) + 360) % 360},${s}%,${l}%)`).join(",")})`;
          b.appendChild(sw);
        }
        b.appendChild(document.createTextNode(name));
        b.addEventListener("click", () => set(val));
        el.appendChild(b);
      }
    } else if (item.type === "range") {
      el = document.createElement("label");
      el.className = "setting slider";
      el.innerHTML = `<div class="lbl"><span></span><span class="val"></span></div><input type="range">`;
      el.querySelector("span").textContent = item.label;
      const input = el.querySelector("input");
      Object.assign(input, { min: item.min, max: item.max, step: item.step });
      input.addEventListener("input", () => set(parseFloat(input.value)));
    } else {
      el = document.createElement("label");
      el.className = "setting";
      el.innerHTML = `<span></span><span class="switch"><input type="checkbox"><span></span></span>`;
      el.querySelector("span").textContent = item.label;
      el.querySelector("input").addEventListener("change", (e) => set(e.target.checked));
    }
    controls[item.key] = { item, el };
    body.appendChild(el);
    if (item.hint) {
      const p = document.createElement("div");
      p.className = "hint";
      p.textContent = item.hint;
      body.appendChild(p);
    }
  }
}

function syncSettingsUI() {
  for (const { item, el } of Object.values(controls)) {
    const v = S[item.key];
    if (item.type === "chips") {
      el.querySelectorAll(".chip").forEach((b) => b.classList.toggle("on", b.dataset.val === String(v)));
    } else if (item.type === "range") {
      const input = el.querySelector("input");
      if (parseFloat(input.value) !== v) input.value = v;
      el.querySelector(".val").textContent = item.fmt(v);
    } else {
      el.querySelector("input").checked = !!v;
    }
  }
}

$("#reset-settings").addEventListener("click", () => {
  S = { ...DEFAULTS };
  save();
  setMode(S.mode, false);
  $("#hud").hidden = !S.showFps;
  syncSettingsUI();
  toast("Settings reset");
});

/* ---- Screen wake lock ---- */

let wakeLock = null;
async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  if (!S.keepAwake || !source) {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    return;
  }
  if (wakeLock || document.visibilityState !== "visible") return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch (e) { /* denied or unsupported */ }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    resumeAudio();
    requestWakeLock();
  }
});
// iOS can suspend the context after interruptions (calls, Siri); a tap brings it back.
document.addEventListener("pointerdown", resumeAudio);

buildSettings();
setMode(S.mode, false);
$("#hud").hidden = !S.showFps;

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
