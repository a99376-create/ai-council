# 🏛️ מועצת ה-AI

ChatGPT, Claude ו-Gemini דנים בשאלה שלך בגלוי: בסבב הראשון כל אחד מציע, בסבבים הבאים כל אחד קורא את האחרים ומגיב, ובסוף אחד מהם מסכם.
כל תשובה מופיעה על המסך ברגע שהיא מוכנה — רואים את כל הדיון, לא רק את התוצאה.

- האתר: Cloudflare Worker נפרד (`ai-council`), כתובת `…workers.dev` (מופיעה בסיכום של כל הרצת Deploy ב-Actions).
- כניסה בסיסמה (`COUNCIL_PASSWORD`). בלי סיסמה מוגדרת — הכול חסום.
- מפתחות ה-API נשמרים רק ב-GitHub Secrets ומשם נכנסים ל-Worker כסודות. הם לעולם לא נשלחים לדפדפן ולא נכתבים בקוד.
- מודל בלי מפתח פשוט לא משתתף.
- שמות המודלים ב-`wrangler.toml` (`[vars]`) — אם חברה מוציאה מודל משימוש, מחליפים שם.

## איך זה עולה
Cloudflare מחובר לפרויקט הזה (Workers Builds): כל שינוי ב-main נבנה ומועלה אוטומטית.
הסודות נשמרים ב-Cloudflare: Workers & Pages → ai-council → Settings → Variables and Secrets.

## סודות (גיבוי: GitHub → Settings → Secrets and variables → Actions, ואז הרצה ידנית של הפעולה)
| שם | מה |
|---|---|
| `CLOUDFLARE_API_TOKEN` | טוקן של Cloudflare (תבנית "Edit Cloudflare Workers") |
| `COUNCIL_PASSWORD` | הסיסמה לאתר |
| `OPENAI_API_KEY` | מפתח של OpenAI |
| `ANTHROPIC_API_KEY` | מפתח של Anthropic |
| `GEMINI_API_KEY` | מפתח של Google AI Studio |

אחרי הוספת סוד: Actions → Deploy the council → Run workflow.

## עלויות
כל דיון שולח (מספר המודלים × מספר הסבבים) + 1 בקשות. כל בקשה מחויבת בחשבון של אותה חברה. אין כאן שום שירות בתשלום של Cloudflare.

הגרסה המקורית (פייתון, מ-ChatGPT) תוארה ב-`ORIGINAL_README.md`; הקוד הועבר ל-Worker כדי שלא יהיה צורך בשרת שרץ כל הזמן.
