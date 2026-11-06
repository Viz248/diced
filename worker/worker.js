/**
 * diced — AI food estimate proxy
 *
 * Runs on Cloudflare Workers (free tier). Its only job is to hold the
 * Gemini API key server-side so it never appears in the public diced
 * repo/app, and to turn "orange" (or "orange, answers: [...]") into a
 * strict-JSON calorie/macro estimate, asking at most one clarifying
 * question when the portion is genuinely ambiguous.
 *
 * Fully free to run: Cloudflare Workers' free tier plus Google AI Studio's
 * free Gemini API tier (no credit card, no billing) comfortably cover
 * personal use — see worker/README.md.
 *
 * Deploy: paste this whole file into a new Worker in the Cloudflare
 * dashboard (Workers & Pages -> Create -> paste -> Deploy). Then set two
 * encrypted variables under that Worker's Settings -> Variables:
 *   GEMINI_API_KEY  - your free key from aistudio.google.com
 *   APP_SECRET      - any random string you make up (also goes into
 *                     the diced app's settings so random internet
 *                     traffic can't use your key)
 * Nothing else to configure — CORS is locked to the diced GitHub Pages
 * origin below.
 */

const ALLOWED_ORIGIN = 'https://viz248.github.io';
const MODEL = 'gemini-flash-latest';
const MAX_TOKENS = 400;

const SYSTEM_PROMPT = `You estimate calories and macros for a food a user is about to log in a personal diet-tracking app. You are not a doctor and this is not medical advice — you are giving a practical, reasonable estimate for someone tracking their own food.

Respond with ONLY a single JSON object, no markdown fences, no prose before or after it. Two possible shapes:

1) If the portion/preparation is genuinely ambiguous enough that the calorie estimate would swing by more than roughly 30% depending on the answer (e.g. "a bowl of rice" could be 150 or 600 kcal; "a burger" could be a slider or a quarter-pounder with everything), and you have not already asked a question in this conversation, ask exactly ONE short, concrete clarifying question:
{"status":"question","question":"Small, medium, or large bowl?"}

2) Otherwise, give your best estimate directly — do not ask about things that barely move the number (e.g. don't ask about ripeness of a banana, or whether toast has a pat of butter or a scrape). Default to an average/typical serving when no portion is given:
{"status":"estimate","name":"Orange","kcal":62,"protein":1,"carbs":15,"fat":0,"servingLabel":"1 medium (~130g)"}

Fields for the estimate shape: name (short, cleaned-up food name), kcal (integer), protein/carbs/fat (grams, integers, reasonable macro split that roughly accounts for the calories), servingLabel (what portion this estimate assumes, short).

You get at most one question total across the whole exchange — if you already asked one and got an answer (or the user's answers list is non-empty), you MUST return an estimate this time, doing your best with whatever you now know.`;

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Secret',
    'Access-Control-Max-Age': '86400',
  };
  if (origin === ALLOWED_ORIGIN) headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
  return headers;
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405, origin);
    }
    if (origin !== ALLOWED_ORIGIN) {
      return json({ error: 'origin_not_allowed' }, 403, origin);
    }
    if (!env.APP_SECRET || request.headers.get('X-App-Secret') !== env.APP_SECRET) {
      return json({ error: 'unauthorized' }, 401, origin);
    }
    if (!env.GEMINI_API_KEY) {
      return json({ error: 'server_not_configured' }, 500, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: 'bad_request' }, 400, origin);
    }

    const description = String(body.description || '').trim().slice(0, 300);
    if (!description) return json({ error: 'bad_request' }, 400, origin);

    const answers = Array.isArray(body.answers) ? body.answers.slice(0, 3) : [];

    // build the conversation: user's food, then any question/answer rounds so far
    let userMsg = `Food: ${description}`;
    answers.forEach(a => {
      userMsg += `\nQ: ${String(a.question || '').slice(0, 200)}\nA: ${String(a.answer || '').slice(0, 200)}`;
    });
    if (answers.length > 0) {
      userMsg += '\n\n(You already asked a question above — you must return an estimate now, not another question.)';
    }

    let geminiRes;
    try {
      geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts: [{ text: userMsg }] }],
            generationConfig: { maxOutputTokens: MAX_TOKENS, responseMimeType: 'application/json' },
          }),
        }
      );
    } catch (e) {
      return json({ error: 'upstream_unreachable' }, 502, origin);
    }

    if (!geminiRes.ok) {
      const status = geminiRes.status === 429 ? 429 : 502;
      return json({ error: 'upstream_error', status: geminiRes.status }, status, origin);
    }

    const data = await geminiRes.json();
    const text = ((data.candidates || [])[0]?.content?.parts || []).map(p => p.text || '').join('').trim();

    let parsed;
    try {
      // model sometimes wraps in fences despite instructions — strip them defensively
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return json({ error: 'unparseable_response' }, 502, origin);
    }

    if (parsed.status === 'question' && answers.length === 0 && typeof parsed.question === 'string') {
      return json({ status: 'question', question: parsed.question }, 200, origin);
    }
    if (parsed.status === 'estimate' &&
        typeof parsed.name === 'string' &&
        Number.isFinite(parsed.kcal)) {
      return json({
        status: 'estimate',
        name: parsed.name,
        kcal: Math.round(parsed.kcal),
        protein: Math.round(parsed.protein || 0),
        carbs: Math.round(parsed.carbs || 0),
        fat: Math.round(parsed.fat || 0),
        servingLabel: String(parsed.servingLabel || ''),
      }, 200, origin);
    }

    return json({ error: 'unparseable_response' }, 502, origin);
  },
};
