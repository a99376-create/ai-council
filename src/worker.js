// מועצת ה-AI — Cloudflare Worker.
// The page (public/index.html) runs the discussion itself, one call per model per round, so every answer appears the moment it is ready.
// This worker only: checks the password, keeps the API keys (Worker secrets — never sent to the browser), and asks ONE model per request.
//   POST /api/status  {}                                        → which models have a key, and their model names
//   POST /api/ask     {model, task, round, rounds, history[]}   → {text} from that model
//   header x-council-password = the COUNCIL_PASSWORD secret (no password set → everything is refused)

const SYSTEM = 'אתה חבר במועצת AI שדנה בגלוי בשאלה של המשתמש, יחד עם שני מודלים אחרים. ענה בעברית, בצורה ממוקדת ומעשית. ' +
  'בסבב הראשון הצע תשובה או תוכנית משלך. בסבבים הבאים קרא את מה שכתבו האחרים, ציין במפורש במה אתה מסכים ובמה לא ולמה, ושפר. ' +
  'אל תעמיד פנים שביצעת פעולות שלא ביצעת, ואל תמציא עובדות; אם אינך בטוח — אמור זאת.';
const NAMES = { openai: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' };
const MAX_TOKENS = 1200, MAX_TASK = 12000, MAX_HIST_EACH = 4000;

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

async function okPassword(req, env) {
  const want = String(env.COUNCIL_PASSWORD || ''); if (!want) return false;
  const got = String(req.headers.get('x-council-password') || '');
  const enc = new TextEncoder(), [a, b] = await Promise.all([got, want].map(s => crypto.subtle.digest('SHA-256', enc.encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b); let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]; return d === 0; // same length, constant time
}

// a small brake against someone hammering the page: per IP, per minute (kept in memory of this worker instance — enough for a private page)
const HITS = new Map();
function tooMany(ip) { const m = Math.floor(Date.now() / 60000), k = ip + '|' + m, n = (HITS.get(k) || 0) + 1; HITS.set(k, n);
  if (HITS.size > 5000) for (const key of HITS.keys()) if (!key.endsWith('|' + m)) HITS.delete(key); return n > 40; }

function modelOf(env, m) { return m === 'openai' ? (env.OPENAI_MODEL || 'gpt-5.6-terra') : m === 'claude' ? (env.ANTHROPIC_MODEL || 'claude-sonnet-5-5') : (env.GEMINI_MODEL || 'gemini-3.8-flash'); }
function keyOf(env, m) { const k = m === 'openai' ? env.OPENAI_API_KEY : m === 'claude' ? env.ANTHROPIC_API_KEY : env.GEMINI_API_KEY; return String(k || '').replace(/[\s"'`]+/g, ''); } // a pasted key may carry spaces, a line break or quotes

function promptOf(b) {
  const task = String(b.task || '').slice(0, MAX_TASK), round = Math.max(1, Math.min(4, +b.round || 1)), rounds = Math.max(1, Math.min(4, +b.rounds || 3));
  const hist = (Array.isArray(b.history) ? b.history : []).filter(h => h && h.text).slice(-12)
    .map(h => `— ${NAMES[h.model] || h.model} (סבב ${+h.round || '?'}):\n${String(h.text).slice(0, MAX_HIST_EACH)}`).join('\n\n');
  if (b.summary) return `שאלת המשתמש:\n${task}\n\nזה הדיון המלא של המועצה:\n\n${hist}\n\nכתוב עכשיו סיכום קצר וברור למשתמש: על מה הסכימו, מה נשאר במחלוקת, ומה ההמלצה הסופית. אל תוסיף דעות חדשות שלא עלו בדיון.`;
  if (round === 1) return `שאלת המשתמש:\n${task}\n\nזה הסבב הראשון מתוך ${rounds}. הצע את התשובה או התוכנית שלך.`;
  return `שאלת המשתמש:\n${task}\n\nזה סבב ${round} מתוך ${rounds}. אלה הדברים שנאמרו עד עכשיו:\n\n${hist}\n\nהתייחס לדברי האחרים: במה אתה מסכים, במה לא ולמה. אחר כך כתוב את הגרסה המשופרת שלך.${round === rounds ? ' זה הסבב האחרון — סיים בהמלצה ברורה.' : ''}`;
}

// a busy model (429/5xx) is asked again after a short wait; Gemini then falls back to a lighter model (GEMINI_FALLBACK)
async function call(env, m, prompt) {
  let res; for (const wait of [0, 2500, 6000]) { if (wait) await new Promise(r => setTimeout(r, wait)); res = await call1(env, m, prompt, null); if (!res.busy) return res; }
  if (m === 'gemini') { const fb = env.GEMINI_FALLBACK || 'gemini-3.5-flash'; if (fb !== modelOf(env, m)) { const r2 = await call1(env, m, prompt, fb); if (!r2.busy) return r2; res = r2; } }
  return { status: 'error', text: NAMES[m] + ' לא ענה גם אחרי כמה ניסיונות. ההודעה האחרונה: ' + res.text };
}
async function call1(env, m, prompt, modelOverride) {
  const key = keyOf(env, m); if (!key) return { status: 'missing', text: 'אין מפתח API ל-' + NAMES[m] + ' — המודל הזה לא משתתף.' };
  const model = modelOverride || modelOf(env, m); let r, j; const busy = st => st === 429 || st >= 500;
  try {
    if (m === 'openai') {
      r = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
        body: JSON.stringify({ model, instructions: SYSTEM, input: prompt, max_output_tokens: MAX_TOKENS * 3 }) });
      j = await r.json().catch(() => ({}));
      if (!r.ok) return { status: 'error', busy: busy(r.status), text: 'שגיאה מ-OpenAI (' + r.status + '): ' + String(j.error && j.error.message || '').slice(0, 300) };
      const t = (j.output || []).flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('\n');
      return { status: 'ok', text: t || '(לא התקבל טקסט)', model };
    }
    if (m === 'claude') {
      // the key goes as a bearer token (newer keys, sk-ant-usr…, expect it); the older x-api-key header is tried once if that is refused
      const body = JSON.stringify({ model, max_tokens: MAX_TOKENS, system: SYSTEM, messages: [{ role: 'user', content: prompt }] }), base = { 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
      r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { ...base, authorization: 'Bearer ' + key }, body });
      if (r.status === 401) r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { ...base, 'x-api-key': key }, body });
      j = await r.json().catch(() => ({}));
      if (!r.ok) return { status: 'error', busy: busy(r.status), text: 'שגיאה מ-Anthropic (' + r.status + '): ' + String(j.error && j.error.message || '').slice(0, 300) };
      return { status: 'ok', text: (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n') || '(לא התקבל טקסט)', model };
    }
    r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', { method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: MAX_TOKENS * 3 } }) });
    j = await r.json().catch(() => ({}));
    if (!r.ok) return { status: 'error', busy: busy(r.status), text: 'שגיאה מ-Gemini (' + r.status + '): ' + String(j.error && j.error.message || '').slice(0, 300) };
    const t = (j.candidates || []).flatMap(c => (c.content && c.content.parts) || []).map(p => p.text || '').join('\n');
    return { status: 'ok', text: t || '(לא התקבל טקסט)', model };
  } catch (e) { return { status: 'error', text: 'לא הצלחתי להגיע ל-' + NAMES[m] + ': ' + String(e && e.message || e).slice(0, 200) }; }
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (!u.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    if (req.method !== 'POST') return json({ error: 'POST בלבד' }, 405);
    if (tooMany(req.headers.get('cf-connecting-ip') || '?')) return json({ error: 'יותר מדי בקשות — נסו שוב בעוד דקה' }, 429);
    if (!(await okPassword(req, env))) return json({ error: env.COUNCIL_PASSWORD ? 'סיסמה שגויה' : 'עוד לא הוגדרה סיסמה למערכת' }, 401);
    const b = await req.json().catch(() => ({}));
    if (u.pathname === '/api/status') return json({ models: Object.keys(NAMES).map(m => ({ id: m, name: NAMES[m], ready: !!keyOf(env, m), model: modelOf(env, m) })) });
    if (u.pathname === '/api/ask') {
      if (!NAMES[b.model]) return json({ error: 'מודל לא מוכר' }, 400);
      if (String(b.task || '').trim().length < 3) return json({ error: 'השאלה קצרה מדי' }, 400);
      return json(await call(env, b.model, promptOf(b)));
    }
    return json({ error: 'לא נמצא' }, 404);
  }
};
