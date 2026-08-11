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
}

function rebuildCoachPanels() {
  ["nutrition", "gym"].forEach((c) => {
    const panel = $("#panel-" + c);
    if (!panel) return;
    while (panel.firstChild) panel.removeChild(panel.firstChild);
    buildCoachPanel(c);
    renderChat(c);
  });
  applyAvatars();
}

const state = {
  tab: "dashboard",
  uid: null,        // Firebase Auth uid — scopes every Firestore path
  userEmail: null,
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
  state.workouts = await fsGet("workouts", "startedAt", "asc");
}

async function loadChat(coach) {
  state.chats[coach] = await fsGet("chats/" + coach + "/messages", "at", "asc");
}

async function addChatMsg(coach, role, content, img) {
  const msg = { role, content, at: new Date().toISOString() };
  if (img) msg.img = img;
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
function dayKey(iso) {
  const d = new Date(iso);
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

  // baby countdown (dashboard card)
  if (p.babyDue) {
    const due = new Date(p.babyDue + "T00:00:00");
    const days = Math.max(0, Math.ceil((due - Date.now()) / 86400000));
    $("#babyDays").textContent = String(days);
    $("#babyDueLabel").textContent = "due " + due.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
    $("#babyCard").hidden = false;
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
  maybeShowStreakReminder(wStreak, pStreak);
}

// Gentle evening nudge if today's weigh-in or photo is still missing.
// Client-side only (checked on each dashboard render / app open) — this app
// has no push notification backend, so it can only remind you while it's open.
let streakReminderShownThisLoad = false;
function maybeShowStreakReminder(wStreak, pStreak) {
  if (streakReminderShownThisLoad) return;
  const hour = new Date().getHours();
  if (hour < 18) return; // only nudge in the evening
  const todayKey = dayKey(new Date().toISOString());
  const loggedWeightToday = state.weights.some((w) => dayKey(w.loggedAt) === todayKey);
  const loggedPhotoToday = state.photos.some((p) => dayKey(p.takenAt) === todayKey);
  if (loggedWeightToday && loggedPhotoToday) return;
  streakReminderShownThisLoad = true;
  const missing = [];
  if (!loggedWeightToday) missing.push(wStreak + "-day weigh-in streak");
  if (!loggedPhotoToday) missing.push(pStreak + "-day photo streak");
  toast("Evening check — don't lose your " + missing.join(" or your ") + " today.");
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

function pickMealPhoto(useCamera) {
  if (useCamera) {
    takeCameraPhoto(async (f) => {
      try {
        const data = await compressForFirestore(f);
        mealAttach = await downscaleDataUrl(data, 768, 0.8);
        renderMealPhotoPrev();
      } catch (err) { toast("Could not read photo: " + err.message, true); }
    });
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
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
  } catch (e) {
    toast("Save failed: " + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function deleteMeal(id) {
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

function heatLevel(setsTotal) {
  if (!setsTotal) return 0;
  if (setsTotal <= 3) return 1;
  if (setsTotal <= 7) return 2;
  if (setsTotal <= 12) return 3;
  return 4;
}

function renderHeatmap() {
  const grid = $("#heatmapGrid");
  const summary = $("#heatmapSummary");
  if (!grid) return;
  while (grid.firstChild) grid.removeChild(grid.firstChild);

  // sum sets per day
  const byDay = {};
  state.workouts.forEach((w) => {
    const k = dayKey(w.startedAt);
    byDay[k] = byDay[k] || { sets: 0, durationSec: 0, sessions: 0 };
    byDay[k].sets += w.sets || 0;
    byDay[k].durationSec += w.durationSec || 0;
    byDay[k].sessions += 1;
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
    const lvl = info ? heatLevel(info.sets) : 0;
    const cell = el("div", "heat-cell" + (lvl ? " lvl" + lvl : ""));
    if (inFuture) cell.style.visibility = "hidden";
    else {
      cell.title = fmtDayShort(d.toISOString()) + (info ? " — " + info.sessions + " session" + (info.sessions > 1 ? "s" : "") + ", " + info.sets + " sets" : " — rest day");
      cell.addEventListener("click", () => showHeatmapDay(k, info));
    }
    grid.appendChild(cell);
  }

  const activeDays = Object.keys(byDay).length;
  const totalSets = Object.values(byDay).reduce((s, v) => s + v.sets, 0);
  if (!activeDays) {
    summary.textContent = "No workouts logged yet — finish a session from the timer to see it here.";
  } else {
    summary.innerHTML = "";
    summary.appendChild(document.createTextNode("Last " + HEATMAP_WEEKS + " weeks: "));
    summary.appendChild(el("b", null, String(activeDays)));
    summary.appendChild(document.createTextNode(" active days, "));
    summary.appendChild(el("b", null, String(totalSets)));
    summary.appendChild(document.createTextNode(" total sets."));
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
  detail.appendChild(el("div", "hd-date", dateLabel));
  if (!info) {
    detail.appendChild(el("div", "hd-row", "Rest day — no workout logged."));
    return;
  }
  const mins = Math.round(info.durationSec / 60);
  detail.appendChild(el("div", "hd-row", info.sessions + " session" + (info.sessions > 1 ? "s" : "") + " · " + info.sets + " sets · " + mins + " min total"));
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
  const timerB = el("button", "link-btn timer-btn", "⏱");
  timerB.id = "timerBtn-" + coachId;
  timerB.title = coachId === "gym" ? "Workout timer" : "Kitchen timer";
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
      wrap.appendChild(botRow(coachId, div));
    } else {
      wrap.appendChild(div);
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
function coachSystemParts(coachId) {
  const p = state.profile;
  const todayLabel = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const shared =
    "\n\nTODAY'S ACTUAL DATE: " + todayLabel + ". Trust this over any date assumption from your training — always use this as the true current date." +
    "\n\nCLIENT PROFILE:\n- Height: " + p.height + ", Age: " + p.age +
    "\n- Start weight: " + p.startWeight + " lbs, Goal: " + p.goalWeight + " lbs" +
    "\n- Daily targets: " + p.calories + " calories, " + p.protein + "g protein" +
    "\n- Background: " + p.context +
    "\n\nRULES:\n- Be direct, warm, and practical. Short paragraphs. No fluff." +
    "\n- PLAIN TEXT ONLY: never use asterisks, markdown, em-dashes as decoration, bullet symbols, or role-play actions (no *smiles*, no **bold**). " +
    "Your replies are read aloud by a text-to-speech voice — write exactly how a real human coach would speak. " +
    "Lists are fine as short separate lines starting with a number, like \"1. \"." +
    "\n- Give specific numbers, portions, sets, and reps — never vague advice." +
    "\n- The client can attach photos (meals, physique, equipment) — comment specifically on what you see." +
    "\n- You are not a doctor; for medical red flags, say so briefly and move on." +
    "\n- Remember the conversation history and build on it.";
  if (coachId === "nutrition") {
    const todayKey = dayKey(new Date().toISOString());
    const todayMeals = state.meals.filter((m) => dayKey(m.loggedAt) === todayKey);
    const calSoFar = todayMeals.reduce((s, m) => s + (m.calories || 0), 0);
    const proteinSoFar = todayMeals.reduce((s, m) => s + (m.protein || 0), 0);
    const dynamic = todayMeals.length
      ? "LOGGED SO FAR TODAY: " + Math.round(calSoFar) + " kcal / " + Math.round(proteinSoFar) + "g protein, from: " +
        todayMeals.map((m) => m.name || m.description || m.desc || "a logged meal").join(", ") + ". Use this to say what's left for the day, not just the flat daily target."
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
        "If the meal is too vague to estimate (no portions, no idea what it is), ask ONE short clarifying question instead of logging. " +
        "Never claim you logged something without calling the tool.",
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
    dynamic: "",
  };
}

/* ---------- coach brain (server-side proxy) ---------- */
// All Claude calls — including Maya's log_meal tool-use loop — run inside the
// coachCall Cloud Function. The browser never sees an API key, and the function
// writes meals under the caller's own users/{uid}/ namespace.
async function callClaude(coachId) {
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
  const parts = coachSystemParts(coachId);
  const res = await fns.httpsCallable("coachCall")({
    system: parts.stable,
    systemDynamic: parts.dynamic,
    messages: history,
    useTools: coachId === "nutrition",
    targets: { calories: state.profile.calories, protein: state.profile.protein },
  });
  const data = res.data || {};
  if (data.mealLogged) {
    await loadMeals();
    renderMealTotals();
    renderFoodHeatmap();
  }
  if (!data.text) throw new Error("Coach returned an empty response");
  return data.text;
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
  [["nutrition", "Maya"], ["gym", "Vanessa"]].forEach((pair) => {
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
  marcus: "Professional headshot portrait of an attractive man in his late 20s, a friendly registered dietitian and nutritionist, short tidy hair, warm genuine smile, sage-green casual button-up shirt, soft studio lighting, dark charcoal background with a subtle lime-green rim light, head-and-shoulders, photorealistic",
  vanessa: "Professional headshot portrait of an attractive athletic woman in her late 20s, a confident personal trainer, high sporty ponytail, black fitted athletic tank top, determined friendly smirk, soft gym lighting, dark charcoal background with a subtle lime-green rim light, head-and-shoulders, photorealistic",
  dre: "Professional headshot portrait of an attractive athletic man in his late 20s, a confident personal trainer, short fade haircut, black fitted athletic t-shirt, determined friendly smirk, soft gym lighting, dark charcoal background with a subtle lime-green rim light, head-and-shoulders, photorealistic",
};

async function regenerateAvatars() {
  const btn = $("#regenAvatars");
  btn.disabled = true;
  try {
    const jobs = [
      [coachGender("nutrition") === "male" ? "marcus" : "maya", "nutrition"],
      [coachGender("gym") === "male" ? "dre" : "vanessa", "gym"],
    ];
    for (let i = 0; i < jobs.length; i++) {
      const who = jobs[i][0], coachId = jobs[i][1];
      btn.textContent = "⏳ Generating " + COACHES[coachId].short + "… (~30s)";
      const res = await fns.httpsCallable("avatarCall")({ prompt: GROK_PROMPTS[who] });
      const b64 = res.data && res.data.imageBase64;
      if (!b64) throw new Error("Avatar server returned no image data");
      const small = await downscaleDataUrl("data:image/jpeg;base64," + b64, 512, 0.85);
      const patch = {};
      patch[who] = small;
      await db.collection(ucol("settings")).doc("avatars").set(patch, { merge: true });
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
  wk.tick = setInterval(wkTick, 300);
}

function openTimerSheet(coachId) {
  if (coachId === "gym") {
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
  const chip = $("#timerBtn-gym");
  if (chip) {
    chip.classList.toggle("live", wk.active);
    chip.classList.toggle("resting", wk.active && wk.restActive);
    chip.textContent = wk.active ? "⏱ " + fmtClock(wkElapsed()) : "⏱";
  }
  const body = $("#wkSheetBody");
  if (!body) return;
  while (body.firstChild) body.removeChild(body.firstChild);
  sheetHead(body, "🏋️ Workout timer");

  if (!wk.active) {
    body.appendChild(el("p", "timer-hint", "Clock your session, count sets, time your rests — it logs to your history when you finish."));
    const go = el("button", "btn big", "▶ Start workout");
    go.id = "wkStart";
    go.addEventListener("click", startWorkout);
    body.appendChild(go);
    return;
  }

  const big = el("div", "wk-big", wk.restActive ? fmtClock(wk.restEnd - Date.now()) : fmtClock(wkElapsed()));
  big.id = "wkBig";
  body.appendChild(big);
  const lbl = el("div", "wk-label", wk.restActive ? "rest — next set when it hits zero" : "session time");
  lbl.id = "wkBigLabel";
  body.appendChild(lbl);
  const stat = el("div", "timer-stat", wk.sets + (wk.sets === 1 ? " set done" : " sets done"));
  stat.id = "wkSets";
  body.appendChild(stat);

  const row = el("div", "wk-row");
  const setB = el("button", "btn", "＋ Set done");
  setB.id = "wkSetBtn";
  setB.title = "Logs a set and starts your rest";
  setB.addEventListener("click", setDone);
  row.appendChild(setB);
  const pause = el("button", "btn ghost", wk.running ? "⏸ Pause" : "▶ Resume");
  pause.id = "wkPause";
  pause.addEventListener("click", pauseResume);
  row.appendChild(pause);
  body.appendChild(row);

  body.appendChild(el("div", "wk-label", "rest timer"));
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
  body.appendChild(chips);

  const fin = el("button", "btn ghost big", "Finish & log workout");
  fin.id = "wkFinish";
  fin.addEventListener("click", () => armEnd(fin));
  body.appendChild(fin);
}

function wkTick() {
  if (wk.active) {
    const chip = $("#timerBtn-gym");
    if (chip) chip.textContent = "⏱ " + fmtClock(wkElapsed());
    const big = $("#wkBig");
    const lbl = $("#wkBigLabel");
    if (wk.restActive) {
      const rem = wk.restEnd - Date.now();
      if (rem <= 0) { wkRestDone(); }
      else {
        if (big) big.textContent = fmtClock(rem);
        if (lbl) lbl.textContent = "rest — next set when it hits zero";
      }
    } else {
      if (big) big.textContent = fmtClock(wkElapsed());
      if (lbl && lbl.textContent.startsWith("rest —")) lbl.textContent = "session time";
    }
  }
  if (ck.running) {
    const rem = ck.endAt - Date.now();
    if (rem <= 0) { ckDone(); return; }
    const big = $("#ckBig");
    if (big) big.textContent = fmtClock(rem);
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
  wkSave();
  renderWk();
  toast("Workout started — clock's running. Tap ＋ Set done after each set.");
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
  const sheet = $("#wkSheet");
  const body = $("#wkSheetBody");
  if (body && sheet && !sheet.hidden) {
    body.classList.remove("wk-flash");
    void body.offsetWidth; // restart animation
    body.classList.add("wk-flash");
  }
  renderWk();
  const lbl = $("#wkBigLabel");
  if (lbl) lbl.textContent = "rest over — GO 💪";
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
    if (db) {
      const ref = await db.collection(ucol("workouts")).add(entry);
      state.workouts.push({ id: ref.id, ...entry });
      renderHeatmap();
    }
    toast("Workout logged — " + Math.max(1, Math.round(durSec / 60)) + " min, " + sets + " sets 💪");
  } catch (e) {
    toast("Workout done but save failed: " + e.message, true);
  }
  wk.active = false;
  wk.running = false;
  wk.restActive = false;
  wk.sets = 0;
  wk.accumMs = 0;
  wk.endArmed = false;
  try { localStorage.removeItem(WK_KEY); } catch (e) { /* noop */ }
  renderWk();
  const sheet = $("#wkSheet");
  if (sheet) sheet.hidden = true;
}

/* ---------- cooking / kitchen timer (Maya's page) ---------- */
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
    const snap = await db.collection(ucol("chats")).doc(coachId).collection("messages").get();
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
  const g = state.profile.coachGenders || {};
  $("#s_genderNutrition").value = g.nutrition || "female";
  $("#s_genderGym").value = g.gym || "female";
  const acct = $("#accountEmail");
  if (acct) acct.textContent = state.userEmail || "unknown";
  renderAvatarPreview();
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

function openOnboarding() {
  const p = state.profile;
  const existing = state.hasProfileDoc; // Ethan (migrated) pre-fills; brand-new users start clean
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
  $("#ob_genderNutrition").value = g.nutrition || "female";
  $("#ob_genderGym").value = g.gym || "female";
  $("#ob_calories").value = existing ? (p.calories || "") : "";
  $("#ob_protein").value = existing ? (p.protein || "") : "";
  $("#onboardGate").hidden = false;
}

async function saveOnboarding() {
  const btn = $("#onboardSave");
  const height = $("#ob_height").value.trim();
  const age = $("#ob_age").value.trim();
  const startWeight = $("#ob_startWeight").value.trim();
  const goalWeight = $("#ob_goalWeight").value.trim();
  const calories = $("#ob_calories").value.trim();
  const protein = $("#ob_protein").value.trim();
  const errBox = $("#onboardErr");
  if (errBox) errBox.hidden = true;
  if (!height || !age || !startWeight || !goalWeight || !calories || !protein) {
    const msg = "Fill in height, age, current + goal weight, and your targets (edit any field above and calories/protein auto-calculate).";
    if (errBox) { errBox.textContent = msg; errBox.hidden = false; }
    toast(msg, true);
    return;
  }
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
      nutrition: $("#ob_genderNutrition").value === "male" ? "male" : "female",
      gym: $("#ob_genderGym").value === "male" ? "male" : "female",
    };
    state.profile.context = parts.join(" ");
    state.profile.onboarded = true;
    await saveProfile();
    state.hasProfileDoc = true;
    applyCoachGenders();
    rebuildCoachPanels();
    renderDashboard();
    renderSettings();
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
}

/* ---------- one-time legacy migration (flat collections → users/{uid}/) ---------- */
// Idempotent: a done-flag at users/{uid}/settings/migration gates re-runs.
// Copies docs preserving IDs, verifies counts, never deletes the legacy data
// (Ethan deletes it manually in the Firebase console after verifying).
// Defense in depth: only the admin account ever ATTEMPTS to read the legacy
// flat collections — don't rely solely on Firestore rules denying the read.
const ADMIN_EMAIL = "ejarr1998@gmail.com";
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
  $("#mealPhotoBtn").addEventListener("click", () => pickMealPhoto(true));
  $("#mealGalleryBtn").addEventListener("click", () => pickMealPhoto(false));
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
  $("#onboardSave").addEventListener("click", saveOnboarding);
  $("#redoOnboard").addEventListener("click", openOnboarding);
  ["ob_height", "ob_age", "ob_startWeight", "ob_goalWeight", "ob_sex", "ob_goal", "ob_activity"].forEach((id) => {
    $("#" + id).addEventListener("input", obAutoTargets);
    $("#" + id).addEventListener("change", obAutoTargets);
  });
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
  applyBranding();
  hideSplash();
  buildCoachPanel("nutrition");
  buildCoachPanel("gym");
  wkRestore();
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
      if (wasStarted) { location.reload(); return; } // clean state for the next sign-in
      showAuthGate();
      return;
    }
    state.uid = user.uid;
    state.userEmail = user.email || null;
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
}

document.addEventListener("DOMContentLoaded", boot);
