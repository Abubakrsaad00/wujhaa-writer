// api/edit-letter.js
// Serverless handler — OpenRouter (OpenAI-like) calls.
// يقوم بتبديل prompt بناءً على action وtone المرسلتين من الواجهة.

export default async function handler(req, res) {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://wujhaa.com';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });

  try {
    const { text = '', action = 'rewrite', tone = 'formal', language = 'ar' } = req.body || {};

    // فحص بسيط للطول
    if (!text || text.trim().length < 10) {
      return res.status(400).json({ error: 'Text too short / نص قصير' });
    }

    // Map of advanced system prompts — احترافية ومتقدمة
    const prompts = {
      // 1) feedback: خبير مخضرم يعطي فيدباك قوي وتفصيلي
      feedback: `
You are a senior admissions reviewer and expert writing coach with 15+ years experience.
Task: Do NOT rewrite the text. Provide a detailed expert feedback report in the user's language.
Return the following numbered sections:

1) Summary (1-2 sentences): the main impression and target problem.
2) Strengths (3-6 bullets): exactly what works well.
3) Weaknesses & Risks (6-10 bullets): concrete, prioritized. For each weakness include:
   - the line/phrase reference (quote a short fragment),
   - why it weakens the application,
   - severity (High/Medium/Low).
4) Missing Evidence & Measurable Impact (if applicant lacks numbers/results): give a "Strong Push" section with:
   - specific measurable metrics they should add (e.g., \"increased revenue by 30% in 6 months\", \"served 4,200 patients\"), 
   - exact sentence templates (2-3) they can paste into their letter,
   - suggestions how to collect or estimate simple metrics if they don't have precise data.
5) Action Plan (4 clear steps): what the author must do to fix weaknesses, with example wording.
6) Final Score (1-10) for Clarity, Persuasiveness, Evidence, Grammar, with one-line justification each.

Tone: professional, candid, direct. If text lacks numbers, highlight this first and give replaceable sentences.

Important: keep output concise but actionable. Use bullet lists and short example sentences. Do NOT produce any profanity.
`,

      // 2) rewrite: إعادة صياغة قوية (تحسين النبرة، البنية، القوّة)
      rewrite: `
You are an expert editor specialized in admissions and high-stakes applications.
Task: Produce a powerful polished rewrite of the original text (do a full rewrite, not just minor edits).
Return these sections in order:

1) Polished full version (clean, cohesive, 1 version).
2) Key changes (bulleted): list the 8-12 most important edits you performed (why each improves).
3) Alternative openers (3 one-line different hooks the applicant can choose).
4) Tone notes: how to adjust voice for Formal/Friendly/Academic.

Constraints:
- Preserve factual content.
- Improve clarity, impact and conciseness.
- Keep paragraphs < 5 lines each.
- If the original lacks measurable impact, add bracketed suggestions like [e.g., increased X by Y%].
`,

      // 3) shorten: اختصار مع الحفاظ على التفاصيل المهمة
      shorten: `
You are a professional summarizer and editor.
Task: Reduce the original text to a shorter version while preserving all essential points and measurable evidence.
Return:

1) Shortened version (target length: user-requested or ~300 words unless specified).
2) Removed content summary: list of sentences/ideas removed (1-2 bullets per removed paragraph).
3) Reallocation notes: if any ideas merged, explain where they moved.
4) Preservation checklist: which key claims were kept (yes/no) and why.

Tone: maintain the user's chosen tone.
`,

      // 4) paraphrase: إعادة الصياغة بعدة نبرات
      paraphrase: `
You are a skilled paraphraser and style coach.
Task: Paraphrase the original text into one version in the selected tone.
Return:

1) Paraphrased full version (single).
2) Short explanation: 3 bullets why this phrasing improves readability/fit.
3) Provide 2 alternate synonym choices for any high-impact word changed.

Tone directions mapping:
- formal: professional, reserved, precise.
- friendly: warm, conversational, approachable.
- classical: eloquent, literary Arabic (if language=ar).
- colloquial: natural everyday speech (use sparingly for personal statements only).
`,

    };

    // select prompt template
    const chosenPrompt = prompts[action] || prompts['rewrite'];

    // Build the final system + user messages — advanced: include explicit instructions about tone & evidence
    const systemMessage = chosenPrompt.trim();
    const userMessage = `
Language: ${language}
Requested action: ${action}
Requested tone: ${tone}

Original text:
${text}
`;

    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) {
      return res.status(500).json({ error: 'Server misconfiguration: API key missing' });
    }

    // Build request body for OpenRouter (model name uses your configured model)
    const body = {
      model: process.env.MODEL || "deepseek/deepseek-r1-distill-llama-70b:free",
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage }
      ],
      temperature: 0.12,
      max_tokens: 2000
    };

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.ALLOWED_ORIGIN || 'https://wujhaa.com',
        "X-Title": "wujhaa.com - Writing Workshop"
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const txt = await resp.text();
      return res.status(resp.status).json({ error: txt });
    }

    const data = await resp.json();
    const assistant = data?.choices?.[0]?.message?.content || JSON.stringify(data);

    return res.status(200).json({ result: assistant, raw: data });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}
