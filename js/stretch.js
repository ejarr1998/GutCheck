/* ---------- Stretches: library + routine builder + guided session player ----------
   Opened from the Coach (gym) page's 🧘 button. Three tabs (Library/Routines/
   Builder) inside #stretchHub, plus a separate full-screen #stretchPlayer for
   walking through a routine one step at a time with a restartable timer. */

const DEFAULT_EXERCISES = [
  { id: "hip-flexor", category: "stretch", name: "Kneeling hip flexor stretch",
    detail: "Half-kneeling, tuck pelvis under FIRST — that's the detail everyone misses, stretching in a tilted position does nothing — then shift forward gently until you feel the front of the hip open.",
    seconds: 75, sets: 1, perSide: true },
  { id: "knee-to-chest", category: "stretch", name: "Knee-to-chest lower back release",
    detail: "Lie on your back, pull one knee toward your chest and hold, then switch sides.",
    seconds: 75, sets: 1, perSide: false },
  { id: "skip-hamstring", category: "stretch", name: "Skip hamstring stretches for now",
    detail: "In APT the hamstrings are usually already chronically lengthened — stretching them further can be counterproductive.", note: true },
  { id: "glute-bridge", category: "strengthen", name: "Glute bridges",
    detail: "Progress to single-leg, then hip thrusts. Bridges with banded hip abduction significantly reduced APT in a 2014 study — bracing during a bridge is also the single highest TrA-activation position tested.",
    seconds: 30, sets: 3, perSide: false },
  { id: "dead-bug", category: "strengthen", name: "Dead bugs",
    detail: "The #1 exercise for teaching your core to hold the pelvis neutral while your limbs move.",
    seconds: 30, sets: 3, perSide: false },
  { id: "bird-dog", category: "strengthen", name: "Bird-dogs",
    detail: "Same lesson as dead bugs, opposite orientation, plus gentle back-extensor endurance.",
    seconds: 30, sets: 3, perSide: true },
  { id: "side-plank", category: "strengthen", name: "Side planks",
    detail: "Targets glute medius and obliques.",
    seconds: 20, sets: 3, perSide: true },
  { id: "pelvic-tilt", category: "strengthen", name: "Posterior pelvic tilt drill (\"tail tuck\")",
    detail: "Literally practicing the movement of un-tilting.",
    seconds: 20, sets: 3, perSide: false },
  { id: "stand-stretch", category: "habit", name: "Hip flexor stretch on standing",
    detail: "Every time you stand up from sitting: one hip flexor stretch per side. Sitting is the cause — this is the antidote.",
    seconds: 30, sets: 1, perSide: true },
  { id: "brace-practice", category: "habit", name: "\"20% brace\" during standing tasks",
    detail: "Practice a light 20% core brace during standing tasks — brushing teeth, washing dishes, holding the baby later.", note: true },
  { id: "treadmill-checkin", category: "habit", name: "Treadmill posture check-in",
    detail: "Ribs stacked over pelvis, light abdominal engagement — don't walk in a swayback posture or you're practicing the problem.", note: true },
];

const AVOID_LIST = [
  "Sit-ups / crunches — strengthen hip flexors and deepen APT",
  "Straight-leg raises — same issue",
  "Standing with locked knees and a swayed back",
  "Long uninterrupted sitting",
];

const CATEGORY_META = {
  stretch: { label: "A. Stretch", subtitle: "Daily, 2–3 min/side — back-friendly" },
  strengthen: { label: "B. Strengthen", subtitle: "Phase 2, once cleared" },
  habit: { label: "C. Retrain the habit", subtitle: "All day, free" },
};

const stretchState = {
  loaded: false,
  exercises: [],
  routines: [],
  todayIds: new Set(),
  logEntries: [],
  tab: "library",
  draft: { name: "", items: [] }, // builder-in-progress routine
  editingRoutineId: null,
  session: null, // { steps: [...], index: 0 }
  timer: { running: false, remaining: 0, total: 0, handle: null },
};

function googleSearchUrl(name) {
  return "https://www.google.com/search?q=" + encodeURIComponent(name + " stretch how to");
}

async function seedExercisesIfEmpty() {
  const snap = await db.collection(ucol("exercises")).limit(1).get();
  if (!snap.empty) return;
  const batch = db.batch();
  DEFAULT_EXERCISES.forEach((ex) => {
    batch.set(db.collection(ucol("exercises")).doc(ex.id), ex);
  });
  await batch.commit();
}

async function loadStretchData() {
  await seedExercisesIfEmpty();
  const [exSnap, routineSnap, logSnap] = await Promise.all([
    db.collection(ucol("exercises")).get(),
    db.collection(ucol("routines")).get(),
    db.collection(ucol("stretchLog")).get(),
  ]);
  stretchState.exercises = exSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  stretchState.routines = routineSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  stretchState.logEntries = logSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const today = dayKey(new Date().toISOString());
  stretchState.todayIds = new Set(
    stretchState.logEntries.filter((e) => dayKey(e.loggedAt) === today).map((e) => e.exerciseId)
  );
  stretchState.loaded = true;
}

function exerciseById(id) {
  return stretchState.exercises.find((e) => e.id === id);
}

async function toggleStretchDone(ex) {
  const today = dayKey(new Date().toISOString());
  const already = stretchState.logEntries.find((e) => e.exerciseId === ex.id && dayKey(e.loggedAt) === today);
  try {
    if (already) {
      await db.collection(ucol("stretchLog")).doc(already.id).delete();
      stretchState.logEntries = stretchState.logEntries.filter((e) => e.id !== already.id);
      stretchState.todayIds.delete(ex.id);
    } else {
      const entry = { exerciseId: ex.id, exerciseName: ex.name, loggedAt: new Date().toISOString() };
      const ref = await db.collection(ucol("stretchLog")).add(entry);
      stretchState.logEntries.push({ id: ref.id, ...entry });
      stretchState.todayIds.add(ex.id);
    }
    renderStretchTab();
  } catch (e) { toast("Couldn't save: " + e.message, true); }
}

/* ---------- hub open/close + tabs ---------- */

async function openStretchHub() {
  const hub = $("#stretchHub");
  if (!hub) return;
  hub.hidden = false;
  if (!stretchState.loaded) {
    $("#stretchTabBody").innerHTML = "<p class=\"hint\">Loading…</p>";
    await loadStretchData();
  }
  renderStretchTab();
}

function closeStretchHub() {
  $("#stretchHub").hidden = true;
}

function switchStretchTab(tab) {
  stretchState.tab = tab;
  document.querySelectorAll(".stretch-tab").forEach((b) => b.classList.toggle("on", b.dataset.stab === tab));
  renderStretchTab();
}

function renderStretchTab() {
  if (stretchState.tab === "library") renderLibraryTab();
  else if (stretchState.tab === "routines") renderRoutinesTab();
  else renderBuilderTab();
}

/* ---------- Library tab ---------- */

function renderLibraryTab() {
  const body = $("#stretchTabBody");
  body.innerHTML = "";
  const streak = computeStreak(stretchState.logEntries, "loggedAt");
  const streakCard = el("div", "stretch-streak", "🔥 " + streak + " day stretch streak");
  body.appendChild(streakCard);

  ["stretch", "strengthen", "habit"].forEach((cat) => {
    const meta = CATEGORY_META[cat];
    body.appendChild(el("div", "stretch-cat-head", meta.label));
    body.appendChild(el("div", "stretch-cat-sub", meta.subtitle));
    stretchState.exercises.filter((e) => e.category === cat).forEach((ex) => {
      body.appendChild(exerciseCard(ex));
    });
  });

  body.appendChild(el("div", "stretch-cat-head", "D. What to avoid"));
  const avoidList = el("ul", "stretch-avoid-list");
  AVOID_LIST.forEach((line) => avoidList.appendChild(el("li", null, line)));
  body.appendChild(avoidList);

  const addBtn = el("button", "btn ghost big", "+ Add your own exercise");
  addBtn.type = "button";
  addBtn.addEventListener("click", addCustomExercise);
  body.appendChild(addBtn);
}

function exerciseCard(ex) {
  const card = el("div", "exercise-card");
  const top = el("div", "exercise-card-top");
  if (!ex.note) {
    const check = el("button", "exercise-check" + (stretchState.todayIds.has(ex.id) ? " on" : ""), stretchState.todayIds.has(ex.id) ? "✓" : "");
    check.type = "button";
    check.title = "Mark done today";
    check.addEventListener("click", () => toggleStretchDone(ex));
    top.appendChild(check);
  }
  const textBox = el("div", "exercise-card-text");
  textBox.appendChild(el("div", "exercise-name", ex.name));
  textBox.appendChild(el("div", "exercise-detail", ex.detail || ""));
  if (ex.seconds) {
    const badge = ex.perSide ? ex.seconds + "s/side" : ex.sets > 1 ? ex.sets + " × " + ex.seconds + "s" : ex.seconds + "s";
    textBox.appendChild(el("div", "exercise-badge", badge));
  }
  top.appendChild(textBox);
  const search = el("a", "exercise-search", "🔍");
  search.href = googleSearchUrl(ex.name);
  search.target = "_blank";
  search.rel = "noopener";
  search.title = "Search this stretch";
  top.appendChild(search);
  card.appendChild(top);
  return card;
}

async function addCustomExercise() {
  const name = (prompt("Exercise name:") || "").trim();
  if (!name) return;
  const category = (prompt("Category — type: stretch, strengthen, or habit", "stretch") || "stretch").trim().toLowerCase();
  if (!CATEGORY_META[category]) { toast("Category must be stretch, strengthen, or habit", true); return; }
  const detail = (prompt("Instructions (optional):") || "").trim();
  const seconds = parseInt(prompt("Default hold time in seconds (optional, e.g. 30):") || "0", 10) || 0;
  const entry = { category, name, detail, seconds, sets: 1, perSide: false };
  try {
    const ref = await db.collection(ucol("exercises")).add(entry);
    stretchState.exercises.push({ id: ref.id, ...entry });
    renderLibraryTab();
    toast("Added");
  } catch (e) { toast("Couldn't add: " + e.message, true); }
}

/* ---------- Routines tab ---------- */

function renderRoutinesTab() {
  const body = $("#stretchTabBody");
  body.innerHTML = "";
  if (!stretchState.routines.length) {
    body.appendChild(el("p", "hint", "No routines yet — build one in the Builder tab."));
  }
  stretchState.routines.forEach((r) => {
    const card = el("div", "routine-card");
    const head = el("div", "routine-card-head");
    head.appendChild(el("div", "routine-name", r.name));
    head.appendChild(el("div", "routine-count", (r.items || []).length + " exercise" + ((r.items || []).length === 1 ? "" : "s")));
    card.appendChild(head);
    const row = el("div", "routine-card-actions");
    const startBtn = el("button", "btn big", "▶ Start");
    startBtn.type = "button";
    startBtn.addEventListener("click", () => window.startSession(r));
    const editBtn = el("button", "btn ghost sm", "Edit");
    editBtn.type = "button";
    editBtn.addEventListener("click", () => editRoutine(r));
    const delBtn = el("button", "btn ghost sm", "Delete");
    delBtn.type = "button";
    delBtn.addEventListener("click", () => deleteRoutine(r));
    row.appendChild(startBtn);
    row.appendChild(editBtn);
    row.appendChild(delBtn);
    card.appendChild(row);
    body.appendChild(card);
  });
  const newBtn = el("button", "btn ghost big", "+ New routine");
  newBtn.type = "button";
  newBtn.addEventListener("click", () => {
    stretchState.draft = { name: "", items: [] };
    stretchState.editingRoutineId = null;
    switchStretchTab("builder");
  });
  body.appendChild(newBtn);
}

async function deleteRoutine(r) {
  if (!(await confirmAction("Delete \"" + r.name + "\"? This can't be undone."))) return;
  try {
    await db.collection(ucol("routines")).doc(r.id).delete();
    stretchState.routines = stretchState.routines.filter((x) => x.id !== r.id);
    renderRoutinesTab();
    toast("Deleted");
  } catch (e) { toast("Couldn't delete: " + e.message, true); }
}

function editRoutine(r) {
  stretchState.draft = { name: r.name, items: (r.items || []).map((i) => ({ ...i })) };
  stretchState.editingRoutineId = r.id;
  switchStretchTab("builder");
}

/* ---------- Builder tab ---------- */

function renderBuilderTab() {
  const body = $("#stretchTabBody");
  body.innerHTML = "";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Routine name, e.g. Morning back routine";
  nameInput.value = stretchState.draft.name;
  nameInput.className = "routine-name-input";
  nameInput.addEventListener("input", () => { stretchState.draft.name = nameInput.value; });
  body.appendChild(nameInput);

  body.appendChild(el("div", "stretch-cat-head", "Tap to add"));
  const picker = el("div", "builder-picker");
  stretchState.exercises.filter((e) => !e.note).forEach((ex) => {
    const chip = el("button", "builder-chip", ex.name);
    chip.type = "button";
    chip.addEventListener("click", () => {
      stretchState.draft.items.push({
        exerciseId: ex.id, seconds: ex.seconds || 30, sets: ex.sets || 1, perSide: !!ex.perSide,
      });
      renderBuilderTab();
    });
    picker.appendChild(chip);
  });
  body.appendChild(picker);

  body.appendChild(el("div", "stretch-cat-head", "Your routine (" + stretchState.draft.items.length + ")"));
  if (!stretchState.draft.items.length) {
    body.appendChild(el("p", "hint", "Tap exercises above to add them in order."));
  }
  stretchState.draft.items.forEach((item, i) => {
    const ex = exerciseById(item.exerciseId);
    if (!ex) return;
    const row = el("div", "builder-row");
    const top = el("div", "builder-row-top");
    top.appendChild(el("span", "builder-row-name", (i + 1) + ". " + ex.name));
    const removeBtn = el("button", "icon-btn", "✕");
    removeBtn.type = "button";
    removeBtn.addEventListener("click", () => { stretchState.draft.items.splice(i, 1); renderBuilderTab(); });
    top.appendChild(removeBtn);
    row.appendChild(top);

    const controls = el("div", "builder-row-controls");
    controls.appendChild(numberField("Sets", item.sets, 1, 10, (v) => { item.sets = v; }));
    controls.appendChild(numberField("Sec", item.seconds, 5, 600, (v) => { item.seconds = v; }));
    const sideToggle = el("button", "btn ghost sm" + (item.perSide ? " on" : ""), item.perSide ? "Per side: on" : "Per side: off");
    sideToggle.type = "button";
    sideToggle.addEventListener("click", () => { item.perSide = !item.perSide; renderBuilderTab(); });
    controls.appendChild(sideToggle);
    const up = el("button", "icon-btn", "↑");
    up.type = "button";
    up.disabled = i === 0;
    up.addEventListener("click", () => { [stretchState.draft.items[i - 1], stretchState.draft.items[i]] = [stretchState.draft.items[i], stretchState.draft.items[i - 1]]; renderBuilderTab(); });
    const down = el("button", "icon-btn", "↓");
    down.type = "button";
    down.disabled = i === stretchState.draft.items.length - 1;
    down.addEventListener("click", () => { [stretchState.draft.items[i + 1], stretchState.draft.items[i]] = [stretchState.draft.items[i], stretchState.draft.items[i + 1]]; renderBuilderTab(); });
    controls.appendChild(up);
    controls.appendChild(down);
    row.appendChild(controls);
    body.appendChild(row);
  });

  const saveBtn = el("button", "btn big", stretchState.editingRoutineId ? "Save changes" : "Save routine");
  saveBtn.type = "button";
  saveBtn.disabled = !stretchState.draft.items.length;
  saveBtn.addEventListener("click", saveDraftRoutine);
  body.appendChild(saveBtn);
}

function numberField(label, value, min, max, onChange) {
  const wrap = el("label", "builder-num");
  wrap.appendChild(el("span", null, label));
  const input = document.createElement("input");
  input.type = "number";
  input.value = value;
  input.min = min;
  input.max = max;
  input.addEventListener("input", () => {
    const v = Math.max(min, Math.min(max, parseInt(input.value, 10) || min));
    onChange(v);
  });
  wrap.appendChild(input);
  return wrap;
}

async function saveDraftRoutine() {
  const name = stretchState.draft.name.trim() || "Untitled routine";
  const items = stretchState.draft.items;
  if (!items.length) return;
  try {
    if (stretchState.editingRoutineId) {
      await db.collection(ucol("routines")).doc(stretchState.editingRoutineId).set({ name, items }, { merge: true });
      const idx = stretchState.routines.findIndex((r) => r.id === stretchState.editingRoutineId);
      if (idx >= 0) stretchState.routines[idx] = { id: stretchState.editingRoutineId, name, items };
    } else {
      const ref = await db.collection(ucol("routines")).add({ name, items, createdAt: new Date().toISOString() });
      stretchState.routines.push({ id: ref.id, name, items });
    }
    toast("Routine saved");
    stretchState.draft = { name: "", items: [] };
    stretchState.editingRoutineId = null;
    switchStretchTab("routines");
  } catch (e) { toast("Couldn't save: " + e.message, true); }
}

/* ---------- Guided session player ---------- */

function expandRoutineToSteps(routine) {
  const steps = [];
  (routine.items || []).forEach((item) => {
    const ex = exerciseById(item.exerciseId);
    if (!ex) return;
    const setCount = item.sets || 1;
    const sides = item.perSide ? ["Left", "Right"] : [null];
    for (let s = 1; s <= setCount; s++) {
      sides.forEach((side) => {
        let label = "";
        if (setCount > 1) label = "Set " + s + " of " + setCount;
        if (side) label = label ? label + " — " + side : side;
        steps.push({ name: ex.name, detail: ex.detail || "", seconds: item.seconds || 30, label });
      });
    }
  });
  return steps;
}

function startSession(routine) {
  const steps = expandRoutineToSteps(routine);
  if (!steps.length) { toast("This routine has no exercises yet", true); return; }
  stretchState.session = { steps, index: 0 };
  closeStretchHub();
  $("#stretchPlayer").hidden = false;
  renderSessionStep();
}

function endSession() {
  clearInterval(stretchState.timer.handle);
  stretchState.timer = { running: false, remaining: 0, total: 0, handle: null };
  stretchState.session = null;
  $("#stretchPlayer").hidden = true;
}

function renderSessionStep() {
  const { steps, index } = stretchState.session;
  const step = steps[index];
  clearInterval(stretchState.timer.handle);
  stretchState.timer = { running: false, remaining: step.seconds, total: step.seconds, handle: null };
  $("#spSet").textContent = step.label || "";
  $("#spName").textContent = step.name;
  $("#spDetail").textContent = step.detail;
  $("#spTimer").textContent = fmtClock(step.seconds * 1000);
  $("#spStartPause").textContent = "▶ Start";
  $("#spProgressFill").style.width = Math.round(((index) / steps.length) * 100) + "%";
  $("#spPrev").disabled = index === 0;
  $("#spNext").textContent = index === steps.length - 1 ? "Finish" : "Next ›";
  $("#spNavLabel").textContent = (index + 1) + " / " + steps.length;
}

function toggleSessionTimer() {
  const t = stretchState.timer;
  if (t.running) {
    clearInterval(t.handle);
    t.running = false;
    $("#spStartPause").textContent = "▶ Resume";
    return;
  }
  t.running = true;
  $("#spStartPause").textContent = "⏸ Pause";
  t.handle = setInterval(() => {
    t.remaining -= 1;
    $("#spTimer").textContent = fmtClock(Math.max(0, t.remaining) * 1000);
    if (t.remaining <= 0) {
      clearInterval(t.handle);
      t.running = false;
      beep();
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      $("#spStartPause").textContent = "▶ Start";
      setTimeout(() => sessionNext(), 900);
    }
  }, 1000);
}

function restartSessionTimer() {
  clearInterval(stretchState.timer.handle);
  const step = stretchState.session.steps[stretchState.session.index];
  stretchState.timer = { running: false, remaining: step.seconds, total: step.seconds, handle: null };
  $("#spTimer").textContent = fmtClock(step.seconds * 1000);
  $("#spStartPause").textContent = "▶ Start";
}

function sessionNext() {
  const s = stretchState.session;
  if (s.index >= s.steps.length - 1) { endSession(); toast("Routine complete 💪"); return; }
  s.index++;
  renderSessionStep();
}

function sessionPrev() {
  const s = stretchState.session;
  if (s.index === 0) return;
  s.index--;
  renderSessionStep();
}

/* ---------- boot ---------- */

function bindStretchUI() {
  $("#stretchHubClose").addEventListener("click", closeStretchHub);
  document.querySelectorAll(".stretch-tab").forEach((b) => {
    b.addEventListener("click", () => switchStretchTab(b.dataset.stab));
  });
  $("#spClose").addEventListener("click", () => { if (confirm("End this session?")) endSession(); });
  $("#spStartPause").addEventListener("click", toggleSessionTimer);
  $("#spRestart").addEventListener("click", restartSessionTimer);
  $("#spNext").addEventListener("click", sessionNext);
  $("#spPrev").addEventListener("click", sessionPrev);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bindStretchUI);
} else {
  bindStretchUI();
}

window.openStretchHub = openStretchHub;
window.startSession = startSession;
window.endSession = endSession;
