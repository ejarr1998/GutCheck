/* ============================================================
   GutCheck Cloud Functions — server-side AI proxy
   All four API keys live here as secrets; browsers never see them.
   Every function: auth verification → per-user
   daily rate cap → uid-scoped Firestore writes (Admin SDK).
   ============================================================ */
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const DEEPGRAM_API_KEY = defineSecret("DEEPGRAM_API_KEY");
const ELEVENLABS_API_KEY = defineSecret("ELEVENLABS_API_KEY");
const XAI_API_KEY = defineSecret("XAI_API_KEY");

const DAILY_CALL_CAP = 150; // per user, across all functions, UTC day
const CLAUDE_MODEL = "claude-sonnet-5";
const MAX_TOOL_ROUNDS = 4;

const ELEVEN_VOICES = {
  nutrition: { female: "21m00Tcm4TlvDq8ikWAM", male: "pNInz6obpgDQGcFmaJgB" }, // Rachel / Adam
  gym: { female: "EXAVITQu4vr4xnSDxMaL", male: "TxGEqnHWrfWFTfGW9XjX" },       // Bella / Josh
};
const AURA_VOICES = {
  nutrition: { female: "aura-2-thalia-en", male: "aura-2-orion-en" },
  gym: { female: "aura-2-hera-en", male: "aura-2-arcas-en" },
};
function pickVoice(map, coachId, gender) {
  const perCoach = map[coachId] || map.nutrition;
  return perCoach[gender === "male" ? "male" : "female"];
}

/* ---------- shared guard: auth + per-user daily rate cap ---------- */
// Open sign-up: any authenticated Google account may call, but every call is
// uid-scoped server-side (Firestore rules enforce the same on direct reads),
// and the per-user daily cap limits API-cost exposure per account.
async function guard(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Sign in first.");
  }
  const uid = request.auth.uid;
  const day = new Date().toISOString().slice(0, 10); // UTC day
  const usageRef = db.doc(`users/${uid}/usage/${day}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(usageRef);
    const n = snap.exists ? (snap.data().count || 0) : 0;
    if (n >= DAILY_CALL_CAP) {
      throw new HttpsError("resource-exhausted", "Daily AI limit reached — try again tomorrow.");
    }
    tx.set(usageRef, { count: n + 1, updatedAt: new Date().toISOString() }, { merge: true });
  });
  return uid;
}

/* ---------- Maya's meal-logging tool (runs server-side) ---------- */
const MAYA_TOOLS = [{
  name: "log_meal",
  description:
    "Log a meal to the client's daily tracker (Today's fuel card on the dashboard). " +
    "Use whenever the client asks you to log something they ate, or tells you what they ate expecting it to be tracked. " +
    "One call per eating occasion — if they describe several foods eaten together (e.g. eggs, toast, and cheese for breakfast), combine them into ONE call with ONE combined total, not one call per food. " +
    "Only make separate calls when they describe genuinely separate occasions in the same message (like breakfast AND a separate afternoon snack). " +
    "Only for actual food or drink — never log non-food items, and never log a 0-calorie entry for a real meal; re-estimate or ask instead.",
  input_schema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "A short, clean name listing just the food items themselves (e.g. \"Eggs, cheese, toast, butter\"), roughly 3-8 words. Strip out everything else — the client's own phrasing, restated calories/macros, brand names, hedging, photo references. Exception: for sodas/soft drinks, keep the actual drink name (e.g. \"Dr Pepper\") rather than genericizing it. Never paste their raw message.",
      },
      calories: { type: "number", description: "Estimated total calories for the whole meal (integer)" },
      protein: { type: "number", description: "Estimated total grams of protein for the whole meal (integer)" },
    },
    required: ["description", "calories", "protein"],
  },
}, {
  name: "delete_meal",
  description:
    "Delete a meal entry from the client's daily tracker. Use ONLY when the client clearly asks to remove, delete, or undo something logged today — never delete without being explicitly asked, and never guess which entry they mean. " +
    "The exact id for each entry is given to you in the LOGGED SO FAR TODAY section of your instructions, right next to its name — use that id, not the food name.",
  input_schema: {
    type: "object",
    properties: {
      meal_id: { type: "string", description: "The exact id of the meal entry to delete, copied from the LOGGED SO FAR TODAY list." },
    },
    required: ["meal_id"],
  },
}];

// Available to both coaches — a durable fact that should survive the client
// clearing their chat history (it lives in settings/coachMemory, not the chat).
const REMEMBER_TOOL = {
  name: "remember_fact",
  description:
    "Save one short, durable fact about the client that's worth carrying forward even if they clear this chat history — " +
    "a real preference, an injury or health note, a routine change they've committed to. " +
    "Use sparingly. Never for small talk, one-off requests, or anything already covered in the client profile you were given.",
  input_schema: {
    type: "object",
    properties: {
      fact: { type: "string", description: "One short, self-contained sentence stating the fact (max ~150 chars)." },
    },
    required: ["fact"],
  },
};
const MAX_MEMORY_FACTS = 40; // per coach — oldest drop off if exceeded

async function runRememberTool(uid, coachId, fact) {
  const cleaned = String(fact || "").trim().slice(0, 200);
  if (!cleaned) return "Rejected: empty fact.";
  const ref = db.doc(`users/${uid}/settings/coachMemory`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const arr = Array.isArray(data[coachId]) ? data[coachId] : [];
    const next = arr.concat([cleaned]).slice(-MAX_MEMORY_FACTS);
    tx.set(ref, Object.assign({}, data, { [coachId]: next }), { merge: true });
  });
  return "Remembered.";
}

// Same 3 AM cutoff as the client (js/app.js's dayKey) — must match exactly
// so the client's LOGGED SO FAR TODAY context and the server's own totals
// after log_meal/delete_meal always agree on what "today" means.
const DAY_CUTOFF_HOURS = 3;
function dayKey(iso) {
  const d = new Date(new Date(iso).getTime() - DAY_CUTOFF_HOURS * 60 * 60 * 1000);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// Executes one tool_use block from Maya. Writes under users/{uid}/meals and
// returns a confirmation (with today's totals) or a rejection she can react to.
async function runMayaTool(uid, name, input, targets) {
  if (name === "delete_meal") return runDeleteMealTool(uid, input, targets);
  if (name !== "log_meal") return "Unknown tool: " + name;
  const cal = Math.round(Number(input.calories));
  const pro = Math.round(Number(input.protein));
  if (!cal || cal < 1 || cal > 10000) {
    return "Rejected: calories (" + input.calories + ") is not a plausible number. Ask the client for clarification or re-estimate, then try again.";
  }
  if (isNaN(pro) || pro < 0 || pro > 500) {
    return "Rejected: protein (" + input.protein + ") is not a plausible number. Re-estimate and try again.";
  }
  const entry = {
    loggedAt: new Date().toISOString(),
    description: String(input.description || "Meal").slice(0, 80),
    calories: cal,
    protein: pro,
    source: "maya",
  };
  await db.collection(`users/${uid}/meals`).add(entry);
  const today = dayKey(entry.loggedAt);
  const snap = await db.collection(`users/${uid}/meals`).get();
  let calSoFar = 0, proSoFar = 0;
  snap.forEach((d) => {
    const m = d.data();
    if (dayKey(m.loggedAt) === today) {
      calSoFar += m.calories || 0;
      proSoFar += m.protein || 0;
    }
  });
  const tCal = (targets && targets.calories) || "?";
  const tPro = (targets && targets.protein) || "?";
  return "Logged: " + entry.description + " (" + cal + " kcal, " + pro + "g protein). " +
    "Today's totals are now " + Math.round(calSoFar) + " kcal and " + Math.round(proSoFar) +
    "g protein against targets of " + tCal + " kcal and " + tPro + "g.";
}

async function runDeleteMealTool(uid, input, targets) {
  const id = String(input.meal_id || "").trim();
  if (!id) return "Rejected: no meal_id given — use the exact id from the LOGGED SO FAR TODAY list, not the food name.";
  try {
    const ref = db.doc(`users/${uid}/meals/${id}`);
    const snap = await ref.get();
    if (!snap.exists) return "Rejected: that meal entry no longer exists — it may have already been removed.";
    const removed = snap.data();
    await ref.delete();
    const today = dayKey(removed.loggedAt || new Date().toISOString());
    const all = await db.collection(`users/${uid}/meals`).get();
    let calSoFar = 0, proSoFar = 0;
    all.forEach((d) => {
      const m = d.data();
      if (dayKey(m.loggedAt) === today) {
        calSoFar += m.calories || 0;
        proSoFar += m.protein || 0;
      }
    });
    const tCal = (targets && targets.calories) || "?";
    const tPro = (targets && targets.protein) || "?";
    return "Deleted: " + (removed.description || "that meal") + " (" + (removed.calories || 0) + " kcal, " + (removed.protein || 0) + "g protein). " +
      "Today's totals are now " + Math.round(calSoFar) + " kcal and " + Math.round(proSoFar) +
      "g protein against targets of " + tCal + " kcal and " + tPro + "g.";
  } catch (e) {
    // logged with the exact id the model sent — if this fires again, the
    // Cloud Functions log will show precisely what was wrong with it
    // (malformed id, wrong uid path, permission issue, etc.) instead of the
    // model having to guess and narrate a vague "system error" to the client
    console.error("delete_meal failed for uid=" + uid + " meal_id=" + JSON.stringify(input.meal_id) + ": " + e.message);
    return "Rejected: couldn't delete that meal (" + e.message + "). Tell the client there was a technical issue and to try again in a moment, or delete it manually from the dashboard tracker.";
  }
}

async function callAnthropic(apiKey, body) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    // "internal" is one of only two HttpsError codes where Firebase strips
    // the message before it reaches the client (for security) — replacing it
    // with a bare "INTERNAL" string, exactly what showed up in chat. Using
    // "unavailable" instead means the real Claude API status + error body
    // actually reaches the client the next time something goes wrong here.
    throw new HttpsError("unavailable", "Claude API " + res.status + ": " + t.slice(0, 200));
  }
  return res.json();
}

/* ---------- coachCall: Claude chat + Maya's tool loop ---------- */
exports.coachCall = onCall({ secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = await guard(request);
  const { system, systemMemory, systemDynamic, messages, useTools, targets, coachId } = request.data || {};
  if (typeof system !== "string" || !system || system.length > 8000) {
    throw new HttpsError("invalid-argument", "Missing or oversized system prompt.");
  }
  // Three-tier system prompt, cheapest-to-priciest to keep as fresh input tokens:
  //  1. stable persona/rules/profile — changes almost never, 1-hour cache
  //  2. long-term memory — changes only when remember_fact fires, 1-hour cache
  //     (kept separate from #3 so a meal log doesn't blow this cache too)
  //  3. today's food log so far — genuinely volatile, stays uncached
  // 1h TTL (vs the 5-min default) matters here specifically because this is a
  // low-frequency app — people often go 20+ minutes between messages, which
  // was expiring the cache before it ever got reused.
  const systemBlocks = [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: "1h" } }];
  if (typeof systemMemory === "string" && systemMemory) {
    systemBlocks.push({ type: "text", text: systemMemory, cache_control: { type: "ephemeral", ttl: "1h" } });
  }
  if (typeof systemDynamic === "string" && systemDynamic) {
    systemBlocks.push({ type: "text", text: systemDynamic });
  }
  if (!Array.isArray(messages) || !messages.length) {
    throw new HttpsError("invalid-argument", "messages must be a non-empty array.");
  }
  if (messages.length > 40) {
    throw new HttpsError("invalid-argument", "Too many messages.");
  }
  // Not a functional window — the client already sends a deliberately-sized,
  // cache-friendly window (see windowedHistory() in app.js). This is purely
  // an abuse ceiling; slice(-30) here would just re-introduce the sliding-
  // front problem the client-side logic exists to avoid.
  const history = messages.slice(-40);

  // Cache breakpoint on the conversation tail: without this, the entire
  // history gets rebilled as fresh input tokens on every single turn, which
  // is the biggest cost driver in a growing chat (and includes any photos
  // sitting in there). Marking the last message here writes everything up
  // through it to cache; next turn's call resends this exact prefix plus one
  // new exchange, so all of it reads back at ~10% price instead of full
  // price. This also solves the "old photo rebilled every turn" problem as a
  // side effect — once an image is inside the cached prefix, repeat reads of
  // it are cheap, so stripping images out separately would actively work
  // against this (any edit to an older message breaks the cache prefix
  // right at that point), for a smaller savings than just letting it cache.
  if (history.length) {
    const lastMsg = history[history.length - 1];
    const blocks = Array.isArray(lastMsg.content)
      ? lastMsg.content.slice()
      : [{ type: "text", text: String(lastMsg.content == null ? "" : lastMsg.content) }];
    if (blocks.length) {
      const lastBlock = Object.assign({}, blocks[blocks.length - 1], { cache_control: { type: "ephemeral", ttl: "1h" } });
      blocks[blocks.length - 1] = lastBlock;
      history[history.length - 1] = Object.assign({}, lastMsg, { content: blocks });
    }
  }

  const tools = [];
  if (useTools) {
    tools.push(REMEMBER_TOOL);
    if (coachId === "nutrition") tools.push(...MAYA_TOOLS);
  }

  // Replace images in older turns with a text placeholder — used for the
  // one retry when a turn comes back with no text at all. The most common
  // cause is a photo-heavy history hitting the model's context/image limits
  // (stop_reason "model_context_window_exceeded" returns empty content).
  function stripOldImages(msgs, keepLast = 4) {
    return msgs.map((m, i) => {
      if (i >= msgs.length - keepLast || !Array.isArray(m.content)) return m;
      const content = m.content.map((b) => (b.type === "image" ? { type: "text", text: "[earlier photo]" } : b));
      return Object.assign({}, m, { content });
    });
  }

  let mealLogged = null; // summary string when log_meal fired, else null
  let mealDeleted = null; // summary string when delete_meal fired, else null
  let remembered = null;
  let lastText = "";
  let retriedEmpty = false;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const body = {
      model: CLAUDE_MODEL,
      max_tokens: 1200,
      system: systemBlocks,
      messages: history,
    };
    if (tools.length) body.tools = tools;
    const data = await callAnthropic(ANTHROPIC_API_KEY.value(), body);
    const blocks = data.content || [];
    lastText = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (data.stop_reason !== "tool_use") {
      if (!lastText && !retriedEmpty) {
        // one retry with a slimmer, image-free history before giving up
        retriedEmpty = true;
        console.warn("coachCall empty response, stop_reason=" + data.stop_reason + " — retrying with trimmed history");
        history = stripOldImages(history).slice(-24);
        continue;
      }
      return { text: lastText || "", mealLogged, mealDeleted, remembered };
    }
    // execute every tool call in this turn, then feed the results back
    history.push({ role: "assistant", content: blocks });
    const results = [];
    for (const b of blocks) {
      if (b.type !== "tool_use") continue;
      let out;
      try {
        if (b.name === "remember_fact") {
          const fact = String((b.input || {}).fact || "").trim().slice(0, 200);
          out = await runRememberTool(uid, coachId === "gym" ? "gym" : "nutrition", fact);
          if (fact) remembered = fact;
        } else {
          out = await runMayaTool(uid, b.name, b.input || {}, targets);
          if (String(out).startsWith("Logged:")) {
            // e.g. "Panko chicken (410 kcal, 21g protein)" — shown client-side
            // as a visible "action taken" chip so a claimed log is provable
            mealLogged = String(out).split(". ")[0].replace("Logged: ", "");
          } else if (String(out).startsWith("Deleted:")) {
            mealDeleted = String(out).split(". ")[0].replace("Deleted: ", "");
          }
        }
      } catch (e) {
        out = "Tool failed: " + e.message;
      }
      results.push({ type: "tool_result", tool_use_id: b.id, content: out });
    }
    history.push({ role: "user", content: results });
  }
  // hit the round cap — the tool calls still happened, so tell the user what changed
  return { text: lastText || "Done — check Today's fuel on the Home tab for what I logged.", mealLogged, mealDeleted, remembered };
});

/* ---------- voiceCall: Deepgram STT (nova-3) + ElevenLabs/Aura-2 TTS ---------- */
exports.voiceCall = onCall({ secrets: [DEEPGRAM_API_KEY, ELEVENLABS_API_KEY] }, async (request) => {
  await guard(request);
  const { op } = request.data || {};

  if (op === "stt") {
    const { audioBase64, mime } = request.data;
    if (typeof audioBase64 !== "string" || !audioBase64 || audioBase64.length > 12_000_000) {
      throw new HttpsError("invalid-argument", "audioBase64 missing or too large.");
    }
    const buf = Buffer.from(audioBase64, "base64");
    const res = await fetch("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true", {
      method: "POST",
      headers: {
        Authorization: "Token " + DEEPGRAM_API_KEY.value(),
        "Content-Type": mime || "application/octet-stream",
      },
      body: buf,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new HttpsError("unavailable", "Deepgram STT " + res.status + ": " + t.slice(0, 160));
    }
    const data = await res.json();
    const alt = data.results && data.results.channels && data.results.channels[0] &&
      data.results.channels[0].alternatives && data.results.channels[0].alternatives[0];
    return { transcript: alt && alt.transcript ? alt.transcript : "" };
  }

  if (op === "tts") {
    const { text, coachId, voiceId } = request.data;
    const gender = request.data.gender === "male" ? "male" : "female";
    if (typeof text !== "string" || !text.trim() || text.length > 1800) {
      throw new HttpsError("invalid-argument", "text missing or too long (max 1800 chars).");
    }
    const elevenKey = ELEVENLABS_API_KEY.value();
    if (elevenKey) {
      const vid = voiceId || pickVoice(ELEVEN_VOICES, coachId, gender);
      const res = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + vid, {
        method: "POST",
        headers: { "xi-api-key": elevenKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new HttpsError("unavailable", "ElevenLabs TTS " + res.status + ": " + t.slice(0, 160));
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return { audioBase64: buf.toString("base64"), mime: "audio/mpeg" };
    }
    // Deepgram Aura-2 fallback
    const voice = pickVoice(AURA_VOICES, coachId, gender);
    const res = await fetch("https://api.deepgram.com/v1/speak?model=" + voice, {
      method: "POST",
      headers: {
        Authorization: "Token " + DEEPGRAM_API_KEY.value(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new HttpsError("unavailable", "Deepgram TTS " + res.status + ": " + t.slice(0, 160));
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { audioBase64: buf.toString("base64"), mime: "audio/mpeg" };
  }

  throw new HttpsError("invalid-argument", "Unknown op: " + op);
});

/* ---------- avatarCall: Grok image generation ---------- */
/* ---------- push notifications: send on new thread message (covers nudges too,
   since a nudge is just sendThreadMessage() with a canned string) ---------- */

async function sendPushToUser(uid, { title, body, tag, url, fromUid }) {
  const ref = db.doc(`users/${uid}/settings/push`);
  const snap = await ref.get();
  const raw = (snap.exists && Array.isArray(snap.data().tokens)) ? snap.data().tokens : [];
  if (!raw.length) return;
  // Tokens are {token, standalone} objects (plain strings are legacy/unknown).
  // If the account has the PWA installed AND a browser session, both hold FCM
  // tokens and the phone shows every notification twice — so when at least
  // one standalone (installed PWA) token exists, send ONLY to those.
  const entries = raw.map((t) => (typeof t === "string" ? { token: t, standalone: false } : t)).filter((t) => t && t.token);
  const pwa = entries.filter((t) => t.standalone);
  const targets = (pwa.length ? pwa : entries).map((t) => t.token);
  if (!targets.length) return;
  let res;
  try {
    res = await admin.messaging().sendEachForMulticast({
      notification: { title, body },
      data: { url: url || "./", tag: tag || "gutcheck", fromUid: fromUid || "" },
      tokens: targets,
    });
  } catch (e) {
    console.error("Push send failed:", e);
    return;
  }
  // prune tokens Firebase says are dead (uninstalled app, expired, etc.)
  const dead = [];
  res.responses.forEach((r, i) => {
    const code = r.error && r.error.code;
    if (!r.success && (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token")) {
      dead.push(targets[i]);
    }
  });
  if (dead.length) {
    await ref.set({ tokens: entries.filter((t) => !dead.includes(t.token)) }, { merge: true });
  }
}

exports.onThreadMessage = onDocumentCreated("threads/{pair}/messages/{messageId}", async (event) => {
  const msg = event.data.data();
  const pair = event.params.pair;
  const members = pair.split("_");
  const toUid = members.find((m) => m !== msg.from);
  if (!toUid || !msg.from) return;

  let senderName = "Someone";
  try {
    const threadSnap = await db.doc(`threads/${pair}`).get();
    const names = (threadSnap.exists && threadSnap.data().names) || {};
    senderName = names[msg.from] || senderName;
  } catch (e) { /* fall back to generic name */ }

  const text = String(msg.text || "");
  const isNudge = text.startsWith("💪 Nudge");
  await sendPushToUser(toUid, {
    title: isNudge ? "💪 Nudge from " + senderName : senderName,
    body: text.slice(0, 140),
    tag: "thread-" + pair,
    url: "./",
    fromUid: msg.from,
  });
});

exports.avatarCall = onCall({ secrets: [XAI_API_KEY] }, async (request) => {
  await guard(request);
  const { prompt } = request.data || {};
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 1000) {
    throw new HttpsError("invalid-argument", "prompt missing or too long (max 1000 chars).");
  }
  const res = await fetch("https://api.x.ai/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer " + XAI_API_KEY.value() },
    body: JSON.stringify({ model: "grok-imagine-image", prompt, n: 1, response_format: "b64_json" }), // grok-2-image was deprecated by xAI on 2026-02-28
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new HttpsError("unavailable", "xAI " + res.status + ": " + t.slice(0, 160));
  }
  const data = await res.json();
  const b64 = data.data && data.data[0] && data.data[0].b64_json;
  if (!b64) throw new HttpsError("unavailable", "xAI returned no image data");
  return { imageBase64: b64 };
});
