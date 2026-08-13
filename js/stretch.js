/* ---------- Stretches: library + routine builder + guided session player ----------
   Opened from the Coach (gym) page's 🧘 button. Three tabs (Library/Routines/
   Builder) inside #stretchHub, plus a separate full-screen #stretchPlayer for
   walking through a routine one step at a time with a restartable timer.

   No content is auto-seeded per account — every account starts with an empty
   library. An earlier version seeded one person's personal exercise list into
   EVERY account (including things that weren't really exercises), which made
   no sense once more than one person used this. cleanupLegacySeed() removes
   that old auto-seeded data (matched by its old fixed doc ids, never
   colliding with anything a person added themselves) the first time this
   loads for an account, then never runs again. */

const OLD_SEED_IDS = [
  "hip-flexor", "knee-to-chest", "skip-hamstring", "glute-bridge", "dead-bug",
  "bird-dog", "side-plank", "pelvic-tilt", "stand-stretch", "brace-practice", "treadmill-checkin",
];

const DEFAULT_TARGET_TAGS = ["Hip Flexors", "Lower Back", "Hamstrings", "Glutes", "Core", "Shoulders", "Quads", "Calves", "Full Body"];

const stretchState = {
  loaded: false,
  exercises: [],
  routines: [],
  targetTags: DEFAULT_TARGET_TAGS.slice(),
  todayIds: new Set(),
  logEntries: [],
  tab: "library",
  activeFilter: null, // target tag currently filtering the Library/Builder picker, or null for "All"
  draft: { name: "", items: [] }, // builder-in-progress routine
  editingRoutineId: null,
  editingExerciseId: null, // set while #exerciseEditSheet is open for an existing exercise
  editTags: [], // tags currently selected in the edit sheet
  session: null, // { steps: [...], index: 0, returnTo: "hub"|"routines" }
  timer: { running: false, remaining: 0, total: 0, handle: null },
};

function googleSearchUrl(name) {
  return "https://www.google.com/search?q=" + encodeURIComponent(name + " stretch how to");
}

async function cleanupLegacySeed() {
  const flagRef = db.collection(ucol("settings")).doc("stretchLibraryCleaned");
  try {
    const flag = await flagRef.get();
    if (flag.exists) return;
  } catch (e) { /* fall through and try anyway */ }
  try {
    const batch = db.batch();
    OLD_SEED_IDS.forEach((id) => batch.delete(db.collection(ucol("exercises")).doc(id)));
    batch.set(flagRef, { at: new Date().toISOString() });
    await batch.commit();
  } catch (e) { /* not fatal — worst case the old items just sit there, editable/deletable manually */ }
}

async function loadTargetTags() {
  try {
    const doc = await db.collection(ucol("settings")).doc("stretchTargets").get();
    const saved = doc.exists && Array.isArray(doc.data().tags) ? doc.data().tags : [];
    if (saved.length) stretchState.targetTags = Array.from(new Set([...saved, ...DEFAULT_TARGET_TAGS]));
  } catch (e) { /* defaults are fine */ }
}
async function saveTargetTags() {
  try { await db.collection(ucol("settings")).doc("stretchTargets").set({ tags: stretchState.targetTags }); }
  catch (e) { toast("Couldn't save that target: " + e.message, true); }
}

async function loadStretchData() {
  await cleanupLegacySeed();
  await loadTargetTags();
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

function filteredExercises() {
  if (!stretchState.activeFilter) return stretchState.exercises;
  return stretchState.exercises.filter((e) => (e.targets || []).includes(stretchState.activeFilter));
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
  if (!hub.dataset.built) buildStretchHubShell();
  if (!stretchState.loaded) {
    $("#stretchTabBody").innerHTML = "<p class=\"hint\">Loading…</p>";
    await loadStretchData();
  }
  renderStretchTab();
}

function closeStretchHub() {
  if (window.__navPop) window.__navPop("stretchHub");
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

// The hub's own head/tabs are static per session (built once), only the tab
// body re-renders — built lazily here instead of static HTML so this file
// owns its own markup end to end.
function buildStretchHubShell() {
  const hub = $("#stretchHub");
  hub.dataset.built = "1";
  const head = el("div", "stretch-hub-head");
  head.appendChild(el("div", "stretch-hub-title", "🧘 Stretches"));
  const close = el("button", "icon-btn", "✕");
  close.type = "button";
  close.addEventListener("click", closeStretchHub);
  head.appendChild(close);
  hub.appendChild(head);

  const tabs = el("div", "stretch-tabs");
  tabs.id = "stretchTabs";
  [["library", "Library"], ["routines", "Routines"], ["builder", "Builder"]].forEach(([id, label]) => {
    const b = el("button", "stretch-tab" + (id === "library" ? " on" : ""), label);
    b.type = "button";
    b.dataset.stab = id;
    b.addEventListener("click", () => switchStretchTab(id));
    tabs.appendChild(b);
  });
  hub.appendChild(tabs);

  const body = el("div", "stretch-tab-body");
  body.id = "stretchTabBody";
  hub.appendChild(body);
}

/* ---------- target-tag filter chip row (shared by Library + Builder) ---------- */

function tagFilterRow(onPick) {
  const row = el("div", "stretch-filter-row");
  const allChip = el("button", "stretch-filter-chip" + (!stretchState.activeFilter ? " on" : ""), "All");
  allChip.type = "button";
  allChip.addEventListener("click", () => { stretchState.activeFilter = null; onPick(); });
  row.appendChild(allChip);
  stretchState.targetTags.forEach((tag) => {
    const chip = el("button", "stretch-filter-chip" + (stretchState.activeFilter === tag ? " on" : ""), tag);
    chip.type = "button";
    chip.addEventListener("click", () => { stretchState.activeFilter = tag; onPick(); });
    row.appendChild(chip);
  });
  return row;
}

/* ---------- Library tab ---------- */

function renderLibraryTab() {
  const body = $("#stretchTabBody");
  body.innerHTML = "";
  const streak = computeStreak(stretchState.logEntries, "loggedAt");
  body.appendChild(el("div", "stretch-streak", "🔥 " + streak + " day stretch streak"));

  body.appendChild(tagFilterRow(renderLibraryTab));

  const list = filteredExercises();
  if (!list.length) {
    body.appendChild(el("p", "hint", stretchState.exercises.length
      ? "Nothing tagged for this target yet."
      : "No exercises yet — add your first one below."));
  }
  list.forEach((ex) => body.appendChild(exerciseCard(ex)));

  const addBtn = el("button", "btn ghost big", "+ Add exercise");
  addBtn.type = "button";
  addBtn.addEventListener("click", () => openExerciseEdit(null));
  body.appendChild(addBtn);
}

function exerciseCard(ex) {
  const card = el("div", "exercise-card");
  const top = el("div", "exercise-card-top");
  const check = el("button", "exercise-check" + (stretchState.todayIds.has(ex.id) ? " on" : ""), stretchState.todayIds.has(ex.id) ? "✓" : "");
  check.type = "button";
  check.title = "Mark done today";
  check.addEventListener("click", () => toggleStretchDone(ex));
  top.appendChild(check);

  const textBox = el("div", "exercise-card-text");
  textBox.appendChild(el("div", "exercise-name", ex.name));
  if (ex.detail) textBox.appendChild(el("div", "exercise-detail", ex.detail));
  const metaRow = el("div", "exercise-meta-row");
  (ex.targets || []).forEach((t) => metaRow.appendChild(el("span", "exercise-target-badge", t)));
  if (ex.seconds) {
    const badge = ex.perSide ? ex.seconds + "s/side" : ex.sets > 1 ? ex.sets + " × " + ex.seconds + "s" : ex.seconds + "s";
    metaRow.appendChild(el("span", "exercise-badge", badge));
  }
  if (metaRow.childNodes.length) textBox.appendChild(metaRow);
  top.appendChild(textBox);

  const actions = el("div", "exercise-card-actions");
  const edit = el("button", "icon-btn", "✏️");
  edit.type = "button";
  edit.title = "Edit";
  edit.addEventListener("click", () => openExerciseEdit(ex.id));
  actions.appendChild(edit);
  const search = el("a", "icon-btn", "🔍");
  search.href = googleSearchUrl(ex.name);
  search.target = "_blank";
  search.rel = "noopener";
  search.title = "Search this stretch";
  actions.appendChild(search);
  top.appendChild(actions);

  card.appendChild(top);
  return card;
}

/* ---------- exercise add/edit sheet ---------- */

function openExerciseEdit(exerciseId) {
  const ex = exerciseId ? exerciseById(exerciseId) : null;
  stretchState.editingExerciseId = exerciseId || null;
  stretchState.editTags = ex ? (ex.targets || []).slice() : [];
  $("#exerciseEditTitle").textContent = ex ? "Edit exercise" : "Add exercise";
  $("#exEditName").value = ex ? ex.name : "";
  $("#exEditDetail").value = ex ? ex.detail || "" : "";
  $("#exEditSeconds").value = ex ? ex.seconds || 30 : 30;
  $("#exEditSets").value = ex ? ex.sets || 1 : 1;
  const perSideBtn = $("#exEditPerSide");
  perSideBtn.dataset.on = ex && ex.perSide ? "1" : "0";
  perSideBtn.textContent = "Per side: " + (perSideBtn.dataset.on === "1" ? "on" : "off");
  perSideBtn.classList.toggle("on", perSideBtn.dataset.on === "1");
  $("#exEditDelete").hidden = !ex;
  renderExerciseEditTags();
  $("#exerciseEditSheet").hidden = false;
}

function closeExerciseEdit() {
  $("#exerciseEditSheet").hidden = true;
}

function renderExerciseEditTags() {
  const box = $("#exEditTags");
  box.innerHTML = "";
  stretchState.targetTags.forEach((tag) => {
    const chip = el("button", "builder-chip" + (stretchState.editTags.includes(tag) ? " on" : ""), tag);
    chip.type = "button";
    chip.addEventListener("click", () => {
      const i = stretchState.editTags.indexOf(tag);
      if (i >= 0) stretchState.editTags.splice(i, 1); else stretchState.editTags.push(tag);
      renderExerciseEditTags();
    });
    box.appendChild(chip);
  });
  const addChip = el("button", "builder-chip dashed", "+ New target");
  addChip.type = "button";
  addChip.addEventListener("click", async () => {
    const name = (prompt("New target area (e.g. \"Ankles\"):") || "").trim();
    if (!name) return;
    if (stretchState.targetTags.some((t) => t.toLowerCase() === name.toLowerCase())) { toast("Already exists"); return; }
    stretchState.targetTags.push(name);
    stretchState.editTags.push(name);
    await saveTargetTags();
    renderExerciseEditTags();
  });
  box.appendChild(addChip);
}

async function saveExerciseEdit() {
  const name = $("#exEditName").value.trim();
  if (!name) { toast("Give it a name", true); return; }
  const entry = {
    name,
    targets: stretchState.editTags.slice(),
    detail: $("#exEditDetail").value.trim(),
    seconds: Math.max(0, parseInt($("#exEditSeconds").value, 10) || 0),
    sets: Math.max(1, parseInt($("#exEditSets").value, 10) || 1),
    perSide: $("#exEditPerSide").dataset.on === "1",
  };
  try {
    if (stretchState.editingExerciseId) {
      await db.collection(ucol("exercises")).doc(stretchState.editingExerciseId).set(entry, { merge: true });
      const idx = stretchState.exercises.findIndex((e) => e.id === stretchState.editingExerciseId);
      if (idx >= 0) stretchState.exercises[idx] = { id: stretchState.editingExerciseId, ...entry };
    } else {
      const ref = await db.collection(ucol("exercises")).add(entry);
      stretchState.exercises.push({ id: ref.id, ...entry });
    }
    closeExerciseEdit();
    renderStretchTab();
    toast("Saved");
  } catch (e) { toast("Couldn't save: " + e.message, true); }
}

async function deleteExerciseEdit() {
  const id = stretchState.editingExerciseId;
  if (!id) return;
  const ex = exerciseById(id);
  if (!(await confirmAction("Delete \"" + (ex ? ex.name : "this exercise") + "\"? This can't be undone."))) return;
  try {
    await db.collection(ucol("exercises")).doc(id).delete();
    stretchState.exercises = stretchState.exercises.filter((e) => e.id !== id);
    closeExerciseEdit();
    renderStretchTab();
    toast("Deleted");
  } catch (e) { toast("Couldn't delete: " + e.message, true); }
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
  body.appendChild(tagFilterRow(renderBuilderTab));
  const picker = el("div", "builder-picker");
  filteredExercises().forEach((ex) => {
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

// Started from the Routines tab inside the hub, so ending the session should
// bring the person back to the hub (not whatever tab happened to be
// underneath) — this is the "takes me to the Social screen" bug: the player
// closed itself without telling nav.js its history layer was done, leaving a
// stale entry that desynced the back-stack from what was actually on screen.
function startSession(routine) {
  const steps = expandRoutineToSteps(routine);
  if (!steps.length) { toast("This routine has no exercises yet", true); return; }
  stretchState.session = { steps, index: 0 };
  $("#stretchHub").hidden = true;
  $("#stretchPlayer").hidden = false;
  renderSessionStep();
}

function endSession() {
  if (window.__navPop) window.__navPop("stretchPlayer");
  clearInterval(stretchState.timer.handle);
  stretchState.timer = { running: false, remaining: 0, total: 0, handle: null };
  stretchState.session = null;
  $("#stretchPlayer").hidden = true;
  $("#stretchHub").hidden = false;
  renderStretchTab();
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
  $("#spProgressFill").style.width = Math.round((index / steps.length) * 100) + "%";
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

async function endSessionWithConfirm() {
  if (!(await confirmAction("End this session?"))) return;
  endSession();
}

/* ---------- boot ---------- */

function bindStretchUI() {
  $("#spClose").addEventListener("click", endSessionWithConfirm);
  $("#spStartPause").addEventListener("click", toggleSessionTimer);
  $("#spRestart").addEventListener("click", restartSessionTimer);
  $("#spNext").addEventListener("click", sessionNext);
  $("#spPrev").addEventListener("click", sessionPrev);

  $("#exerciseEditClose").addEventListener("click", closeExerciseEdit);
  $("#exEditSave").addEventListener("click", saveExerciseEdit);
  $("#exEditDelete").addEventListener("click", deleteExerciseEdit);
  $("#exEditPerSide").addEventListener("click", () => {
    const btn = $("#exEditPerSide");
    const on = btn.dataset.on === "1";
    btn.dataset.on = on ? "0" : "1";
    btn.textContent = "Per side: " + (on ? "off" : "on");
    btn.classList.toggle("on", !on);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bindStretchUI);
} else {
  bindStretchUI();
}

window.openStretchHub = openStretchHub;
window.startSession = startSession;
window.endSession = endSession;
