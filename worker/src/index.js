const ALLOWED_ORIGINS = new Set([
  "https://smitharajappa.github.io",
  "http://localhost:8745",
  "http://localhost:8744",
  "http://localhost:8743",
]);

const MODEL = "gemini-3.6-flash";
const MAX_DESC_CHARS = 1200;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // base64-decoded size cap

// Best-effort per-isolate throttle. Workers isolates are reused for a
// while but not shared globally or durable across restarts, so this is
// a soft speed bump against a single burst, not a real rate limiter.
// The Gemini free-tier key itself already hard-caps requests/day at
// zero cost, so the actual financial risk is already bounded to $0.
const seenAt = new Map();
function tooSoon(ip) {
  const now = Date.now();
  const last = seenAt.get(ip) || [];
  const recent = last.filter((t) => now - t < 60 * 60 * 1000);
  recent.push(now);
  seenAt.set(ip, recent);
  return recent.length > 20; // 20 requests/hour/ip, soft cap
}

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
    "Content-Type": "application/json",
  };
}

const PROMPT_HEADER = `You are a calm, encouraging home-repair triage assistant for someone with little to no repair experience or tools.
Decide: can an inexperienced person safely fix this themselves with basic tools, or does it need a professional (gas, electrical panel work, structural, roofing, refrigerant, or anything with real injury/code risk always needs a pro)?
Use plain, non-condescending language. Name the actual part once in parentheses if it has a technical name, but don't require the reader to already know it.
Reply with ONLY a JSON object, no markdown fence, matching exactly this shape:
{"itemName": "short 2-4 word name of the broken thing", "verdict": "diy" | "borderline" | "pro", "diagnosis": "2-3 plain-English sentences on what is likely wrong and why", "estTimeMinutes": number, "estCostUSD": number or [minNumber,maxNumber], "tools": ["short common-name tool or material", ...], "steps": ["short imperative step", ...], "safetyNote": "one sentence warning, or null if none apply", "proScript": "one short sentence the person can say when calling a pro, or null if verdict is diy", "proCostRange": "typical price range as a string like \\"$120-250\\", or null if verdict is diy"}
If verdict is "pro", steps should describe what the professional will do (not DIY instructions), tools should be empty or minimal, and proScript/proCostRange must be filled in.
If verdict is "diy" or "borderline", give 3-6 concrete steps and a real tools list, and leave proScript/proCostRange null unless useful as a fallback.
Even if the description is vague, ambiguous, or oddly worded, make your best reasonable guess and still return the JSON object — never reply with a clarifying question or plain text, and never refuse; note any uncertainty inside the diagnosis field itself.`;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers });
    }
    if (!ALLOWED_ORIGINS.has(origin)) {
      return new Response(JSON.stringify({ error: "origin_not_allowed" }), { status: 403, headers });
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (tooSoon(ip)) {
      return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json_body" }), { status: 400, headers });
    }

    const description = String(body.description || "").slice(0, MAX_DESC_CHARS);
    const image = body.image && typeof body.image === "object" ? body.image : null;

    if (!description && !image) {
      return new Response(JSON.stringify({ error: "missing_input" }), { status: 400, headers });
    }
    if (image) {
      if (typeof image.data !== "string" || typeof image.mimeType !== "string") {
        return new Response(JSON.stringify({ error: "invalid_image" }), { status: 400, headers });
      }
      if (image.data.length > MAX_IMAGE_BYTES * 1.4) {
        return new Response(JSON.stringify({ error: "image_too_large" }), { status: 400, headers });
      }
    }

    const parts = [
      { text: PROMPT_HEADER + "\n\nDescription from the person: " + (description || "(see photo)") },
    ];
    if (image) parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });

    const callGemini = () =>
      fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: {
              temperature: 0.4,
              maxOutputTokens: 2000,
              responseMimeType: "application/json",
            },
          }),
        }
      );

    // One attempt: call Gemini, then try to read a usable JSON diagnosis out
    // of it. Returns {ok:true, parsed} or {ok:false, error, detail}.
    async function attempt() {
      const geminiRes = await callGemini();
      if (geminiRes.status === 429) {
        return { ok: false, error: "quota_exceeded" };
      }
      if (geminiRes.status === 503) {
        return { ok: false, error: "upstream_error", detail: "503 from model" };
      }
      if (!geminiRes.ok) {
        const errText = await geminiRes.text().catch(() => "");
        return { ok: false, error: "upstream_error", detail: errText.slice(0, 300) };
      }
      const data = await geminiRes.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) return { ok: false, error: "empty_completion" };
      try {
        return { ok: true, parsed: JSON.parse(text) };
      } catch {
        return { ok: false, error: "invalid_json", raw: text.slice(0, 500) };
      }
    }

    // These are one-off slips (model overloaded, or wrote a stray sentence
    // around the JSON) — a single retry after a short delay clears most of
    // them without the viewer ever noticing.
    let result = await attempt();
    if (!result.ok && (result.error === "upstream_error" || result.error === "invalid_json" || result.error === "empty_completion")) {
      await new Promise((r) => setTimeout(r, 1200));
      result = await attempt();
    }

    if (!result.ok) {
      const status = result.error === "quota_exceeded" ? 429 : 502;
      return new Response(JSON.stringify(result), { status, headers });
    }

    return new Response(JSON.stringify(result.parsed), {
      headers: { ...headers, "Content-Type": "application/json" },
    });
  },
};
