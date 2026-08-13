/* ============================================================
   GutCheck — progress photos, weight log, AI coaches
   Vanilla JS + Firebase (Auth + Firestore) + Cloud Functions proxy (Claude / Deepgram / ElevenLabs / Grok)
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
let auth = null;
let fns = null;
try {
  firebase.initializeApp(FIREBASE_CONFIG);
  db = firebase.firestore();
  auth = firebase.auth();
  fns = firebase.functions();
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
// All AI keys live server-side in Cloud Functions secrets — nothing to paste here.
const AVATARS = { nutrition: null, gym: null }; // data URLs from settings/avatars

// Ethan's account — gates admin-only features (legacy migration, baby countdown card).
const ADMIN_EMAIL = "ejarr1998@gmail.com";

const DEFAULT_PROFILE = {
  name: "",
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
    name: "Coach Vanessa",
    short: "Vanessa",
    title: "AI Gym Coach",
    greeting:
      "What's up — I'm Vanessa, your home-training coach. I know your program, your back history, and your goals. Ask me about form, swapping exercises, or what to do today.",
    suggestions: [
      "Walk me through today's workout",
      "My lower back feels tight — what should I swap?",
      "How do I make push-ups harder without weights?",
      "I only have 15 minutes — what's the minimum effective workout?",
      "How do I progress goblet squats at home?",
    ],
  },
};

/* ---------- coach identity (gender-selectable) ---------- */
const COACH_NAMES = {
  nutrition: { female: { name: "Coach Maya", short: "Maya" }, male: { name: "Coach Marcus", short: "Marcus" } },
  gym: { female: { name: "Coach Vanessa", short: "Vanessa" }, male: { name: "Coach Dre", short: "Dre" } },
};
// Keep the original female greetings as templates; names get swapped on apply.
COACHES.nutrition._greetingF = COACHES.nutrition.greeting;
COACHES.gym._greetingF = COACHES.gym.greeting;

function coachGender(coachId) {
  return (state.profile.coachGenders && state.profile.coachGenders[coachId]) || "female";
}

function applyCoachGenders() {
  ["nutrition", "gym"].forEach((c) => {
    const pick = COACH_NAMES[c][coachGender(c)] || COACH_NAMES[c].female;
    const femShort = COACH_NAMES[c].female.short;
    COACHES[c].name = pick.name;
    COACHES[c].short = pick.short;
    COACHES[c].greeting = COACHES[c]._greetingF.split(femShort).join(pick.short);
  });
  const estBtn = $("#mealEstimateBtn");
  if (estBtn) estBtn.textContent = "✨ " + COACHES.nutrition.short + ", log this";
}

function rebuildCoachPanels() {
  // These static cards live inside panel-nutrition/panel-gym alongside the
  // chat UI (food log heatmap, workout heatmap) — preserve them, only clear
  // and rebuild the chat-specific elements that buildCoachPanel() creates.
  const PRESERVE_IDS = ["foodLogCard", "heatmapCard"];
  ["nutrition", "gym"].forEach((c) => {
    const panel = $("#panel-" + c);
    if (!panel) return;
    Array.from(panel.children).forEach((child) => {
      if (!PRESERVE_IDS.includes(child.id)) panel.removeChild(child);
    });
    buildCoachPanel(c);
    renderChat(c);
  });
  applyAvatars();
}

const state = {
  tab: "dashboard",
  uid: null,        // Firebase Auth uid — scopes every Firestore path
  userEmail: null,
  userPhone: null,
  hasProfileDoc: false, // false = brand-new account (no profile written yet)
  profile: { ...DEFAULT_PROFILE },
  weights: [], // {id, weight, loggedAt}
  photos: [],  // {id, imageData, label, note, takenAt}
  measurements: [], // {id, loggedAt, waist, chest, arms, thighs}
  meals: [],        // {id, loggedAt, name, calories, protein, source}
  workouts: [],     // {id, startedAt, finishedAt, durationSec, sets}
  chartMode: "raw", // "raw" | "smooth"
  heatmapSel: null, // dayKey of selected workout heatmap cell
  foodHeatmapSel: null, // dayKey of selected food log heatmap cell
  chats: { nutrition: [], gym: [] }, // {id, role, content, at}
  coachMemory: { nutrition: [], gym: [] }, // durable facts learned in chat, survive a Reset
  chatExpanded: { nutrition: false, gym: false }, // show full history vs just the recent tail
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
    audio: null,
    speakBtn: null,
  },
};

/* ---------- Firestore helpers ---------- */
// Every user-owned path is namespaced under users/{uid}/ so accounts are
// fully isolated (also enforced by security rules server-side).
function ucol(path) {
  if (!state.uid) throw new Error("Not signed in");
  return "users/" + state.uid + "/" + path;
}

async function fsGet(col, orderBy, dir) {
  const snap = await db.collection(ucol(col)).orderBy(orderBy, dir || "asc").get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function loadProfile() {
  try {
    const doc = await db.collection(ucol("settings")).doc("profile").get();
    state.hasProfileDoc = doc.exists;
    if (doc.exists) state.profile = { ...DEFAULT_PROFILE, ...doc.data() };
  } catch (e) {
    console.warn("profile load failed:", e);
  }
}

async function saveProfile() {
  await db.collection(ucol("settings")).doc("profile").set(state.profile);
}

async function loadWeights() {
  state.weights = await fsGet("weights", "loggedAt", "asc");
}

async function loadPhotos() {
  state.photos = await fsGet("photos", "takenAt", "desc");
}

async function loadMeasurements() {
  state.measurements = await fsGet("measurements", "loggedAt", "asc");
}

async function loadMeals() {
  state.meals = await fsGet("meals", "loggedAt", "asc");
}

async function loadWorkouts() {
  const snap = await db.collection(ucol("workouts")).get();
  state.workouts = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => new Date(a.loggedAt || a.startedAt || 0) - new Date(b.loggedAt || b.startedAt || 0));
}

async function loadCoachMemory() {
  try {
    const doc = await db.collection(ucol("settings")).doc("coachMemory").get();
    if (doc.exists) {
      const d = doc.data();
      state.coachMemory = {
        nutrition: Array.isArray(d.nutrition) ? d.nutrition : [],
        gym: Array.isArray(d.gym) ? d.gym : [],
      };
    }
  } catch (e) { /* offline or brand-new account — empty memory is fine */ }
}

async function loadChat(coach) {
  state.chats[coach] = await fsGet("chats/" + coach + "/messages", "at", "asc");
}

async function addChatMsg(coach, role, content, img, extra) {
  const msg = { role, content, at: new Date().toISOString() };
  if (img) msg.img = img;
  if (extra) Object.assign(msg, extra); // e.g. { action } — a coach tool action to display
  const ref = await db.collection(ucol("chats")).doc(coach).collection("messages").add(msg);
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
// Day boundary is 3 AM, not midnight — so a late-night snack at 12:05 AM
// still counts toward the day that's ending, not the new one. Shift the
// timestamp back by the cutoff before reading out Y/M/D; everything from
// 3:00 AM onward maps normally, everything before it falls back to the
// previous calendar day.
const DAY_CUTOFF_HOURS = 3;
function dayKey(iso) {
  const d = new Date(new Date(iso).getTime() - DAY_CUTOFF_HOURS * 60 * 60 * 1000);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// Counts consecutive days (ending today or yesterday) that have at least one entry.
// entries: array of {..., [dateField]: iso}. Walks backward from today so a
// missed day breaks the streak; still-open "today" doesn't count against you yet.
function computeStreak(entries, dateField) {
  if (!entries.length) return 0;
  const days = new Set(entries.map((e) => dayKey(e[dateField])));
  const today = new Date();
  let streak = 0;
  let cursor = new Date(today);
  // if today has no entry yet, start counting from yesterday instead of breaking at 0
  if (!days.has(dayKey(cursor.toISOString()))) {
    cursor.setDate(cursor.getDate() - 1);
  }
  while (days.has(dayKey(cursor.toISOString()))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
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
const TABS = ["dashboard", "photos", "nutrition", "gym", "social", "settings"];
function go(tab) {
  state.tab = tab;
  try { localStorage.setItem("gutcheckTab", tab); } catch (e) { /* private browsing — just won't persist */ }
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

  // baby countdown (dashboard card) — Ethan's account only, not shown for other users
  if (p.babyDue && String(state.userEmail || "").toLowerCase() === ADMIN_EMAIL) {
    const due = new Date(p.babyDue + "T00:00:00");
    const days = Math.max(0, Math.ceil((due - Date.now()) / 86400000));
    $("#babyDays").textContent = String(days);
    $("#babyDueLabel").textContent = "due " + due.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
    $("#babyCard").hidden = false;
  } else {
    $("#babyCard").hidden = true;
  }

  const wStreak = computeStreak(state.weights, "loggedAt");
  const pStreak = computeStreak(state.photos, "takenAt");
  $("#streakWeight").textContent = String(wStreak);
  $("#streakPhoto").textContent = String(pStreak);

  renderChart();
  renderWeightLog();
  renderMeasurements();
  renderMealTotals();
  renderFoodHeatmap();
}

// 7-day trailing average, keyed to each raw entry's date (so short histories
// still get a (partial) smoothed line instead of waiting for 7 entries to exist).
function smoothWeights(weights) {
  return weights.map((w, i) => {
    const cutoff = new Date(w.loggedAt); cutoff.setDate(cutoff.getDate() - 6);
    const window = weights.filter((x, j) => j <= i && new Date(x.loggedAt) >= cutoff);
    const avg = window.reduce((s, x) => s + x.weight, 0) / window.length;
    return { loggedAt: w.loggedAt, weight: Math.round(avg * 10) / 10 };
  });
}

function renderChart() {
  const svg = $("#weightChart");
  const empty = $("#chartEmpty");
  const note = $("#trendNote");
  const raw = state.weights;
  if (raw.length < 2) {
    svg.setAttribute("hidden", ""); // SVG elements don't reflect the .hidden property
    empty.hidden = false;
    note.hidden = true;
    return;
  }
  const source = state.chartMode === "smooth" ? smoothWeights(raw) : raw;
  const pts = source.map((w) => ({ x: fmtDayShort(w.loggedAt), y: w.weight }));

  // trend note: lbs/week over the visible history, from a simple first-to-last slope
  const days = Math.max(1, (new Date(raw[raw.length - 1].loggedAt) - new Date(raw[0].loggedAt)) / 86400000);
  const perWeek = ((raw[raw.length - 1].weight - raw[0].weight) / days) * 7;
  note.hidden = false;
  note.innerHTML = "";
  note.appendChild(document.createTextNode("trend: "));
  const b = el("b", null, (perWeek <= 0 ? "" : "+") + perWeek.toFixed(1) + " lb/week");
  note.appendChild(b);

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

function promptEditWeight(current) {
  return new Promise((resolve) => {
    const gate = $("#weightEditGate");
    const input = $("#weightEditInput");
    input.value = current;
    gate.hidden = false;
    setTimeout(() => { input.focus(); input.select(); }, 50);
    const save = $("#weightEditSave");
    const cancel = $("#weightEditCancel");
    const done = (val) => {
      gate.hidden = true;
      save.onclick = null;
      cancel.onclick = null;
      input.onkeydown = null;
      resolve(val);
    };
    save.onclick = () => done(parseFloat(input.value));
    cancel.onclick = () => done(null);
    input.onkeydown = (e) => { if (e.key === "Enter") done(parseFloat(input.value)); };
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
    const b = el("b", "editable-weight", w.weight + " lbs");
    b.title = "Tap to edit";
    b.addEventListener("click", async () => {
      const newVal = await promptEditWeight(w.weight);
      if (newVal === null || isNaN(newVal)) return;
      if (newVal < 50 || newVal > 800) { toast("Enter a valid weight in lbs", true); return; }
      try {
        await db.collection(ucol("weights")).doc(w.id).set({ weight: newVal }, { merge: true });
        w.weight = newVal;
        renderDashboard();
        toast("Weight updated");
      } catch (e) { toast("Update failed: " + e.message, true); }
    });
    const del = el("button", "del", "✕");
    del.title = "Delete entry";
    del.addEventListener("click", async () => {
      if (!(await confirmAction("Delete the " + w.weight + " lbs entry from " + fmtDayShort(w.loggedAt) + "? This can't be undone."))) return;
      try {
        await db.collection(ucol("weights")).doc(w.id).delete();
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
    const ref = await db.collection(ucol("weights")).add(entry);
    state.weights.push({ id: ref.id, ...entry });
    $("#weightInput").value = "";
    renderDashboard();
    toast("Weight logged");
  } catch (e) { toast("Save failed: " + e.message, true); }
}

/* ---------- measurements ---------- */
const MEAS_FIELDS = [
  { key: "waist", label: "Waist" },
  { key: "chest", label: "Chest" },
  { key: "arms", label: "Arms" },
  { key: "thighs", label: "Thighs" },
];

async function logMeasurements() {
  const entry = { loggedAt: new Date().toISOString() };
  let any = false;
  MEAS_FIELDS.forEach((f) => {
    const raw = $("#m_" + f.key).value.trim();
    if (raw !== "") {
      const v = parseFloat(raw);
      if (!isNaN(v)) { entry[f.key] = v; any = true; }
    }
  });
  if (!any) { toast("Enter at least one measurement", true); return; }
  try {
    const ref = await db.collection(ucol("measurements")).add(entry);
    state.measurements.push({ id: ref.id, ...entry });
    MEAS_FIELDS.forEach((f) => { $("#m_" + f.key).value = ""; });
    renderMeasurements();
    toast("Measurements logged");
  } catch (e) { toast("Save failed: " + e.message, true); }
}

function renderMeasurements() {
  const grid = $("#measGrid");
  const emptyHint = $("#measEmpty");
  while (grid.firstChild) grid.removeChild(grid.firstChild);
  let any = false;
  MEAS_FIELDS.forEach((f) => {
    const entries = state.measurements.filter((m) => m[f.key] != null);
    if (!entries.length) return;
    any = true;
    const first = entries[0][f.key];
    const latest = entries[entries.length - 1][f.key];
    const delta = latest - first;
    const card = el("div", "meas-card");
    card.appendChild(el("div", "mlabel", f.label));
    card.appendChild(el("div", "mnum", latest + " in"));
    if (entries.length > 1 && delta !== 0) {
      const dEl = el("div", "mdelta " + (delta < 0 ? "down" : "up"),
        (delta > 0 ? "+" : "") + delta.toFixed(1) + " in since first log");
      card.appendChild(dEl);
    }
    grid.appendChild(card);
  });
  emptyHint.hidden = any;
}

/* ---------- meals: "Today's Fuel" card (photo/description -> Maya estimate or manual -> save) ---------- */
let mealAttach = null; // pending photo data URL for the meal being composed

function renderMealPhotoPrev() {
  const prev = $("#mealPhotoPrev");
  while (prev.firstChild) prev.removeChild(prev.firstChild);
  prev.hidden = !mealAttach;
  if (!mealAttach) return;
  const img = document.createElement("img");
  img.src = mealAttach;
  img.alt = "meal photo";
  prev.appendChild(img);
  prev.appendChild(el("span", null, "Photo attached"));
  const rm = el("button", "rm", "✕");
  rm.type = "button";
  rm.title = "Remove photo";
  rm.addEventListener("click", () => { mealAttach = null; renderMealPhotoPrev(); });
  prev.appendChild(rm);
}

// Opens the phone camera straight away (mobile + PWA) via the capture attribute;
// on desktop the attribute is ignored and a normal file picker opens instead.
// Use this for "Take a photo" buttons — plain file inputs skip the camera entirely in many PWAs.
function takeCameraPhoto(onFile) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.setAttribute("capture", "environment");
  input.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) onFile(f);
  });
  input.click();
}

// Plain file input, no "capture" attribute — on mobile this opens the native
// chooser with both Camera and Photo Library options, so one button covers both.
function pickMealPhoto() {
  // One Upload button -> choose camera or library first (Android Chrome
  // doesn't offer the native choice, so we ask explicitly).
  const gate = $("#photoPickGate");
  gate.hidden = false;
  $("#pickCameraBtn").onclick = () => { gate.hidden = true; openMealPhotoInput("environment"); };
  $("#pickLibraryBtn").onclick = () => { gate.hidden = true; openMealPhotoInput(null); };
  $("#pickCancelBtn").onclick = () => { gate.hidden = true; };
}

function openMealPhotoInput(capture) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  if (capture) input.capture = capture;
  input.addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const data = await compressForFirestore(f);
      mealAttach = await downscaleDataUrl(data, 768, 0.8);
      renderMealPhotoPrev();
    } catch (err) { toast("Could not read photo: " + err.message, true); }
  });
  input.click();
}

function openMealConfirm(estText, cal, protein) {
  $("#mealEstText").textContent = estText;
  $("#m_cal").value = cal != null ? cal : "";
  $("#m_pro").value = protein != null ? protein : "";
  $("#mealConfirm").hidden = false;
}

function closeMealConfirm() {
  $("#mealConfirm").hidden = true;
}

function openManualMealEntry() {
  const desc = $("#mealDesc").value.trim();
  openMealConfirm(desc ? "Manual entry — " + desc : "Manual entry — enter your numbers below.", null, null);
}

async function estimateMealWithMaya() {
  const desc = $("#mealDesc").value.trim();
  if (!desc && !mealAttach) { toast("Describe the meal or attach a photo first", true); return; }

  const btn = $("#mealEstimateBtn");
  btn.disabled = true;
  const origLabel = btn.textContent;
  btn.textContent = "Estimating…";
  try {
    const content = [];
    if (mealAttach) {
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: mealAttach.split(",")[1] || "" } });
    }
    content.push({
      type: "text",
      text: "Estimate calories and protein for this meal" + (desc ? ": " + desc : " from the photo") +
        ". Respond with ONLY compact JSON, no markdown, no explanation: " +
        "{\"description\":\"short 3-6 word name for this meal\",\"calories\":number,\"protein\":number}",
    });
    const res = await fns.httpsCallable("coachCall")({
      system: "You are Maya, a nutrition estimation engine. Reply with ONLY the compact JSON the client asks for — no markdown, no explanation.",
      messages: [{ role: "user", content }],
      useTools: false,
    });
    const raw = String((res.data && res.data.text) || "").trim();
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    const est = "Maya's estimate — " + esc(parsed.description || desc || "meal") + ": " +
      Math.round(parsed.calories) + " kcal, " + Math.round(parsed.protein) + "g protein. Adjust below if needed.";
    openMealConfirm(est, Math.round(parsed.calories) || "", Math.round(parsed.protein) || "");
  } catch (e) {
    toast("Estimate failed: " + e.message + " — you can still enter numbers manually", true);
  } finally {
    btn.disabled = false;
    btn.textContent = origLabel;
  }
}

async function saveMealEntry() {
  const cal = parseFloat($("#m_cal").value);
  const protein = parseFloat($("#m_pro").value);
  if (isNaN(cal) && isNaN(protein)) { toast("Enter calories or protein", true); return; }
  const desc = $("#mealDesc").value.trim();
  const entry = {
    loggedAt: new Date().toISOString(),
    description: desc || "Meal",
    calories: isNaN(cal) ? 0 : cal,
    protein: isNaN(protein) ? 0 : protein,
    source: mealAttach ? "photo" : "manual",
  };
  if (mealAttach) entry.imageData = mealAttach;
  const btn = $("#mealSaveBtn");
  btn.disabled = true;
  try {
    const ref = await db.collection(ucol("meals")).add(entry);
    state.meals.push({ id: ref.id, ...entry });
    $("#mealDesc").value = "";
    mealAttach = null;
    renderMealPhotoPrev();
    closeMealConfirm();
    renderMealTotals();
    renderFoodHeatmap();
    toast("Meal logged");
    if (window.socialOnMealLogged) socialOnMealLogged();
    if (window.checkSodaAutoPost) window.checkSodaAutoPost(entry.description);
  } catch (e) {
    toast("Save failed: " + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// Promise-based "are you sure?" dialog — blocks accidental one-tap deletes.
function confirmAction(msg, yesLabel, noLabel) {
  return new Promise((resolve) => {
    const gate = $("#confirmGate");
    $("#confirmMsg").textContent = msg;
    gate.hidden = false;
    const yes = $("#confirmYes");
    const no = $("#confirmNo");
    yes.textContent = yesLabel || "Delete";
    no.textContent = noLabel || "Keep it";
    const done = (val) => {
      gate.hidden = true;
      yes.onclick = null;
      no.onclick = null;
      yes.textContent = "Delete";
      no.textContent = "Keep it";
      resolve(val);
    };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
  });
}

async function deleteMeal(id) {
  const meal = state.meals.find((m) => m.id === id);
  const label = meal ? (meal.description || "this meal") : "this meal";
  if (!(await confirmAction("Delete \"" + label + "\" from your food log? This can't be undone."))) return;
  try {
    await db.collection(ucol("meals")).doc(id).delete();
    state.meals = state.meals.filter((m) => m.id !== id);
    renderMealTotals();
    renderFoodHeatmap();
    toast("Entry deleted");
  } catch (e) { toast("Delete failed: " + e.message, true); }
}

function renderMealTotals() {
  const todayKey = dayKey(new Date().toISOString());
  const today = state.meals.filter((m) => dayKey(m.loggedAt) === todayKey);
  const cal = today.reduce((s, m) => s + (m.calories || 0), 0);
  const protein = today.reduce((s, m) => s + (m.protein || 0), 0);
  const calGoal = parseFloat(state.profile.calories) || 0;
  const proteinGoal = parseFloat(state.profile.protein) || 0;

  $("#fuelCalLabel").textContent = Math.round(cal) + " / " + (calGoal || "–");
  $("#fuelProLabel").textContent = Math.round(protein) + " / " + (proteinGoal || "–") + "g";
  $("#fuelCalBar").style.width = (calGoal ? Math.min(100, (cal / calGoal) * 100) : 0) + "%";
  $("#fuelProBar").style.width = (proteinGoal ? Math.min(100, (protein / proteinGoal) * 100) : 0) + "%";
  const left = $("#fuelLeft");
  if (calGoal) {
    const remaining = Math.round(calGoal - cal);
    left.textContent = remaining >= 0 ? remaining + " kcal left" : (-remaining) + " over";
  } else {
    left.textContent = "–";
  }

  const list = $("#mealList");
  while (list.firstChild) list.removeChild(list.firstChild);
  today.slice().reverse().forEach((m) => {
    const row = el("div", "wrow");
    const left2 = el("span", null, (m.description || "Meal") + (m.source === "photo" ? " 📷" : ""));
    const right = el("span");
    const b = el("b", null, Math.round(m.calories || 0) + " kcal · " + Math.round(m.protein || 0) + "g");
    const del = el("button", "del", "✕");
    del.title = "Delete entry";
    del.addEventListener("click", () => deleteMeal(m.id));
    right.appendChild(b);
    right.appendChild(document.createTextNode(" "));
    right.appendChild(del);
    row.appendChild(left2);
    row.appendChild(right);
    list.appendChild(row);
  });
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
    const ref = await db.collection(ucol("photos")).add(entry);
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
  if (!(await confirmAction("Delete this progress photo? This can't be undone."))) return;
  try {
    await db.collection(ucol("photos")).doc(id).delete();
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
/* ---------- workout history heatmap (reads what finishWorkout() already saves) ---------- */
const HEATMAP_WEEKS = 18;

function heatLevel(tagCount) {
  if (!tagCount) return 0;
  if (tagCount === 1) return 1;
  if (tagCount === 2) return 2;
  if (tagCount === 3) return 3;
  return 4;
}

function renderHeatmap() {
  const grid = $("#heatmapGrid");
  const summary = $("#heatmapSummary");
  if (!grid) return;
  while (grid.firstChild) grid.removeChild(grid.firstChild);

  // group logged entries per day (legacy entries without a tags array still count as one generic entry)
  const byDay = {};
  state.workouts.forEach((w) => {
    const k = dayKey(w.loggedAt || w.startedAt);
    byDay[k] = byDay[k] || { tags: [], entries: [] };
    const tags = Array.isArray(w.tags) && w.tags.length ? w.tags : ["Workout"];
    byDay[k].entries.push({ id: w.id, tags });
    tags.forEach((t) => byDay[k].tags.push(t));
  });

  const totalDays = HEATMAP_WEEKS * 7;
  const today = new Date();
  // align the grid to end on today, oldest day first, columns = weeks (7 rows each)
  const start = new Date(today);
  start.setDate(start.getDate() - (totalDays - 1));
  // pad so the first column starts on a Sunday, matching the 7-row grid
  const pad = start.getDay();
  start.setDate(start.getDate() - pad);

  for (let i = 0; i < totalDays + pad; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const k = dayKey(d.toISOString());
    const inFuture = d > today;
    const info = byDay[k];
    const lvl = info ? heatLevel(info.tags.length) : 0;
    const cell = el("div", "heat-cell" + (lvl ? " lvl" + lvl : ""));
    if (inFuture) cell.style.visibility = "hidden";
    else {
      cell.title = fmtDayShort(d.toISOString()) + (info ? " — " + info.tags.join(", ") : " — rest day");
      cell.addEventListener("click", () => showHeatmapDay(k, info));
    }
    grid.appendChild(cell);
  }

  const activeDays = Object.keys(byDay).length;
  if (!activeDays) {
    summary.textContent = "No workouts logged yet — tap Log workout to see it here.";
  } else {
    summary.innerHTML = "";
    summary.appendChild(document.createTextNode("Last " + HEATMAP_WEEKS + " weeks: "));
    summary.appendChild(el("b", null, String(activeDays)));
    summary.appendChild(document.createTextNode(" active days."));
  }
}

function showHeatmapDay(k, info) {
  const detail = $("#heatmapDetail");
  if (!detail) return;
  if (state.heatmapSel === k) {
    // tap the same day again to close it
    detail.hidden = true;
    state.heatmapSel = null;
    return;
  }
  state.heatmapSel = k;
  while (detail.firstChild) detail.removeChild(detail.firstChild);
  detail.hidden = false;
  const dateLabel = new Date(k + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const head = el("div", "hd-head");
  head.appendChild(el("div", "hd-date", dateLabel));
  const editBtn = el("button", "link-btn hd-edit", info ? "✏️ Edit" : "+ Log this day");
  editBtn.type = "button";
  editBtn.addEventListener("click", () => editWorkoutDay(k, info || { tags: [], entries: [] }));
  head.appendChild(editBtn);
  detail.appendChild(head);
  if (!info) {
    detail.appendChild(el("div", "hd-row", "Rest day — no workout logged."));
    return;
  }
  detail.appendChild(el("div", "hd-row", info.tags.join(", ")));
}

/* ---------- food log history heatmap (past days: hit/miss calorie + protein targets) ---------- */
function renderFoodHeatmap() {
  const grid = $("#foodHeatmapGrid");
  const summary = $("#foodHeatmapSummary");
  if (!grid) return;
  while (grid.firstChild) grid.removeChild(grid.firstChild);

  const calGoal = parseFloat(state.profile.calories) || 0;
  const proGoal = parseFloat(state.profile.protein) || 0;

  // sum calories/protein per day, plus keep the individual meals for the detail view
  const byDay = {};
  state.meals.forEach((m) => {
    const k = dayKey(m.loggedAt);
    byDay[k] = byDay[k] || { calories: 0, protein: 0, meals: [] };
    byDay[k].calories += m.calories || 0;
    byDay[k].protein += m.protein || 0;
    byDay[k].meals.push(m);
  });

  const totalDays = HEATMAP_WEEKS * 7;
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - (totalDays - 1));
  const pad = start.getDay();
  start.setDate(start.getDate() - pad);

  let goodDays = 0, partialDays = 0, offDays = 0;
  for (let i = 0; i < totalDays + pad; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const k = dayKey(d.toISOString());
    const inFuture = d > today;
    const info = byDay[k];

    let cls = "";
    if (info && calGoal && proGoal) {
      const underCal = info.calories <= calGoal;
      const overProtein = info.protein >= proGoal;
      if (underCal && overProtein) { cls = " food-good"; goodDays++; }
      else if (underCal || overProtein) { cls = " food-partial"; partialDays++; }
      else { cls = " food-off"; offDays++; }
    }
    const cell = el("div", "heat-cell" + cls);
    if (inFuture) cell.style.visibility = "hidden";
    else {
      cell.title = fmtDayShort(d.toISOString()) + (info
        ? " — " + Math.round(info.calories) + " kcal, " + Math.round(info.protein) + "g protein"
        : " — nothing logged");
      cell.addEventListener("click", () => showFoodHeatmapDay(k, info, calGoal, proGoal));
    }
    grid.appendChild(cell);
  }

  if (!calGoal || !proGoal) {
    summary.textContent = "Set your calorie and protein targets in Settings to see hit/miss coloring.";
  } else if (!goodDays && !partialDays && !offDays) {
    summary.textContent = "No meals logged yet — use Today's fuel on Home to start tracking.";
  } else {
    summary.innerHTML = "";
    summary.appendChild(document.createTextNode("Last " + HEATMAP_WEEKS + " weeks: "));
    summary.appendChild(el("b", null, String(goodDays)));
    summary.appendChild(document.createTextNode(" days hit both, "));
    summary.appendChild(el("b", null, String(partialDays)));
    summary.appendChild(document.createTextNode(" hit one, "));
    summary.appendChild(el("b", null, String(offDays)));
    summary.appendChild(document.createTextNode(" missed both."));
  }
}

function showFoodHeatmapDay(k, info, calGoal, proGoal) {
  const detail = $("#foodHeatmapDetail");
  if (!detail) return;
  if (state.foodHeatmapSel === k) {
    detail.hidden = true;
    state.foodHeatmapSel = null;
    return;
  }
  state.foodHeatmapSel = k;
  while (detail.firstChild) detail.removeChild(detail.firstChild);
  detail.hidden = false;
  const dateLabel = new Date(k + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  detail.appendChild(el("div", "hd-date", dateLabel));
  if (!info) {
    detail.appendChild(el("div", "hd-row", "Nothing logged this day."));
    return;
  }
  const calLine = Math.round(info.calories) + " kcal" + (calGoal ? " / " + calGoal + " goal" + (info.calories <= calGoal ? " ✓" : " over") : "");
  const proLine = Math.round(info.protein) + "g protein" + (proGoal ? " / " + proGoal + "g goal" + (info.protein >= proGoal ? " ✓" : " short") : "");
  detail.appendChild(el("div", "hd-row", calLine + " · " + proLine));
  info.meals.slice().reverse().forEach((m) => {
    const row = el("div", "wrow");
    row.appendChild(el("span", null, (m.description || "Meal") + (m.source === "photo" ? " 📷" : m.source === "maya" ? " ✨" : "")));
    row.appendChild(el("span", null, Math.round(m.calories || 0) + " kcal · " + Math.round(m.protein || 0) + "g"));
    detail.appendChild(row);
  });
}

/* ---------- data export / backup ---------- */
async function exportAllData() {
  const btn = $("#exportBtn");
  const status = $("#exportStatus");
  btn.disabled = true;
  status.hidden = false;
  status.textContent = "Gathering your data…";
  try {
    const payload = {
      exportedAt: new Date().toISOString(),
      profile: state.profile,
      weights: state.weights,
      measurements: state.measurements,
      meals: state.meals,
      workouts: state.workouts,
      photos: state.photos.map((p) => ({ id: p.id, label: p.label, note: p.note, takenAt: p.takenAt, imageData: p.imageData })),
      chats: state.chats,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "gutcheck-backup-" + dayKey(new Date().toISOString()) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    status.textContent = "Downloaded — includes photos, so the file may be large.";
  } catch (e) {
    status.textContent = "Export failed: " + e.message;
  } finally {
    btn.disabled = false;
  }
}

function buildCoachPanel(coachId) {
  const meta = COACHES[coachId];
  const panel = $("#panel-" + coachId);

  const head = el("div", "chat-head");
  const idBox = el("div", "chat-id");
  const av = el("div", "avatar", meta.short[0]);
  av.id = "avatarBox-" + coachId;
  av.classList.add("tap-zoom");
  av.title = "Tap to see " + meta.short + " full size";
  av.addEventListener("click", () => showAvatarFull(coachId));
  idBox.appendChild(av);
  const nameBox = el("div");
  nameBox.appendChild(el("div", "chat-name", meta.name));
  nameBox.appendChild(el("div", "chat-role", meta.title));
  idBox.appendChild(nameBox);
  head.appendChild(idBox);
  const actions = el("div", "chat-head-actions");
  const timerB = el("button", "link-btn timer-btn", coachId === "gym" ? "📋" : "⏱");
  timerB.id = "timerBtn-" + coachId;
  timerB.title = coachId === "gym" ? "Log workout" : "Kitchen timer";
  timerB.addEventListener("click", () => openTimerSheet(coachId));
  actions.appendChild(timerB);
  const reset = el("button", "link-btn", "↺ Reset");
  reset.addEventListener("click", () => clearChat(coachId));
  actions.appendChild(reset);
  head.appendChild(actions);
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
  ta.placeholder = "Message " + meta.short + "…";
  ta.id = "chatInput-" + coachId;
  const autoGrow = () => {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 130) + "px";
  };
  ta.addEventListener("input", autoGrow);
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

  // floating jump buttons: back to top / back to the chat box
  const jumps = el("div", "jump-btns");
  jumps.id = "jumpBtns-" + coachId;
  jumps.hidden = true;
  const jt = el("button", "jump-fab", "↑");
  jt.type = "button";
  jt.id = "jumpTop-" + coachId;
  jt.title = "Jump to top";
  jt.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  const jb = el("button", "jump-fab", "↓");
  jb.type = "button";
  jb.id = "jumpInput-" + coachId;
  jb.title = "Jump to the bottom";
  jb.addEventListener("click", () => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
  });
  jumps.appendChild(jt);
  jumps.appendChild(jb);
  panel.appendChild(jumps);
}

function setupJumpBtns() {
  const sync = () => {
    const doc = document.documentElement;
    const atBottom = window.scrollY + window.innerHeight >= doc.scrollHeight - 60;
    ["nutrition", "gym"].forEach((id) => {
      const j = $("#jumpBtns-" + id);
      const panel = $("#panel-" + id);
      if (!j || !panel) return;
      // only show while actually mid-scroll — hidden at the very top and the very bottom
      j.hidden = panel.hidden || window.scrollY < 320 || atBottom;
    });
  };
  window.addEventListener("scroll", sync, { passive: true });
  window.addEventListener("resize", sync);
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

function msgAvatar(coachId) {
  const meta = COACHES[coachId];
  const a = el("button", "msg-avatar");
  a.type = "button";
  a.title = meta.short + " — tap to enlarge";
  if (AVATARS[coachId]) {
    const i = document.createElement("img");
    i.src = AVATARS[coachId];
    i.alt = meta.short;
    a.appendChild(i);
  } else {
    a.textContent = meta.short[0];
  }
  a.addEventListener("click", () => showAvatarFull(coachId));
  return a;
}

function botRow(coachId, bubble) {
  const row = el("div", "msg-row");
  row.appendChild(msgAvatar(coachId));
  row.appendChild(bubble);
  return row;
}

/* Renders a user chat message with the "remember" trigger phrase highlighted
   in a distinct pill, so the client can SEE that the message was treated as
   a memory instruction. (REMEMBER_RE lives by sendCoachMessage, hoisted use
   here is fine since it's a const evaluated before any render.) */
function appendUserContent(div, text) {
  const m = (text || "").match(REMEMBER_RE);
  if (!m) { div.appendChild(document.createTextNode(text || "")); return; }
  div.appendChild(document.createTextNode(text.slice(0, m.index)));
  div.appendChild(el("span", "remember-hit", m[0]));
  div.appendChild(document.createTextNode(text.slice(m.index + m[0].length)));
}

function renderChat(coachId) {
  const meta = COACHES[coachId];
  const wrap = $("#chatScroll-" + coachId);
  while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
  const msgs = state.chats[coachId];

  if (!msgs.length) {
    wrap.appendChild(botRow(coachId, el("div", "msg bot", meta.greeting)));
    const sug = el("div", "suggestions");
    meta.suggestions.forEach((s) => {
      const chip = el("button", "chip", s);
      chip.addEventListener("click", () => sendCoachMessage(coachId, s));
      sug.appendChild(chip);
    });
    wrap.appendChild(sug);
    return;
  }

  const CHAT_VISIBLE = 20;
  const expanded = state.chatExpanded[coachId];
  const hiddenCount = msgs.length - CHAT_VISIBLE;
  const showEarlierLink = !expanded && hiddenCount > 0;
  const toRender = showEarlierLink ? msgs.slice(-CHAT_VISIBLE) : msgs;

  if (showEarlierLink) {
    const btn = el("button", "link-btn center-btn show-earlier", "Show " + hiddenCount + " earlier message" + (hiddenCount > 1 ? "s" : ""));
    btn.type = "button";
    btn.addEventListener("click", () => { state.chatExpanded[coachId] = true; renderChat(coachId); });
    wrap.appendChild(btn);
  }

  toRender.forEach((m) => {
    const div = el("div", "msg " + (m.role === "user" ? "user" : "bot"));
    if (m.img) {
      const im = document.createElement("img");
      im.src = m.img;
      im.alt = "shared photo";
      im.className = "chat-img";
      div.appendChild(im);
    }
    if (m.role === "user") appendUserContent(div, m.content);
    else div.appendChild(document.createTextNode(m.content));
    const foot = el("span", "time", fmtTime(m.at));
    div.appendChild(foot);
    if (m.role !== "user") {
      const spk = el("button", "speak-btn", "🔊");
      spk.title = "Play as " + meta.short;
      spk.addEventListener("click", () => speakText(coachId, m.content, spk));
      div.appendChild(spk);
      wrap.appendChild(botRow(coachId, div));
      // tool actions (meal logged/deleted) get a color-coded chip so "I did
      // that" is always backed by a visible, persisted receipt
      if (m.action) {
        const deleted = m.action.type === "deleted";
        const label = (deleted ? "🗑️ Removed: " : "✅ Logged: ") + m.action.summary + " — see Today's fuel on Home";
        wrap.appendChild(el("div", "action-note" + (deleted ? " deleted" : ""), label));
      } else if (m.unverifiedClaim) {
        wrap.appendChild(el("div", "action-note unverified", "⚠️ This reply mentions logging/removing something, but no log action actually happened — check Today's fuel to be sure."));
      }
    } else {
      wrap.appendChild(div);
      if (m.remembered) {
        wrap.appendChild(el("div", "remember-note", "🧠 Saved to " + meta.short + "'s memory — see it in Settings"));
      }
    }
  });

  if (state.sending[coachId]) {
    const t = el("div", "msg bot typing");
    const s = el("span", "spin", "◌");
    t.appendChild(s);
    t.appendChild(document.createTextNode(meta.short + " is thinking…"));
    wrap.appendChild(botRow(coachId, t));
  }
}

/* ---------- full-size coach photo viewer ---------- */
function showAvatarFull(coachId) {
  const meta = COACHES[coachId];
  const src = AVATARS[coachId];
  if (!src) { toast("No photo yet — generate coach avatars in Settings"); return; }
  let v = $("#avatarViewer");
  if (!v) {
    v = el("div", "avatar-viewer");
    v.id = "avatarViewer";
    v.hidden = true;
    const frame = el("div", "av-frame");
    const img = document.createElement("img");
    img.id = "avatarViewerImg";
    img.alt = "coach photo";
    frame.appendChild(img);
    const cap = el("div", "av-cap");
    cap.id = "avatarViewerCap";
    frame.appendChild(cap);
    const closeB = el("button", "icon-btn av-close", "✕");
    closeB.title = "Close";
    frame.appendChild(closeB);
    v.appendChild(frame);
    v.addEventListener("click", () => { v.hidden = true; });
    document.body.appendChild(v);
  }
  $("#avatarViewerImg").src = src;
  $("#avatarViewerCap").textContent = meta.name + " — " + meta.title;
  v.hidden = false;
}

// Split into { stable, dynamic } so the server can mark the stable block with
// cache_control — the dynamic "logged today" line changes on every log_meal
// call and would otherwise invalidate the cache on exactly the round we want it.
function memoryBlockFor(coachId) {
  const facts = (state.coachMemory && state.coachMemory[coachId]) || [];
  if (!facts.length) return "";
  return "LONG-TERM MEMORY (persists even if the client clears this chat) — things you've learned about them over time:\n" +
    facts.map((f) => "- " + f).join("\n");
}

function coachSystemParts(coachId) {
  const p = state.profile;
  const todayLabel = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const shared =
    "\n\nTODAY'S ACTUAL DATE: " + todayLabel + ". Trust this over any date assumption from your training — always use this as the true current date." +
    "\n\nCLIENT PROFILE:\n- Name: " + (p.name || "not given — ask their name early if it hasn't come up") +
    "\n- Height: " + p.height + ", Age: " + p.age +
    "\n- Start weight: " + p.startWeight + " lbs, Goal: " + p.goalWeight + " lbs" +
    "\n- Daily targets: " + p.calories + " calories, " + p.protein + "g protein" +
    "\n- Background: " + p.context +
    "\n\nRULES:\n- Be direct, warm, and practical. Short paragraphs. No fluff." +
    "\n- PLAIN TEXT ONLY: never use asterisks, markdown, em-dashes as decoration, bullet symbols, or role-play actions (no *smiles*, no **bold**). " +
    "This applies even when correcting yourself, apologizing, or emphasizing an important number — say it plainly with word choice and sentence structure, never with bold/asterisk markup, no matter how much you want to underline the point. " +
    "Your replies are read aloud by a text-to-speech voice — write exactly how a real human coach would speak. " +
    "Lists are fine as short separate lines starting with a number, like \"1. \"." +
    "\n- Give specific numbers, portions, sets, and reps — never vague advice." +
    "\n- The client can attach photos (meals, physique, equipment) — comment specifically on what you see." +
    "\n- You are not a doctor; for medical red flags, say so briefly and move on." +
    "\n- Remember the conversation history and build on it." +
    "\n- Use the client's first name naturally sometimes (greetings, check-ins) — not every message, just like a real coach would." +
    "\n- LONG-TERM MEMORY: you have a remember_fact tool. Call it sparingly, only for something durable worth carrying forward even if this chat gets cleared — " +
    "a real preference, an injury or health note, a routine change they've committed to. Never for small talk or one-off requests, and never for anything already in the client profile above." +
    " If the client explicitly asks you to remember or note something (\"remember\", \"add this to your memory\", \"don't forget\"), you MUST call remember_fact for it on that same turn — " +
    "saying \"I've got it\" without calling the tool means the fact is lost the moment this chat is cleared.";
  if (coachId === "nutrition") {
    const todayKey = dayKey(new Date().toISOString());
    const todayMeals = state.meals.filter((m) => dayKey(m.loggedAt) === todayKey);
    const calSoFar = todayMeals.reduce((s, m) => s + (m.calories || 0), 0);
    const proteinSoFar = todayMeals.reduce((s, m) => s + (m.protein || 0), 0);
    // Genuinely volatile (changes every meal logged) — kept separate from the
    // memory block below so logging a meal doesn't blow the memory cache too.
    const dynamic = todayMeals.length
      ? "LOGGED SO FAR TODAY: " + Math.round(calSoFar) + " kcal / " + Math.round(proteinSoFar) + "g protein, from: " +
        todayMeals.map((m) => (m.name || m.description || m.desc || "a logged meal") + " (id " + m.id + ")").join(", ") +
        ". Use this to say what's left for the day, not just the flat daily target. The (id ...) after each item is its exact meal_id for the delete_meal tool if the client ever asks to remove one — never show these ids to the client, they're only for you."
      : "Nothing logged yet today — no need to mention this unless it's relevant.";
    const me = COACHES.nutrition.short;
    const other = COACHES.gym.short;
    return {
      stable: "You are " + me + ", an expert sports nutritionist and fat-loss coach." + shared +
        "\n- Stay within the client's calorie and protein targets unless asked otherwise." +
        "\n- When suggesting meals, include rough calories and protein per item." +
        "\n- Favor simple, cheap, fast home cooking the client can actually make." +
        "\n- STAY IN YOUR LANE: your domain is food — calories, protein, meals, groceries, eating out, cravings, hydration. " +
        "You work alongside " + other + ", the strength coach, who lives in the Coach tab. " +
        "If the client asks about workouts, exercises, form, or training plans, give at most ONE short sentence, then redirect: \"That's " + other + "'s department — ask " + other + " in the Coach tab.\" " +
        "Never write out workout routines, sets, or reps." +
        "\n- MEAL LOGGING: you have a log_meal tool that writes straight to the client's dashboard tracker. " +
        "When the client tells you what they ate expecting it to be tracked (or asks you to log something), call log_meal with your best realistic estimate, then confirm in one short sentence with the numbers and what's left today. " +
        "Group foods eaten together as ONE meal into a SINGLE log_meal call with combined totals — e.g. eggs, toast, butter, and cheese for breakfast is one entry, not four. Only make separate calls when the client describes genuinely separate eating occasions in the same message (like breakfast AND a separate afternoon snack). " +
        "ALWAYS write your own short, clean name for the description field — just the food items themselves (e.g. \"Eggs, cheese, toast, butter\"), roughly 3-8 words. Strip out everything else: the client's own phrasing, restated calories/macros, brand names, hedging, photo references. Never paste their raw wording or a long/rambling description into it, no matter how detailed their message was. " +
        "Exception: for sodas and soft drinks, keep the actual drink name instead of genericizing it (e.g. \"Dr Pepper\", not \"Soda\" or \"Soft drink\") — that detail matters here. " +
        "If the meal is too vague to estimate (no portions, no idea what it is), ask ONE short clarifying question instead of logging. " +
        "Never claim you logged something without calling the tool. Discussing or estimating a food's calories earlier in the conversation is NOT the same as logging it — if the client then asks you to log or track it, or to make sure it's logged, you MUST call log_meal at that point even if you already stated the same numbers before. Every time they ask you to log something is a fresh request for a fresh tool call, never something you can fulfill by just repeating numbers from earlier. " +
        "\n- MEAL DELETION: you also have a delete_meal tool. Use it ONLY when the client clearly asks to remove, delete, or undo a specific entry from today's log — never on your own initiative, and never if you're not sure which entry they mean (ask them to clarify instead of guessing). " +
        "When they do ask, you MUST actually call the tool — never claim a technical issue, say you \"hit a snag,\" or apologize for a problem without having genuinely attempted the tool call first. " +
        "Match what they describe against the LOGGED SO FAR TODAY list and pass that entry's exact meal_id (shown in parentheses next to it) — never invent an id or use the food name as the id. " +
        "After deleting, confirm in one short sentence with the updated totals. Never claim you deleted something without calling the tool. " +
        "If delete_meal (or log_meal) comes back starting with \"Rejected:\", tell the client the SPECIFIC reason from that message, in plain words — never a vague catch-all like \"I hit a snag\" or \"something went wrong on my end.\" They need the actual reason to know what to do next. " +
        "\n- VISIBILITY: you CAN see the client's food log. Every message you receive includes a LOGGED SO FAR TODAY section listing everything eaten today with running totals — " +
        "including meals the client logged themselves on the home screen, not just ones you logged. " +
        "When the client asks what they've eaten, what's in their tracker, or what's left today, answer straight from that section with the item names and numbers. " +
        "Never say you can't see the log or the dashboard — you can." +
        "\n- QUOTING TOTALS: the LOGGED SO FAR TODAY section and the log_meal/delete_meal tool results are the ONLY sources of truth for today's numbers. " +
        "Both tools report exact running totals after every log or delete. Quote those numbers verbatim — never estimate, recompute, round, or add them up yourself. " +
        "If the numbers aren't in front of you, say what you see in the log instead of guessing.",
      memory: memoryBlockFor("nutrition"),
      dynamic,
    };
  }
  const meG = COACHES.gym.short;
  const otherG = COACHES.nutrition.short;
  const gymDesc = coachGender("gym") === "male"
    ? "You are " + meG + ", a sharp, encouraging strength coach specializing in home training and training around lower-back issues."
    : "You are " + meG + ", a sharp, encouraging female strength coach specializing in home training and training around lower-back issues.";
  return {
    stable: gymDesc + shared +
      "\n- All programming must match the client's equipment and injury notes in the profile." +
      "\n- Protect the lower back (or any noted limitation): coach brace/neutral spine, swap risky movements proactively." +
      "\n- Respect the client's health notes: moderate intensity when recovery is a concern, no grind-to-failure every session." +
      "\n- STAY IN YOUR LANE: your domain is training — workouts, form, progression, exercise swaps, steps, recovery. " +
      "You work alongside " + otherG + ", the nutritionist, who lives in the Nutritionist tab. " +
      "If the client asks about food, calories, meal ideas, or diets, give at most ONE short sentence, then redirect: \"That's " + otherG + "'s department — ask " + otherG + " in the Nutritionist tab.\" " +
      "Never write out meal plans or calorie breakdowns.",
    memory: memoryBlockFor("gym"),
    dynamic: "",
  };
}

/* ---------- coach brain (server-side proxy) ---------- */
// All Claude calls — including Maya's log_meal tool-use loop — run inside the
// coachCall Cloud Function. The browser never sees an API key, and the function
// writes meals under the caller's own users/{uid}/ namespace.
// How much of the conversation gets sent to Claude each turn — deliberately
// NOT a naive sliding window. slice(-30) keeps re-sending "the last 30" every
// turn, but once a chat passes 30 messages, that means the OLDEST message
// drops off the front on every single new message, shifting the whole array.
// The prompt cache added in coachCall matches by exact prefix, so that shift
// breaks the cache every single turn, permanently, for any conversation that
// grows past the cap — silently cancelling out the caching we just added.
// Instead, this only moves the window's start in big fixed jumps (CONTEXT_MAX
// - CONTEXT_KEEP messages at a time), so within a run of ~16 turns the front
// stays byte-identical and the cache stays warm; only the (rarer) jump itself
// costs a fresh, uncached write.
const CONTEXT_MAX = 32;
const CONTEXT_KEEP = 16;
function windowedHistory(full) {
  const n = full.length;
  if (n <= CONTEXT_MAX) return full;
  const period = CONTEXT_MAX - CONTEXT_KEEP;
  const start = Math.ceil((n - CONTEXT_MAX) / period) * period;
  return full.slice(start);
}

async function callClaude(coachId, alreadyRemembered) {
  const history = windowedHistory(state.chats[coachId]).map((m) => {
    if (!m.img) return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: String(m.img).split(",")[1] || "" } },
        { type: "text", text: m.content || "(photo shared — no caption)" },
      ],
    };
  });
  // Refresh the food log before building the prompt so the LOGGED SO FAR
  // TODAY section Maya sees can't be stale (e.g. app open for hours while
  // meals were logged elsewhere) — wrong totals erode trust fast.
  if (coachId === "nutrition") { try { await loadMeals(); } catch (e) { /* offline — prompt uses what we have */ } }
  const parts = coachSystemParts(coachId);
  // When the client already saved an explicit "remember …" fact, tell the
  // coach it's done so it doesn't double-save — just acknowledge it.
  let dynamic = parts.dynamic || "";
  if (alreadyRemembered) {
    dynamic += (dynamic ? "\n" : "") +
      "MEMORY NOTE: the client explicitly asked you to remember this: \"" + alreadyRemembered + "\". " +
      "It has ALREADY been saved to your long-term memory — do NOT call remember_fact for it again. " +
      "Just briefly confirm you've noted it, in one short sentence.";
  }
  const res = await fns.httpsCallable("coachCall")({
    system: parts.stable,
    systemMemory: parts.memory,
    systemDynamic: dynamic,
    messages: history,
    useTools: true,
    coachId,
    targets: { calories: state.profile.calories, protein: state.profile.protein },
  });
  const data = res.data || {};
  if (data.mealLogged || data.mealDeleted) {
    await loadMeals();
    renderMealTotals();
    renderFoodHeatmap();
  }
  if (data.mealLogged && window.checkSodaAutoPost) window.checkSodaAutoPost(data.mealLogged);
  if (data.remembered) {
    const arr = (state.coachMemory[coachId] = state.coachMemory[coachId] || []);
    if (!arr.some((f) => f.toLowerCase() === String(data.remembered).toLowerCase())) arr.push(data.remembered);
  }
  if (!data.text) throw new Error("Coach returned an empty response");
  return {
    text: data.text,
    action: data.mealLogged
      ? { type: "logged", summary: data.mealLogged }
      : data.mealDeleted
      ? { type: "deleted", summary: data.mealDeleted }
      : null,
  };
}

/* ---------- voice (Deepgram nova-3 STT; ElevenLabs TTS, Aura-2 fallback — all via voiceCall) ---------- */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("Could not read audio"));
    r.readAsDataURL(blob);
  });
}

async function base64ToBlob(b64, mime) {
  const res = await fetch("data:" + (mime || "audio/mpeg") + ";base64," + b64);
  return res.blob();
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
  const audioBase64 = await blobToBase64(blob);
  const res = await fns.httpsCallable("voiceCall")({
    op: "stt",
    audioBase64,
    mime: blob.type || "application/octet-stream",
  });
  return (res.data && res.data.transcript) ? res.data.transcript.trim() : "";
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

/* strip markdown/asterisks so TTS reads like a human, not a parser */
function ttsClean(text) {
  return String(text || "")
    .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/`{1,3}[^`]*`{1,3}/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^\s*(\d+)\.\s+/gm, "$1, ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~#>]/g, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, ". ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function speakText(coachId, text, btn) {
  // tapping the playing button stops playback
  if (state.voice.speakBtn === btn && state.voice.audio) {
    stopSpeaking();
    return;
  }
  stopSpeaking();

  if (btn) {
    btn.classList.add("speaking");
    btn.textContent = "⏸";
    state.voice.speakBtn = btn;
  }
  try {
    // voiceCall caps text at 1800 chars server-side — chunk conservatively
    const chunks = [];
    let rest = ttsClean(text);
    while (rest.length > 1800) {
      let cut = Math.max(rest.lastIndexOf(". ", 1800), rest.lastIndexOf("! ", 1800), rest.lastIndexOf("? ", 1800), rest.lastIndexOf("\n", 1800));
      if (cut < 400) cut = 1800;
      chunks.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) chunks.push(rest);

    for (const chunk of chunks) {
      const res = await fns.httpsCallable("voiceCall")({ op: "tts", text: chunk, coachId, gender: coachGender(coachId) });
      const d = res.data || {};
      if (!d.audioBase64) throw new Error("Voice server returned no audio");
      const audioBlob = await base64ToBlob(d.audioBase64, d.mime);
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
function avatarCacheKey(coachId) { return "gutcheck_avatar_" + (state.uid || "anon") + "_" + coachId; }

async function loadAvatars() {
  ["nutrition", "gym"].forEach((c) => {
    const cached = localStorage.getItem(avatarCacheKey(c));
    if (cached) AVATARS[c] = cached;
  });
  applyAvatars();
  try {
    const doc = await db.collection(ucol("settings")).doc("avatars").get();
    if (doc.exists) {
      const d = doc.data();
      const nKey = coachGender("nutrition") === "male" ? "marcus" : "maya";
      const gKey = coachGender("gym") === "male" ? "dre" : "vanessa";
      // fall back across genders so an older avatar still shows until regenerated
      const nAv = d[nKey] || d.maya || d.marcus;
      const gAv = d[gKey] || d.vanessa || d.dre;
      if (nAv) { AVATARS.nutrition = nAv; localStorage.setItem(avatarCacheKey("nutrition"), nAv); }
      if (gAv) { AVATARS.gym = gAv; localStorage.setItem(avatarCacheKey("gym"), gAv); }
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
  ["nutrition", "gym"].forEach((c) => {
    const label = COACHES[c].short; // reflects whichever gender/persona is currently active
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
    // keep the per-coach regen buttons labeled with the active persona's name
    const rb = $("#regenAvatar-" + c);
    if (rb && !rb.disabled) rb.textContent = "✨ New photo for " + label;
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
  marcus: "Professional headshot portrait of an attractive man in his late 20s, a friendly registered dietitian and nutritionist, short tidy hair, warm genuine smile, sage-green casual button-up shirt, soft studio lighting, dark charcoal background with a subtle lime-green rim light, head-and-shoulders, photorealistic",
  vanessa: "Professional headshot portrait of an attractive athletic woman in her late 20s, a confident personal trainer, high sporty ponytail, black fitted athletic tank top, determined friendly smirk, soft gym lighting, dark charcoal background with a subtle lime-green rim light, head-and-shoulders, photorealistic",
  dre: "Professional headshot portrait of an attractive athletic man in his late 20s, a confident personal trainer, short fade haircut, black fitted athletic t-shirt, determined friendly smirk, soft gym lighting, dark charcoal background with a subtle lime-green rim light, head-and-shoulders, photorealistic",
};

// The prompts above are fixed strings, so sending the exact same one every time
// tends to make the image model converge on a very similar face each regen.
// Append a randomized (but style-consistent) variation so repeats actually differ.
const AVATAR_VARIATIONS = {
  hair: ["short brown hair", "dark wavy hair", "hair pulled back in a low bun", "black hair", "sandy blonde hair", "short curly hair", "shoulder-length chestnut hair", "buzzed fade haircut"],
  skin: ["olive skin tone", "deep brown skin tone", "fair skin tone", "warm tan skin tone", "medium brown skin tone", "light brown skin tone"],
  detail: ["a subtle smile line", "light stubble", "freckles across the nose", "a small silver stud earring", "naturally arched eyebrows", "a faint dimple when smiling", "high cheekbones"],
};
function randomAvatarVariant() {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  return pick(AVATAR_VARIATIONS.hair) + ", " + pick(AVATAR_VARIATIONS.skin) + ", " + pick(AVATAR_VARIATIONS.detail);
}
function buildAvatarPrompt(persona) {
  return GROK_PROMPTS[persona] + ", " + randomAvatarVariant();
}

/* xAI's image endpoint rate-limits concurrent calls on a single API key —
   firing 4 generations at once during onboarding reliably got one of them
   rejected. Everything now goes through this helper: one call at a time,
   with one automatic retry after a short backoff. */
async function generateAvatarImage(prompt) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fns.httpsCallable("avatarCall")({ prompt });
      const b64 = res.data && res.data.imageBase64;
      if (!b64) throw new Error("Avatar server returned no image data");
      return b64;
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 2500));
    }
  }
  throw lastErr;
}

async function regenerateAvatar(coachId) {
  const btn = $("#regenAvatar-" + coachId);
  if (!btn || btn.disabled) return;
  const who = coachId === "nutrition"
    ? (coachGender("nutrition") === "male" ? "marcus" : "maya")
    : (coachGender("gym") === "male" ? "dre" : "vanessa");
  btn.disabled = true;
  try {
    btn.textContent = "⏳ Generating " + COACHES[coachId].short + "… (~30s)";
    const b64 = await generateAvatarImage(buildAvatarPrompt(who));
    const small = await downscaleDataUrl("data:image/jpeg;base64," + b64, 512, 0.85);
    const patch = {};
    patch[who] = small;
    await db.collection(ucol("settings")).doc("avatars").set(patch, { merge: true });
    AVATARS[coachId] = small;
    localStorage.setItem(avatarCacheKey(coachId), small);
    applyAvatars();
    renderAvatarPreview();
    toast("New photo saved for " + COACHES[coachId].short + " — synced to all your devices");
  } catch (e) {
    toast("Avatar generation failed: " + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ New photo for " + COACHES[coachId].short;
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

  const takeBtn = el("button", "btn big", "📷 Take a photo");
  takeBtn.addEventListener("click", () => {
    takeCameraPhoto(async (f) => {
      try {
        const data = await compressForFirestore(f);
        attachPhoto(coachId, data);
      } catch (err) { toast("Could not read photo: " + err.message, true); }
    });
  });
  sheet.appendChild(takeBtn);
  const libBtn = el("button", "btn ghost big", "🖼 Choose from gallery");
  libBtn.style.marginTop = "8px";
  libBtn.addEventListener("click", () => $("#attachFile").click());
  sheet.appendChild(libBtn);

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
  // Two separate concerns, kept separate on purpose:
  //  --vvh: the TRUE current visible height. Views that need to fit exactly
  //    within what's actually on screen (like the social conversation) size
  //    off this directly — it already reflects the keyboard, Safari's
  //    auto-hiding toolbar, rotation, anything, with no guesswork.
  //  --kbd / body.kbd-open: an approximate "is a keyboard probably open"
  //    signal, still useful for the sticky chat input bar's bottom offset.
  // Earlier this diffed visualViewport.height against a cached "keyboard
  // closed" baseline of window.innerHeight — but iOS Safari's toolbar
  // show/hide (independent of the keyboard, triggered by normal scrolling)
  // also changes innerHeight, which could desync that baseline and make
  // --kbd wrong (and the conversation's height calc wrong along with it)
  // even with no keyboard involved at all. Reading visualViewport.height
  // directly every time sidesteps that entirely — nothing to go stale.
  const sync = () => {
    const vv = window.visualViewport;
    document.documentElement.style.setProperty("--vvh", vv.height + "px");
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
  sync(); // set --vvh/--kbd immediately instead of waiting for the first event
}

/* ---------- workout log: simple big-picture tagging (no timers/sets/GPS) ---------- */
// Logging a workout is just "what did you do today" — tap the tags that
// apply, add your own if one's missing, hit Log. That's the whole feature.
const DEFAULT_WORKOUT_TAGS = ["Run", "Walk", "Arms", "Legs", "Back", "Chest", "Shoulders", "Core"];
let WORKOUT_TAGS = DEFAULT_WORKOUT_TAGS.slice();
const wkLog = { selected: [], editKey: null, editEntryIds: [] };

function middayIsoForDayKey(k) {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0).toISOString();
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
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

async function loadWorkoutTags() {
  try {
    const doc = await db.collection(ucol("settings")).doc("workoutTags").get();
    const saved = doc.exists && Array.isArray(doc.data().tags) ? doc.data().tags : [];
    if (saved.length) WORKOUT_TAGS = Array.from(new Set([...saved, ...DEFAULT_WORKOUT_TAGS]));
  } catch (e) { /* offline or brand-new account — defaults are fine */ }
}
async function saveWorkoutTags() {
  try { await db.collection(ucol("settings")).doc("workoutTags").set({ tags: WORKOUT_TAGS }); }
  catch (e) { toast("Couldn't save that workout type: " + e.message, true); }
}

function buildTimerUI() {
  const wkOv = el("div", "picker");
  wkOv.id = "wkSheet";
  wkOv.hidden = true;
  const wkSh = el("div", "picker-sheet timer-sheet");
  wkSh.id = "wkSheetBody";
  wkOv.appendChild(wkSh);
  wkOv.addEventListener("click", (e) => { if (e.target === wkOv) wkOv.hidden = true; });
  document.body.appendChild(wkOv);

  const ckOv = el("div", "picker");
  ckOv.id = "ckSheet";
  ckOv.hidden = true;
  const ckSh = el("div", "picker-sheet timer-sheet");
  ckSh.id = "ckSheetBody";
  ckOv.appendChild(ckSh);
  ckOv.addEventListener("click", (e) => { if (e.target === ckOv) ckOv.hidden = true; });
  document.body.appendChild(ckOv);

  renderWk();
  renderCk();
  setInterval(wkTick, 300);
}

function openTimerSheet(coachId) {
  if (coachId === "gym") {
    wkLog.selected = [];
    wkLog.editKey = null;
    wkLog.editEntryIds = [];
    renderWk();
    $("#wkSheet").hidden = false;
  } else {
    renderCk();
    $("#ckSheet").hidden = false;
  }
}

function sheetHead(body, title) {
  const head = el("div", "picker-head");
  head.appendChild(el("b", null, title));
  const x = el("button", "icon-btn", "✕");
  x.title = "Close";
  x.addEventListener("click", () => { body.parentElement.hidden = true; });
  head.appendChild(x);
  body.appendChild(head);
}

function renderWk() {
  const body = $("#wkSheetBody");
  if (!body) return;
  while (body.firstChild) body.removeChild(body.firstChild);
  const editing = !!wkLog.editKey;
  const isNewDay = editing && !wkLog.editEntryIds.length;
  const title = editing
    ? (isNewDay ? "📋 Log — " : "✏️ Edit — ") + new Date(wkLog.editKey + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "📋 Log workout";
  sheetHead(body, title);
  body.appendChild(el("p", "timer-hint", editing
    ? "Tap everything that applies, then save. Untap everything to leave it as a rest day."
    : "Tap everything you did today, then log it. Don't see it? Add your own — it'll show up here from now on."));

  // when editing, show any already-logged tags even if they aren't in the master list
  // (e.g. an old "Workout" placeholder from before tagging existed)
  const displayTags = editing ? Array.from(new Set([...WORKOUT_TAGS, ...wkLog.selected])) : WORKOUT_TAGS;

  const grid = el("div", "wk-tag-grid");
  displayTags.forEach((tag) => {
    const chip = el("button", "wk-tag" + (wkLog.selected.includes(tag) ? " on" : ""), tag);
    chip.type = "button";
    chip.addEventListener("click", () => {
      const i = wkLog.selected.indexOf(tag);
      if (i >= 0) wkLog.selected.splice(i, 1); else wkLog.selected.push(tag);
      renderWk();
    });
    grid.appendChild(chip);
  });
  const addBtn = el("button", "wk-tag wk-tag-add", "+ Add new");
  addBtn.type = "button";
  addBtn.addEventListener("click", addWorkoutTag);
  grid.appendChild(addBtn);
  body.appendChild(grid);

  const btn = el("button", "btn big", editing
    ? (wkLog.selected.length ? (isNewDay ? "Log " : "Save: ") + wkLog.selected.join(", ") : (isNewDay ? "Log workout" : "Save (clear this day)"))
    : (wkLog.selected.length ? "Log " + wkLog.selected.join(", ") : "Log workout"));
  btn.disabled = !wkLog.selected.length && (!editing || isNewDay);
  btn.addEventListener("click", editing ? saveWorkoutEdit : logWorkout);
  body.appendChild(btn);
}

function promptWorkoutTag() {
  return new Promise((resolve) => {
    const gate = $("#tagPromptGate");
    const input = $("#tagPromptInput");
    input.value = "";
    gate.hidden = false;
    setTimeout(() => input.focus(), 50);
    const add = $("#tagPromptAdd");
    const cancel = $("#tagPromptCancel");
    const done = (val) => {
      gate.hidden = true;
      add.onclick = null;
      cancel.onclick = null;
      input.onkeydown = null;
      resolve(val);
    };
    add.onclick = () => done(input.value.trim());
    cancel.onclick = () => done(null);
    input.onkeydown = (e) => { if (e.key === "Enter") done(input.value.trim()); };
  });
}

async function addWorkoutTag() {
  const name = await promptWorkoutTag();
  if (!name) return;
  if (WORKOUT_TAGS.some((t) => t.toLowerCase() === name.toLowerCase())) {
    toast("You already have a \"" + name + "\" option");
    return;
  }
  WORKOUT_TAGS.push(name);
  wkLog.selected.push(name);
  await saveWorkoutTags();
  renderWk();
}

async function logWorkout() {
  if (!wkLog.selected.length) return;
  const entry = { loggedAt: new Date().toISOString(), tags: wkLog.selected.slice() };
  try {
    const ref = await db.collection(ucol("workouts")).add(entry);
    state.workouts.push({ id: ref.id, ...entry });
    renderHeatmap();
    toast("Logged: " + entry.tags.join(", ") + " 💪");
    if (window.socialOnWorkoutLogged) socialOnWorkoutLogged(entry.tags);
  } catch (e) {
    toast("Couldn't save that workout: " + e.message, true);
    return;
  }
  wkLog.selected = [];
  renderWk();
  const sheet = $("#wkSheet");
  if (sheet) sheet.hidden = true;
}

function editWorkoutDay(k, info) {
  wkLog.selected = Array.from(new Set(info.tags));
  wkLog.editKey = k;
  wkLog.editEntryIds = info.entries.map((e) => e.id).filter(Boolean);
  renderWk();
  $("#wkSheet").hidden = false;
}

async function saveWorkoutEdit() {
  const k = wkLog.editKey;
  const ids = wkLog.editEntryIds;
  const newTags = wkLog.selected.slice();
  try {
    await Promise.all(ids.map((id) => db.collection(ucol("workouts")).doc(id).delete()));
    state.workouts = state.workouts.filter((w) => !ids.includes(w.id));
    if (newTags.length) {
      const entry = { loggedAt: middayIsoForDayKey(k), tags: newTags };
      const ref = await db.collection(ucol("workouts")).add(entry);
      state.workouts.push({ id: ref.id, ...entry });
    }
    renderHeatmap();
    toast(newTags.length ? "Updated: " + newTags.join(", ") : "Cleared that day's workout");
  } catch (e) {
    toast("Couldn't save changes: " + e.message, true);
    return;
  }
  wkLog.selected = [];
  wkLog.editKey = null;
  wkLog.editEntryIds = [];
  const sheet = $("#wkSheet");
  if (sheet) sheet.hidden = true;
  // the day detail panel is now stale — close it, they can tap the day again to see the update
  const detail = $("#heatmapDetail");
  if (detail) { detail.hidden = true; state.heatmapSel = null; }
}

function wkTick() {
  if (ck.running) {
    const rem = ck.endAt - Date.now();
    if (rem <= 0) { ckDone(); return; }
    const big = $("#ckBig");
    if (big) big.textContent = fmtClock(rem);
  }
}


const CK_KEY = "gutcheck_cook";
const ck = { durSec: 600, running: false, endAt: 0, leftMs: 600000, flash: false };

function ckLeft() {
  return ck.running ? Math.max(0, ck.endAt - Date.now()) : ck.leftMs;
}
function ckSave() {
  try {
    localStorage.setItem(CK_KEY, JSON.stringify({
      durSec: ck.durSec, running: ck.running, endAt: ck.endAt, leftMs: ckLeft(),
    }));
  } catch (e) { /* storage blocked — timer still works in-memory */ }
}
function ckRestore() {
  try {
    const raw = localStorage.getItem(CK_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    ck.durSec = s.durSec || 600;
    ck.leftMs = s.leftMs != null ? s.leftMs : ck.durSec * 1000;
    ck.endAt = s.endAt || 0;
    if (s.running) {
      if (Date.now() >= ck.endAt) { ck.running = false; ck.leftMs = 0; ck.flash = true; }
      else ck.running = true;
    }
  } catch (e) { /* ignore corrupt state */ }
}

function ckSet(sec) {
  ck.durSec = sec;
  ck.running = false;
  ck.leftMs = sec * 1000;
  ck.flash = false;
  ckSave();
  renderCk();
}

function ckAdd(sec) {
  if (ck.running) {
    ck.endAt += sec * 1000;
    if (ckLeft() <= 0) ck.endAt = Date.now() + 5000;
  } else {
    ck.leftMs = Math.max(60000, ckLeft() + sec * 1000);
    ck.durSec = Math.round(ck.leftMs / 1000);
  }
  ck.flash = false;
  ckSave();
  renderCk();
}

function ckStartPause() {
  if (ck.running) {
    ck.leftMs = ckLeft();
    ck.running = false;
  } else {
    if (ckLeft() <= 0) ck.leftMs = ck.durSec * 1000;
    ck.endAt = Date.now() + ckLeft();
    ck.running = true;
    ck.flash = false;
  }
  ckSave();
  renderCk();
}

function ckDone() {
  ck.running = false;
  ck.leftMs = 0;
  ck.flash = true;
  ckSave();
  beep();
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
  renderCk();
  const body = $("#ckSheetBody");
  if (body) {
    body.classList.remove("wk-flash");
    void body.offsetWidth;
    body.classList.add("wk-flash");
  }
}

function renderCk() {
  const body = $("#ckSheetBody");
  if (!body) return;
  while (body.firstChild) body.removeChild(body.firstChild);
  sheetHead(body, "🍳 Kitchen timer");

  const big = el("div", "wk-big", fmtClock(ckLeft()));
  big.id = "ckBig";
  body.appendChild(big);
  const lbl = el("div", "wk-label", ck.flash ? "time's up — check the pan! 🍳" : ck.running ? "counting down" : "set your cook time");
  lbl.id = "ckLabel";
  body.appendChild(lbl);

  const chips = el("div", "wk-chips");
  [60, 300, 600, 900, 1200, 1800].forEach((s) => {
    const c = el("button", "wk-chip" + (ck.durSec === s && !ck.running ? " on" : ""), (s / 60) + "m");
    c.addEventListener("click", () => ckSet(s));
    chips.appendChild(c);
  });
  body.appendChild(chips);

  const row = el("div", "wk-row");
  const minus = el("button", "btn ghost", "−1 min");
  minus.addEventListener("click", () => ckAdd(-60));
  row.appendChild(minus);
  const goB = el("button", "btn", ck.running ? "⏸ Pause" : "▶ Start");
  goB.id = "ckGo";
  goB.addEventListener("click", ckStartPause);
  row.appendChild(goB);
  const plus = el("button", "btn ghost", "+1 min");
  plus.addEventListener("click", () => ckAdd(60));
  row.appendChild(plus);
  body.appendChild(row);

  const clr = el("button", "link-btn center-btn", "Reset to " + Math.round(ck.durSec / 60) + "m");
  clr.id = "ckReset";
  clr.addEventListener("click", () => ckSet(ck.durSec));
  body.appendChild(clr);
}

/* Explicit "please remember …" requests get a guaranteed, deterministic save
   to long-term coach memory. The model's remember_fact tool stays as the
   smart catch-all for facts it notices on its own, but a direct ask must
   never depend on the model choosing to use the tool (it sometimes just says
   "I've got it" and saves nothing). */
const REMEMBER_RE = /(please\s+remember|remember\s+that|remember|keep in mind|don'?t forget|add\s+(?:this|that|it)?\s*to\s+(?:your\s+)?memory|save\s+(?:this|that|it)?\s*to\s+(?:your\s+)?memory|note\s+that)/i;

function extractRememberFact(text) {
  const m = (text || "").match(REMEMBER_RE);
  if (!m) return null;
  const fact = text.slice(m.index + m[0].length)
    .replace(/^[\s:;,.\-—?!"')]+/, "")
    .replace(/^(the fact|that|this)\s+/i, "")
    .trim();
  return fact.length >= 4 ? fact.slice(0, 200) : null;
}

async function saveCoachMemoryFact(coachId, fact) {
  const arr = (state.coachMemory[coachId] = state.coachMemory[coachId] || []);
  if (arr.some((f) => f.toLowerCase() === fact.toLowerCase())) return false; // already known
  state.coachMemory[coachId] = arr.concat([fact]).slice(-40);
  await db.collection(ucol("settings")).doc("coachMemory").set(state.coachMemory);
  renderMemoryList(); // keep the Settings list live if it's on screen
  return true;
}

// Belt-and-suspenders against the coach ignoring the "no markdown" system
// prompt rule under emphasis/urgency (e.g. correcting itself, highlighting a
// number) — strips markdown bold/italic/header syntax before it's stored or
// spoken, so it can never show up as literal asterisks in the chat or get
// read aloud oddly by TTS, regardless of what the model actually generated.
function stripMarkdownArtifacts(text) {
  if (!text) return text;
  return text
    .replace(/\*\*(.+?)\*\*/gs, "$1")
    .replace(/__(.+?)__/gs, "$1")
    .replace(/(^|\s)\*(\S(?:.*?\S)?)\*(?=\s|$)/gs, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*{2,}/g, "");
}

async function sendCoachMessage(coachId, text) {
  if (state.sending[coachId]) return;
  const img = state.attach[coachId] || null;
  state.sending[coachId] = true;
  $("#chatInput-" + coachId).value = "";
  $("#chatInput-" + coachId).style.height = "auto"; // undo any auto-grow from the message just sent
  state.attach[coachId] = null;
  renderAttachPrev(coachId);
  const rememberFact = extractRememberFact(text);
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
  // Guaranteed memory write for explicit "remember …" asks — flag the chat
  // message too so renderChat can show it was saved.
  let rememberedSaved = false;
  if (rememberFact) {
    try {
      rememberedSaved = await saveCoachMemoryFact(coachId, rememberFact);
      if (rememberedSaved) {
        const mine = state.chats[coachId][state.chats[coachId].length - 1];
        if (mine && mine.id) {
          mine.remembered = rememberFact;
          db.collection(ucol("chats")).doc(coachId).collection("messages").doc(mine.id)
            .set({ remembered: rememberFact }, { merge: true }).catch(() => {});
        }
      }
    } catch (e) { console.warn("memory save failed:", e); }
  }
  renderChat(coachId);
  scrollChatBottom(coachId, true);
  let reply, replyAction = null;
  try {
    const result = await callClaude(coachId, rememberedSaved ? rememberFact : null);
    reply = stripMarkdownArtifacts(result.text);
    replyAction = result.action;
  } catch (e) {
    reply = "Hmm, my brain hiccuped: " + e.message + ". Check the API key in Settings and try again.";
  }
  // Safety net against a hallucinated "I logged/deleted that" — if the reply
  // *says* it did something to the log but no log_meal/delete_meal actually
  // fired this turn (no receipt chip to show), flag it so the person isn't
  // trusting a claim with nothing behind it. Prompt rules already say never
  // to claim this without calling the tool, but that's probabilistic; this
  // check is a hard, deterministic backstop based on what the server
  // actually reports happened, not what the text says happened.
  const claimsLogAction = !replyAction && coachId === "nutrition" && /\b(logged|log(?:ging)? it|added (?:it|that) to your (?:tracker|log)|removed (?:it|that) from your (?:tracker|log))\b/i.test(reply || "");
  const extra = {};
  if (replyAction) extra.action = replyAction;
  if (claimsLogAction) extra.unverifiedClaim = true;
  try {
    await addChatMsg(coachId, "assistant", reply, null, Object.keys(extra).length ? extra : null);
  } catch (e) {
    console.warn("reply save failed:", e);
    state.chats[coachId].push({ id: "local-" + Date.now(), role: "assistant", content: reply, at: new Date().toISOString() });
  }
  state.sending[coachId] = false;
  renderChat(coachId);
  scrollChatBottom(coachId, true);
}

async function clearChat(coachId) {
  if (!(await confirmAction("Clear your entire conversation with " + COACHES[coachId].short + "? This can't be undone."))) return;
  try {
    const snap = await db.collection(ucol("chats")).doc(coachId).collection("messages").get();
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    state.chats[coachId] = [];
    state.chatExpanded[coachId] = false;
    renderChat(coachId);
    toast("Conversation cleared");
  } catch (e) { toast("Clear failed: " + e.message, true); }
}

/* ---------- settings ---------- */
const PROFILE_FIELDS = ["name", "height", "age", "startWeight", "goalWeight", "calories", "protein", "babyDue", "context"];

function renderSettings() {
  PROFILE_FIELDS.forEach((f) => { $("#s_" + f).value = state.profile[f] || ""; });
  const g = state.profile.coachGenders || {};
  $("#s_genderNutrition").value = g.nutrition || "female";
  $("#s_genderGym").value = g.gym || "female";
  const acct = $("#accountEmail");
  if (acct) acct.textContent = state.userEmail || state.userPhone || "unknown";
  const babyRow = $("#babyDueRow");
  if (babyRow) babyRow.hidden = String(state.userEmail || "").toLowerCase() !== ADMIN_EMAIL;
  renderAvatarPreview();
  renderMemoryList();
  if (window.renderPushToggle) window.renderPushToggle();
}

function renderMemoryList() {
  const box = $("#memoryList");
  if (!box) return;
  while (box.firstChild) box.removeChild(box.firstChild);
  const groups = [["nutrition", COACHES.nutrition.short], ["gym", COACHES.gym.short]];
  let any = false;
  groups.forEach(([coachId, label]) => {
    const facts = state.coachMemory[coachId] || [];
    if (!facts.length) return;
    any = true;
    box.appendChild(el("div", "mem-group-label", label));
    facts.forEach((fact, i) => {
      const row = el("div", "mem-row");
      row.appendChild(el("div", "mem-text", fact));
      const del = el("button", "icon-btn", "✕");
      del.title = "Forget this";
      del.addEventListener("click", () => deleteMemoryFact(coachId, i));
      row.appendChild(del);
      box.appendChild(row);
    });
  });
  if (!any) box.appendChild(el("p", "hint left", "Nothing remembered yet — your coaches will pick things up as you chat."));
}

async function deleteMemoryFact(coachId, index) {
  const facts = (state.coachMemory[coachId] || []).slice();
  facts.splice(index, 1);
  state.coachMemory[coachId] = facts;
  renderMemoryList();
  try {
    await db.collection(ucol("settings")).doc("coachMemory").set(state.coachMemory);
  } catch (e) { toast("Couldn't save that change: " + e.message, true); }
}

async function onSaveProfile() {
  PROFILE_FIELDS.forEach((f) => { state.profile[f] = $("#s_" + f).value.trim(); });
  state.profile.coachGenders = {
    nutrition: $("#s_genderNutrition").value === "male" ? "male" : "female",
    gym: $("#s_genderGym").value === "male" ? "male" : "female",
  };
  state.profile.onboarded = true;
  try {
    await saveProfile();
    applyCoachGenders();
    rebuildCoachPanels();
    renderDashboard();
    toast("Profile saved — your coaches will use it");
  } catch (e) { toast("Save failed: " + e.message, true); }
  // name/avatar changes should reach the Social directory immediately
  if (window.socialSyncDirectory) {
    localStorage.removeItem("socialDirSig");
    window.socialSyncDirectory();
  }
}

/* ---------- first-run guided setup ---------- */
function parseHeightInches(h) {
  const m = String(h || "").match(/(\d+)\s*'\s*(\d+)?/);
  if (m) return parseInt(m[1], 10) * 12 + (parseInt(m[2] || "0", 10) || 0);
  const cm = parseFloat(h);
  if (!isNaN(cm) && cm > 100) return cm / 2.54; // they typed centimeters
  return 0;
}

// Mifflin-St Jeor → TDEE → goal adjustment; protein ≈ 0.9 g per lb of goal weight.
function obAutoTargets() {
  const inches = parseHeightInches($("#ob_height").value);
  const age = parseFloat($("#ob_age").value);
  const wt = parseFloat($("#ob_startWeight").value);
  const goalWt = parseFloat($("#ob_goalWeight").value) || wt;
  if (!inches || !age || !wt) return;
  const kg = wt * 0.453592;
  const cm = inches * 2.54;
  const bmr = 10 * kg + 6.25 * cm - 5 * age + ($("#ob_sex").value === "male" ? 5 : -161);
  const tdee = bmr * (parseFloat($("#ob_activity").value) || 1.45);
  const goal = $("#ob_goal").value;
  const adj = goal === "lose" ? -500 : goal === "gain" ? 250 : 0;
  const floor = $("#ob_sex").value === "male" ? 1500 : 1200;
  const cal = Math.max(floor, Math.round((tdee + adj) / 10) * 10);
  const pro = Math.max(80, Math.round(goalWt * 0.9));
  $("#ob_calories").value = cal;
  $("#ob_protein").value = pro;
}

/* ---------- onboarding coach picker: generates all 4 avatars in parallel, ---------- */
/* lets the user pick by face instead of a gender dropdown */
const PERSONA_COACH = { maya: "nutrition", marcus: "nutrition", vanessa: "gym", dre: "gym" };
const PERSONA_GENDER = { maya: "female", marcus: "male", vanessa: "female", dre: "male" };
const PERSONA_AVATARS = {}; // persona -> data URL, populated during onboarding
let obSelectedGender = { nutrition: "female", gym: "female" };

function renderPickerCard(persona, failed) {
  const box = $("#cpcAvatar-" + persona);
  if (!box) return;
  while (box.firstChild) box.removeChild(box.firstChild);
  if (PERSONA_AVATARS[persona]) {
    const img = document.createElement("img");
    img.src = PERSONA_AVATARS[persona];
    img.alt = persona;
    box.appendChild(img);
  } else if (failed) {
    // Don't spin forever on a real error — fall back to a plain initial so
    // the card is still selectable, and the person can retry from Settings.
    box.appendChild(el("div", "avatar", persona[0].toUpperCase()));
  } else {
    box.appendChild(el("div", "cpc-spinner"));
  }
}

function selectPickerCard(coachId, gender) {
  obSelectedGender[coachId] = gender;
  const pickerId = coachId === "nutrition" ? "pickerNutrition" : "pickerGym";
  $("#" + pickerId).querySelectorAll(".coach-pick-card").forEach((card) => {
    card.classList.toggle("selected", PERSONA_GENDER[card.dataset.persona] === gender);
  });
}

// Fetches any avatars already generated for this account, shows them immediately,
// then generates whichever of the 4 personas are still missing — all in parallel,
// so this runs the whole time the user is filling out the rest of the form.
async function ensureAllAvatarsGenerating() {
  let existing = {};
  try {
    const doc = await db.collection(ucol("settings")).doc("avatars").get();
    if (doc.exists) existing = doc.data() || {};
  } catch (e) { /* brand-new account or offline — just generate fresh */ }

  Object.keys(PERSONA_COACH).forEach((persona) => {
    if (existing[persona]) PERSONA_AVATARS[persona] = existing[persona];
    renderPickerCard(persona);
  });

  const missing = Object.keys(PERSONA_COACH).filter((p) => !PERSONA_AVATARS[p]);
  const failures = [];
  // Sequential, not parallel — concurrent image calls on one key get
  // rate-limited by xAI (this was the "3 of 4 photos generated" failure).
  for (const persona of missing) {
    try {
      const b64 = await generateAvatarImage(buildAvatarPrompt(persona));
      const small = await downscaleDataUrl("data:image/jpeg;base64," + b64, 512, 0.85);
      PERSONA_AVATARS[persona] = small;
      const patch = {};
      patch[persona] = small;
      await db.collection(ucol("settings")).doc("avatars").set(patch, { merge: true });
      renderPickerCard(persona);
    } catch (e) {
      renderPickerCard(persona, true);
      failures.push(persona + ": " + e.message);
    }
  }
  if (failures.length) {
    toast("Some coach photos didn't generate — " + failures[0] + ". You can still pick and retry later in Settings.", true);
  }
}

function openOnboarding() {
  const p = state.profile;
  const existing = state.hasProfileDoc; // Ethan (migrated) pre-fills; brand-new users start clean
  $("#ob_name").value = p.name || "";
  $("#ob_height").value = existing ? (p.height || "") : "";
  $("#ob_age").value = existing ? (p.age || "") : "";
  $("#ob_startWeight").value = existing ? (p.startWeight || "") : "";
  $("#ob_goalWeight").value = existing ? (p.goalWeight || "") : "";
  $("#ob_sex").value = p.sex || "male";
  $("#ob_goal").value = p.mainGoal || "lose";
  $("#ob_days").value = p.trainingDays || "";
  $("#ob_equipment").value = p.equipment || "home";
  $("#ob_injuries").value = "";
  $("#ob_diet").value = "";
  $("#ob_custom").value = existing ? (p.context || "") : "";
  const g = p.coachGenders || {};
  obSelectedGender = { nutrition: g.nutrition || "female", gym: g.gym || "female" };
  selectPickerCard("nutrition", obSelectedGender.nutrition);
  selectPickerCard("gym", obSelectedGender.gym);
  $("#ob_calories").value = existing ? (p.calories || "") : "";
  $("#ob_protein").value = existing ? (p.protein || "") : "";
  $("#obStep1").hidden = false;
  $("#obStep2").hidden = true;
  $("#onboardGate").hidden = false;
  ensureAllAvatarsGenerating(); // fire-and-forget — runs the whole time they're on step 1
}

function validateStep1Fields() {
  const name = $("#ob_name").value.trim();
  const height = $("#ob_height").value.trim();
  const age = $("#ob_age").value.trim();
  const startWeight = $("#ob_startWeight").value.trim();
  const goalWeight = $("#ob_goalWeight").value.trim();
  const calories = $("#ob_calories").value.trim();
  const protein = $("#ob_protein").value.trim();
  const errBox = $("#onboardErr");
  if (errBox) errBox.hidden = true;
  if (!name || !height || !age || !startWeight || !goalWeight || !calories || !protein) {
    const msg = "Fill in your name, height, age, current + goal weight, and your targets (edit any field above and calories/protein auto-calculate).";
    if (errBox) { errBox.textContent = msg; errBox.hidden = false; }
    toast(msg, true);
    return false;
  }
  return true;
}

function advanceToStep2() {
  if (!validateStep1Fields()) return;
  $("#obStep1").hidden = true;
  $("#obStep2").hidden = false;
}

function backToStep1() {
  $("#obStep2").hidden = true;
  $("#obStep1").hidden = false;
}

async function saveOnboarding() {
  if (!validateStep1Fields()) { backToStep1(); return; }
  const btn = $("#onboardSave");
  const height = $("#ob_height").value.trim();
  const age = $("#ob_age").value.trim();
  const startWeight = $("#ob_startWeight").value.trim();
  const goalWeight = $("#ob_goalWeight").value.trim();
  const calories = $("#ob_calories").value.trim();
  const protein = $("#ob_protein").value.trim();
  const actLabel = { "1.3": "mostly sedentary", "1.45": "moderately active", "1.6": "very active" }[$("#ob_activity").value] || "moderately active";
  const goalLabel = { lose: "lose fat", maintain: "maintain weight", gain: "build muscle" }[$("#ob_goal").value];
  const equipLabel = { home: "at home with minimal equipment", gym: "at a full gym", both: "a mix of home and gym" }[$("#ob_equipment").value];
  const days = $("#ob_days").value.trim();
  const parts = [];
  parts.push(
    ($("#ob_sex").value === "male" ? "Male" : "Female") + ", " + age + ", " + height + ". " +
    "Currently " + startWeight + " lbs, goal " + goalWeight + " lbs — main goal: " + goalLabel + ". " +
    "Trains " + (days || "a few") + " days/week " + equipLabel + ". Daily life: " + actLabel + "."
  );
  const injuries = $("#ob_injuries").value.trim();
  if (injuries) parts.push("Injuries / health notes: " + injuries);
  const diet = $("#ob_diet").value.trim();
  if (diet) parts.push("Food preferences / restrictions: " + diet);
  const custom = $("#ob_custom").value.trim();
  if (custom) parts.push(custom);

  btn.disabled = true;
  try {
    state.profile.name = $("#ob_name").value.trim();
    state.profile.height = height;
    state.profile.age = age;
    state.profile.startWeight = startWeight;
    state.profile.goalWeight = goalWeight;
    state.profile.calories = calories;
    state.profile.protein = protein;
    state.profile.sex = $("#ob_sex").value;
    state.profile.mainGoal = $("#ob_goal").value;
    state.profile.trainingDays = days;
    state.profile.equipment = $("#ob_equipment").value;
    state.profile.coachGenders = {
      nutrition: obSelectedGender.nutrition === "male" ? "male" : "female",
      gym: obSelectedGender.gym === "male" ? "male" : "female",
    };
    state.profile.context = parts.join(" ");
    state.profile.onboarded = true;
    await saveProfile();
    state.hasProfileDoc = true;
    applyCoachGenders();
    rebuildCoachPanels();
    // Avatars for the chosen personas were already generated (or are still
    // finishing) during onboarding — apply whatever's ready now instantly,
    // no need to regenerate.
    const nPersona = obSelectedGender.nutrition === "male" ? "marcus" : "maya";
    const gPersona = obSelectedGender.gym === "male" ? "dre" : "vanessa";
    if (PERSONA_AVATARS[nPersona]) { AVATARS.nutrition = PERSONA_AVATARS[nPersona]; localStorage.setItem(avatarCacheKey("nutrition"), PERSONA_AVATARS[nPersona]); }
    if (PERSONA_AVATARS[gPersona]) { AVATARS.gym = PERSONA_AVATARS[gPersona]; localStorage.setItem(avatarCacheKey("gym"), PERSONA_AVATARS[gPersona]); }
    applyAvatars();
    // Full re-render, matching what a fresh boot does — without this, other
    // tabs (Photos, both coach chats, both heatmaps) stayed stale until the
    // user manually refreshed the page after finishing onboarding.
    renderDashboard();
    renderPhotos();
    renderHeatmap();
    renderFoodHeatmap();
    renderChat("nutrition");
    renderChat("gym");
    renderSettings();
    renderAvatarPreview();
    $("#onboardGate").hidden = true;
    toast("Setup saved — meet " + COACHES.nutrition.short + " and " + COACHES.gym.short + "!");
  } catch (e) {
    toast("Save failed: " + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- auth gate ---------- */
function showAuthGate(msg) {
  const gate = $("#authGate");
  if (gate) gate.hidden = false;
  const err = $("#authGateErr");
  if (err) { err.hidden = !msg; err.textContent = msg || ""; }
}

function hideAuthGate() {
  const gate = $("#authGate");
  if (gate) gate.hidden = true;
}

async function signInWithGoogle() {
  const errBox = $("#authGateErr");
  if (errBox) errBox.hidden = true;
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    await auth.signInWithPopup(provider);
  } catch (e) {
    // Popup blocked/closed or unsupported (installed PWA, some mobile browsers) → redirect
    if (e && (e.code === "auth/popup-blocked" || e.code === "auth/popup-closed-by-user" ||
              e.code === "auth/operation-not-supported-in-this-environment" || e.code === "auth/web-storage-unsupported")) {
      try { await auth.signInWithRedirect(provider); return; } catch (e2) { e = e2; }
    }
    if (e && e.code !== "auth/cancelled-popup-request") {
      showAuthGate("Sign-in failed: " + (e.message || e.code || "unknown error"));
    }
  }
}

async function signOut() {
  try { await auth.signOut(); } catch (e) { toast("Sign-out failed: " + e.message, true); }
  resetPhoneAuthStep();
}

/* ---------- phone sign-in (Firebase invisible reCAPTCHA + SMS code) ---------- */
let recaptchaVerifier = null;
let recaptchaWidgetId = null;
let phoneConfirmationResult = null;

// Renders once per page load and is reused for every attempt — recreating a
// RecaptchaVerifier on the same container after a failed send throws
// "reCAPTCHA has already been rendered in this element". A failed attempt
// just resets the existing widget instead of rebuilding it.
async function ensureRecaptcha() {
  if (recaptchaVerifier) return recaptchaVerifier;
  recaptchaVerifier = new firebase.auth.RecaptchaVerifier("recaptchaContainer", { size: "invisible" });
  recaptchaWidgetId = await recaptchaVerifier.render();
  return recaptchaVerifier;
}

// Best-effort normalize to E.164 — assumes US (+1) for a bare 10-digit number,
// otherwise requires the person to include their country code with a leading +.
function normalizePhone(raw) {
  const digits = String(raw || "").replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return "+1" + digits;
  return digits ? "+" + digits : "";
}

async function sendPhoneCode() {
  const errBox = $("#authGateErr");
  if (errBox) errBox.hidden = true;
  const phone = normalizePhone($("#phoneInput").value);
  if (!phone || phone.length < 8) {
    showAuthGate("Enter a valid phone number with country code, e.g. +1 555 123 4567.");
    return;
  }
  const btn = $("#phoneSendCodeBtn");
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = "Sending…";
  try {
    const verifier = await ensureRecaptcha();
    phoneConfirmationResult = await auth.signInWithPhoneNumber(phone, verifier);
    $("#phoneAuthNumber").textContent = phone;
    $("#phoneAuthStep1").hidden = true;
    $("#phoneAuthStep2").hidden = false;
    $("#phoneCodeInput").focus();
  } catch (e) {
    showAuthGate("Couldn't send code: " + (e.message || e.code || "unknown error"));
    // reset the existing widget so the next attempt gets a fresh token —
    // do NOT recreate the verifier, that's what throws "already rendered"
    try { if (window.grecaptcha && recaptchaWidgetId != null) window.grecaptcha.reset(recaptchaWidgetId); } catch (e2) { /* noop */ }
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

async function verifyPhoneCode() {
  const errBox = $("#authGateErr");
  if (errBox) errBox.hidden = true;
  const code = $("#phoneCodeInput").value.trim();
  if (!code) { showAuthGate("Enter the code you received."); return; }
  if (!phoneConfirmationResult) { showAuthGate("That session expired — request a new code."); return; }
  const btn = $("#phoneVerifyBtn");
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = "Verifying…";
  try {
    await phoneConfirmationResult.confirm(code);
    // onAuthStateChanged (in boot()) takes it from here
  } catch (e) {
    showAuthGate("That code didn't work: " + (e.message || e.code || "unknown error"));
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

function resetPhoneAuthStep() {
  const err = $("#authGateErr");
  if (err) err.hidden = true;
  $("#phoneAuthStep1").hidden = false;
  $("#phoneAuthStep2").hidden = true;
  $("#phoneCodeInput").value = "";
  phoneConfirmationResult = null;
}

/* ---------- one-time legacy migration (flat collections → users/{uid}/) ---------- */
// Idempotent: a done-flag at users/{uid}/settings/migration gates re-runs.
// Copies docs preserving IDs, verifies counts, never deletes the legacy data
// (Ethan deletes it manually in the Firebase console after verifying).
// Defense in depth: only the admin account ever ATTEMPTS to read the legacy
// flat collections — don't rely solely on Firestore rules denying the read.
async function migrateLegacy() {
  const flagRef = db.collection(ucol("settings")).doc("migration");
  try {
    const flag = await flagRef.get();
    const d = flag.exists ? flag.data() : null;
    // A flag written with counts.skipped (legacy unreadable at the time) must NOT
    // block a later retry — e.g. rules fixed after the fact.
    if (d && d.done && !(d.counts && d.counts.skipped)) return;
  } catch (e) { /* flag read failed — fall through and try anyway */ }

  if (String(state.userEmail || "").toLowerCase() !== ADMIN_EMAIL) {
    // Not Ethan — there is nothing of theirs in the legacy collections.
    await flagRef.set({ done: true, at: new Date().toISOString(), counts: { skipped: "not admin" } });
    return;
  }

  const counts = {};
  const flat = ["weights", "photos", "meals", "measurements", "workouts"];
  const copyCol = async (fromPath, toPath) => {
    const snap = await db.collection(fromPath).get();
    if (snap.empty) { return 0; }
    let n = 0;
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = db.batch();
      snap.docs.slice(i, i + 400).forEach((d) => {
        batch.set(db.collection(toPath).doc(d.id), d.data());
      });
      await batch.commit();
      n += snap.docs.slice(i, i + 400).length;
    }
    // verify
    const check = await db.collection(toPath).get();
    if (check.size < snap.size) throw new Error("Migration verify failed for " + fromPath + " (" + check.size + "/" + snap.size + ")");
    return n;
  };

  try {
    for (const c of flat) counts[c] = await copyCol(c, ucol(c));
    for (const coach of ["nutrition", "gym"]) {
      counts["chats/" + coach] = await copyCol("chats/" + coach + "/messages", ucol("chats") + "/" + coach + "/messages");
    }
    for (const d of ["profile", "avatars"]) {
      const doc = await db.collection("settings").doc(d).get();
      if (doc.exists) {
        await db.collection(ucol("settings")).doc(d).set(doc.data());
        counts["settings/" + d] = 1;
      }
    }
  } catch (e) {
    if (e && (e.code === "permission-denied" || /permission/i.test(e.message || ""))) {
      // Legacy already locked down or removed — nothing to migrate.
      counts.skipped = "legacy not readable";
    } else {
      throw e;
    }
  }
  await flagRef.set({ done: true, at: new Date().toISOString(), counts });
}

/* ---------- PWA: splash, logo, install, service worker ---------- */
let deferredInstall = null;

function applyBranding() {
  if (typeof LOGO_URL !== "string" || !LOGO_URL) return;
  const sp = $("#splashLogo");
  if (sp) sp.src = LOGO_URL;
  const bm = $(".brand-mark");
  if (bm) {
    while (bm.firstChild) bm.removeChild(bm.firstChild);
    const i = document.createElement("img");
    i.src = LOGO_URL;
    i.className = "brand-logo";
    i.alt = "";
    bm.appendChild(i);
  }
}

function hideSplash() {
  const sp = $("#splash");
  if (!sp) return;
  setTimeout(() => {
    sp.classList.add("gone");
    setTimeout(() => { if (sp.parentElement) sp.parentElement.removeChild(sp); }, 700);
  }, 900);
}

function setupInstall() {
  const btn = $("#installBtn");
  if (btn) {
    btn.addEventListener("click", async () => {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      try { await deferredInstall.userChoice; } catch (e) { /* dismissed */ }
      deferredInstall = null;
      btn.hidden = true;
    });
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e;
    const b = $("#installBtn");
    if (b) b.hidden = false;
  });
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const tip = $("#iosInstallTip");
  if (tip) tip.hidden = !(isIos && !standalone);
  if (standalone) {
    const card = $("#installCard");
    if (card) card.hidden = true;
  }
}

function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW registration failed:", e));
  });
}

/* ---------- boot ---------- */
/* ---------- collapsible cards (food log, workout history) ---------- */
function wireCollapsibleCard(toggleId, cardId, storageKey) {
  const toggle = $("#" + toggleId);
  const card = $("#" + cardId);
  if (!toggle || !card) return;
  if (localStorage.getItem(storageKey) === "1") card.classList.add("collapsed");
  toggle.addEventListener("click", () => {
    card.classList.toggle("collapsed");
    localStorage.setItem(storageKey, card.classList.contains("collapsed") ? "1" : "0");
  });
}

function wireEvents() {
  document.querySelectorAll("[data-go]").forEach((b) => {
    b.addEventListener("click", () => go(b.dataset.go));
  });
  $("#weightForm").addEventListener("submit", (e) => {
    e.preventDefault();
    logWeight($("#weightInput").value);
  });
  $("#chartToggle").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-mode]");
    if (!btn) return;
    state.chartMode = btn.dataset.mode;
    $("#chartToggle").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
    renderChart();
  });
  $("#measForm").addEventListener("submit", (e) => e.preventDefault());
  $("#logMeasBtn").addEventListener("click", logMeasurements);
  $("#mealUploadBtn").addEventListener("click", () => pickMealPhoto());
  $("#mealEstimateBtn").addEventListener("click", estimateMealWithMaya);
  $("#mealManualBtn").addEventListener("click", openManualMealEntry);
  $("#mealSaveBtn").addEventListener("click", saveMealEntry);
  $("#mealCancelBtn").addEventListener("click", closeMealConfirm);
  $("#exportBtn").addEventListener("click", exportAllData);
  $("#photoBtn").addEventListener("click", () => takeCameraPhoto((f) => uploadPhoto(f)));
  $("#photoGalleryBtn").addEventListener("click", () => $("#photoFile").click());
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
  $("#signOutBtn").addEventListener("click", signOut);
  $("#googleSignInBtn").addEventListener("click", signInWithGoogle);
  $("#phoneSendCodeBtn").addEventListener("click", sendPhoneCode);
  $("#phoneVerifyBtn").addEventListener("click", verifyPhoneCode);
  $("#phoneBackBtn").addEventListener("click", resetPhoneAuthStep);
  $("#phoneCodeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") verifyPhoneCode(); });
  $("#phoneInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendPhoneCode(); });
  $("#onboardSave").addEventListener("click", saveOnboarding);
  $("#obContinue").addEventListener("click", advanceToStep2);
  $("#obBack").addEventListener("click", backToStep1);
  $("#redoOnboard").addEventListener("click", openOnboarding);
  $("#onboardGate").addEventListener("click", (e) => {
    const card = e.target.closest(".coach-pick-card");
    if (!card) return;
    selectPickerCard(card.dataset.coach, PERSONA_GENDER[card.dataset.persona]);
  });
  ["ob_height", "ob_age", "ob_startWeight", "ob_goalWeight", "ob_sex", "ob_goal", "ob_activity"].forEach((id) => {
    $("#" + id).addEventListener("input", obAutoTargets);
    $("#" + id).addEventListener("change", obAutoTargets);
  });
  $("#regenAvatar-nutrition").addEventListener("click", () => regenerateAvatar("nutrition"));
  $("#regenAvatar-gym").addEventListener("click", () => regenerateAvatar("gym"));
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
  wireCollapsibleCard("foodLogToggle", "foodLogCard", "gutcheck_collapsed_foodlog");
  wireCollapsibleCard("workoutLogToggle", "heatmapCard", "gutcheck_collapsed_workoutlog");
}

async function boot() {
  applyBranding();
  hideSplash();
  buildCoachPanel("nutrition");
  buildCoachPanel("gym");
  ckRestore();
  buildTimerUI();
  setupJumpBtns();
  setupInstall();
  registerSW();
  wireEvents();
  if (!db || !auth || !fns) {
    toast("Firebase failed to initialize — check your connection", true);
    return;
  }

  // Auth gate: nothing loads until a user is signed in. onAuthStateChanged
  // also fires after signInWithRedirect returns the user to the app.
  let started = false;
  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      const wasStarted = started;
      started = false;
      state.uid = null;
      state.userEmail = null;
      state.userPhone = null;
      if (wasStarted) { location.reload(); return; } // clean state for the next sign-in
      showAuthGate();
      return;
    }
    state.uid = user.uid;
    state.userEmail = user.email || null;
    state.userPhone = user.phoneNumber || null;
    if (started) return; // token refresh re-fires this — don't reload the app
    started = true;
    try {
      await migrateLegacy();
    } catch (e) {
      console.error("migration failed:", e);
      showAuthGate("Migration failed: " + e.message + " — tell Ethan before retrying.");
      try { await auth.signOut(); } catch (e2) { /* noop */ }
      return;
    }
    hideAuthGate();
    await startApp();
  });
}

async function startApp() {
  try {
    await loadProfile(); // first — coach genders and onboarding depend on it
    applyCoachGenders();
    rebuildCoachPanels();
    await Promise.all([
      loadWeights(),
      loadPhotos(),
      loadMeasurements(),
      loadMeals(),
      loadWorkouts(),
      loadWorkoutTags(),
      loadCoachMemory(),
      loadChat("nutrition"),
      loadChat("gym"),
      loadAvatars(),
    ]);
  } catch (e) {
    if (e && (e.code === "permission-denied" || /permission|insufficient/i.test(e.message || ""))) {
      showAuthGate("This account can't reach its data — Firestore rules may not be deployed yet. Tell Ethan, then try again.");
      try { await auth.signOut(); } catch (e2) { /* noop */ }
      return;
    }
    toast("Could not load data: " + e.message + " — check your connection", true);
  }
  renderDashboard();
  renderPhotos();
  renderHeatmap();
  renderFoodHeatmap();
  renderChat("nutrition");
  renderChat("gym");
  renderSettings();
  // Brand-new accounts (and Ethan post-migration, once) get the guided setup.
  if (!state.hasProfileDoc || !state.profile.onboarded) openOnboarding();
  if (window.socialBoot) socialBoot();
  // Refreshing the page shouldn't bounce back to Home — stay on whichever
  // tab was open on this device last, if it's still a valid tab.
  let savedTab = null;
  try { savedTab = localStorage.getItem("gutcheckTab"); } catch (e) { /* noop */ }
  if (savedTab && TABS.includes(savedTab) && savedTab !== state.tab) go(savedTab);
}

document.addEventListener("DOMContentLoaded", boot);
