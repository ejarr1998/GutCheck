/* ============================================================
   GutCheck Cloud Functions — server-side AI proxy
   All four API keys live here as secrets; browsers never see them.
   Every function: auth verification → per-user
   daily rate cap → uid-scoped Firestore writes (Admin SDK).
   ============================================================ */
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const DEEPGRAM_API_KEY = defineSecret("DEEPGRAM_API_KEY");
const ELEVENLABS_API_KEY = defineSecret("ELEVENLABS_API_KEY");
const XAI_API_KEY = defineSecret("XAI_API_KEY");

const DAILY_CALL_CAP = 150; // per user, across all functions, UTC day
const CLAUDE_MODEL = "claude-sonnet-4-5";
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
    "Only for actual food or drink — never log non-food items, and never log a 0-calorie entry for a real meal; re-estimate or ask instead.",
  input_schema: {
    type: "object",
    properties: {
      description: { type: "string", description: "Short 3-6 word name for the meal" },
      calories: { type: "number", description: "Estimated total calories (integer)" },
      protein: { type: "number", description: "Estimated grams of protein (integer)" },
    },
    required: ["description", "calories", "protein"],
  },
}];

function dayKey(iso) {
  const d = new Date(iso);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// Executes one tool_use block from Maya. Writes under users/{uid}/meals and
// returns a confirmation (with today's totals) or a rejection she can react to.
async function runMayaTool(uid, name, input, targets) {
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
    throw new HttpsError("internal", "Claude API " + res.status + ": " + t.slice(0, 200));
  }
  return res.json();
}

/* ---------- coachCall: Claude chat + Maya's tool loop ---------- */
exports.coachCall = onCall({ secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = await guard(request);
  const { system, systemDynamic, messages, useTools, targets } = request.data || {};
  if (typeof system !== "string" || !system || system.length > 8000) {
    throw new HttpsError("invalid-argument", "Missing or oversized system prompt.");
  }
  // Stable persona/rules/profile block is cached (ephemeral); the volatile
  // "logged so far today" line rides as a second, uncached block so logging a
  // meal doesn't blow the cache on the very next round.
  const systemBlocks = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  if (typeof systemDynamic === "string" && systemDynamic) {
    systemBlocks.push({ type: "text", text: systemDynamic });
  }
  if (!Array.isArray(messages) || !messages.length) {
    throw new HttpsError("invalid-argument", "messages must be a non-empty array.");
  }
  if (messages.length > 40) {
    throw new HttpsError("invalid-argument", "Too many messages.");
  }
  const history = messages.slice(-30);

  let mealLogged = false;
  let lastText = "";
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const body = {
      model: CLAUDE_MODEL,
      max_tokens: 1200,
      system: systemBlocks,
      messages: history,
    };
    if (useTools) body.tools = MAYA_TOOLS;
    const data = await callAnthropic(ANTHROPIC_API_KEY.value(), body);
    const blocks = data.content || [];
    lastText = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (data.stop_reason !== "tool_use") {
      return { text: lastText || "", mealLogged };
    }
    // execute every tool call in this turn, then feed the results back
    history.push({ role: "assistant", content: blocks });
    const results = [];
    for (const b of blocks) {
      if (b.type !== "tool_use") continue;
      let out;
      try {
        out = await runMayaTool(uid, b.name, b.input || {}, targets);
        if (String(out).startsWith("Logged:")) mealLogged = true;
      } catch (e) {
        out = "Tool failed: " + e.message;
      }
      results.push({ type: "tool_result", tool_use_id: b.id, content: out });
    }
    history.push({ role: "user", content: results });
  }
  // hit the round cap — the tool calls still happened, so tell the user what changed
  return { text: lastText || "Done — check Today's fuel on the Home tab for what I logged.", mealLogged };
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
      throw new HttpsError("internal", "Deepgram STT " + res.status + ": " + t.slice(0, 160));
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
        throw new HttpsError("internal", "ElevenLabs TTS " + res.status + ": " + t.slice(0, 160));
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
      throw new HttpsError("internal", "Deepgram TTS " + res.status + ": " + t.slice(0, 160));
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { audioBase64: buf.toString("base64"), mime: "audio/mpeg" };
  }

  throw new HttpsError("invalid-argument", "Unknown op: " + op);
});

/* ---------- avatarCall: Grok image generation ---------- */
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
    throw new HttpsError("internal", "xAI " + res.status + ": " + t.slice(0, 160));
  }
  const data = await res.json();
  const b64 = data.data && data.data[0] && data.data[0].b64_json;
  if (!b64) throw new HttpsError("internal", "xAI returned no image data");
  return { imageBase64: b64 };
});
