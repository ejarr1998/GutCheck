/* ============================================================
   GutCheck — progress photos, weight log, AI coaches
   Vanilla JS + Firebase (Firestore) + Claude (browser call)
   ============================================================ */
"use strict";

/* ---------- Firebase ---------- */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBrU3858Blfz8om6jzz91JWF1FODcVkMhA",
  authDomain: "gutcheck-efc9a.firebaseapp.com",
  projectId: "gutcheck-efc9a",
  storageBucket: "gutcheck-efc9a.firebasestorage.app",
  messagingSenderId: "149877550947",
  appId: "1:149877550947:web:70e746055301b932212d56",
};

let db = null;
try {
  firebase.initializeApp(FIREBASE_CONFIG);
  db = firebase.firestore();
} catch (e) {
  console.error("Firebase init failed:", e);
}

/* ---------- tiny DOM helpers (XSS-safe: textContent only) ---------- */
function $(sel, root) { return (root || document).querySelector(sel); }
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function esc(s) { return String(s == null ? "" : s); }

let toastTimer = null;
function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isErr ? " err" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

/* ---------- constants ---------- */
const KEY_CLAUDE = "sandbox_key_claude"; // shared origin with kimis-sandbox
const KEY_DEEPGRAM = "sandbox_key_deepgram"; // voice: STT + TTS
const KEY_GROK = "sandbox_key_grok"; // xAI image generation (coach avatars)
const COACH_VOICES = { nutrition: "aura-2-thalia-en", gym: "aura-2-stella-en" }; // Maya / Dre (female Aura-2 voices)
const AVATARS = { nutrition: null, gym: null }; // data URLs from settings/avatars

const DEFAULT_PROFILE = {
  height: "6'2\"",
  age: "28",
  startWeight: "190",
  goalWeight: "175",
  calories: "2100",
  protein: "160",
  babyDue: "2026-11-24",
  context:
    "Male, 28, 6'2\". Gained ~15-20 lbs (170-175 lifelong, now 190), wants to lose the gut and get back to ~175 by mid-November 2026. " +
    "Trains at home only (no gym) 3x/week full-body with dumbbells/backpack + daily 8-10k steps. " +
    "Recurring lower-back issues — avoid aggressive spinal loading, prefer core stability work (planks, dead bugs, bird dogs). " +
    "Had mono (EBV) in March 2025 and post-COVID immune issues — avoid overtraining, moderate intensity. " +
    "First baby due Nov 24, 2026 — plan must survive severe sleep deprivation.",
};

const COACHES = {
  nutrition: {
    name: "Coach Maya",
    short: "Maya",
    title: "AI Nutritionist",
    greeting:
      "Hey! I'm Maya, your nutritionist. Ask me anything — meal ideas, whether a food fits your calories, what to order at a restaurant, or how to hit your protein target today.",
    suggestions: [
      "Give me a full day of eating at my targets",
      "High-protein breakfast ideas that take 5 minutes",
      "Is olive oil ok for cooking chicken?",
      "What should I eat before and after a workout?",
      "How do I handle cravings at night?",
    ],
  },
  gym: {
    name: "Coach Dre",
    short: "Dre",
    title: "AI Gym Coach",
    greeting:
      "What's up — I'm Dre, your home-training coach. I know your program, your back history, and your goals. Ask me about form, swapping exercises, or what to do today.",
    suggestions: [
      "Walk me through today's workout",
      "My lower back feels tight — what should I swap?",
      "How do I make push-ups harder without weights?",
      "I only have 15 minutes — what's the minimum effective workout?",
      "How do I progress goblet squats at home?",
    ],
  },
};

const state = {
  tab: "dashboard",
  profile: { ...DEFAULT_PROFILE },
  weights: [], // {id, weight, loggedAt}
  photos: [],  // {id, imageData, label, note, takenAt}
  chats: { nutrition: [], gym: [] }, // {id, role, content, at}
  sending: { nutrition: false, gym: false },
  attach: { nutrition: null, gym: null }, // pending photo to send (data URL)
  pickerCoach: null,
  compareMode: false,
  compareSel: [],
  viewerId: null,
  voice: {
    recorder: null,
    chunks: [],
    coachId: null,
    autoSpeakNext: { nutrition: false, gym: false },
    audio: null,
    speakBtn: null,
  },
};

/* ---------- Firestore helpers ---------- */
async function fsGet(col, orderBy, dir) {
  const snap = await db.collection(col).orderBy(orderBy, dir || "asc").get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function loadProfile() {
  try {
    const doc = await db.collection("settings").doc("profile").get();
    if (doc.exists) state.profile = { ...DEFAULT_PROFILE, ...doc.data() };
  } catch (e) {
    console.warn("profile load failed:", e);
  }
}

async function saveProfile() {
  await db.collection("settings").doc("profile").set(state.profile);
}

async function loadWeights() {
  state.weights = await fsGet("weights", "loggedAt", "asc");
}

async function loadPhotos() {
  state.photos = await fsGet("photos", "takenAt", "desc");
}

async function loadChat(coach) {
  state.chats[coach] = await fsGet("chats/" + coach + "/messages", "at", "asc");
}

async function addChatMsg(coach, role, content, img) {
  const msg = { role, content, at: new Date().toISOString() };
  if (img) msg.img = img;
  const ref = await db.collection("chats").doc(coach).collection("messages").add(msg);
  state.chats[coach].push({ id: ref.id, ...msg });
}

/* ---------- formatting ---------- */
function fmtDay(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}
function fmtDayShort(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) +
    " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function dayKey(iso) {
  const d = new Date(iso);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/* ---------- fullscreen ---------- */
function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch((e) => {
      toast("Couldn't enter fullscreen: " + e.message, true);
    });
  } else {
    toast("Fullscreen isn't supported in this browser — use Add to Home Screen instead", true);
  }
}

function syncFsBtn() {
  const btn = $("#fsToggle");
  if (btn) {
    btn.textContent = document.fullscreenElement ? "✕" : "⛶";
    btn.title = document.fullscreenElement ? "Exit full screen" : "Full screen";
  }
}

/* ---------- tabs ---------- */
const TABS = ["dashboard", "photos", "nutrition", "gym", "settings"];
function go(tab) {
  state.tab = tab;
  stopSpeaking();
  TABS.forEach((t) => { $("#panel-" + t).hidden = t !== tab; });
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.go === tab);
  });
  if (tab === "nutrition" || tab === "gym") scrollChatBottom(tab, false);
}

/* ---------- dashboard ---------- */
function renderDashboard() {
  const p = state.profile;
  const start = parseFloat(p.startWeight) || 190;
  const goal = parseFloat(p.goalWeight) || 175;
  const current = state.weights.length ? state.weights[state.weights.length - 1].weight : start;
  const lost = start - current;
  const pct = Math.min(100, Math.max(0, (lost / Math.max(1, start - goal)) * 100));

  $("#dashTitle").textContent = lost >= 1 ? lost.toFixed(1) + " lbs down" : "Day one energy";
  $("#dashSub").textContent = start + " → " + goal + " lbs · " + p.calories + " kcal · " + p.protein + "g protein";
  $("#currentWeight").textContent = current;
  $("#goalLabel").textContent = "current lbs · goal " + goal;
  $("#pctLabel").textContent = pct.toFixed(0) + "% of the way";
  $("#goalBar").style.width = pct + "%";
  $("#statCal").textContent = p.calories;
  $("#statProtein").textContent = p.protein + "g";
  $("#statPhotos").textContent = String(state.photos.length);

  // baby countdown
  if (p.babyDue) {
    const days = Math.max(0, Math.ceil((new Date(p.babyDue + "T00:00:00") - Date.now()) / 86400000));
    $("#babyDays").textContent = String(days);
    $("#babyChip").hidden = false;
  }

  renderChart();
  renderWeightLog();
}

function renderChart() {
  const svg = $("#weightChart");
  const empty = $("#chartEmpty");
  const pts = state.weights.map((w) => ({ x: fmtDayShort(w.loggedAt), y: w.weight }));
  if (pts.length < 2) {
    svg.setAttribute("hidden", ""); // SVG elements don't reflect the .hidden property
    empty.hidden = false;
    return;
  }
  svg.removeAttribute("hidden");
  empty.hidden = true;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const W = 600, H = 180, padL = 40, padR = 14, padT = 16, padB = 26;
  const ys = pts.map((p) => p.y);
  const minY = Math.min(...ys) - 1.5, maxY = Math.max(...ys) + 1.5;
  const sx = (i) => padL + (i * (W - padL - padR)) / Math.max(1, pts.length - 1);
  const sy = (y) => padT + (1 - (y - minY) / (maxY - minY)) * (H - padT - padB);
  const NS = "http://www.w3.org/2000/svg";

  // gridlines
  for (let g = 0; g <= 3; g++) {
    const yv = minY + ((maxY - minY) * g) / 3;
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", padL); line.setAttribute("x2", W - padR);
    line.setAttribute("y1", sy(yv)); line.setAttribute("y2", sy(yv));
    line.setAttribute("stroke", "#262b1c"); line.setAttribute("stroke-width", "1");
    svg.appendChild(line);
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", 4); t.setAttribute("y", sy(yv) + 4);
    t.setAttribute("fill", "#9aa08c"); t.setAttribute("font-size", "11");
    t.textContent = String(Math.round(yv));
    svg.appendChild(t);
  }

  // area
  const area = document.createElementNS(NS, "path");
  let d = "M" + sx(0) + "," + sy(pts[0].y);
  pts.forEach((p, i) => { d += " L" + sx(i) + "," + sy(p.y); });
  d += " L" + sx(pts.length - 1) + "," + (H - padB) + " L" + sx(0) + "," + (H - padB) + " Z";
  area.setAttribute("d", d);
  area.setAttribute("fill", "rgba(163,230,53,.14)");
  svg.appendChild(area);

  // line
  const line = document.createElementNS(NS, "path");
  let ld = "M" + sx(0) + "," + sy(pts[0].y);
  pts.forEach((p, i) => { ld += " L" + sx(i) + "," + sy(p.y); });
  line.setAttribute("d", ld);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "#a3e635");
  line.setAttribute("stroke-width", "2.5");
  line.setAttribute("stroke-linejoin", "round");
  svg.appendChild(line);

  // points + x labels (first, last, and up to 6)
  const labelEvery = Math.ceil(pts.length / 6);
  pts.forEach((p, i) => {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", sx(i)); c.setAttribute("cy", sy(p.y));
    c.setAttribute("r", "3.5"); c.setAttribute("fill", "#a3e635");
    svg.appendChild(c);
    if (i % labelEvery === 0 || i === pts.length - 1) {
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", sx(i)); t.setAttribute("y", H - 8);
      t.setAttribute("fill", "#9aa08c"); t.setAttribute("font-size", "10.5");
      t.setAttribute("text-anchor", "middle");
      t.textContent = p.x;
      svg.appendChild(t);
    }
  });
}

function renderWeightLog() {
  const wrap = $("#weightLog");
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
  const recent = state.weights.slice(-5).reverse();
  recent.forEach((w) => {
    const row = el("div", "wrow");
    const left = el("span", null, fmtDayShort(w.loggedAt));
    const right = el("span");
    const b = el("b", null, w.weight + " lbs");
    const del = el("button", "del", "✕");
    del.title = "Delete entry";
    del.addEventListener("click", async () => {
      try {
        await db.collection("weights").doc(w.id).delete();
        state.weights = state.weights.filter((x) => x.id !== w.id);
        renderDashboard();
        toast("Entry deleted");
      } catch (e) { toast("Delete failed: " + e.message, true); }
    });
    right.appendChild(b);
    right.appendChild(document.createTextNode(" "));
    right.appendChild(del);
    row.appendChild(left);
    row.appendChild(right);
    wrap.appendChild(row);
  });
}

async function logWeight(val) {
  const w = parseFloat(val);
  if (!w || w < 50 || w > 800) { toast("Enter a valid weight in lbs", true); return; }
  try {
    const entry = { weight: w, loggedAt: new Date().toISOString() };
    const ref = await db.collection("weights").add(entry);
    state.weights.push({ id: ref.id, ...entry });
    $("#weightInput").value = "";
    renderDashboard();
    toast("Weight logged");
  } catch (e) { toast("Save failed: " + e.message, true); }
}

/* ---------- photos ---------- */
function compressImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read image")); };
    img.src = url;
  });
}

async function compressForFirestore(file) {
  // Firestore doc limit is 1 MiB; keep base64 under ~900 KB
  let dim = 1280, q = 0.82;
  for (let i = 0; i < 4; i++) {
    const data = await compressImage(file, dim, q);
    if (data.length < 900000) return data;
    dim = Math.round(dim * 0.75); q -= 0.1;
  }
  return compressImage(file, 800, 0.6);
}

async function uploadPhoto(file) {
  const btn = $("#photoBtn");
  btn.disabled = true;
  btn.textContent = "⏳ Saving…";
  try {
    const imageData = await compressForFirestore(file);
    const entry = {
      imageData,
      label: $("#photoLabel").value,
      note: $("#photoNote").value.trim(),
      takenAt: new Date().toISOString(),
    };
    const ref = await db.collection("photos").add(entry);
    state.photos.unshift({ id: ref.id, ...entry });
    $("#photoNote").value = "";
    renderPhotos();
    renderDashboard();
    toast("Photo saved — consistency is the whole game");
  } catch (e) {
    toast("Upload failed: " + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "📷 Take / upload today's photo";
    $("#photoFile").value = "";
  }
}

function renderPhotos() {
  const wrap = $("#photoTimeline");
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
  $("#photoEmpty").hidden = state.photos.length > 0;
  $("#compareToggle").disabled = state.photos.length < 2;
  $("#compareHint").hidden = !state.compareMode;
  $("#compareCount").textContent = String(state.compareSel.length);

  // group by day
  const groups = new Map();
  state.photos.forEach((p) => {
    const k = dayKey(p.takenAt);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  });

  groups.forEach((list) => {
    wrap.appendChild(el("div", "day-label", fmtDay(list[0].takenAt)));
    const grid = el("div", "photo-grid");
    list.forEach((p) => {
      const cell = el("button", "photo-cell" + (state.compareSel.includes(p.id) ? " selected" : ""));
      const img = document.createElement("img");
      img.src = p.imageData;
      img.alt = p.label;
      img.loading = "lazy";
      cell.appendChild(img);
      cell.appendChild(el("span", "plabel", p.label));
      if (state.compareSel.includes(p.id)) cell.appendChild(el("span", "check", "✓"));
      cell.addEventListener("click", () => {
        if (state.compareMode) toggleCompareSel(p.id);
        else openViewer(p.id);
      });
      grid.appendChild(cell);
    });
    wrap.appendChild(grid);
  });

  renderCompare();
}

function toggleCompareSel(id) {
  const i = state.compareSel.indexOf(id);
  if (i >= 0) state.compareSel.splice(i, 1);
  else {
    if (state.compareSel.length >= 2) state.compareSel.shift();
    state.compareSel.push(id);
  }
  renderPhotos();
}

function renderCompare() {
  const card = $("#compareCard");
  const grid = $("#compareGrid");
  while (grid.firstChild) grid.removeChild(grid.firstChild);
  const pair = state.compareSel
    .map((id) => state.photos.find((p) => p.id === id))
    .filter(Boolean)
    .sort((a, b) => new Date(a.takenAt) - new Date(b.takenAt));
  card.hidden = pair.length !== 2;
  pair.forEach((p) => {
    const box = el("div");
    const img = document.createElement("img");
    img.src = p.imageData;
    img.alt = p.label;
    box.appendChild(img);
    const cap = el("div", "cap");
    const b = el("b", null, p.label);
    cap.appendChild(b);
    cap.appendChild(document.createTextNode(" · " + fmtDateTime(p.takenAt)));
    if (p.note) cap.appendChild(document.createTextNode(" · " + p.note));
    box.appendChild(cap);
    grid.appendChild(box);
  });
}

function openViewer(id) {
  const p = state.photos.find((x) => x.id === id);
  if (!p) return;
  state.viewerId = id;
  $("#viewerImg").src = p.imageData;
  const meta = $("#viewerMeta");
  while (meta.firstChild) meta.removeChild(meta.firstChild);
  const strong = el("b", null, p.label);
  strong.style.textTransform = "capitalize";
  meta.appendChild(strong);
  meta.appendChild(el("span", null, " · " + fmtDateTime(p.takenAt) + (p.note ? " · " + p.note : "")));
  $("#viewer").hidden = false;
}

async function deleteViewerPhoto() {
  const id = state.viewerId;
  if (!id) return;
  try {
    await db.collection("photos").doc(id).delete();
    state.photos = state.photos.filter((p) => p.id !== id);
    state.compareSel = state.compareSel.filter((x) => x !== id);
    $("#viewer").hidden = true;
    state.viewerId = null;
    renderPhotos();
    renderDashboard();
    toast("Photo deleted");
  } catch (e) { toast("Delete failed: " + e.message, true); }
}

/* ---------- coaches ---------- */
function buildCoachPanel(coachId) {
  const meta = COACHES[coachId];
  const panel = $("#panel-" + coachId);

  const head = el("div", "chat-head");
  const idBox = el("div", "chat-id");
  const av = el("div", "avatar", meta.short[0]);
  av.id = "avatarBox-" + coachId;
  idBox.appendChild(av);
  const nameBox = el("div");
  nameBox.appendChild(el("div", "chat-name", meta.name));
  nameBox.appendChild(el("div", "chat-role", meta.title));
  idBox.appendChild(nameBox);
  head.appendChild(idBox);
  const reset = el("button", "link-btn", "↺ Reset");
  reset.addEventListener("click", () => clearChat(coachId));
  head.appendChild(reset);
  panel.appendChild(head);

  const scroll = el("div", "chat-scroll");
  scroll.id = "chatScroll-" + coachId;
  panel.appendChild(scroll);

  const prev = el("div", "attach-prev");
  prev.id = "attachPrev-" + coachId;
  prev.hidden = true;
  panel.appendChild(prev);

  const bar = el("form", "chat-input-bar");
  const ta = document.createElement("textarea");
  ta.rows = 1;
  ta.placeholder = "Ask " + meta.short + " anything…";
  ta.id = "chatInput-" + coachId;
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      bar.requestSubmit();
    }
  });
  const cam = el("button", "mic-btn", "📷");
  cam.type = "button";
  cam.id = "chatCam-" + coachId;
  cam.title = "Send a photo to " + meta.short;
  cam.addEventListener("click", () => openAttachPicker(coachId));
  const mic = el("button", "mic-btn", "🎙");
  mic.type = "button";
  mic.id = "chatMic-" + coachId;
  mic.title = "Talk to " + meta.short;
  mic.addEventListener("click", () => toggleRecording(coachId));
  const send = el("button", "send-btn", "➤");
  send.type = "submit";
  send.id = "chatSend-" + coachId;
  bar.appendChild(ta);
  bar.appendChild(cam);
  bar.appendChild(mic);
  bar.appendChild(send);
  bar.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (text || state.attach[coachId]) sendCoachMessage(coachId, text);
  });
  panel.appendChild(bar);
  panel.appendChild(el("p", "chat-disclaimer", "AI coach, not a doctor. It knows your targets from Settings."));
}

function scrollChatBottom(coachId, smooth) {
  const panel = $("#panel-" + coachId);
  requestAnimationFrame(() => {
    const kids = $("#chatScroll-" + coachId);
    if (kids && kids.lastElementChild) {
      kids.lastElementChild.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "end" });
    }
    window.scrollTo({ top: panel.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  });
}

function renderChat(coachId) {
  const meta = COACHES[coachId];
  const wrap = $("#chatScroll-" + coachId);
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
  const msgs = state.chats[coachId];

  if (!msgs.length) {
    wrap.appendChild(el("div", "msg bot", meta.greeting));
    const sug = el("div", "suggestions");
    meta.suggestions.forEach((s) => {
      const chip = el("button", "chip", s);
      chip.addEventListener("click", () => sendCoachMessage(coachId, s));
      sug.appendChild(chip);
    });
    wrap.appendChild(sug);
    return;
  }

  msgs.forEach((m) => {
    const div = el("div", "msg " + (m.role === "user" ? "user" : "bot"));
    if (m.img) {
      const im = document.createElement("img");
      im.src = m.img;
      im.alt = "shared photo";
      im.className = "chat-img";
      div.appendChild(im);
    }
    div.appendChild(document.createTextNode(m.content));
    const foot = el("span", "time", fmtTime(m.at));
    div.appendChild(foot);
    if (m.role !== "user") {
      const spk = el("button", "speak-btn", "🔊");
      spk.title = "Play as " + meta.short;
      spk.addEventListener("click", () => speakText(coachId, m.content, spk));
      div.appendChild(spk);
    }
    wrap.appendChild(div);
  });

  if (state.sending[coachId]) {
    const t = el("div", "msg bot typing");
    const s = el("span", "spin", "◌");
    t.appendChild(s);
    t.appendChild(document.createTextNode(meta.short + " is thinking…"));
    wrap.appendChild(t);
  }
}

function coachSystemPrompt(coachId) {
  const p = state.profile;
  const shared =
    "\n\nCLIENT PROFILE:\n- Height: " + p.height + ", Age: " + p.age +
    "\n- Start weight: " + p.startWeight + " lbs, Goal: " + p.goalWeight + " lbs" +
    "\n- Daily targets: " + p.calories + " calories, " + p.protein + "g protein" +
    "\n- Background: " + p.context +
    "\n\nRULES:\n- Be direct, warm, and practical. Short paragraphs. No fluff." +
    "\n- Give specific numbers, portions, sets, and reps — never vague advice." +
    "\n- The client can attach photos (meals, physique, equipment) — comment specifically on what you see." +
    "\n- You are not a doctor; for medical red flags, say so briefly and move on." +
    "\n- Remember the conversation history and build on it.";
  if (coachId === "nutrition") {
    return "You are Maya, an expert sports nutritionist and fat-loss coach." + shared +
      "\n- Stay within the client's calorie and protein targets unless asked otherwise." +
      "\n- When suggesting meals, include rough calories and protein per item." +
      "\n- Favor simple, cheap, fast home cooking a sleep-deprived new dad can actually make." +
      "\n- STAY IN YOUR LANE: your domain is food — calories, protein, meals, groceries, eating out, cravings, hydration. " +
      "You work alongside Dre, the strength coach, who lives in the Coach tab. " +
      "If the client asks about workouts, exercises, form, or training plans, give at most ONE short sentence, then redirect: \"That's Dre's department — ask her in the Coach tab.\" " +
      "Never write out workout routines, sets, or reps.";
  }
  return "You are Dre, a sharp, encouraging female strength coach specializing in home training and training around lower-back issues." + shared +
    "\n- All programming must be home-friendly: dumbbells, backpack load, bodyweight, floor work." +
    "\n- Protect the lower back: coach brace/neutral spine, swap risky movements proactively." +
    "\n- Account for mono/EBV history: moderate intensity, no grind-to-failure every session." +
    "\n- STAY IN YOUR LANE: your domain is training — workouts, form, progression, exercise swaps, steps, recovery. " +
    "You work alongside Maya, the nutritionist, who lives in the Nutritionist tab. " +
    "If the client asks about food, calories, meal ideas, or diets, give at most ONE short sentence, then redirect: \"That's Maya's department — ask her in the Nutritionist tab.\" " +
    "Never write out meal plans or calorie breakdowns.";
}

async function callClaude(coachId) {
  const key = localStorage.getItem(KEY_CLAUDE);
  if (!key) {
    return "I'm ready to coach you, but I need a brain first — add your Anthropic API key in Settings (⚙️ gear icon, top right → AI connection). " +
      "If you've saved one on kimis-sandbox before, it should already work — same browser, same key slot. " +
      "Your targets are already loaded: " + state.profile.calories + " kcal / " + state.profile.protein +
      "g protein, " + state.profile.startWeight + " → " + state.profile.goalWeight + " lbs.";
  }
  const history = state.chats[coachId].slice(-30).map((m) => {
    if (!m.img) return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: String(m.img).split(",")[1] || "" } },
        { type: "text", text: m.content || "(photo shared — no caption)" },
      ],
    };
  });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 1200,
      system: coachSystemPrompt(coachId),
      messages: history,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("Claude API " + res.status + ": " + text.slice(0, 200));
  }
  const data = await res.json();
  const out = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (!out) throw new Error("Claude returned an empty response");
  return out;
}

/* ---------- voice (Deepgram: nova-3 STT + aura-2 TTS) ---------- */
function deepgramKey() {
  return localStorage.getItem(KEY_DEEPGRAM) || "";
}

function pickMime() {
  if (!window.MediaRecorder) return null;
  const cands = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"];
  for (const m of cands) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* keep looking */ }
  }
  return null;
}

async function toggleRecording(coachId) {
  const mic = $("#chatMic-" + coachId);
  // stop path
  if (state.voice.recorder && state.voice.recorder.state === "recording") {
    state.voice.recorder.stop();
    return;
  }
  if (!deepgramKey()) {
    toast("Add your Deepgram key first (Settings ⚙️ → Voice)", true);
    return;
  }
  const mime = pickMime();
  if (!mime || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("Voice recording isn't supported in this browser", true);
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toast("Microphone access denied — allow the mic and try again", true);
    return;
  }
  const rec = new MediaRecorder(stream, { mimeType: mime });
  state.voice.chunks = [];
  state.voice.coachId = coachId;
  state.voice.recorder = rec;
  rec.addEventListener("dataavailable", (e) => {
    if (e.data && e.data.size) state.voice.chunks.push(e.data);
  });
  rec.addEventListener("stop", async () => {
    stream.getTracks().forEach((t) => t.stop());
    mic.classList.remove("recording");
    mic.textContent = "⏳";
    mic.disabled = true;
    const blob = new Blob(state.voice.chunks, { type: mime.split(";")[0] });
    state.voice.recorder = null;
    try {
      const text = await transcribeAudio(blob);
      if (text) {
        const ta = $("#chatInput-" + coachId);
        ta.value = (ta.value ? ta.value.trim() + " " : "") + text;
        state.voice.autoSpeakNext[coachId] = true; // voice in → voice out
        ta.focus();
      } else {
        toast("Didn't catch that — try again", true);
      }
    } catch (e) {
      toast("Transcription failed: " + e.message, true);
    } finally {
      mic.textContent = "🎙";
      mic.disabled = false;
    }
  });
  rec.start();
  mic.classList.add("recording");
  mic.textContent = "⏹";
}

async function transcribeAudio(blob) {
  const res = await fetch("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true", {
    method: "POST",
    headers: {
      Authorization: "Token " + deepgramKey(),
      "Content-Type": blob.type || "application/octet-stream",
    },
    body: blob,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("Deepgram STT " + res.status + ": " + t.slice(0, 160));
  }
  const data = await res.json();
  const alt = data.results && data.results.channels && data.results.channels[0] &&
    data.results.channels[0].alternatives && data.results.channels[0].alternatives[0];
  return alt && alt.transcript ? alt.transcript.trim() : "";
}

function stopSpeaking() {
  if (state.voice.audio) {
    try { state.voice.audio.pause(); } catch (e) { /* noop */ }
    state.voice.audio = null;
  }
  if (state.voice.speakBtn) {
    state.voice.speakBtn.classList.remove("speaking");
    state.voice.speakBtn.textContent = "🔊";
    state.voice.speakBtn = null;
  }
}

async function speakText(coachId, text, btn) {
  // tapping the playing button stops playback
  if (state.voice.speakBtn === btn && state.voice.audio) {
    stopSpeaking();
    return;
  }
  stopSpeaking();
  if (!deepgramKey()) {
    toast("Add your Deepgram key first (Settings ⚙️ → Voice)", true);
    return;
  }
  if (btn) {
    btn.classList.add("speaking");
    btn.textContent = "⏸";
    state.voice.speakBtn = btn;
  }
  try {
    const voice = COACH_VOICES[coachId] || COACH_VOICES.nutrition;
    // Deepgram speak accepts ~2000 chars per call — split long replies on sentence boundaries
    const chunks = [];
    let rest = text;
    while (rest.length > 1800) {
      let cut = Math.max(rest.lastIndexOf(". ", 1800), rest.lastIndexOf("! ", 1800), rest.lastIndexOf("? ", 1800), rest.lastIndexOf("\n", 1800));
      if (cut < 400) cut = 1800;
      chunks.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) chunks.push(rest);

    for (const chunk of chunks) {
      const res = await fetch("https://api.deepgram.com/v1/speak?model=" + voice, {
        method: "POST",
        headers: {
          Authorization: "Token " + deepgramKey(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: chunk }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error("Deepgram TTS " + res.status + ": " + t.slice(0, 160));
      }
      const audioBlob = await res.blob();
      const url = URL.createObjectURL(audioBlob);
      await new Promise((resolve) => {
        const a = new Audio(url);
        state.voice.audio = a;
        a.addEventListener("ended", () => { URL.revokeObjectURL(url); resolve(); });
        a.addEventListener("error", () => { URL.revokeObjectURL(url); resolve(); });
        a.play().catch(() => resolve()); // autoplay policy / headless: don't hang the queue
      });
      if (!state.voice.audio) break; // user stopped playback
    }
  } catch (e) {
    toast("Voice failed: " + e.message, true);
  } finally {
    stopSpeaking();
  }
}

/* ---------- coach avatars (Firestore settings/avatars + Grok regen) ---------- */
function avatarCacheKey(coachId) { return "gutcheck_avatar_" + coachId; }

async function loadAvatars() {
  ["nutrition", "gym"].forEach((c) => {
    const cached = localStorage.getItem(avatarCacheKey(c));
    if (cached) AVATARS[c] = cached;
  });
  applyAvatars();
  try {
    const doc = await db.collection("settings").doc("avatars").get();
    if (doc.exists) {
      const d = doc.data();
      if (d.maya) { AVATARS.nutrition = d.maya; localStorage.setItem(avatarCacheKey("nutrition"), d.maya); }
      if (d.dre) { AVATARS.gym = d.dre; localStorage.setItem(avatarCacheKey("gym"), d.dre); }
      applyAvatars();
    }
  } catch (e) { console.warn("avatar load failed:", e); }
  renderAvatarPreview();
}

function applyAvatars() {
  ["nutrition", "gym"].forEach((c) => {
    const box = $("#avatarBox-" + c);
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    if (AVATARS[c]) {
      const img = document.createElement("img");
      img.src = AVATARS[c];
      img.alt = COACHES[c].short;
      box.appendChild(img);
      box.classList.add("has-img");
    } else {
      box.classList.remove("has-img");
      box.textContent = COACHES[c].short[0];
    }
  });
}

function renderAvatarPreview() {
  const wrap = $("#avatarPreview");
  if (!wrap) return;
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
  [["nutrition", "Maya"], ["gym", "Dre"]].forEach((pair) => {
    const c = pair[0], label = pair[1];
    const box = el("div", "ap");
    if (AVATARS[c]) {
      const img = document.createElement("img");
      img.src = AVATARS[c];
      img.alt = label;
      box.appendChild(img);
    } else {
      const ph = el("div", "avatar", label[0]);
      ph.style.margin = "0 auto 4px";
      box.appendChild(ph);
    }
    box.appendChild(el("div", null, label));
    wrap.appendChild(box);
  });
}

function downscaleDataUrl(dataUrl, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL("image/jpeg", quality || 0.82));
    };
    img.onerror = () => reject(new Error("Could not process image"));
    img.src = dataUrl;
  });
}

const GROK_PROMPTS = {
  maya: "Professional headshot portrait of an attractive woman in her late 20s, a friendly registered dietitian and nutritionist, warm genuine smile, sage-green casual blouse, soft studio lighting, dark charcoal background with a subtle lime-green rim light, head-and-shoulders, photorealistic",
  dre: "Professional headshot portrait of an attractive athletic woman in her late 20s, a confident personal trainer, high sporty ponytail, black fitted athletic tank top, determined friendly smirk, soft gym lighting, dark charcoal background with a subtle lime-green rim light, head-and-shoulders, photorealistic",
};

async function regenerateAvatars() {
  const key = localStorage.getItem(KEY_GROK);
  if (!key) { toast("Add your xAI key first, then generate", true); return; }
  const btn = $("#regenAvatars");
  btn.disabled = true;
  try {
    const jobs = [["maya", "nutrition"], ["dre", "gym"]];
    for (let i = 0; i < jobs.length; i++) {
      const who = jobs[i][0], coachId = jobs[i][1];
      btn.textContent = "⏳ Generating " + (who === "maya" ? "Maya" : "Dre") + "… (~30s)";
      const res = await fetch("https://api.x.ai/v1/images/generations", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify({ model: "grok-2-image", prompt: GROK_PROMPTS[who], n: 1, response_format: "b64_json" }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error("xAI " + res.status + ": " + t.slice(0, 160));
      }
      const data = await res.json();
      const b64 = data.data && data.data[0] && data.data[0].b64_json;
      if (!b64) throw new Error("xAI returned no image data");
      const small = await downscaleDataUrl("data:image/jpeg;base64," + b64, 512, 0.85);
      const patch = {};
      patch[who] = small;
      await db.collection("settings").doc("avatars").set(patch, { merge: true });
      AVATARS[coachId] = small;
      localStorage.setItem(avatarCacheKey(coachId), small);
      applyAvatars();
      renderAvatarPreview();
    }
    toast("New avatars saved — synced to all your devices");
  } catch (e) {
    toast("Avatar generation failed: " + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ Generate new coach avatars";
  }
}

/* ---------- chat photo sharing ---------- */
function openAttachPicker(coachId) {
  state.pickerCoach = coachId;
  let picker = $("#attachPicker");
  if (!picker) {
    picker = el("div", "picker");
    picker.id = "attachPicker";
    picker.addEventListener("click", (e) => { if (e.target === picker) closeAttachPicker(); });
    document.body.appendChild(picker);
  }
  while (picker.firstChild) picker.removeChild(picker.firstChild);
  const sheet = el("div", "picker-sheet");
  const head = el("div", "picker-head");
  head.appendChild(el("b", null, "Send a photo to " + COACHES[coachId].short));
  const close = el("button", "icon-btn", "✕");
  close.addEventListener("click", closeAttachPicker);
  head.appendChild(close);
  sheet.appendChild(head);

  const upBtn = el("button", "btn big", "📷 Take / upload a new photo");
  upBtn.addEventListener("click", () => $("#attachFile").click());
  sheet.appendChild(upBtn);

  if (state.photos.length) {
    sheet.appendChild(el("div", "day-label", "Or pick from your progress photos"));
    const grid = el("div", "picker-grid");
    state.photos.slice(0, 12).forEach((p) => {
      const cell = el("button", "pcell");
      const img = document.createElement("img");
      img.src = p.imageData;
      img.alt = p.label;
      img.loading = "lazy";
      cell.appendChild(img);
      cell.addEventListener("click", () => attachPhoto(coachId, p.imageData));
      grid.appendChild(cell);
    });
    sheet.appendChild(grid);
  }
  picker.appendChild(sheet);
  picker.hidden = false;
}

function closeAttachPicker() {
  const picker = $("#attachPicker");
  if (picker) picker.hidden = true;
  state.pickerCoach = null;
}

async function attachPhoto(coachId, dataUrl) {
  try {
    state.attach[coachId] = await downscaleDataUrl(dataUrl, 768, 0.8);
  } catch (e) {
    state.attach[coachId] = dataUrl;
  }
  closeAttachPicker();
  renderAttachPrev(coachId);
  const ta = $("#chatInput-" + coachId);
  if (ta) ta.focus();
}

function renderAttachPrev(coachId) {
  const prev = $("#attachPrev-" + coachId);
  if (!prev) return;
  while (prev.firstChild) prev.removeChild(prev.firstChild);
  const dataUrl = state.attach[coachId];
  prev.hidden = !dataUrl;
  if (!dataUrl) return;
  const img = document.createElement("img");
  img.src = dataUrl;
  img.alt = "attached photo";
  prev.appendChild(img);
  prev.appendChild(el("span", null, "Photo attached — add a caption or just hit send"));
  const rm = el("button", "rm", "✕");
  rm.title = "Remove photo";
  rm.addEventListener("click", () => { state.attach[coachId] = null; renderAttachPrev(coachId); });
  prev.appendChild(rm);
}

/* ---------- keyboard-aware layout (visualViewport) ---------- */
function wireViewport() {
  if (!window.visualViewport) return;
  const sync = () => {
    const vv = window.visualViewport;
    const kbd = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty("--kbd", kbd + "px");
    const open = kbd > 80;
    const was = document.body.classList.contains("kbd-open");
    document.body.classList.toggle("kbd-open", open);
    if (open && !was && (state.tab === "nutrition" || state.tab === "gym")) {
      scrollChatBottom(state.tab, false);
    }
  };
  window.visualViewport.addEventListener("resize", sync);
  window.visualViewport.addEventListener("scroll", sync);
}

/* ---------- workout timer (active session: clock + sets + rest timer) ---------- */
const WK_KEY = "gutcheck_workout";
const wk = {
  active: false,   // session in progress (even while paused)
  running: false,  // clock currently ticking
  startEpoch: 0,
  accumMs: 0,
  sets: 0,
  restDur: 90,     // last-used rest length (seconds)
  restEnd: 0,
  restActive: false,
  expanded: false,
  endArmed: false,
  begunAt: null,
  tick: null,
};

function wkElapsed() {
  return wk.accumMs + (wk.running ? Date.now() - wk.startEpoch : 0);
}
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}
function wkSave() {
  try {
    localStorage.setItem(WK_KEY, JSON.stringify({
      active: wk.active, running: wk.running, startEpoch: wk.startEpoch,
      accumMs: wk.accumMs, sets: wk.sets, restDur: wk.restDur,
      restEnd: wk.restEnd, restActive: wk.restActive, begunAt: wk.begunAt,
    }));
  } catch (e) { /* storage full/blocked — timer still works in-memory */ }
}
function wkRestore() {
  try {
    const raw = localStorage.getItem(WK_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (!s.active) return;
    Object.assign(wk, s);
    if (wk.restActive && Date.now() >= wk.restEnd) wk.restActive = false; // rest expired while away
  } catch (e) { /* ignore corrupt state */ }
}

let _wkAudio = null;
function beep() {
  try {
    _wkAudio = _wkAudio || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _wkAudio;
    [0, 220].forEach((delay, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = i === 0 ? 880 : 1175;
      const t0 = ctx.currentTime + delay / 1000;
      g.gain.setValueAtTime(0.001, t0);
      g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
      o.start(t0); o.stop(t0 + 0.24);
    });
  } catch (e) { /* audio unavailable — vibration + flash still fire */ }
}

function buildWorkoutWidget() {
  const strip = el("div", "wk-strip idle");
  strip.id = "wkStrip";
  document.body.appendChild(strip);
  const panel = el("div", "wk-panel");
  panel.id = "wkPanel";
  panel.hidden = true;
  document.body.appendChild(panel);
  renderWk();
  wk.tick = setInterval(wkTick, 300);
}

function renderWk() {
  const strip = $("#wkStrip");
  const panel = $("#wkPanel");
  if (!strip || !panel) return;
  document.body.classList.toggle("wk-on", wk.active);
  while (strip.firstChild) strip.removeChild(strip.firstChild);

  if (!wk.active) {
    strip.className = "wk-strip idle";
    strip.textContent = "⏱ Start workout";
    strip.onclick = startWorkout;
    panel.hidden = true;
    wk.expanded = false;
    return;
  }
  strip.onclick = null;
  strip.className = "wk-strip";

  const time = el("span", "wk-time", fmtClock(wkElapsed()));
  time.id = "wkTime";
  strip.appendChild(time);
  const sets = el("span", "wk-sets", wk.sets + (wk.sets === 1 ? " set" : " sets"));
  sets.id = "wkSets";
  strip.appendChild(sets);

  const restB = el("button", "wk-btn push" + (wk.restActive ? " resting" : ""), wk.restActive ? fmtClock(wk.restEnd - Date.now()) : "Rest");
  restB.id = "wkRestBtn";
  restB.title = wk.restActive ? "Tap to skip rest" : "Start rest timer";
  restB.addEventListener("click", (e) => { e.stopPropagation(); if (wk.restActive) skipRest(); else startRest(wk.restDur); });
  strip.appendChild(restB);

  const setB = el("button", "wk-btn accent", "+ Set");
  setB.id = "wkSetBtn";
  setB.title = "Set done — starts your rest";
  setB.addEventListener("click", (e) => { e.stopPropagation(); setDone(); });
  strip.appendChild(setB);

  const exB = el("button", "wk-btn icon", wk.expanded ? "▼" : "▲");
  exB.id = "wkExpand";
  exB.title = wk.expanded ? "Collapse timer" : "Expand timer";
  exB.addEventListener("click", (e) => { e.stopPropagation(); wk.expanded = !wk.expanded; renderWk(); });
  strip.appendChild(exB);

  const endB = el("button", "wk-btn icon", "✕");
  endB.id = "wkEnd";
  endB.title = "End workout";
  endB.addEventListener("click", (e) => { e.stopPropagation(); armEnd(endB); });
  strip.appendChild(endB);

  while (panel.firstChild) panel.removeChild(panel.firstChild);
  panel.hidden = !wk.expanded;
  if (wk.expanded) {
    const big = el("div", "wk-big", wk.restActive ? fmtClock(wk.restEnd - Date.now()) : fmtClock(wkElapsed()));
    big.id = "wkBig";
    panel.appendChild(big);
    const lbl = el("div", "wk-label", wk.restActive ? "rest — next set when it hits zero" : "session time");
    lbl.id = "wkBigLabel";
    panel.appendChild(lbl);

    const chips = el("div", "wk-chips");
    [60, 90, 120, 180].forEach((s) => {
      const c = el("button", "wk-chip" + (wk.restDur === s ? " on" : ""), s + "s");
      c.addEventListener("click", () => startRest(s));
      chips.appendChild(c);
    });
    const plus = el("button", "wk-chip", "+15s");
    plus.id = "wkPlus";
    plus.addEventListener("click", () => addRest(15));
    chips.appendChild(plus);
    const skip = el("button", "wk-chip", "Skip");
    skip.id = "wkSkip";
    skip.addEventListener("click", skipRest);
    chips.appendChild(skip);
    panel.appendChild(chips);

    const row = el("div", "wk-row");
    const pause = el("button", "btn ghost sm", wk.running ? "⏸ Pause" : "▶ Resume");
    pause.id = "wkPause";
    pause.addEventListener("click", pauseResume);
    row.appendChild(pause);
    const fin = el("button", "btn sm", "Finish workout");
    fin.id = "wkFinish";
    fin.addEventListener("click", () => armEnd(fin));
    row.appendChild(fin);
    panel.appendChild(row);
  }
}

function wkTick() {
  if (!wk.active) return;
  const t = $("#wkTime");
  if (t) t.textContent = fmtClock(wkElapsed());
  const big = $("#wkBig");
  const lbl = $("#wkBigLabel");
  if (wk.restActive) {
    const rem = wk.restEnd - Date.now();
    if (rem <= 0) { wkRestDone(); return; }
    const rb = $("#wkRestBtn");
    if (rb) rb.textContent = fmtClock(rem);
    if (big) big.textContent = fmtClock(rem);
    if (lbl) lbl.textContent = "rest — next set when it hits zero";
  } else {
    const rb = $("#wkRestBtn");
    if (rb && rb.textContent !== "GO 💪") rb.textContent = "Rest";
    if (big) big.textContent = fmtClock(wkElapsed());
    if (lbl) lbl.textContent = "session time";
  }
}

function startWorkout() {
  wk.active = true;
  wk.running = true;
  wk.startEpoch = Date.now();
  wk.accumMs = 0;
  wk.sets = 0;
  wk.begunAt = new Date().toISOString();
  wk.restActive = false;
  wk.expanded = true;
  wkSave();
  renderWk();
  toast("Workout started — clock's running. Tap + Set after each set.");
}

function pauseResume() {
  if (wk.running) {
    wk.accumMs += Date.now() - wk.startEpoch;
    wk.running = false;
  } else {
    wk.startEpoch = Date.now();
    wk.running = true;
  }
  wkSave();
  renderWk();
}

function setDone() {
  wk.sets += 1;
  const setsEl = $("#wkSets");
  if (setsEl) setsEl.textContent = wk.sets + (wk.sets === 1 ? " set" : " sets");
  startRest(wk.restDur);
}

function startRest(sec) {
  wk.restDur = sec;
  wk.restEnd = Date.now() + sec * 1000;
  wk.restActive = true;
  wkSave();
  renderWk();
}

function addRest(sec) {
  if (!wk.restActive) return;
  wk.restEnd += sec * 1000;
  wkSave();
}

function skipRest() {
  wk.restActive = false;
  wkSave();
  renderWk();
}

function wkRestDone() {
  wk.restActive = false;
  wkSave();
  beep();
  if (navigator.vibrate) navigator.vibrate([180, 80, 180]);
  const panel = $("#wkPanel");
  if (panel && !panel.hidden) {
    panel.classList.remove("wk-flash");
    void panel.offsetWidth; // restart animation
    panel.classList.add("wk-flash");
  }
  const rb = $("#wkRestBtn");
  if (rb) rb.textContent = "GO 💪";
  const lbl = $("#wkBigLabel");
  if (lbl) lbl.textContent = "rest over — go!";
  setTimeout(() => { const b = $("#wkRestBtn"); if (b && !wk.restActive) b.textContent = "Rest"; }, 5000);
}

function armEnd(btn) {
  if (!wk.endArmed) {
    wk.endArmed = true;
    const old = btn.textContent;
    btn.textContent = "Sure?";
    setTimeout(() => {
      wk.endArmed = false;
      if (btn.isConnected) btn.textContent = old;
    }, 3000);
    return;
  }
  finishWorkout();
}

async function finishWorkout() {
  const durSec = Math.round(wkElapsed() / 1000);
  const sets = wk.sets;
  const entry = {
    startedAt: wk.begunAt || new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationSec: durSec,
    sets: sets,
  };
  try {
    if (db) await db.collection("workouts").add(entry);
    toast("Workout logged — " + Math.max(1, Math.round(durSec / 60)) + " min, " + sets + " sets 💪");
  } catch (e) {
    toast("Workout done but save failed: " + e.message, true);
  }
  wk.active = false;
  wk.running = false;
  wk.restActive = false;
  wk.sets = 0;
  wk.accumMs = 0;
  wk.expanded = false;
  wk.endArmed = false;
  try { localStorage.removeItem(WK_KEY); } catch (e) { /* noop */ }
  renderWk();
}

async function sendCoachMessage(coachId, text) {
  if (state.sending[coachId]) return;
  const img = state.attach[coachId] || null;
  state.sending[coachId] = true;
  $("#chatInput-" + coachId).value = "";
  state.attach[coachId] = null;
  renderAttachPrev(coachId);
  try {
    await addChatMsg(coachId, "user", text || "", img);
  } catch (e) {
    state.sending[coachId] = false;
    $("#chatInput-" + coachId).value = text; // don't eat the message — let them retry
    state.attach[coachId] = img;
    renderAttachPrev(coachId);
    toast("Message didn't send: " + e.message + " — is Firestore created in the Firebase console?", true);
    return;
  }
  renderChat(coachId);
  scrollChatBottom(coachId, true);
  let reply;
  try {
    reply = await callClaude(coachId);
  } catch (e) {
    reply = "Hmm, my brain hiccuped: " + e.message + ". Check the API key in Settings and try again.";
  }
  try {
    await addChatMsg(coachId, "assistant", reply);
  } catch (e) {
    console.warn("reply save failed:", e);
    state.chats[coachId].push({ id: "local-" + Date.now(), role: "assistant", content: reply, at: new Date().toISOString() });
  }
  state.sending[coachId] = false;
  renderChat(coachId);
  scrollChatBottom(coachId, true);
  if (state.voice.autoSpeakNext[coachId]) {
    state.voice.autoSpeakNext[coachId] = false;
    speakText(coachId, reply, null);
  }
}

async function clearChat(coachId) {
  try {
    const snap = await db.collection("chats").doc(coachId).collection("messages").get();
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    state.chats[coachId] = [];
    renderChat(coachId);
    toast("Conversation cleared");
  } catch (e) { toast("Clear failed: " + e.message, true); }
}

/* ---------- settings ---------- */
const PROFILE_FIELDS = ["height", "age", "startWeight", "goalWeight", "calories", "protein", "babyDue", "context"];

function renderSettings() {
  PROFILE_FIELDS.forEach((f) => { $("#s_" + f).value = state.profile[f] || ""; });
  $("#aiPill").hidden = !localStorage.getItem(KEY_CLAUDE);
  $("#dgPill").hidden = !localStorage.getItem(KEY_DEEPGRAM);
  $("#grokPill").hidden = !localStorage.getItem(KEY_GROK);
  renderAvatarPreview();
}

async function onSaveProfile() {
  PROFILE_FIELDS.forEach((f) => { state.profile[f] = $("#s_" + f).value.trim(); });
  try {
    await saveProfile();
    renderDashboard();
    toast("Profile saved — your coaches will use it");
  } catch (e) { toast("Save failed: " + e.message, true); }
}

function onSaveKey() {
  const v = $("#s_apiKey").value.trim();
  if (!v) { toast("Paste a key first", true); return; }
  localStorage.setItem(KEY_CLAUDE, v);
  $("#s_apiKey").value = "";
  $("#aiPill").hidden = false;
  toast("Key saved — coaches are live");
}

function onSaveDgKey() {
  const v = $("#s_dgKey").value.trim();
  if (!v) { toast("Paste a key first", true); return; }
  localStorage.setItem(KEY_DEEPGRAM, v);
  $("#s_dgKey").value = "";
  $("#dgPill").hidden = false;
  toast("Voice key saved — tap 🎙 in any coach chat");
}

function onSaveGrokKey() {
  const v = $("#s_grokKey").value.trim();
  if (!v) { toast("Paste a key first", true); return; }
  localStorage.setItem(KEY_GROK, v);
  $("#s_grokKey").value = "";
  $("#grokPill").hidden = false;
  toast("Image key saved — generate fresh avatars anytime");
}

/* ---------- boot ---------- */
function wireEvents() {
  document.querySelectorAll("[data-go]").forEach((b) => {
    b.addEventListener("click", () => go(b.dataset.go));
  });
  $("#weightForm").addEventListener("submit", (e) => {
    e.preventDefault();
    logWeight($("#weightInput").value);
  });
  $("#photoBtn").addEventListener("click", () => $("#photoFile").click());
  $("#photoFile").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) uploadPhoto(f);
  });
  $("#compareToggle").addEventListener("click", () => {
    state.compareMode = !state.compareMode;
    state.compareSel = [];
    $("#compareToggle").classList.toggle("ghost", !state.compareMode);
    renderPhotos();
  });
  $("#viewerClose").addEventListener("click", () => { $("#viewer").hidden = true; state.viewerId = null; });
  $("#viewerDelete").addEventListener("click", deleteViewerPhoto);
  $("#viewer").addEventListener("click", (e) => {
    if (e.target === $("#viewer")) { $("#viewer").hidden = true; state.viewerId = null; }
  });
  $("#saveProfile").addEventListener("click", onSaveProfile);
  $("#saveKey").addEventListener("click", onSaveKey);
  $("#saveDgKey").addEventListener("click", onSaveDgKey);
  $("#saveGrokKey").addEventListener("click", onSaveGrokKey);
  $("#regenAvatars").addEventListener("click", regenerateAvatars);
  $("#settingsBtn").addEventListener("click", () => go("settings"));
  $("#fsToggle").addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", syncFsBtn);
  wireViewport();

  // hidden file input for chat photo attachments
  const af = document.createElement("input");
  af.type = "file";
  af.accept = "image/*";
  af.id = "attachFile";
  af.hidden = true;
  document.body.appendChild(af);
  af.addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    const coachId = state.pickerCoach;
    e.target.value = "";
    if (f && coachId) {
      try {
        const data = await compressForFirestore(f);
        attachPhoto(coachId, data);
      } catch (err) { toast("Could not read photo: " + err.message, true); }
    }
  });
}

async function boot() {
  buildCoachPanel("nutrition");
  buildCoachPanel("gym");
  wkRestore();
  buildWorkoutWidget();
  wireEvents();
  if (!db) {
    toast("Firebase failed to initialize — check your connection", true);
    return;
  }
  try {
    await Promise.all([
      loadProfile(),
      loadWeights(),
      loadPhotos(),
      loadChat("nutrition"),
      loadChat("gym"),
      loadAvatars(),
    ]);
  } catch (e) {
    toast("Could not load data: " + e.message + " — check Firestore is enabled and rules allow read/write", true);
  }
  renderDashboard();
  renderPhotos();
  renderChat("nutrition");
  renderChat("gym");
  renderSettings();
}

document.addEventListener("DOMContentLoaded", boot);
