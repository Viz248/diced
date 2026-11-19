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
const MODEL = 'gemini-3.5-flash-lite';
const MAX_TOKENS = 800;
const REVIEW_MAX_TOKENS = 700;

const SYSTEM_PROMPT = `You estimate calories and macros for a food a user is about to log in a personal diet-tracking app. You are not a doctor and this is not medical advice — you are giving a practical, reasonable estimate for someone tracking their own food.

Respond with ONLY a single JSON object, no markdown fences, no prose before or after it — this applies even when you use search to look something up; cite nothing, just fold what you found into the numbers. Two possible shapes:

1) If the portion/preparation is genuinely ambiguous enough that the calorie estimate would swing by more than roughly 30% depending on the answer (e.g. "a bowl of rice" could be 150 or 600 kcal; "a burger" could be a slider or a quarter-pounder with everything), and you have not already asked a question in this conversation, ask exactly ONE short, concrete clarifying question:
{"status":"question","question":"Small, medium, or large bowl?"}

2) Otherwise, give your best estimate directly — do not ask about things that barely move the number (e.g. don't ask about ripeness of a banana, or whether toast has a pat of butter or a scrape). Default to an average/typical serving when no portion is given:
{"status":"estimate","name":"Orange","kcal":62,"protein":1,"carbs":15,"fat":0,"servingLabel":"1 medium (~130g)"}

Fields for the estimate shape: name (short, cleaned-up food name), kcal (integer), protein/carbs/fat (grams, integers, reasonable macro split that roughly accounts for the calories), servingLabel (what portion this estimate assumes, short).

You get at most one question total across the whole exchange — if you already asked one and got an answer (or the user's answers list is non-empty), you MUST return an estimate this time, doing your best with whatever you now know.

Vocabulary note for this user: when they say "chenna", they mean a chickpea/chana curry (scooped out, no gravy) — not paneer or cottage cheese, despite that being the more common meaning of the word elsewhere.

When this user mentions eggs or egg whites with no size given, assume medium/standard-sized (not large or jumbo) — that is what they have actually been eating and tracking.

This user is in India and will sometimes describe packaged snacks by their price (e.g. "a 20rs packet of Kurkure", "a 10 rupee pack"). Do NOT ask a clarifying question about this — the whole point of mentioning the price is so you can work out the size without the user having to go check the packet themselves. Use this rough reference for typical small Indian snack-pack sizes (chips/Kurkure/similar extruded or fried snacks) by price, and estimate directly from it:
₹5 ≈ 14g, ₹10 ≈ 19g, ₹20 ≈ 42g, ₹30 ≈ 57g, ₹50 ≈ 85g (interpolate for prices in between). Treat this the same as any other "typical serving" assumption elsewhere in this prompt — a reasonable default, not a fact you need to double check with the user.

IMPORTANT — identifiable branded/packaged products (Kurkure, Lay's, a named cookie/soda/cereal brand, etc.) are NOT the same as a generic home-cooked description like "a bowl of rice". These have a real, fixed nutrition label. You have a search tool — use it to look up the actual current published nutrition-facts panel for that specific product per 100g when you're not fully certain of the exact numbers from memory (not a generic guess for "a fried corn snack"), then scale it to the pack weight. For Kurkure Corn Puffs / Masala Munch specifically, use this reference label (per 100g) unless search turns up something more specific/current: ~500 kcal, 6g protein, 58g carbs, 26g fat. For any other named branded product, search for its real label the same way rather than guessing from general knowledge alone.`;

const REVIEW_SYSTEM_PROMPT = `You are a terse, practical coach reviewing one week of a real person's food log in a personal diet-tracking app. You are not a doctor and this is not medical advice.

You will be given facts that are already correctly computed — don't recompute or contradict them — plus the actual foods logged each day. Your job is the part a spreadsheet can't do: spot real patterns in WHAT they ate and give specific, concrete advice, not generic "eat less, move more" filler.

Respond with ONLY a single JSON object, no markdown fences, no prose outside it:
{"status":"review","topLine":"one short honest sentence verdict on the week","cutDown":["..."],"eatMore":["..."],"swaps":["..."]}

- topLine: one sentence summarizing the week, in plain terms.
- cutDown (0-3 items): specific foods or habits that are the actual repeat offenders in the log — name them (e.g. "the 9pm chips, 4 nights this week"), not vague categories like "snacking". Omit entirely (empty array) if nothing stands out.
- eatMore (0-2 items): specific, concrete gaps — what they're actually short on and why it matters for their goal (e.g. protein only hit on days they ate eggs). Omit if nothing stands out.
- swaps (0-2 items): a specific food-for-food substitution that keeps what they clearly like (crunchy, sweet, filling, etc.) but costs less — never generic advice like "eat a salad instead". Omit if nothing obvious.

Days marked as a planned cheat day are expected to run high on purpose — never flag those as a problem. Only call out real, unplanned patterns, and only ones actually visible in the logged foods below. If the week was genuinely solid, say so plainly in topLine and leave the arrays empty — do not invent nitpicks just to fill them. Keep every string to one sentence, specific, and grounded in the actual food names given.`;

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

async function handleWeeklyReview(body, env, origin) {
  const week = body.week;
  if (!week || !Array.isArray(week.days)) return json({ error: 'bad_request' }, 400, origin);

  const lines = [];
  lines.push(`Week: ${String(week.startDate || '').slice(0, 20)} to ${String(week.endDate || '').slice(0, 20)}`);
  lines.push(`Protein floor: ${week.proteinMinG || '?'}g/day${week.fatMaxG ? `, fat limit: ${week.fatMaxG}g/day` : ''}`);
  if (week.weightChangeKg != null) {
    lines.push(`Weight change: ${week.weightChangeKg}kg (pace target: -${week.weeklyPaceTargetKg}kg/week)`);
  }
  if (Array.isArray(week.missedDays) && week.missedDays.length) {
    lines.push(`Not logged at all: ${week.missedDays.slice(0, 7).map(d => String(d).slice(0, 40)).join(', ')}`);
  }
  if (Array.isArray(week.deterministicNotes) && week.deterministicNotes.length) {
    lines.push('');
    lines.push('Already-computed facts (trust these, do not recompute):');
    week.deterministicNotes.slice(0, 10).forEach(n => lines.push(`- ${String(n).slice(0, 300)}`));
  }
  lines.push('');
  lines.push('Day-by-day log:');
  week.days.slice(0, 7).forEach(d => {
    const foods = Array.isArray(d.foods) ? d.foods.slice(0, 25) : [];
    if (!foods.length) return;
    lines.push(`${String(d.weekday || '').slice(0, 10)} ${String(d.date || '').slice(0, 20)}${d.isCheatDay ? ' (planned cheat day)' : ''}: ${d.loggedKcal}kcal (target ${d.targetKcal}${d.over > 0 ? `, +${d.over} over` : ''}), protein ${d.protein}g, fat ${d.fat}g`);
    foods.forEach(f => lines.push(`  - ${String(f.meal || '').slice(0, 20)}: ${String(f.name || '').slice(0, 100)} (${Number(f.kcal) || 0} kcal)`));
  });

  const userMsg = lines.join('\n').slice(0, 8000);

  let geminiRes;
  try {
    geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: REVIEW_SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: userMsg }] }],
          generationConfig: { maxOutputTokens: REVIEW_MAX_TOKENS, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(20000),
      }
    );
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return json({ error: 'upstream_timeout' }, 504, origin);
    }
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
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return json({ error: 'unparseable_response' }, 502, origin);
  }

  const clampList = (arr, max) =>
    Array.isArray(arr) ? arr.slice(0, max).map(x => String(x).slice(0, 300)).filter(Boolean) : [];

  return json({
    status: 'review',
    topLine: String(parsed.topLine || '').slice(0, 300),
    cutDown: clampList(parsed.cutDown, 3),
    eatMore: clampList(parsed.eatMore, 2),
    swaps: clampList(parsed.swaps, 2),
  }, 200, origin);
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

    if (body.type === 'weekly_review') {
      return handleWeeklyReview(body, env, origin);
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
            tools: [{ google_search: {} }],
            generationConfig: { maxOutputTokens: MAX_TOKENS },
          }),
          signal: AbortSignal.timeout(15000),
        }
      );
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        return json({ error: 'upstream_timeout' }, 504, origin);
      }
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
