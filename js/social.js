/* ==========================================================================
   GutCheck Social — feed, people, messages, nudges, profile pictures.
   Closed-group design: every signed-in account is friends with everyone.
   Loaded after app.js; reuses its globals (state, db, ucol, $, el, toast,
   dayKey, compressForFirestore, downscaleDataUrl, confirmAction).
   ========================================================================== */

let lastConvoY = 0;
let suppressConvoHeadToggle = false;

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
  startMsgListener();
  socialCheckStreakCard();
  initPush();
  // reloading shouldn't dump you back on the feed if you were mid-conversation
  try {
    const saved = JSON.parse(localStorage.getItem("gutcheckSocialView") || "null");
    if (saved && saved.view === "convo" && saved.convoUid) openConvo(saved.convoUid);
    else if (saved && saved.view && saved.view !== "convo") switchSocialView(saved.view);
  } catch (e) { /* noop — just stays on the default feed view */ }
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

  const mkRow = (uid, name, isMe) => {
    const row = el("div", "person-row" + (isMe ? "" : " tappable"));
    row.appendChild(avatarEl(uid, name, "md"));
    const txt = el("div", "person-text");
    txt.appendChild(el("div", "person-name", name + (isMe ? " (you)" : "")));
    row.appendChild(txt);
    if (!isMe) {
      row.addEventListener("click", (e) => {
        if (e.target.closest(".person-actions")) return; // nudge/message buttons handle themselves
        switchSocialView("messages");
        openConvo(uid);
      });
      const actions = el("div", "person-actions");
      const nudge = el("button", "btn ghost xs", "💪");
      nudge.type = "button";
      nudge.title = "Nudge " + name;
      nudge.addEventListener("click", (e) => { e.stopPropagation(); sendNudge(uid); });
      actions.appendChild(nudge);
      row.appendChild(actions);
    }
    return row;
  };

  list.appendChild(mkRow(state.uid, myName(), true));
  Object.keys(social.people).forEach((uid) => {
    const p = social.people[uid];
    list.appendChild(mkRow(uid, p.name || "Friend", false));
  });
}

/* ---------- nudges ---------- */

const NUDGE_PREFIX = "💪 Nudge from ";

const NUDGE_LINES = [
  "get up, we're not doing the couch thing today",
  "I logged mine. Your turn.",
  "let's go 💪",
  "don't make me nudge you again",
  "rooting for you today",
  "you don't have to crush it, just show up",
];

// Returns the plain line (no "💪 Nudge from X: " wrapper) if this message is
// a nudge, else null. The sender's display name is looked up separately via
// personName() rather than parsed out of the text, so it stays correct even
// if that person's name changes later.
function parseNudge(text) {
  if (!text || !text.startsWith(NUDGE_PREFIX)) return null;
  const rest = text.slice(NUDGE_PREFIX.length);
  const idx = rest.indexOf(": ");
  return idx >= 0 ? rest.slice(idx + 2) : rest;
}

function previewText(text) {
  const line = parseNudge(text);
  if (line) return "💪 " + line;
  return text ? text.slice(0, 60) : "No messages yet";
}

async function sendNudge(uid) {
  const line = NUDGE_LINES[Math.floor(Math.random() * NUDGE_LINES.length)];
  try {
    await sendThreadMessage(uid, NUDGE_PREFIX + myName() + ": " + line);
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
    txt.appendChild(el("div", "thread-last", previewText(t.lastText)));
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
  if (badge) {
    badge.hidden = unread === 0;
    badge.textContent = unread;
  }
  const tabDot = $("#socialTabDot");
  if (tabDot) {
    tabDot.hidden = unread === 0;
    tabDot.textContent = unread;
  }
}

/* ---------- new-message notifications (45s polling) ---------- */
// notifiedAt tracks the last lastAt we already toasted about, so we only
// notify once per incoming message and never for stuff that pre-dates boot.
const msgNotified = {};

async function pollMessages() {
  if (state.tab === "social" && social.view === "messages") return; // already fresh
  await loadThreads();
  social.threads.forEach((t) => {
    const incoming = t.lastFrom && t.lastFrom !== state.uid;
    const isNew = (t.lastAt || "") > (msgNotified[t.id] || "");
    if (incoming && isNew) {
      msgNotified[t.id] = t.lastAt;
      const other = otherMember(t);
      if (state.tab === "social" && social.view === "convo" && social.convoUid === other) {
        loadConvo(); // sitting in this chat — just show it
      } else {
        toast("💬 " + personName(other) + ": " + previewText(t.lastText));
      }
    }
  });
}

function startMsgPolling() {
  // baseline: everything that exists at boot is "already seen" for toasts
  social.threads.forEach((t) => { msgNotified[t.id] = t.lastAt || ""; });
  setInterval(pollMessages, 45000);
}

/* ---------- real-time messages (Firestore snapshots; no refresh needed) ---------- */

let threadsUnsub = null;
let convoUnsub = null;

function startMsgListener() {
  // baseline: threads that exist at boot don't trigger banners
  social.threads.forEach((t) => { msgNotified[t.id] = t.lastAt || ""; });
  try {
    threadsUnsub = db.collection("threads")
      .where("members", "array-contains", state.uid)
      .onSnapshot(onThreadsSnapshot, () => {});
  } catch (e) {
    startMsgPolling(); // older SDK / test stub without onSnapshot
  }
}

function onThreadsSnapshot(snap) {
  social.threads = [];
  snap.forEach((d) => social.threads.push({ id: d.id, ...d.data() }));
  social.threads.sort((a, b) => String(b.lastAt || "").localeCompare(String(a.lastAt || "")));
  social.threads.forEach((t) => {
    const incoming = t.lastFrom && t.lastFrom !== state.uid;
    const isNew = (t.lastAt || "") > (msgNotified[t.id] || "");
    if (incoming && isNew) {
      msgNotified[t.id] = t.lastAt;
      const other = otherMember(t);
      if (state.tab === "social" && social.view === "convo" && social.convoUid === other) {
        // convo listener handles the live append; just clear the unread state
        social.lastMsgSeen[t.id] = t.lastAt;
        localStorage.setItem("socialMsgSeen", JSON.stringify(social.lastMsgSeen));
      } else {
        showMsgBanner(other, t.lastText || "");
      }
    }
  });
  renderThreads();
}

function subscribeConvo() {
  if (convoUnsub) { convoUnsub(); convoUnsub = null; }
  const key = pairKey(state.uid, social.convoUid);
  try {
    convoUnsub = db.collection("threads").doc(key).collection("messages")
      .orderBy("createdAt", "desc").limit(100)
      .onSnapshot((snap) => {
        social.convoMsgs = [];
        snap.forEach((d) => social.convoMsgs.unshift({ id: d.id, ...d.data() }));
        renderConvo();
      }, () => {});
  } catch (e) { /* stub path: loadConvo() covers it */ }
}

function unsubscribeConvo() {
  if (convoUnsub) { convoUnsub(); convoUnsub = null; }
}

/* ---------- drop-down message banner ---------- */

let bannerTimer = null;
let bannerUid = null;

function showMsgBanner(uid, text) {
  bannerUid = uid;
  const name = personName(uid);
  $("#msgBannerName").textContent = name;
  $("#msgBannerPreview").textContent = previewText(text).slice(0, 80);
  const av = $("#msgBannerAvatar");
  while (av.firstChild) av.removeChild(av.firstChild);
  const fresh = avatarEl(uid, name);
  av.className = fresh.className;
  av.style.cssText = fresh.style.cssText;
  while (fresh.firstChild) av.appendChild(fresh.firstChild);
  const banner = $("#msgBanner");
  banner.hidden = false;
  requestAnimationFrame(() => banner.classList.add("show"));
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(hideMsgBanner, 4500);
}

function hideMsgBanner() {
  const banner = $("#msgBanner");
  banner.classList.remove("show");
  clearTimeout(bannerTimer);
  setTimeout(() => { banner.hidden = true; }, 250);
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
  $("#socialConvo").classList.remove("head-hidden");
  subscribeConvo();
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

function msgDelBtn(messageId) {
  const del = el("button", "msg-del", "✕");
  del.type = "button";
  del.title = "Delete for both of you";
  del.addEventListener("click", (e) => { e.stopPropagation(); deleteConvoMessage(messageId); });
  return del;
}

// Delete is only reachable by press-and-holding a message — attachLongPress
// "arms" the pressed element (reveals its .msg-del button via CSS), and any
// plain tap elsewhere (or on the armed message itself) disarms it again.
let armedMsgEl = null;
function disarmMsg() {
  if (armedMsgEl) { armedMsgEl.classList.remove("armed"); armedMsgEl = null; }
}
function armMsg(target) {
  if (armedMsgEl === target) return;
  disarmMsg();
  target.classList.add("armed");
  armedMsgEl = target;
}
function attachLongPress(target) {
  const HOLD_MS = 500;
  let timer = null;
  let moved = false;
  const clear = () => { clearTimeout(timer); timer = null; };
  target.addEventListener("pointerdown", () => {
    moved = false;
    clear();
    timer = setTimeout(() => { if (!moved) armMsg(target); }, HOLD_MS);
  });
  target.addEventListener("pointermove", () => { moved = true; clear(); });
  target.addEventListener("pointerup", clear);
  target.addEventListener("pointercancel", clear);
  // a plain tap (not a hold) on an already-armed message dismisses it
  target.addEventListener("click", (e) => {
    if (target.classList.contains("armed") && !e.target.closest(".msg-del")) disarmMsg();
  });
}

function renderConvo() {
  const box = $("#convoScroll");
  while (box.firstChild) box.removeChild(box.firstChild);
  armedMsgEl = null; // the DOM node it pointed to is about to be discarded
  let lastDay = "";
  social.convoMsgs.forEach((m) => {
    const day = dayKey(m.createdAt);
    if (day !== lastDay) {
      lastDay = day;
      box.appendChild(el("div", "convo-day", new Date(m.createdAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })));
    }
    const mine = m.from === state.uid;
    const time = new Date(m.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const nudgeLine = parseNudge(m.text);
    if (nudgeLine) {
      const card = el("div", "nudge-card");
      card.appendChild(el("div", "nudge-icon", "💪"));
      const body = el("div", "nudge-body");
      body.appendChild(el("div", "nudge-label", mine ? "You nudged " + personName(social.convoUid) : personName(m.from) + " nudged you"));
      body.appendChild(el("div", "nudge-text", nudgeLine));
      body.appendChild(el("div", "nudge-time", time));
      card.appendChild(body);
      if (mine) { card.appendChild(msgDelBtn(m.id)); attachLongPress(card); }
      box.appendChild(card);
      return;
    }
    const bubble = el("div", "bubble " + (mine ? "mine" : "theirs"));
    bubble.appendChild(el("span", "bubble-text", m.text));
    bubble.appendChild(el("span", "bubble-time", time));
    if (mine) { bubble.appendChild(msgDelBtn(m.id)); attachLongPress(bubble); }
    box.appendChild(bubble);
  });
  // jump to the newest message inside the convo's own scrollbox, and keep the
  // header visible — programmatic jumps shouldn't trip the scroll-up/down hider
  suppressConvoHeadToggle = true;
  $("#socialConvo").classList.remove("head-hidden");
  box.scrollTop = box.scrollHeight;
  // release suppression only after the layout has settled (two frames),
  // so a late async scroll event can't spuriously hide the header
  requestAnimationFrame(() => requestAnimationFrame(() => {
    lastConvoY = box.scrollTop;
    suppressConvoHeadToggle = false;
  }));
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

// "Delete for everyone" — removes the one shared Firestore doc, so it's gone
// from both people's view. Rules restrict this to messages you sent.
async function deleteConvoMessage(messageId) {
  if (!(await confirmAction("Delete this message for both of you? This can't be undone."))) return;
  const key = pairKey(state.uid, social.convoUid);
  try {
    await db.collection("threads").doc(key).collection("messages").doc(messageId).delete();
    social.convoMsgs = social.convoMsgs.filter((m) => m.id !== messageId);
    renderConvo();
    await refreshThreadPreview(key);
  } catch (e) { toast("Couldn't delete: " + e.message, true); }
}

// If the deleted message was the thread's most recent one, the list/preview
// needs to reflect whatever is now last (or go blank if nothing's left).
async function refreshThreadPreview(key) {
  try {
    const snap = await db.collection("threads").doc(key).collection("messages")
      .orderBy("createdAt", "desc").limit(1).get();
    const ref = db.collection("threads").doc(key);
    if (snap.empty) {
      await ref.set({ lastText: "", lastAt: null, lastFrom: null }, { merge: true });
    } else {
      const last = snap.docs[0].data();
      await ref.set({ lastText: (last.text || "").slice(0, 80), lastAt: last.createdAt, lastFrom: last.from }, { merge: true });
    }
  } catch (e) { /* thread preview just stays stale until the next message — not critical */ }
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
  if (social.view === "convo" && view !== "convo") unsubscribeConvo();
  social.view = view;
  try {
    localStorage.setItem("gutcheckSocialView", JSON.stringify({ view, convoUid: view === "convo" ? social.convoUid : null }));
  } catch (e) { /* private browsing — just won't persist */ }
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
  // auto-hide the convo header: hides scrolling down, returns on any scroll
  // up. Debounced (settles ~90ms after scrolling stops) and holds its state
  // near either end of the scrollbox — momentum/rubber-band bounce at a
  // boundary fires a burst of tiny alternating-direction scroll events that
  // would otherwise retrigger the opacity/margin transition over and over,
  // which is what caused the header to flicker for several seconds.
  const convoScroll = $("#convoScroll");
  let convoScrollTimer = null;
  convoScroll.addEventListener("scroll", () => {
    if (suppressConvoHeadToggle) return;
    const y = convoScroll.scrollTop;
    const maxY = convoScroll.scrollHeight - convoScroll.clientHeight;
    clearTimeout(convoScrollTimer);
    if (y < 8) {
      $("#socialConvo").classList.remove("head-hidden");
      lastConvoY = y;
      return;
    }
    if (y > maxY - 16) {
      // right at the bottom — hold whatever state we're already in instead
      // of reacting to bounce noise
      lastConvoY = y;
      return;
    }
    convoScrollTimer = setTimeout(() => {
      const d = y - lastConvoY;
      lastConvoY = y;
      if (d > 4) $("#socialConvo").classList.add("head-hidden");
      else if (d < -4) $("#socialConvo").classList.remove("head-hidden");
    }, 90);
  }, { passive: true });
  // tapping anywhere in the message list that isn't the currently-armed
  // message dismisses the delete affordance
  convoScroll.addEventListener("click", (e) => {
    if (armedMsgEl && !e.target.closest(".armed")) disarmMsg();
  });
  $("#msgBannerClose").addEventListener("click", (e) => { e.stopPropagation(); hideMsgBanner(); });
  $("#msgBanner").addEventListener("click", () => {
    const uid = bannerUid;
    hideMsgBanner();
    if (uid) { go("social"); switchSocialView("messages"); openConvo(uid); }
  });
}

/* ---------- push notifications (FCM) ----------
   Foreground messages (app open, tab focused) are already covered by the
   Firestore listeners above (startMsgListener + the drop-down banner) — this
   section is specifically for when the app is backgrounded, the phone is
   locked, or the tab/PWA is fully closed. sw.js has the matching
   onBackgroundMessage handler that actually shows the OS notification.

   iOS note: Safari only supports web push for a PWA that's been added to the
   Home Screen and opened in standalone mode (iOS 16.4+). On a regular Safari
   tab, firebase.messaging.isSupported() will resolve false and the button
   below just won't do anything harmful — it'll say "Not supported here". */

// Get this from Firebase Console → Project Settings → Cloud Messaging →
// Web Push certificates (generate a key pair if none exists yet).
const FCM_VAPID_KEY = "BHsm3RlyWmbWUr0r-CWrMoeiXl0Tmt-_N01HHsUEI8MbK4XsE9D6T_cW4-EvrPaci_pdMkJL8OKdtnbefCVNIMg";

let fcmMessaging = null;
let pushSwReg = null;

async function initPush() {
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !firebase.messaging) return;
  try {
    const supported = await firebase.messaging.isSupported();
    if (!supported) return;
    fcmMessaging = firebase.messaging();
    pushSwReg = await navigator.serviceWorker.ready;
    // foreground messages are redundant with the Firestore banner — swallow them
    fcmMessaging.onMessage(() => {});
    if (localStorage.getItem("gutcheckPushEnabled") === "1" && Notification.permission === "granted") {
      await refreshPushToken(); // silently keep the token fresh across app opens
    }
  } catch (e) {
    fcmMessaging = null;
  }
  renderPushToggle();
}

async function refreshPushToken() {
  if (!fcmMessaging || !pushSwReg) return null;
  const token = await fcmMessaging.getToken({ vapidKey: FCM_VAPID_KEY, serviceWorkerRegistration: pushSwReg });
  if (token) {
    await db.collection(ucol("settings")).doc("push").set(
      { tokens: firebase.firestore.FieldValue.arrayUnion(token) }, { merge: true }
    );
  }
  return token;
}

async function enablePushNotifications() {
  if (!FCM_VAPID_KEY || FCM_VAPID_KEY.startsWith("PASTE_")) {
    toast("Push isn't configured yet — needs a VAPID key from Ethan.", true);
    return;
  }
  if (!fcmMessaging) { toast("Push notifications aren't supported on this browser", true); return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("Notification permission denied"); renderPushToggle(); return; }
    const token = await refreshPushToken();
    if (!token) { toast("Couldn't get a push token", true); return; }
    localStorage.setItem("gutcheckPushEnabled", "1");
    toast("Push notifications on 🔔");
  } catch (e) {
    toast("Couldn't enable push: " + e.message, true);
  }
  renderPushToggle();
}

async function disablePushNotifications() {
  try {
    if (fcmMessaging && pushSwReg) {
      const token = await fcmMessaging.getToken({ vapidKey: FCM_VAPID_KEY, serviceWorkerRegistration: pushSwReg }).catch(() => null);
      if (token) {
        await db.collection(ucol("settings")).doc("push").set(
          { tokens: firebase.firestore.FieldValue.arrayRemove(token) }, { merge: true }
        );
      }
    }
  } catch (e) { /* best effort — the token will just go stale and get pruned server-side */ }
  localStorage.removeItem("gutcheckPushEnabled");
  toast("Push notifications off");
  renderPushToggle();
}

function renderPushToggle() {
  const btn = $("#pushToggleBtn");
  if (!btn) return;
  if (!("Notification" in window) || !fcmMessaging) {
    btn.textContent = "Not supported on this browser";
    btn.disabled = true;
    btn.onclick = null;
    return;
  }
  btn.disabled = false;
  if (Notification.permission === "denied") {
    btn.textContent = "Blocked — enable in your browser or phone settings";
    btn.disabled = true;
    btn.onclick = null;
  } else if (localStorage.getItem("gutcheckPushEnabled") === "1" && Notification.permission === "granted") {
    btn.textContent = "🔕 Turn off notifications";
    btn.onclick = disablePushNotifications;
  } else {
    btn.textContent = "🔔 Enable notifications";
    btn.onclick = enablePushNotifications;
  }
}

window.socialBoot = socialBoot;
window.socialSyncDirectory = socialSyncDirectory;
window.socialOnMealLogged = socialOnMealLogged;
window.socialOnWorkoutLogged = socialOnWorkoutLogged;
window.renderPushToggle = renderPushToggle;
