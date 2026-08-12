/* ---------- Android back-gesture / browser-back navigation ----------
   The app is a single page, so without this layer an Android back-swipe
   inside a chat exits the whole app. Here we give the app a real back stack
   using the History API:

     conversation  ->  Messages board  ->  previous tab  ->  ...  ->  Home
     Home + back   ->  "Leave GutCheck?" confirm instead of instantly closing

   How it works: every time the user navigates deeper (switches tabs, opens a
   conversation, opens the photo viewer / comments / avatar crop), we push a
   history entry and remember a "back action" for that layer. When the
   browser fires popstate (back swipe, browser back button), we run the top
   layer's back action instead of leaving. When the user closes a layer with
   an on-screen button (X, back arrow, cancel), we pop the matching history
   entry so the two stay in sync. When nothing is left on the stack we ask
   before letting the app actually close. */
(function () {
  const stack = [];        // [{ type, back }] — deepest layer last
  let skipPop = false;     // we triggered history.back() ourselves
  let exitArmed = false;   // user confirmed "Leave" — next pop really exits
  let askingExit = false;

  window.__navDebug = () => stack.map((l) => l.type); // test hook

  function pushLayer(type, back) {
    stack.push({ type, back });
    try { history.pushState({ gcNav: type }, ""); } catch (e) { /* very old browsers */ }
  }

  // The user closed a layer via on-screen UI: drop it from the stack and
  // consume its history entry so a later back-swipe doesn't double-step.
  function popLayerIf(type) {
    const top = stack[stack.length - 1];
    if (!top || top.type !== type) return;
    stack.pop();
    skipPop = true;
    try { history.back(); } catch (e) { /* nothing we can do */ }
  }

  window.addEventListener("popstate", () => {
    if (skipPop) { skipPop = false; return; }
    const layer = stack.pop();
    if (layer) { layer.back(); return; }
    // Stack is empty — the next back would leave the app entirely.
    if (exitArmed) {
      exitArmed = false;
      try { history.back(); } catch (e) { /* already leaving */ }
      return;
    }
    askExit();
  });

  async function askExit() {
    if (askingExit) return;
    askingExit = true;
    // The browser already stepped back past our last entry, so re-arm one
    // now: if the user cancels, the app keeps a working back stack.
    try { history.pushState({ gcNav: "root" }, ""); } catch (e) { /* ignore */ }
    try {
      const leave = await confirmAction("Leave GutCheck?", "Leave", "Stay");
      if (leave) {
        exitArmed = true;
        try { history.back(); } catch (e) { /* standalone PWA may ignore */ }
      }
    } finally {
      askingExit = false;
    }
  }

  // A spare history entry we always keep underneath the stack. Without it,
  // a back-swipe on an empty stack would navigate away before our popstate
  // handler could ask "Leave GutCheck?" — popstate can't cancel navigation,
  // so we make sure there's always one more same-document entry to land on.
  try { history.pushState({ gcNav: "sentinel" }, ""); } catch (e) { /* ignore */ }

  function bindNav() {
    /* -- tabs: back walks you home one tab at a time -- */
    const origGo = window.go;
    if (typeof origGo === "function") {
      window.go = function (tab) {
        const prev = state.tab;
        origGo(tab);
        // Only real user-driven tab *changes* get a stack entry (not the
        // initial go() during boot).
        if (prev && prev !== tab) {
          pushLayer("tab", () => { exitArmed = false; origGo(prev); });
        }
      };
    }

    /* -- conversation: back returns to the Messages board -- */
    const origOpenConvo = window.openConvo;
    if (typeof origOpenConvo === "function") {
      window.openConvo = function (uid) {
        const r = origOpenConvo.apply(this, arguments);
        pushLayer("convo", () => { if (window.switchSocialView) switchSocialView("messages"); });
        return r;
      };
      const backBtn = document.getElementById("convoBack");
      if (backBtn) backBtn.addEventListener("click", () => popLayerIf("convo"));
    }

    /* -- progress photo viewer: back closes it -- */
    const origOpenViewer = window.openViewer;
    if (typeof origOpenViewer === "function") {
      window.openViewer = function () {
        const r = origOpenViewer.apply(this, arguments);
        pushLayer("viewer", () => {
          const v = document.getElementById("viewer");
          if (v) v.hidden = true;
          state.viewerId = null;
        });
        return r;
      };
      const vc = document.getElementById("viewerClose");
      if (vc) vc.addEventListener("click", () => popLayerIf("viewer"));
      // deleting from inside the viewer also closes it
      const origDel = window.deleteViewerPhoto;
      if (typeof origDel === "function") {
        window.deleteViewerPhoto = async function () {
          const r = await origDel.apply(this, arguments);
          const v = document.getElementById("viewer");
          if (v && v.hidden) popLayerIf("viewer");
          return r;
        };
      }
    }

    /* -- comments sheet: back closes it -- */
    const origOpenComments = window.openComments;
    if (typeof origOpenComments === "function") {
      window.openComments = function () {
        const r = origOpenComments.apply(this, arguments);
        pushLayer("comments", () => {
          const s = document.getElementById("commentSheet");
          if (s) s.hidden = true;
          if (window.social) social.commentsFor = null;
        });
        return r;
      };
      const cc = document.getElementById("commentClose");
      if (cc) cc.addEventListener("click", () => popLayerIf("comments"));
    }

    /* -- avatar crop sheet: back cancels the crop -- */
    const origCrop = window.openAvatarCrop;
    if (typeof origCrop === "function") {
      window.openAvatarCrop = function () {
        const r = origCrop.apply(this, arguments);
        pushLayer("crop", () => {
          const s = document.getElementById("avatarCropSheet");
          if (s) s.hidden = true;
        });
        return r;
      };
      ["cropCancel", "cropCancelBtn", "cropSave"].forEach((id) => {
        const b = document.getElementById(id);
        if (b) b.addEventListener("click", () => popLayerIf("crop"));
      });
    }

    /* -- meal photo picker gate: back cancels it -- */
    const origPick = window.pickMealPhoto;
    if (typeof origPick === "function") {
      window.pickMealPhoto = function () {
        const r = origPick.apply(this, arguments);
        pushLayer("photopick", () => {
          const g = document.getElementById("photoPickGate");
          if (g) g.hidden = true;
        });
        return r;
      };
      ["pickCameraBtn", "pickLibraryBtn", "pickCancelBtn"].forEach((id) => {
        const b = document.getElementById(id);
        if (b) b.addEventListener("click", () => popLayerIf("photopick"));
      });
    }
  }

  // social.js wires its own UI at DOMContentLoaded-ish time too, so bind
  // after everything else has loaded (this script is included last).
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindNav);
  } else {
    bindNav();
  }
})();
