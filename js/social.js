/* ==========================================================================
   GutCheck Social — feed, people, messages, nudges, profile pictures.
   Closed-group design: every signed-in account is friends with everyone.
   Loaded after app.js; reuses its globals (state, db, ucol, $, el, toast,
   dayKey, compressForFirestore, downscaleDataUrl, confirmAction).
   ========================================================================== */

const SOCIAL_REACTIONS = ["👏", "💪", "❤️"];

const social = {
  booted: false,
  people: {},          // uid -> {name, email?, phone?, avatar?}
  posts: [],           // feed, newest first; each has comments[] + reactions{}
  view: "feed",
  convoUid: null,
  convoMsgs: [],
  threads: [],
  postAttach: null,    // data URL waiting to be posted
  commentsFor: null,   // postId currently open in the sheet
  lastMsgSeen: JSON.parse(localStorage.getItem("socialMsgSeen") || "{}"), // pairKey -> iso
};

/* ---------- small helpers ---------- */

function myName() {
  const p = state.profile || {};
  if (p.name) return p.name;
  if (state.userEmail) return state.userEmail.split("@")[0];
  return "Friend";
}

function personName(uid) {
  if (uid === state.uid) return myName();
  const p = social.people[uid];
  return (p && p.name) || "Friend";
}

function hueFromId(uid) {
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) >>> 0;
  return h % 360;
}

// Circular avatar: photo if we have one, else colored initials.
// `override` lets posts/comments fall back to the avatar stored on the doc.
function avatarEl(uid, name, cls, override) {
  const wrap = el("div", "avatar " + (cls || ""));
  const person = uid === state.uid
    ? { avatar: (state.profile || {}).avatar }
    : (social.people[uid] || {});
  const av = person.avatar || override;
  if (av) {
    const img = document.createElement("img");
    img.src = av;
    img.alt = name;
    wrap.appendChild(img);
  } else {
    wrap.style.background = "hsl(" + hueFromId(uid || name) + " 42% 26%)";
    const initial = (name || "F").trim().charAt(0).toUpperCase() || "F";
    wrap.appendChild(el("span", "avatar-init", initial));
  }
  return wrap;
}

function timeAgo(iso) {
  const s = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h";
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return d + "d";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function pairKey(a, b) { return [a, b].sort().join("_"); }

/* ---------- directory (who is everyone?) ---------- */

async function socialSyncDirectory() {
  try {
    const p = state.profile || {};
    const doc = { name: myName(), updatedAt: new Date().toISOString() };
    if (state.userEmail) doc.email = state.userEmail;
    if (state.userPhone) doc.phone = state.userPhone;
    if (p.avatar) doc.avatar = p.avatar;
    const sig = JSON.stringify(doc);
    if (localStorage.getItem("socialDirSig") === sig) return;
    await db.collection("directory").doc(state.uid).set(doc, { merge: true });
    localStorage.setItem("socialDirSig", sig);
  } catch (e) { /* rules not deployed yet or offline — social just stays quiet */ }
}

async function loadPeople() {
  try {
    const snap = await db.collection("directory").get();
    social.people = {};
    snap.forEach((d) => { if (d.id !== state.uid) social.people[d.id] = d.data(); });
  } catch (e) { social.people = {}; }
}

/* ---------- boot ---------- */

async function socialBoot() {
  bindSocialUI();
  renderComposerAvatars();
  await socialSyncDirectory();
  await loadPeople();
  renderPeople();
  renderComposerAvatars();
  await loadFeed();
  await loadThreads();
  socialCheckStreakCard();
  if (!social.booted) {
    social.booted = true;
  }
}

/* ---------- feed ---------- */

async function loadFeed() {
  try {
    const snap = await db.collection("posts").orderBy("createdAt", "desc").limit(50).get();
    const posts = [];
    snap.forEach((d) => posts.push({ id: d.id, ...d.data() }));
    await Promise.all(posts.map(async (p) => {
      try {
        const [cs, rs] = await Promise.all([
          db.collection("posts").doc(p.id).collection("comments").orderBy("createdAt", "asc").limit(50).get(),
          db.collection("posts").doc(p.id).collection("reactions").get(),
        ]);
        p.comments = [];
        cs.forEach((c) => p.comments.push({ id: c.id, ...c.data() }));
        p.reactions = {};
        rs.forEach((r) => { p.reactions[r.id] = r.data().emoji; });
      } catch (e) { p.comments = []; p.reactions = {}; }
    }));
    social.posts = posts;
  } catch (e) { social.posts = []; }
  renderFeed();
}

function reactionCounts(post) {
  const counts = {};
  Object.values(post.reactions || {}).forEach((e) => { counts[e] = (counts[e] || 0) + 1; });
  return counts;
}

function postCard(p) {
  const card = el("article", "post" + (p.type === "auto" ? " auto-post" : ""));
  const name = p.name || personName(p.uid);

  // header
  const head = el("header", "post-head");
  head.appendChild(avatarEl(p.uid, name, null, p.avatar));
  const headText = el("div", "post-head-text");
  headText.appendChild(el("div", "post-name", name));
  headText.appendChild(el("div", "post-time", timeAgo(p.createdAt)));
  head.appendChild(headText);
  if (p.type === "auto") head.appendChild(el("span", "post-badge", "⚡ GutCheck"));
  if (p.uid === state.uid) {
    const del = el("button", "icon-btn post-del", "🗑");
    del.title = "Delete post";
    del.addEventListener("click", async () => {
      if (!(await confirmAction("Delete this post? Comments and reactions go with it."))) return;
      try {
        await db.collection("posts").doc(p.id).delete();
        social.posts = social.posts.filter((x) => x.id !== p.id);
        if (social.commentsFor === p.id) { social.commentsFor = null; $("#commentSheet").hidden = true; }
        renderFeed();
        toast("Post deleted");
      } catch (e) { toast("Delete failed: " + e.message, true); }
    });
    head.appendChild(del);
  }
  card.appendChild(head);

  // image
  if (p.imageData) {
    const imgWrap = el("div", "post-img-wrap");
    const img = document.createElement("img");
    img.src = p.imageData;
    img.alt = p.caption || "post photo";
    img.loading = "lazy";
    imgWrap.appendChild(img);
    card.appendChild(imgWrap);
  }

  // body (auto card text or caption)
  if (p.type === "auto") {
    card.appendChild(el("div", "post-auto-text", p.autoText || ""));
  } else if (p.caption) {
    const cap = el("div", "post-caption", p.caption);
    card.appendChild(cap);
  }

  // actions: reactions + comment count
  const counts = reactionCounts(p);
  const myReaction = (p.reactions || {})[state.uid];
  const actions = el("div", "post-actions");
  SOCIAL_REACTIONS.forEach((emoji) => {
    const n = counts[emoji] || 0;
    const btn = el("button", "react-btn" + (myReaction === emoji ? " on" : ""),
      emoji + (n ? " " + n : ""));
    btn.addEventListener("click", () => toggleReaction(p, emoji));
    actions.appendChild(btn);
  });
  const cBtn = el("button", "react-btn comment-btn", p.comments.length ? "💬 " + p.comments.length : "💬");
  cBtn.addEventListener("click", () => openComments(p.id));
  actions.appendChild(cBtn);
  card.appendChild(actions);

  // comment preview + link
  if (p.comments.length) {
    if (p.comments.length > 2) {
      const link = el("button", "post-comments-link", "View all " + p.comments.length + " comments");
      link.addEventListener("click", () => openComments(p.id));
      card.appendChild(link);
    }
    p.comments.slice(-2).forEach((c) => card.appendChild(commentLine(c, p)));
  }

  // quick-add comment
  const add = el("form", "post-addcomment");
  const input = document.createElement("input");
  input.placeholder = "Add a comment…";
  input.autocomplete = "off";
  const go = el("button", "post-addcomment-btn", "Post");
  go.type = "submit";
  add.appendChild(input);
  add.appendChild(go);
  add.addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = input.value.trim();
    if (!t) return;
    if (await addComment(p.id, t)) input.value = "";
  });
  card.appendChild(add);

  return card;
}

function commentLine(c, p) {
  const line = el("div", "comment-line");
  const b = el("b", null, (c.name || personName(c.uid)) + "  ");
  line.appendChild(b);
  line.appendChild(document.createTextNode(c.text));
  if (c.uid === state.uid) {
    const del = el("button", "comment-del", "✕");
    del.title = "Delete comment";
    del.addEventListener("click", async () => {
      try {
        await db.collection("posts").doc(p.id).collection("comments").doc(c.id).delete();
        p.comments = p.comments.filter((x) => x.id !== c.id);
        renderFeed();
      } catch (e) { toast("Couldn't delete comment: " + e.message, true); }
    });
    line.appendChild(del);
  }
  return line;
}

function renderFeed(keepScroll) {
  const list = $("#feedList");
  if (!list) return;
  const y = keepScroll ? window.scrollY : 0;
  while (list.firstChild) list.removeChild(list.firstChild);
  social.posts.forEach((p) => list.appendChild(postCard(p)));
  const empty = $("#feedEmpty");
  if (empty) empty.hidden = social.posts.length > 0;
  if (keepScroll) window.scrollTo(0, y);
}

async function toggleReaction(p, emoji) {
  const ref = db.collection("posts").doc(p.id).collection("reactions").doc(state.uid);
  const mine = (p.reactions || {})[state.uid];
  try {
    if (mine === emoji) {
      await ref.delete();
      delete p.reactions[state.uid];
    } else {
      await ref.set({ emoji });
      p.reactions[state.uid] = emoji;
    }
    renderFeed(true);
  } catch (e) { toast("Couldn't react: " + e.message, true); }
}

async function addComment(postId, text) {
  const p = social.posts.find((x) => x.id === postId);
  const doc = { uid: state.uid, name: myName(), text: text.slice(0, 500), createdAt: new Date().toISOString() };
  try {
    const ref = await db.collection("posts").doc(postId).collection("comments").add(doc);
    if (p) {
      p.comments.push({ id: ref.id, ...doc });
      renderFeed(true);
      if (social.commentsFor === postId) renderCommentSheet(p);
    }
    return true;
  } catch (e) { toast("Couldn't post comment: " + e.message, true); return false; }
}

/* ---------- composer ---------- */

function pickPostPhoto() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const data = await compressForFirestore(f);
      social.postAttach = await downscaleDataUrl(data, 1080, 0.8);
      renderPostPhotoPrev();
    } catch (err) { toast("Could not read photo: " + err.message, true); }
  });
  input.click();
}

function renderPostPhotoPrev() {
  const prev = $("#postPhotoPrev");
  while (prev.firstChild) prev.removeChild(prev.firstChild);
  if (!social.postAttach) { prev.hidden = true; return; }
  prev.hidden = false;
  const img = document.createElement("img");
  img.src = social.postAttach;
  prev.appendChild(img);
  const rm = el("button", "attach-prev-x", "✕");
  rm.type = "button";
  rm.addEventListener("click", () => { social.postAttach = null; renderPostPhotoPrev(); });
  prev.appendChild(rm);
}

async function sharePost() {
  const caption = $("#postCaption").value.trim();
  if (!caption && !social.postAttach) { toast("Write something or add a photo first", true); return; }
  const btn = $("#postShareBtn");
  btn.disabled = true;
  const doc = {
    uid: state.uid,
    name: myName(),
    avatar: (state.profile || {}).avatar || null,
    type: social.postAttach ? "photo" : "text",
    caption: caption.slice(0, 1000),
    createdAt: new Date().toISOString(),
  };
  if (social.postAttach) doc.imageData = social.postAttach;
  try {
    const ref = await db.collection("posts").add(doc);
    social.posts.unshift({ id: ref.id, ...doc, comments: [], reactions: {} });
    $("#postCaption").value = "";
    social.postAttach = null;
    renderPostPhotoPrev();
    renderFeed();
    toast("Shared 🎉");
  } catch (e) {
    toast("Couldn't post: " + e.message + (e.code === "permission-denied" ? " (rules deploy needed)" : ""), true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- auto accomplishment cards ---------- */

async function socialAutoPost(kind, text) {
  try {
    const today = dayKey(new Date().toISOString());
    const ref = db.collection(ucol("settings")).doc("shared");
    const d = await ref.get();
    const shared = (d.exists && d.data()) || {};
    if (shared[kind] === today) return; // already celebrated today
    const patch = {};
    patch[kind] = today;
    await ref.set(patch, { merge: true });
    await db.collection("posts").add({
      uid: state.uid, name: myName(), avatar: (state.profile || {}).avatar || null,
      type: "auto", autoText: text, caption: "", createdAt: new Date().toISOString(),
    });
    if (social.booted) loadFeed();
  } catch (e) { /* social optional — never break logging */ }
}

function socialOnMealLogged() {
  const target = parseFloat(state.profile.protein) || 0;
  if (!target) return;
  const today = dayKey(new Date().toISOString());
  const pro = state.meals
    .filter((m) => dayKey(m.loggedAt) === today)
    .reduce((s, m) => s + (m.protein || 0), 0);
  if (pro >= target) {
    socialAutoPost("protein", "hit the daily protein goal — " + Math.round(pro) + "g of " + target + "g 🎯");
  }
}

function socialOnWorkoutLogged(tags) {
  socialAutoPost("workout", "logged a workout: " + tags.join(", ") + " 💪");
}

function socialCheckStreakCard() {
  // 7-day weigh-in streak, celebrated once per day max.
  let streak = 0;
  const days = new Set(state.weights.map((w) => dayKey(w.loggedAt)));
  const cursor = new Date();
  if (!days.has(dayKey(cursor.toISOString()))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(dayKey(cursor.toISOString()))) { streak++; cursor.setDate(cursor.getDate() - 1); }
  if (streak >= 7) {
    socialAutoPost("streak", "is on a " + streak + "-day weigh-in streak 🔥");
  }
}

/* ---------- people ---------- */

function renderPeople() {
  const list = $("#peopleList");
  if (!list) return;
  while (list.firstChild) list.removeChild(list.firstChild);

  const mkRow = (uid, name, sub, isMe) => {
    const row = el("div", "person-row");
    row.appendChild(avatarEl(uid, name, "md"));
    const txt = el("div", "person-text");
    txt.appendChild(el("div", "person-name", name + (isMe ? " (you)" : "")));
    if (sub) txt.appendChild(el("div", "person-sub", sub));
    row.appendChild(txt);
    if (!isMe) {
      const actions = el("div", "person-actions");
      const nudge = el("button", "btn ghost sm", "💪 Nudge");
      nudge.type = "button";
      nudge.addEventListener("click", () => sendNudge(uid));
      const msg = el("button", "btn sm", "Message");
      msg.type = "button";
      msg.addEventListener("click", () => { switchSocialView("messages"); openConvo(uid); });
      actions.appendChild(nudge);
      actions.appendChild(msg);
      row.appendChild(actions);
    }
    return row;
  };

  list.appendChild(mkRow(state.uid, myName(), state.userEmail || state.userPhone || "", true));
  Object.keys(social.people).forEach((uid) => {
    const p = social.people[uid];
    list.appendChild(mkRow(uid, p.name || "Friend", p.email || p.phone || "", false));
  });
}

/* ---------- nudges ---------- */

const NUDGE_LINES = [
  "believes in you — go get it done today!",
  "is cheering for you. One meal, one workout at a time.",
  "says: you've got this. No excuses today!",
  "is thinking of you — time to move!",
];

async function sendNudge(uid) {
  const line = NUDGE_LINES[Math.floor(Math.random() * NUDGE_LINES.length)];
  try {
    await sendThreadMessage(uid, "💪 Nudge from " + myName() + ": " + line);
    toast("Nudge sent to " + personName(uid) + " 💪");
  } catch (e) { toast("Couldn't send nudge: " + e.message, true); }
}

/* ---------- messages ---------- */

async function loadThreads() {
  try {
    const snap = await db.collection("threads").where("members", "array-contains", state.uid).get();
    social.threads = [];
    snap.forEach((d) => social.threads.push({ id: d.id, ...d.data() }));
    social.threads.sort((a, b) => String(b.lastAt || "").localeCompare(String(a.lastAt || "")));
  } catch (e) { social.threads = []; }
  renderThreads();
}

function otherMember(t) {
  return (t.members || []).find((m) => m !== state.uid) || "";
}

function renderThreads() {
  const list = $("#threadList");
  if (!list) return;
  while (list.firstChild) list.removeChild(list.firstChild);
  social.threads.forEach((t) => {
    const other = otherMember(t);
    const name = personName(other);
    const row = el("button", "thread-row");
    row.type = "button";
    row.appendChild(avatarEl(other, name, "md"));
    const txt = el("div", "thread-text");
    txt.appendChild(el("div", "person-name", name));
    txt.appendChild(el("div", "thread-last", (t.lastText || "").slice(0, 60)));
    row.appendChild(txt);
    if (t.lastAt) {
      const right = el("div", "thread-right");
      right.appendChild(el("span", "post-time", timeAgo(t.lastAt)));
      const seen = social.lastMsgSeen[t.id] || "";
      if (t.lastAt > seen && (!t.lastFrom || t.lastFrom !== state.uid)) right.appendChild(el("span", "unread-dot"));
      row.appendChild(right);
    }
    row.addEventListener("click", () => openConvo(other));
    list.appendChild(row);
  });
  const empty = $("#threadsEmpty");
  if (empty) empty.hidden = social.threads.length > 0;
  updateMsgBadge();
}

function updateMsgBadge() {
  const unread = social.threads.filter((t) => (t.lastAt || "") > (social.lastMsgSeen[t.id] || "") && (!t.lastFrom || t.lastFrom !== state.uid)).length;
  const badge = $("#msgBadge");
  if (!badge) return;
  badge.hidden = unread === 0;
  badge.textContent = unread;
}

async function openConvo(uid) {
  social.convoUid = uid;
  switchSocialView("convo");
  const name = personName(uid);
  $("#convoName").textContent = name;
  const av = $("#convoAvatar");
  while (av.firstChild) av.removeChild(av.firstChild);
  const fresh = avatarEl(uid, name);
  av.className = fresh.className;
  av.style.cssText = fresh.style.cssText;
  while (fresh.firstChild) av.appendChild(fresh.firstChild);
  await loadConvo();
  // mark seen
  const key = pairKey(state.uid, uid);
  social.lastMsgSeen[key] = new Date().toISOString();
  localStorage.setItem("socialMsgSeen", JSON.stringify(social.lastMsgSeen));
  updateMsgBadge();
}

async function loadConvo() {
  const key = pairKey(state.uid, social.convoUid);
  try {
    // newest 100, fetched desc then flipped so they render oldest -> newest
    const snap = await db.collection("threads").doc(key).collection("messages").orderBy("createdAt", "desc").limit(100).get();
    social.convoMsgs = [];
    snap.forEach((d) => social.convoMsgs.unshift({ id: d.id, ...d.data() }));
  } catch (e) { social.convoMsgs = []; }
  renderConvo();
}

function renderConvo() {
  const box = $("#convoScroll");
  while (box.firstChild) box.removeChild(box.firstChild);
  let lastDay = "";
  social.convoMsgs.forEach((m) => {
    const day = dayKey(m.createdAt);
    if (day !== lastDay) {
      lastDay = day;
      box.appendChild(el("div", "convo-day", new Date(m.createdAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })));
    }
    const mine = m.from === state.uid;
    const bubble = el("div", "bubble " + (mine ? "mine" : "theirs"));
    bubble.appendChild(el("span", "bubble-text", m.text));
    bubble.appendChild(el("span", "bubble-time", new Date(m.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })));
    box.appendChild(bubble);
  });
  box.scrollTop = box.scrollHeight;
}

async function sendThreadMessage(toUid, text) {
  const key = pairKey(state.uid, toUid);
  const now = new Date().toISOString();
  const names = {};
  names[state.uid] = myName();
  names[toUid] = personName(toUid);
  const batch = db.batch();
  batch.set(db.collection("threads").doc(key),
    { members: [state.uid, toUid].sort(), names, lastText: text.slice(0, 80), lastAt: now, lastFrom: state.uid },
    { merge: true });
  batch.set(db.collection("threads").doc(key).collection("messages").doc(),
    { from: state.uid, text: text.slice(0, 1000), createdAt: now });
  await batch.commit();
}

async function sendConvo() {
  const text = $("#convoText").value.trim();
  if (!text || !social.convoUid) return;
  $("#convoText").value = "";
  try {
    await sendThreadMessage(social.convoUid, text);
    await loadConvo();
    loadThreads();
  } catch (e) { toast("Couldn't send: " + e.message, true); }
}

/* ---------- comments sheet ---------- */

function openComments(postId) {
  social.commentsFor = postId;
  const p = social.posts.find((x) => x.id === postId);
  renderCommentSheet(p);
  $("#commentSheet").hidden = false;
}

function renderCommentSheet(p) {
  const list = $("#commentList");
  while (list.firstChild) list.removeChild(list.firstChild);
  if (!p || !p.comments.length) {
    list.appendChild(el("p", "hint", "No comments yet — say something nice."));
    return;
  }
  p.comments.forEach((c) => {
    const row = el("div", "sheet-comment");
    row.appendChild(avatarEl(c.uid, c.name || personName(c.uid), null, c.avatar));
    const body = el("div", "sheet-comment-body");
    const top = el("div", "sheet-comment-top");
    top.appendChild(el("b", null, c.name || personName(c.uid)));
    top.appendChild(el("span", "post-time", timeAgo(c.createdAt)));
    body.appendChild(top);
    body.appendChild(el("div", "sheet-comment-text", c.text));
    row.appendChild(body);
    if (c.uid === state.uid) {
      const del = el("button", "comment-del", "✕");
      del.title = "Delete comment";
      del.addEventListener("click", async () => {
        try {
          await db.collection("posts").doc(p.id).collection("comments").doc(c.id).delete();
          p.comments = p.comments.filter((x) => x.id !== c.id);
          renderCommentSheet(p);
          renderFeed();
        } catch (e) { toast("Couldn't delete: " + e.message, true); }
      });
      row.appendChild(del);
    }
    list.appendChild(row);
  });
}

/* ---------- profile picture ---------- */

function renderComposerAvatars() {
  const spots = [$("#composerAvatar"), $("#settingsAvatar")];
  const fresh = avatarEl(state.uid, myName());
  spots.forEach((spot) => {
    if (!spot) return;
    while (spot.firstChild) spot.removeChild(spot.firstChild);
    const f = avatarEl(state.uid, myName());
    spot.className = f.className + (spot.id === "settingsAvatar" ? " lg" : "");
    spot.style.cssText = f.style.cssText;
    while (f.firstChild) spot.appendChild(f.firstChild);
  });
}

function uploadAvatar() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const data = await compressForFirestore(f);
      openAvatarCrop(data);
    } catch (err) { toast("Could not read photo: " + err.message, true); }
  });
  input.click();
}

/* ---------- avatar crop (square, drag to pan, slider to zoom) ---------- */
const CROP_FRAME = 260; // css px square viewport
const CROP_OUT = 320;   // output px — 2.5x the old 128 thumb, still tiny data
let crop = null;        // {img, scale, minScale, x, y}

function openAvatarCrop(dataUrl) {
  const img = new Image();
  img.onload = () => {
    const minScale = Math.max(CROP_FRAME / img.width, CROP_FRAME / img.height);
    crop = {
      img, minScale, scale: minScale,
      x: (CROP_FRAME - img.width * minScale) / 2,
      y: (CROP_FRAME - img.height * minScale) / 2,
    };
    $("#cropZoom").value = 1;
    renderCrop();
    $("#avatarCropSheet").hidden = false;
  };
  img.onerror = () => toast("Could not load that image", true);
  img.src = dataUrl;
}

function clampCrop() {
  const w = crop.img.width * crop.scale;
  const h = crop.img.height * crop.scale;
  crop.x = Math.min(0, Math.max(CROP_FRAME - w, crop.x));
  crop.y = Math.min(0, Math.max(CROP_FRAME - h, crop.y));
}

function renderCrop() {
  const el = $("#cropImg");
  el.src = crop.img.src;
  el.style.width = crop.img.width * crop.scale + "px";
  el.style.height = crop.img.height * crop.scale + "px";
  el.style.transform = "translate(" + crop.x + "px," + crop.y + "px)";
}

function bindCrop() {
  const frame = $("#cropFrame");
  let drag = null;
  frame.addEventListener("pointerdown", (e) => {
    if (!crop) return;
    drag = { sx: e.clientX, sy: e.clientY, ox: crop.x, oy: crop.y };
    frame.setPointerCapture(e.pointerId);
  });
  frame.addEventListener("pointermove", (e) => {
    if (!drag || !crop) return;
    crop.x = drag.ox + (e.clientX - drag.sx);
    crop.y = drag.oy + (e.clientY - drag.sy);
    clampCrop();
    renderCrop();
  });
  ["pointerup", "pointercancel"].forEach((ev) => frame.addEventListener(ev, () => { drag = null; }));
  $("#cropZoom").addEventListener("input", (e) => {
    if (!crop) return;
    // zoom around the frame center so the crop point stays put
    const cx = CROP_FRAME / 2, cy = CROP_FRAME / 2;
    const prev = crop.scale;
    crop.scale = crop.minScale * parseFloat(e.target.value);
    const k = crop.scale / prev;
    crop.x = cx - (cx - crop.x) * k;
    crop.y = cy - (cy - crop.y) * k;
    clampCrop();
    renderCrop();
  });
  const close = () => { $("#avatarCropSheet").hidden = true; crop = null; };
  $("#cropCancel").addEventListener("click", close);
  $("#cropCancelBtn").addEventListener("click", close);
  $("#cropSave").addEventListener("click", async () => {
    if (!crop) return;
    const k = CROP_OUT / CROP_FRAME;
    const canvas = document.createElement("canvas");
    canvas.width = CROP_OUT;
    canvas.height = CROP_OUT;
    const cx2 = canvas.getContext("2d");
    cx2.drawImage(crop.img, crop.x * k, crop.y * k, crop.img.width * crop.scale * k, crop.img.height * crop.scale * k);
    const thumb = canvas.toDataURL("image/jpeg", 0.88);
    close();
    try {
      state.profile.avatar = thumb;
      await db.collection(ucol("settings")).doc("profile").set({ avatar: thumb }, { merge: true });
      localStorage.removeItem("socialDirSig"); // force directory re-sync
      await socialSyncDirectory();
      renderComposerAvatars();
      toast("Profile picture updated");
    } catch (err) { toast("Couldn't save photo: " + err.message, true); }
  });
}

/* ---------- view switching + wiring ---------- */

function switchSocialView(view) {
  social.view = view;
  ["feed", "people", "messages", "convo"].forEach((v) => {
    const panel = { feed: "#socialFeed", people: "#socialPeople", messages: "#socialMessages", convo: "#socialConvo" }[v];
    $(panel).hidden = v !== view;
  });
  $("#socialSeg").hidden = view === "convo";
  document.querySelectorAll("#socialSeg [data-sview]").forEach((b) => {
    b.classList.toggle("on", b.dataset.sview === view || (view === "convo" && b.dataset.sview === "messages"));
  });
  if (view === "feed") loadFeed();
  if (view === "messages") loadThreads();
  if (view === "people") { loadPeople().then(renderPeople); }
}

let socialUIBound = false;
function bindSocialUI() {
  if (socialUIBound) return;
  socialUIBound = true;

  document.querySelectorAll("#socialSeg [data-sview]").forEach((b) => {
    b.addEventListener("click", () => {
      if (social.view === b.dataset.sview && (b.dataset.sview === "feed" || b.dataset.sview === "messages")) {
        // re-tap the active tab = refresh
        if (b.dataset.sview === "feed") loadFeed();
        else loadThreads();
        toast("Refreshed");
        return;
      }
      switchSocialView(b.dataset.sview);
    });
  });
  $("#postPhotoBtn").addEventListener("click", pickPostPhoto);
  $("#postShareBtn").addEventListener("click", sharePost);
  $("#convoBack").addEventListener("click", () => switchSocialView("messages"));
  $("#convoForm").addEventListener("submit", (e) => { e.preventDefault(); sendConvo(); });
  $("#convoNudge").addEventListener("click", () => { if (social.convoUid) sendNudge(social.convoUid); });
  $("#commentClose").addEventListener("click", () => { $("#commentSheet").hidden = true; social.commentsFor = null; });
  $("#commentForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const t = $("#commentText").value.trim();
    if (!t || !social.commentsFor) return;
    if (await addComment(social.commentsFor, t)) $("#commentText").value = "";
  });
  const avBtn = $("#avatarUploadBtn");
  if (avBtn) avBtn.addEventListener("click", uploadAvatar);
  bindCrop();
}

window.socialBoot = socialBoot;
window.socialSyncDirectory = socialSyncDirectory;
window.socialOnMealLogged = socialOnMealLogged;
window.socialOnWorkoutLogged = socialOnWorkoutLogged;
