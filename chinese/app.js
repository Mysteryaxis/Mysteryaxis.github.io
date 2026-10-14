"use strict";

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const DAY = 86400000;
const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const HAN = /\p{Script=Han}/u;

/* ---------- words ---------- */
const WORDS = [];
for (const [deckId, deck] of Object.entries(DECKS)) {
  deck.words.forEach(([zh, py, en], i) => WORDS.push({ id: `${deckId}:${zh}`, deck: deckId, zh, py, en, order: i }));
}
const WORD_BY_ID = Object.fromEntries(WORDS.map((w) => [w.id, w]));

/* ---------- pinyin & tones ---------- */
function toneOf(syl) {
  if (/[āēīōūǖ]/i.test(syl)) return 1;
  if (/[áéíóúǘ]/i.test(syl)) return 2;
  if (/[ǎěǐǒǔǚ]/i.test(syl)) return 3;
  if (/[àèìòùǜ]/i.test(syl)) return 4;
  return 5;
}
const syllables = (w) => w.py.split(" ");
function joinPinyin(w) {
  const s = syllables(w);
  if (w.deck === "phrases") return s;
  // join syllables of a word, adding an apostrophe before a vowel-initial syllable
  return s.map((x, i) => (i > 0 && /^[aeoāáǎàēéěèōóǒò]/i.test(x) ? "'" + x : x));
}
function pinyinHTML(w) {
  const sep = w.deck === "phrases" ? " " : "";
  return joinPinyin(w).map((x, i) => `<span class="t${toneOf(syllables(w)[i])}">${esc(x)}</span>`).join(sep);
}
function hanziHTML(w) {
  const syl = syllables(w);
  let k = 0;
  return [...w.zh].map((ch) => {
    if (!HAN.test(ch)) return esc(ch);
    let t;
    if (ch === "儿" && k > 0 && /r$/.test(syl[k - 1]) && syl.length < [...w.zh].filter((c) => HAN.test(c)).length) t = toneOf(syl[k - 1]);
    else t = syl[k] !== undefined ? toneOf(syl[k++]) : 5;
    return `<span class="t${t}">${esc(ch)}</span>`;
  }).join("");
}
const plainPinyin = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[\s']/g, "").toLowerCase();

/* ---------- storage ---------- */
const STORE_KEY = "hanzi-daily-v1";
const DEFAULTS = { newPerDay: 10, direction: "zh-en", pinyinFront: false, autoplay: true, rate: 0.8, decks: { hsk1: true, phrases: true } };
let S;
function load() {
  try { S = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { S = {}; }
  S.settings = { ...DEFAULTS, ...(S.settings || {}) };
  S.settings.decks = { ...DEFAULTS.decks, ...S.settings.decks };
  S.cards = S.cards || {};
  S.newLog = S.newLog || { day: dayKey(), count: 0 };
  S.streak = S.streak || { last: null, count: 0 };
}
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch {} }
function newToday() { if (S.newLog.day !== dayKey()) S.newLog = { day: dayKey(), count: 0 }; return S.newLog.count; }
function markStudied() {
  const today = dayKey();
  if (S.streak.last === today) return;
  S.streak.count = S.streak.last === dayKey(Date.now() - DAY) ? S.streak.count + 1 : 1;
  S.streak.last = today;
}
function currentStreak() {
  return S.streak.last === dayKey() || S.streak.last === dayKey(Date.now() - DAY) ? S.streak.count : 0;
}
const enabledWords = () => WORDS.filter((w) => S.settings.decks[w.deck]);
function status(w) {
  const c = S.cards[w.id];
  if (!c) return "new";
  return c.ivl >= 7 ? "known" : "learning";
}

/* ---------- speech ---------- */
let zhVoice = null;
function pickVoice() {
  if (!("speechSynthesis" in window)) return;
  const vs = speechSynthesis.getVoices();
  zhVoice = vs.find((v) => /zh[-_]CN/i.test(v.lang) && /tingting|ting-ting/i.test(v.name)) ||
    vs.find((v) => /zh[-_]CN/i.test(v.lang)) || vs.find((v) => /^zh|cmn/i.test(v.lang)) || null;
}
if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function speak(text, rate = S.settings.rate) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/[？?！!。，,]/g, ""));
  u.lang = "zh-CN";
  if (zhVoice) u.voice = zhVoice;
  u.rate = rate;
  speechSynthesis.speak(u);
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-say]");
  if (b) { e.stopPropagation(); speak(b.dataset.say); }
});
const speakBtn = (zh) => `<button class="speak" data-say="${esc(zh)}" aria-label="Play audio">🔊</button>`;

/* ---------- spaced repetition (SM-2 style) ---------- */
function schedule(card, grade, now = Date.now()) {
  const c = card ? { ...card } : { reps: 0, ease: 2.5, ivl: 0, lapses: 0 };
  if (grade === 0) {
    if (c.reps > 0) c.lapses++;
    c.reps = 0; c.ivl = 0; c.ease = Math.max(1.3, c.ease - 0.2);
    c.due = now + 60 * 1000;
    return c;
  }
  let ivl;
  if (c.reps === 0) ivl = [0, 1, 1, 4][grade];
  else if (c.reps === 1) ivl = [0, 2, 3, 6][grade];
  else ivl = [0, c.ivl * 1.2, c.ivl * c.ease, c.ivl * c.ease * 1.3][grade];
  if (grade >= 2 && c.reps > 0) ivl = Math.max(ivl, c.ivl + 1);
  c.ivl = Math.max(1, Math.round(ivl));
  if (grade === 1) c.ease = Math.max(1.3, c.ease - 0.15);
  if (grade === 3) c.ease += 0.15;
  c.reps++;
  // due at 4am local on the target day, so cards come due at the start of a day
  const d = new Date(now + c.ivl * DAY); d.setHours(4, 0, 0, 0);
  c.due = d.getTime();
  return c;
}
function fmtIvl(c, now = Date.now()) {
  const ms = c.due - now;
  if (ms < 3600000) return Math.max(1, Math.round(ms / 60000)) + "m";
  const d = c.ivl;
  return d < 30 ? d + "d" : d < 365 ? Math.round(d / 30) + "mo" : (d / 365).toFixed(1) + "y";
}
const dueWords = (now = Date.now()) => enabledWords().filter((w) => S.cards[w.id] && S.cards[w.id].due <= now).sort((a, b) => S.cards[a.id].due - S.cards[b.id].due);
const unseenWords = () => enabledWords().filter((w) => !S.cards[w.id]);

/* ---------- navigation ---------- */
const TITLES = { home: "Hanzi Daily", review: "Review", quiz: "Quiz", words: "Words", write: "Writing", tones: "Tones" };
let currentView = "home";
function goto(view) {
  currentView = view;
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
  $$(".tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.goto === view));
  $("#title").textContent = TITLES[view];
  window.scrollTo(0, 0);
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (view === "home") renderHome();
  if (view === "review") enterReview();
  if (view === "quiz") quizSetup();
  if (view === "words") renderWords();
  if (view === "write") enterWrite();
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-goto]");
  if (b) goto(b.dataset.goto);
});

/* ---------- home ---------- */
function renderHome() {
  const now = Date.now();
  const remainingNew = Math.max(0, S.settings.newPerDay - newToday());
  $("#stat-due").textContent = dueWords(now).length;
  $("#stat-new").textContent = Math.min(remainingNew, unseenWords().length);
  $("#stat-learned").textContent = WORDS.filter((w) => S.cards[w.id]).length;
  $("#stat-streak").textContent = currentStreak();
  $("#deck-progress").innerHTML = Object.entries(DECKS).map(([id, d]) => {
    const ws = WORDS.filter((w) => w.deck === id);
    const known = ws.filter((w) => status(w) === "known").length;
    const learning = ws.filter((w) => status(w) === "learning").length;
    return `<div class="deck-bar"><div class="label"><span>${esc(d.name)}</span><span>${known} known · ${learning} learning · ${ws.length} total</span></div>
      <div class="meter"><i class="known" style="width:${(known / ws.length) * 100}%"></i><i class="learning" style="width:${(learning / ws.length) * 100}%"></i></div></div>`;
  }).join("");
  const st = S.settings;
  $("#set-newPerDay").value = String(st.newPerDay);
  $("#set-direction").value = st.direction;
  $("#set-pinyinFront").checked = st.pinyinFront;
  $("#set-autoplay").checked = st.autoplay;
  $("#set-rate").value = st.rate;
  $("#set-decks").innerHTML = Object.entries(DECKS).map(([id, d]) =>
    `<label><input type="checkbox" data-deck="${id}" ${st.decks[id] ? "checked" : ""}>${esc(d.name)}</label>`).join("");
  if (navigator.standalone || matchMedia("(display-mode: standalone)").matches) $("#install-hint").classList.add("hidden");
}
$("#set-newPerDay").onchange = (e) => { S.settings.newPerDay = +e.target.value; save(); session = null; renderHome(); };
$("#set-direction").onchange = (e) => { S.settings.direction = e.target.value; save(); };
$("#set-pinyinFront").onchange = (e) => { S.settings.pinyinFront = e.target.checked; save(); };
$("#set-autoplay").onchange = (e) => { S.settings.autoplay = e.target.checked; save(); };
$("#set-rate").onchange = (e) => { S.settings.rate = +e.target.value; save(); speak("你好"); };
$("#set-decks").onchange = (e) => {
  const id = e.target.dataset.deck;
  S.settings.decks[id] = e.target.checked;
  if (!Object.values(S.settings.decks).some(Boolean)) { S.settings.decks[id] = true; e.target.checked = true; }
  save(); session = null; renderHome();
};
$("#reset").onclick = () => {
  if (!confirm("Reset all progress? This cannot be undone.")) return;
  S.cards = {}; S.newLog = { day: dayKey(), count: 0 }; S.streak = { last: null, count: 0 };
  save(); session = null; renderHome();
};
$("#start-review").onclick = () => goto("review");

/* ---------- review ---------- */
let session = null; // { queue: [{id, isNew, dir}], done, revealed }
function buildSession(extraNew = 0) {
  const now = Date.now();
  const due = dueWords(now).map((w) => ({ id: w.id, isNew: false }));
  const nNew = Math.max(0, S.settings.newPerDay - newToday()) + extraNew;
  const fresh = unseenWords().slice(0, nNew).map((w) => ({ id: w.id, isNew: true }));
  // interleave new cards among reviews
  const queue = [];
  const step = fresh.length ? Math.max(1, Math.floor(due.length / fresh.length)) : 0;
  let di = 0;
  for (const f of fresh) { for (let k = 0; k < step && di < due.length; k++) queue.push(due[di++]); queue.push(f); }
  while (di < due.length) queue.push(due[di++]);
  queue.forEach((q) => (q.dir = cardDir()));
  session = { queue, done: 0, extra: extraNew };
}
function cardDir() { const d = S.settings.direction; return d === "mixed" ? pick(["zh-en", "en-zh"]) : d; }
function enterReview() {
  if (!session || !session.queue.length) buildSession();
  showCard();
}
function showCard() {
  const q = session.queue[0];
  const total = session.done + session.queue.length;
  $("#review-bar").style.width = total ? (session.done / total) * 100 + "%" : "100%";
  const has = !!q;
  $("#review-card").classList.toggle("hidden", !has);
  $("#review-actions").classList.toggle("hidden", !has);
  $("#review-done").classList.toggle("hidden", has);
  if (!has) { $("#more-new").classList.toggle("hidden", !unseenWords().length); return; }
  const w = WORD_BY_ID[q.id];
  const front = $(".fc-front"), back = $(".fc-back");
  const long = [...w.zh].length > 3 ? " long" : "";
  const tag = q.isNew ? `<span class="tag">new</span>` : "";
  if (q.dir === "zh-en") {
    front.innerHTML = `${tag}<div class="hanzi${long}">${hanziHTML(w)}</div>` +
      (S.settings.pinyinFront ? `<div class="pinyin">${pinyinHTML(w)}</div>` : "");
    back.innerHTML = (S.settings.pinyinFront ? "" : `<div class="pinyin">${pinyinHTML(w)}</div>`) +
      `<div class="meaning">${esc(w.en)}</div>${speakBtn(w.zh)}`;
    if (S.settings.autoplay) speak(w.zh);
  } else {
    front.innerHTML = `${tag}<div class="meaning front">${esc(w.en)}</div><div class="hint">${esc(DECKS[w.deck].name)}</div>`;
    back.innerHTML = `<div class="hanzi${long}">${hanziHTML(w)}</div><div class="pinyin">${pinyinHTML(w)}</div>${speakBtn(w.zh)}`;
  }
  back.classList.add("hidden");
  $("#reveal").classList.remove("hidden");
  $("#grades").classList.add("hidden");
}
function reveal() {
  const q = session.queue[0];
  if (!q) return;
  const w = WORD_BY_ID[q.id];
  $(".fc-back").classList.remove("hidden");
  $("#reveal").classList.add("hidden");
  $("#grades").classList.remove("hidden");
  for (let g = 0; g < 4; g++) $("#iv" + g).textContent = fmtIvl(schedule(S.cards[q.id], g));
  if (q.dir === "en-zh" && S.settings.autoplay) speak(w.zh);
}
function grade(g) {
  const q = session.queue.shift();
  if (!q) return;
  const wasNew = !S.cards[q.id];
  S.cards[q.id] = schedule(S.cards[q.id], g);
  if (wasNew) { newToday(); S.newLog.count++; }
  markStudied();
  save();
  if (g === 0) {
    // see it again later in this session
    const pos = Math.min(session.queue.length, 3 + Math.floor(Math.random() * 3));
    session.queue.splice(pos, 0, { ...q, isNew: false, dir: cardDir() });
  } else session.done++;
  showCard();
}
$("#reveal").onclick = reveal;
$("#review-card").onclick = () => { if (!$("#reveal").classList.contains("hidden")) reveal(); };
$("#grades").onclick = (e) => { const b = e.target.closest("[data-grade]"); if (b) grade(+b.dataset.grade); };
$("#more-new").onclick = () => { buildSession((session ? session.extra : 0) + 5); showCard(); };

/* ---------- quiz ---------- */
let quiz = null;
function quizSetup() {
  $("#quiz-setup").classList.remove("hidden");
  $("#quiz-play").classList.add("hidden");
  $("#quiz-result").classList.add("hidden");
}
function startQuiz(mode) {
  let pool = enabledWords();
  if ($("#quiz-learned").checked) {
    const seen = pool.filter((w) => S.cards[w.id]);
    if (seen.length >= 4) pool = seen;
    else alert("Study at least 4 words first — using all words for now.");
  }
  const items = shuffle(pool).slice(0, 10).map((w) => {
    const m = mode === "mixed" ? pick(["meaning", "hanzi", "listen", "pinyin"]) : mode;
    const sameDeck = WORDS.filter((x) => x.deck === w.deck && x.zh !== w.zh && x.en !== w.en && x.py !== w.py);
    let distract = shuffle(sameDeck);
    if (m === "pinyin") {
      // prefer same-length words so the answer isn't obvious from length
      const n = syllables(w).length;
      distract.sort((a, b) => Math.abs(syllables(a).length - n) - Math.abs(syllables(b).length - n));
      // include a tone-confusable option when one exists
      const toneTwin = shuffle(WORDS).find((x) => x.zh !== w.zh && plainPinyin(x.py) === plainPinyin(w.py) && x.py !== w.py);
      if (toneTwin) distract.unshift(toneTwin);
    }
    distract = [...new Map(distract.map((d) => [d.py + "|" + d.en + "|" + d.zh, d])).values()].slice(0, 3);
    return { w, mode: m, options: shuffle([w, ...distract]) };
  });
  quiz = { items, i: 0, score: 0, missed: [] };
  $("#quiz-setup").classList.add("hidden");
  $("#quiz-result").classList.add("hidden");
  $("#quiz-play").classList.remove("hidden");
  showQuestion();
}
function showQuestion() {
  const it = quiz.items[quiz.i];
  const { w, mode } = it;
  $("#quiz-bar").style.width = (quiz.i / quiz.items.length) * 100 + "%";
  const label = { meaning: "What does this mean?", hanzi: "Which characters?", listen: "What did you hear?", pinyin: "How is this pronounced?" }[mode];
  let prompt;
  if (mode === "meaning" || mode === "pinyin") prompt = `<div class="hanzi${[...w.zh].length > 3 ? " long" : ""}">${esc(w.zh)}</div>`;
  else if (mode === "hanzi") prompt = `<div class="meaning front">${esc(w.en)}</div>`;
  else prompt = `<button class="speak" style="width:90px;height:90px;font-size:40px" data-say="${esc(w.zh)}">🔊</button>`;
  $("#quiz-prompt").innerHTML = `<div class="q-label">${label}</div>${prompt}`;
  $("#quiz-options").innerHTML = it.options.map((o, k) => {
    const zh = mode === "hanzi" || mode === "listen";
    const text = mode === "meaning" ? esc(o.en) : mode === "pinyin" ? pinyinHTML(o) : esc(o.zh);
    return `<button class="btn${zh ? " zh" : ""}" data-k="${k}"><span>${text}</span></button>`;
  }).join("");
  $("#quiz-next").classList.add("hidden");
  if (mode === "listen") speak(w.zh);
}
$("#quiz-options").onclick = (e) => {
  const b = e.target.closest("[data-k]");
  if (!b || !$("#quiz-next").classList.contains("hidden")) return;
  const it = quiz.items[quiz.i];
  const chosen = it.options[+b.dataset.k];
  const ok = chosen === it.w;
  if (ok) quiz.score++; else quiz.missed.push(it.w);
  $$("#quiz-options .btn").forEach((x) => { if (it.options[+x.dataset.k] === it.w) x.classList.add("correct"); });
  if (!ok) b.classList.add("wrong");
  // reveal full answer
  $("#quiz-prompt").insertAdjacentHTML("beforeend",
    `<div class="pinyin" style="margin-top:8px">${hanziHTML(it.w)} · ${pinyinHTML(it.w)}</div><div class="hint">${esc(it.w.en)}</div>`);
  if (it.mode !== "listen") speak(it.w.zh);
  $("#quiz-next").classList.remove("hidden");
};
$("#quiz-next").onclick = () => {
  quiz.i++;
  if (quiz.i < quiz.items.length) return showQuestion();
  $("#quiz-play").classList.add("hidden");
  $("#quiz-result").classList.remove("hidden");
  const pct = quiz.score / quiz.items.length;
  $("#quiz-emoji").textContent = pct === 1 ? "🏆" : pct >= 0.7 ? "🎉" : pct >= 0.4 ? "👍" : "💪";
  $("#quiz-score").textContent = `${quiz.score} / ${quiz.items.length}`;
  $("#quiz-missed").innerHTML = quiz.missed.length
    ? `<h2>Review these</h2><ul class="word-list">${quiz.missed.map(wordRow).join("")}</ul>` : "";
  markStudied(); save();
};
$("#quiz-again").onclick = quizSetup;
$(".mode-grid").onclick = (e) => { const b = e.target.closest("[data-mode]"); if (b) startQuiz(b.dataset.mode); };

/* ---------- word list ---------- */
let wordFilter = "all";
function wordRow(w) {
  return `<li data-id="${esc(w.id)}"><span class="wl-zh">${hanziHTML(w)}</span>
    <span class="wl-mid"><div class="wl-py">${pinyinHTML(w)}</div><div class="wl-en">${esc(w.en)}</div></span>
    <span class="dot ${status(w)}"></span></li>`;
}
function renderWords() {
  const q = $("#word-search").value.trim().toLowerCase();
  const qp = plainPinyin(q);
  const list = WORDS.filter((w) => {
    if (wordFilter !== "all" && status(w) !== wordFilter) return false;
    if (!q) return true;
    return w.zh.includes(q) || w.en.toLowerCase().includes(q) || (qp && plainPinyin(w.py).includes(qp));
  });
  $("#word-list").innerHTML = list.length ? list.map(wordRow).join("") : `<li class="empty">No words found</li>`;
}
$("#word-search").oninput = renderWords;
$("#word-filter").onclick = (e) => {
  const b = e.target.closest("[data-f]");
  if (!b) return;
  wordFilter = b.dataset.f;
  $$("#word-filter button").forEach((x) => x.classList.toggle("on", x === b));
  renderWords();
};
document.addEventListener("click", (e) => {
  const li = e.target.closest(".word-list li[data-id]");
  if (li) openWord(WORD_BY_ID[li.dataset.id]);
});
function openWord(w) {
  const c = S.cards[w.id];
  const st = !c ? "Not studied yet" : `${status(w) === "known" ? "Known" : "Learning"} · next review ${c.due <= Date.now() ? "now" : new Date(c.due).toLocaleDateString()}`;
  const chars = [...w.zh].filter((ch) => HAN.test(ch));
  const charInfo = chars.length > 1 ? `<div class="chars">${chars.map((ch) => {
    const single = WORDS.find((x) => x.zh === ch);
    return `<span>${esc(ch)}${single ? " " + esc(single.en.split(";")[0]) : ""}</span>`;
  }).join("")}</div>` : "";
  $("#modal-body").innerHTML = `<div class="hanzi${chars.length > 3 ? " long" : ""}">${hanziHTML(w)}</div>
    <div class="pinyin">${pinyinHTML(w)}</div><div class="meaning">${esc(w.en)}</div>${charInfo}
    <div>${speakBtn(w.zh)}</div><p class="hint">${esc(DECKS[w.deck].name)} · ${st}</p>
    <button class="btn primary" id="modal-write">✍️ Practice writing</button>`;
  $("#modal").classList.remove("hidden");
  speak(w.zh);
  $("#modal-write").onclick = () => { closeModal(); writeTarget = chars.join(""); goto("write"); };
}
function closeModal() { $("#modal").classList.add("hidden"); }
$("#modal-close").onclick = closeModal;
$("#modal").onclick = (e) => { if (e.target.id === "modal") closeModal(); };

/* ---------- writing (Hanzi Writer, loaded on demand) ---------- */
let writeTarget = null, writers = [], selected = 0, hwLoading = null;
function loadHanziWriter() {
  if (window.HanziWriter) return Promise.resolve();
  if (hwLoading) return hwLoading;
  hwLoading = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/hanzi-writer@3.7.2/dist/hanzi-writer.min.js";
    s.onload = res;
    s.onerror = () => { hwLoading = null; rej(); };
    document.head.appendChild(s);
  });
  return hwLoading;
}
function enterWrite() {
  if (writeTarget) { $("#write-input").value = writeTarget; writeTarget = null; }
  if (!$("#write-input").value) $("#write-input").value = pick(WORDS.filter((w) => w.deck === "hsk1")).zh;
  renderWrite();
}
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
async function renderWrite() {
  const text = $("#write-input").value;
  const chars = [...text].filter((ch) => HAN.test(ch)).slice(0, 6);
  const w = WORDS.find((x) => x.zh.replace(/[？?]/g, "") === chars.join(""));
  $("#write-info").innerHTML = chars.length
    ? (w ? `<div class="pinyin">${pinyinHTML(w)}</div><div class="hint">${esc(w.en)}</div>` : "") + speakBtn(chars.join(""))
    : "";
  const box = $("#write-chars");
  box.innerHTML = "";
  writers = []; selected = 0;
  if (!chars.length) { $("#write-msg").textContent = "Type some Chinese characters above."; return; }
  try { await loadHanziWriter(); } catch {
    $("#write-msg").textContent = "Couldn't load stroke data. Writing practice needs an internet connection the first time you open each character.";
    return;
  }
  const avail = Math.min(box.clientWidth || 340, 528);
  const size = chars.length === 1 ? Math.min(280, avail) : chars.length === 2 ? Math.min(170, (avail - 10) / 2) : Math.min(120, (avail - 20) / 3);
  chars.forEach((ch, i) => {
    const el = document.createElement("div");
    el.className = "write-box" + (i === 0 ? " sel" : "");
    el.style.width = el.style.height = size + "px";
    el.innerHTML = `<svg class="grid" width="${size}" height="${size}" stroke="${cssVar("--line")}" stroke-dasharray="4 4">
      <line x1="0" y1="0" x2="${size}" y2="${size}"/><line x1="${size}" y1="0" x2="0" y2="${size}"/>
      <line x1="${size / 2}" y1="0" x2="${size / 2}" y2="${size}"/><line x1="0" y1="${size / 2}" x2="${size}" y2="${size / 2}"/></svg>`;
    el.onclick = () => selectChar(i);
    box.appendChild(el);
    writers.push(HanziWriter.create(el, ch, {
      width: size, height: size, padding: 6,
      strokeColor: cssVar("--text"), outlineColor: cssVar("--line"), radicalColor: null,
      highlightColor: cssVar("--t4"), drawingColor: cssVar("--accent"),
      showOutline: true, showCharacter: true, delayBetweenStrokes: 150, strokeAnimationSpeed: 1.2,
      onLoadCharDataError: () => { $("#write-msg").textContent = `Couldn't load stroke data for ${ch}. Check your connection.`; },
    }));
  });
  $("#write-msg").textContent = "Tap a character to select it. In practice mode, trace each stroke in order with your finger.";
}
function selectChar(i) {
  selected = i;
  $$(".write-box").forEach((b, k) => b.classList.toggle("sel", k === i));
}
function practice(i) {
  if (!writers[i]) return;
  selectChar(i);
  const ch = [...$("#write-input").value].filter((c) => HAN.test(c))[i];
  $("#write-msg").textContent = `Trace ${ch} stroke by stroke. Mistakes 3× in a row show a hint.`;
  writers[i].quiz({
    showHintAfterMisses: 3,
    onComplete: (d) => {
      $("#write-msg").textContent = `${ch} done${d.totalMistakes ? ` with ${d.totalMistakes} mistake${d.totalMistakes > 1 ? "s" : ""}` : " perfectly! 🎉"}`;
      speak(ch);
      if (i + 1 < writers.length) setTimeout(() => practice(i + 1), 900);
    },
  });
}
$("#write-input").onchange = renderWrite;
$("#write-input").onkeydown = (e) => { if (e.key === "Enter") e.target.blur(); };
$("#write-random").onclick = () => { $("#write-input").value = pick(WORDS.filter((w) => w.deck === "hsk1")).zh; renderWrite(); };
$("#write-animate").onclick = () => {
  const w = writers[selected];
  if (w) { w.showCharacter(); w.animateCharacter(); }
};
$("#write-quiz").onclick = () => practice(selected);
let outlineOn = true;
$("#write-outline").onclick = () => {
  outlineOn = !outlineOn;
  writers.forEach((w) => (outlineOn ? w.showOutline() : w.hideOutline()));
};

/* ---------- tone trainer ---------- */
const TONE_SKIP = new Set(["都", "喂", "和", "个", "了", "的", "吗", "呢", "那", "哪"]);
const TONE_POOL = WORDS.filter((w) => w.deck === "hsk1" && syllables(w).length === 1 && toneOf(w.py) < 5 && !TONE_SKIP.has(w.zh) && [...w.zh].length === 1);
let toneQ = null, toneStats = { right: 0, total: 0 };
$("#tone-play").onclick = () => {
  if (!toneQ) { toneQ = pick(TONE_POOL); $("#tone-feedback").innerHTML = ""; }
  speak(toneQ.zh, Math.min(S.settings.rate, 0.8));
};
$(".tone-answers").onclick = (e) => {
  const b = e.target.closest("[data-tone]");
  if (!b) return;
  if (!toneQ) return;
  const t = toneOf(toneQ.py);
  const ok = +b.dataset.tone === t;
  toneStats.total++; if (ok) toneStats.right++;
  $("#tone-feedback").innerHTML = `${ok ? "✅ Correct!" : `❌ It was tone ${t}`}<div><span class="hanzi">${hanziHTML(toneQ)}</span> ${pinyinHTML(toneQ)} · ${esc(toneQ.en)}</div><div class="hint">Tap Play for the next one.</div>`;
  $("#tone-score").textContent = `Score: ${toneStats.right}/${toneStats.total}`;
  toneQ = null;
};

/* ---------- boot ---------- */
load();
renderHome();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
