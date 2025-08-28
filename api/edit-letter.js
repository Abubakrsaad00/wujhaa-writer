// api/edit-letter.js (مُحدّث لاستخدام موديل :free و headers من مثال OpenRouter)
export default async function handler(req, res) {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://wujhaa.com';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Only POST allowed' });

  try {
    const { text, tone = 'formal', action = 'proofread', language = 'ar' } = req.body || {};
    if (!text || text.trim().length < 5) {
      return res.status(400).json({ error: 'Text too short / نص قصير' });
    }

    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) {
      return res.status(500).json({ error: 'Server misconfiguration: API key missing' });
    }

    const system = `You are an expert admissions editor and writing coach. Focus on clarity, structure, tone, grammar, and impact. Return:
1) Polished full version.
2) Bullet list of edits.
3) Short explanation for each edit.
4) Rubric scores (Clarity, Persuasiveness, Grammar, Fit) 1-10.
Respond in the same language as the user.`;

    const userContent = `Action: ${action}
Tone: ${tone}
Language: ${language}
Original text:
${text}

Please produce the 4 sections requested above.`;

    // ===== هنا الفرق: نستخدم الموديل مع :free ونرسل رؤوس إضافية مثل المثال =====
    const body = {
      model: "deepseek/deepseek-r1-distill-llama-70b:free",
      messages: [
        { role: "system", content: system },
        { role: "user",   content: userContent }
      ],
      temperature: 0.18,
      max_tokens: 1200
    };

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        // Headers اختيارية لكن مفيدة كما في المثال الذي وجدته
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
                    
