// מועצת ה-AI — Cloudflare Worker.
// The page (public/index.html) runs the discussion itself, one call per model per round, so every answer appears the moment it is ready.
// This worker only: checks the password, keeps the API keys (Worker secrets — never sent to the browser), and asks ONE model per request.
//   POST /api/status  {}                                        → which models have a key, and their model names
//   POST /api/ask     {model, task, round, rounds, history[]}   → {text} from that model
//   header x-council-password = the COUNCIL_PASSWORD secret (no password set → everything is refused)

import OVERVIEW from '../docs/app-overview.md';
const REPO = 'a99376-create/mezakeharabim-app';
const SYSTEM = 'אתה חבר במועצת AI שדנה בגלוי בשאלה של המשתמש, יחד עם שני מודלים אחרים. ענה בעברית, בצורה ממוקדת ומעשית. ' +
  'בסבב הראשון הצע תשובה או תוכנית משלך. בסבבים הבאים קרא את מה שכתבו האחרים, ציין במפורש במה אתה מסכים ובמה לא ולמה, ושפר. ' +
  'אל תעמיד פנים שביצעת פעולות שלא ביצעת, ואל תמציא עובדות; אם אינך בטוח — אמור זאת.';
const NAMES = { openai: 'ChatGPT', claude: 'Claude', gemini: 'Gemini' }, WHO = { ...NAMES, user: 'המשתמש' };
const MAX_TOKENS = 1500, MAX_TASK = 12000, MAX_HIST_EACH = 4000, MAX_CODE = 40000;

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

function ctxOf(b) { let c = ''; if (b.withApp) c += 'רקע — סקירת האפליקציה שהמשתמש מפתח (חבורת מזכי הרבים):\n' + OVERVIEW + '\n\n';
  if (b.code) c += 'קטעי קוד מהאפליקציה שצורפו לדיון (מקור: GitHub, ענף main):\n' + String(b.code).slice(0, MAX_CODE) + '\n\n'; return c; }
function promptOf(b) { return ctxOf(b) + promptOf0(b); }
function promptOf0(b) {
  const task = String(b.task || '').slice(0, MAX_TASK), round = Math.max(1, Math.min(4, +b.round || 1)), rounds = Math.max(1, Math.min(4, +b.rounds || 3));
  const hist = (Array.isArray(b.history) ? b.history : []).filter(h => h && h.text).slice(-16)
    .map(h => `— ${WHO[h.model] || h.model}${h.model === 'user' ? '' : ' (סבב ' + (+h.round || '?') + ')'}:\n${String(h.text).slice(0, MAX_HIST_EACH)}`).join('\n\n');
  if (b.summary) return `שאלת המשתמש:\n${task}\n\nזה הדיון המלא של המועצה:\n\n${hist}\n\nכתוב עכשיו סיכום קצר וברור למשתמש: על מה הסכימו, מה נשאר במחלוקת, ומה ההמלצה הסופית. אל תוסיף דעות חדשות שלא עלו בדיון.`;
  if (b.reply) return `שאלת המשתמש:\n${task}\n\nזה הדיון עד עכשיו:\n\n${hist}\n\nהמשתמש הגיב עכשיו לדיון:\n${String(b.reply).slice(0, 6000)}\n\nהתייחס ישירות לתגובה שלו: ענה על מה ששאל, עדכן את ההמלצה שלך אם צריך, והתייחס גם לדברי האחרים כשזה רלוונטי.`;
  if (round === 1) return `שאלת המשתמש:\n${task}\n\nזה הסבב הראשון מתוך ${rounds}. הצע את התשובה או התוכנית שלך.`;
  return `שאלת המשתמש:\n${task}\n\nזה סבב ${round} מתוך ${rounds}. אלה הדברים שנאמרו עד עכשיו:\n\n${hist}\n\nהתייחס לדברי האחרים: במה אתה מסכים, במה לא ולמה. אחר כך כתוב את הגרסה המשופרת שלך.${round === rounds ? ' זה הסבב האחרון — סיים בהמלצה ברורה.' : ''}`;
}

// a busy model (429/5xx) is asked again after a short wait; Gemini then falls back to a lighter model (GEMINI_FALLBACK)
async function call(env, m, prompt) {
  let res; for (const wait of [0, 2500, 6000]) { if (wait) await new Promise(r => setTimeout(r, wait)); res = await call1(env, m, prompt, null); if (!res.busy) return res; }
  if (m === 'gemini') for (const fb of String(env.GEMINI_FALLBACK || 'gemini-3.5-flash-lite,gemini-3.1-flash-lite').split(',').map(x => x.trim()).filter(Boolean)) { if (fb === modelOf(env, m)) continue; const r2 = await call1(env, m, prompt, fb); if (!r2.busy) return r2; res = r2; }
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
      const body = JSON.stringify({ model, max_tokens: MAX_TOKENS, system: SYSTEM, messages: [{ role: 'user', content: prompt }] }), base = { 'anthropic-version': env.ANTHROPIC_VERSION || '2026-10-21', 'content-type': 'application/json' }; /* the version in Anthropic's current docs — personal keys (sk-ant-usr…) are newer than 2023-06-01 */
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
    if (!u.pathname.startsWith('/api/')) { const r = await env.ASSETS.fetch(req); if (!/html/.test(r.headers.get('content-type') || '')) return r;
      const h = new Headers(r.headers); h.set('cache-control', 'no-store'); return new Response(r.body, { status: r.status, headers: h }); } // the page itself is never kept stale on a phone
    if (req.method !== 'POST') return json({ error: 'POST בלבד' }, 405);
    if (tooMany(req.headers.get('cf-connecting-ip') || '?')) return json({ error: 'יותר מדי בקשות — נסו שוב בעוד דקה' }, 429);
    if (!(await okPassword(req, env))) return json({ error: env.COUNCIL_PASSWORD ? 'סיסמה שגויה' : 'עוד לא הוגדרה סיסמה למערכת' }, 401);
    const b = await req.json().catch(() => ({}));
    if (u.pathname === '/api/status') return json({ models: Object.keys(NAMES).map(m => ({ id: m, name: NAMES[m], ready: !!keyOf(env, m), model: modelOf(env, m), keyShape: keyOf(env, m) ? keyOf(env, m).slice(0, 10) + '… (' + keyOf(env, m).length + ')' : '' })) });
    if (u.pathname === '/api/ask') {
      if (!NAMES[b.model]) return json({ error: 'מודל לא מוכר' }, 400);
      if (String(b.task || '').trim().length < 3) return json({ error: 'השאלה קצרה מדי' }, 400);
      return json(await call(env, b.model, promptOf(b)));
    }
    if (u.pathname === '/api/overview') return json({ text: OVERVIEW });
    if (u.pathname === '/api/code') return json(await codeSearch(env, b));
    return json({ error: 'לא נמצא' }, 404);
  }
};

// 🔎 code from the app's repository (read-only; GITHUB_TOKEN = a fine-grained token with "Contents: read" on that one repository)
const CACHE = new Map(); const TTL = 10 * 60 * 1000;
async function gh(env, path, raw) {
  const k = path + '|' + (raw ? 1 : 0), c = CACHE.get(k); if (c && Date.now() - c.t < TTL) return c.v;
  const r = await fetch('https://api.github.com/repos/' + REPO + path, { headers: { authorization: 'Bearer ' + String(env.GITHUB_TOKEN || '').trim(), 'user-agent': 'ai-council', accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json' } });
  if (!r.ok) throw new Error('GitHub ' + r.status + (r.status === 401 || r.status === 404 ? ' — המפתח של GitHub חסר או בלי הרשאה לפרויקט' : ''));
  const v = raw ? await r.text() : await r.json(); CACHE.set(k, { t: Date.now(), v }); return v;
}
async function codeSearch(env, b) {
  if (!env.GITHUB_TOKEN) return { error: 'עוד לא חובר מפתח של GitHub — אי אפשר לקרוא את הקוד.' };
  const q = String(b.q || '').trim().slice(0, 200); if (!q) return { error: 'מה לחפש בקוד?' };
  let tree; try { tree = await gh(env, '/git/trees/main?recursive=1'); } catch (e) { return { error: String(e.message) }; }
  const all = (tree.tree || []).filter(f => f.type === 'blob' && /\.(js|mjs|html|css|toml|sql|md|json)$/.test(f.path) && !/\.gen\.js$|^site\/vendor\/|package-lock|^CHANGES-/.test(f.path));
  const words = q.split(/\s+/).filter(Boolean);
  // a file name or path given → that file; else the main source files are searched for every word
  const named = all.filter(f => words.some(w => f.path === w || f.path.endsWith('/' + w)));
  const files = named.length ? named : all.filter(f => /^(site|src)\//.test(f.path) && f.size < 1200000);
  const out = []; let size = 0, hits = 0;
  for (const f of files.slice(0, 30)) {
    let txt; try { txt = await gh(env, '/contents/' + encodeURI(f.path) + '?ref=main', true); } catch (e) { continue; }
    const L = txt.split('\n');
    if (named.length && txt.length <= 30000) { const piece = `### ${f.path} (כל הקובץ)\n` + txt; out.push(piece); size += piece.length; continue; }
    const terms = named.length ? words.filter(w => !named.some(n => n.path.endsWith(w))) : words; if (!terms.length) { out.push(`### ${f.path}: הקובץ גדול מדי לצרף כולו (${Math.round(txt.length / 1000)}KB) — כתבו גם מילה לחפש בו`); continue; }
    const lc = terms.map(w => w.toLowerCase()), marks = [];
    L.forEach((l, i) => { const x = l.toLowerCase(); if (lc.every(w => x.includes(w)) || (lc.length > 1 && lc.filter(w => x.includes(w)).length >= 2)) marks.push(i); });
    if (!marks.length) continue; hits += marks.length;
    const R = []; for (const i of marks.slice(0, 12)) { const a = Math.max(0, i - 10), z = Math.min(L.length - 1, i + 14); if (R.length && a <= R[R.length - 1][1] + 1) R[R.length - 1][1] = z; else R.push([a, z]); }
    for (const [a, z] of R) { const piece = `### ${f.path} שורות ${a + 1}–${z + 1}\n` + L.slice(a, z + 1).map(l => l.length > 400 ? l.slice(0, 400) + ' …' : l).join('\n'); if (size + piece.length > MAX_CODE) break; out.push(piece); size += piece.length; }
    if (size > MAX_CODE) break;
  }
  return { files: files.length, hits, text: out.join('\n\n') || '', note: out.length ? '' : 'לא נמצא בקוד' };
}
