// api/edit-letter.js
/**
 * Vercel / Serverless handler
 * - يدعم عدة "actions" منظمة لمنح الطلبة (RAG / knowledge-based).
 * - يجب تعيين OPENROUTER_API_KEY في متغيرات البيئة.
 * - Request (JSON POST):
 *   {
 *     "action": "rewrite" | "feedback" | "shorten" | "paraphrase" | "ielts_check" | "scholarship_summary" | "compare" | ...,
 *     "language": "ar" | "en",
 *     "tone": "formal" | "friendly" | "concise" | ...,
 *     "text": "النص الإدخالي (لأوامر التحرير)",
 *     "metadata": { ... }  // action-specific (e.g., scholarshipName, country, url, userProfile)
 *   }
 *
 * Response:
 *   { ok: true, action: 'rewrite', result: { raw: string, json?: object } }
 *
 * IMPORTANT:
 * - هذا الملف لا يجري بحث ويب حي؛ لإضافة بحث حي استخدم بروكسي (مثلاً /api/deepseek-proxy) لجلب سياق وروابط ثم أرسلها ضمن metadata.context.
 * - prompts هنا توجه النموذج لإرجاع JSON فقط (مما يقلل تداخل الأوامر).
 */

export default async function handler(req, res) {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed. Use POST.' });
  }

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');

    const {
      action = 'rewrite',
      language = 'ar',
      tone = 'formal',
      text = '',
      metadata = {}
    } = body;

    // --- action registry: كل أمر مع وصفه وprompt system الخاص به ---
    // كل prompt يُرشد الموديل لإخراج JSON وفق schema قياسي: { summary, details, bullets, links, meta }
    const promptsMap = {
      // تحرير و إعادة صياغة قوية
      rewrite: {
        desc: 'إعادة صياغة قوية ومحترفة للنص مع ملخص وتغييرات رئيسية',
        system: (lang, tone) => (lang === 'en' ? (
`You are an expert admissions editor. Output JSON only.

Schema:
{
  "summary": "1-2 sentence summary",
  "polished": "Full polished rewritten text",
  "key_changes": ["change 1", "change 2", ...],
  "openers": ["option1", "option2", "option3"],
  "notes": "short note for tone/length"
}

Constraints:
- Preserve facts.
- Adopt tone: ${tone}.
- Keep paragraphs short.
` ) : (
`أنت محرر خبير مختص برسائل القبول والمنح. أجب بـ JSON فقط (بدون نص عادي).

الشكل المطلوب:
{
  "summary": "ملخص 1-2 جملة",
  "polished": "النص المعاد صياغته بالكامل",
  "key_changes": ["تغيير 1", "تغيير 2", ...],
  "openers": ["خيار1", "خيار2", "خيار3"],
  "notes": "ملاحظات قصيرة عن النبرة/الطول"
}

قيود:
- احفظ الحقائق.
- النبرة: ${tone}.
- فقرات قصيرة.
` ))
      },

      // ملاحظات تفصيلية و feedback
      feedback: {
        desc: 'تقرير فيدباك مفصّل (قوي وعملي) — نقاط قوة، نقاط ضعف، خطة عمل',
        system: (lang) => (lang === 'en' ? (
`You are a senior admissions reviewer. Output JSON only.

Schema:
{
  "summary": "...",
  "strengths": ["..."],
  "weaknesses": [{"quote":"...", "issue":"...", "severity":"High|Medium|Low"}],
  "missing_metrics": ["..."],
  "action_plan": ["step 1","step 2","step 3"],
  "score": {"clarity":7, "evidence":4, "grammar":8}
}
` ) : (
`أنت مُقيّم قبول كبير ومحترف. أجب بـ JSON فقط.

الشكل:
{
  "summary":"...",
  "strengths":["..."],
  "weaknesses":[{"quote":"...","issue":"...","severity":"High|Medium|Low"}],
  "missing_metrics":["..."],
  "action_plan":["خطوة1","خطوة2","خطوة3"],
  "score":{"clarity":7,"evidence":4,"grammar":8}
}
` ))
      },

      // اختصار
      shorten: {
        desc: 'اختصار النص مع حفظ النقاط الأساسية',
        system: (lang, targetWords) => (lang === 'en' ? (
`You are an expert summarizer. Output JSON only.

Schema:
{
  "shortened":"...",
  "original_word_count": 0,
  "shortened_word_count": 0,
  "removed_summary":["..."]
}

Target length: ${targetWords || 'about 300 words'}
` ) : (
`أنت ملخّص محترف. أجب بـ JSON فقط.

الشكل:
{
  "shortened":"...",
  "original_word_count": 0,
  "shortened_word_count": 0,
  "removed_summary":["..."]
}

الطول المستهدف: ${targetWords || 'حوالي 300 كلمة'}
` ))
      },

      // paraphrase in different tones
      paraphrase: {
        desc: 'إعادة صياغة بعدة نبرات — إبراز بديل لكل نبرة',
        system: (lang) => (lang === 'en' ? (
`You are a paraphrasing coach. Output JSON only.

Schema:
{
  "paraphrases": {
    "formal":"...",
    "friendly":"...",
    "concise":"...",
    "academic":"..."
  },
  "notes":["..."]
}
` ) : (
`أنت مدرب إعادة صياغة. أجب بـ JSON فقط.

الشكل:
{
  "paraphrases": {
    "formal":"...",
    "friendly":"...",
    "concise":"...",
    "academic":"..."
  },
  "notes":["..."]
}
` ))
      },

      // التحقق من حاجة IELTS و متطلبات اللغة (يستند إلى الاسم/وصف المنحة أو الmetadata)
      ielts_check: {
        desc: 'تحليل متطلبات اللغة/IELTS لمنحة معينة؛ انتظر metadata.scholarshipName أو metadata.url',
        system: (lang) => (lang === 'en' ? (
`You are an expert on scholarship language requirements. Output JSON only.

Schema:
{
  "scholarship": "...",
  "likely_needs_ielts": "Yes|No|Maybe",
  "notes": "...",
  "evidence_needed": ["check url", "contact email"],
  "links": ["..."]
}
` ) : (
`أنت خبير في متطلبات اللغة للمنح. أجب بـ JSON فقط.

الشكل:
{
  "scholarship":"...",
  "likely_needs_ielts":"Yes|No|Maybe",
  "notes":"...",
  "evidence_needed":["راجع الرابط","راسل اللجنة"],
  "links":["..."]
}
` ))
      },

      // تجميع بيانات عن منحة (عند توفر metadata.context أو metadata.url — وإلا يعتمد على معرفة الموديل)
      scholarship_summary: {
        desc: 'ملخّص منظّم لمنحة: تغطية تمويلية، لغة، IELTS، المدة، الموعد النهائي، رابط التسجيل',
        system: (lang) => (lang === 'en' ? (
`You are a scholarship analyst. Output JSON only.

Schema:
{
  "title":"...",
  "country":"...",
  "level":"Bachelors|Masters|PhD|All",
  "funding":"Fully funded|Partial|None|Unknown",
  "language_of_instruction":"English|Arabic|Other|Unknown",
  "ielts_required":"Yes|No|Maybe",
  "deadline":"YYYY-MM-DD or 'Unknown'",
  "url":"...",
  "notes":"..."
}
` ) : (
`أنت محلّل منح. أجب بـ JSON فقط.

الشكل:
{
  "title":"...",
  "country":"...",
  "level":"Bachelors|Masters|PhD|All",
  "funding":"مموّلة بالكامل|جزئياً|غير مموّلة|غير معروف",
  "language_of_instruction":"English|Arabic|Other|Unknown",
  "ielts_required":"Yes|No|Maybe",
  "deadline":"YYYY-MM-DD أو 'Unknown'",
  "url":"...",
  "notes":"..."
}
` ))
      },

      // مقارنة بين منح متعددة
      compare: {
        desc: 'قارن بين منح (تُرسل كـ metadata.items: [{title,url,...}, ...])',
        system: (lang) => (lang === 'en' ? (
`You are a comparison engine for scholarships. Output JSON only.

Schema:
{
  "comparison_table": [
    {"title":"...","funding":"...","ielts":"...","deadline":"...","best_for":"..."}
  ],
  "recommendation":"..."
}
` ) : (
`أنت محرك مقارنة للمنح. أجب بـ JSON فقط.

الشكل:
{
  "comparison_table":[
    {"title":"...","funding":"...","ielts":"...","deadline":"...","best_for":"..."}
  ],
  "recommendation":"..."
}
` ))
      },

      // قائمة مستندات مطلوبة و checklist
      application_checklist: {
        desc: 'قائمة مستندات مطلوبة وخطوات التقديم مفصّلة',
        system: (lang) => (lang === 'en' ? (
`You are an application checklist generator. Output JSON only.

Schema:
{
  "checklist":[ {"name":"Passport copy","required":true,"notes":"..."} ],
  "timeline_steps":[ "Step 1", "Step 2" ],
  "tips":[ "Tip 1", "Tip 2" ]
}
` ) : (
`أنت مُولّد قائمة تحقق لطلبات التقديم. أجب بـ JSON فقط.

الشكل:
{
  "checklist":[ {"name":"صورة جواز السفر","required":true,"notes":"..."} ],
  "timeline_steps":[ "خطوة 1", "خطوة 2" ],
  "tips":[ "نصيحة 1", "نصيحة 2" ]
}
` ))
      },

      // محاكاة اسئلة مقابلة
      mock_interview: {
        desc: 'إنتاج أسئلة مقابلة مخصصة ومنهجية للإعداد (مع إجابات نموذجية ونصائح)',
        system: (lang) => (lang === 'en' ? (
`You are an admissions interviewer. Output JSON only.

Schema:
{
  "questions":[ {"q":"...","purpose":"...","ideal_points":["..."],"sample_answer":"..."} ],
  "advice":"..."
}
` ) : (
`أنت محاور مقابلات قبول. أجب بـ JSON فقط.

الشكل:
{
  "questions":[ {"q":"...","purpose":"...","ideal_points":["..."],"sample_answer":"..."} ],
  "advice":"..."
}
` ))
      },

      // توليد نقاط للسيرة الذاتية / bullets من وصف
      cv_bullets: {
        desc: 'تحويل خبرات ووصف إلى نقاط قوية للسيرة الذاتية (bullet points) قابلة للنسخ',
        system: (lang) => (lang === 'en' ? (
`You are a CV bullets writer. Output JSON only.

Schema:
{
  "bullets":[ "Achieved X by Y", "Led team of..." ],
  "tailored_for":"masters|phd|scholarship"
}
` ) : (
`أنت كاتب نقاط للسيرة الذاتية. أجب بـ JSON فقط.

الشكل:
{
  "bullets":[ "حصلت على X بـ Y", "قاد فريق..." ],
  "tailored_for":"ماجستير|دكتوراه|منحة"
}
` ))
      },

      // ترجمة وملخص متعدد اللغات
      translate: {
        desc: 'ترجمة أو تصحيح لغة: metadata.targetLanguage',
        system: (lang) => (lang === 'en' ? (
`You are a translator/editor. Output JSON only.

Schema:
{
  "translated":"...",
  "notes":"..."
}
` ) : (
`أنت مترجم/مصحح لغوي. أجب بـ JSON فقط.

الشكل:
{
  "translated":"...",
  "notes":"..."
}
` ))
      },

      // تلخيص صفحة / رابط (لاستخراج محتوى: يفضل إرسال metadata.context مع نص الصفحة)
      summarize_url: {
        desc: 'تلخيص صفحة أو محتوى رابط — ارسال metadata.context (ملخص نص الصفحة) موصى به',
        system: (lang) => (lang === 'en' ? (
`You are a web summarizer. Output JSON only.

Schema:
{
  "title":"...",
  "summary":"...",
  "key_points":["..."],
  "links":["..."]
}
` ) : (
`أنت مُلخّص صفحات ويب. أجب بـ JSON فقط.

الشكل:
{
  "title":"...",
  "summary":"...",
  "key_points":["..."],
  "links":["..."]
}
` ))
      },

      // fallback generic chat (if action unknown)
      generic: {
        desc: 'رد عام مفصّل ومنسّق للطلاب (ملخص + نقاط + روابط إن وُجدت)',
        system: (lang) => (lang === 'en' ? (
`You are a helpful scholarship assistant. Output JSON only.

Schema:
{
  "summary":"...",
  "details":"...",
  "suggestions":["..."],
  "links":["..."]
}
` ) : (
`أنت مساعد منحة مفيد. أجب بـ JSON فقط.

الشكل:
{
  "summary":"...",
  "details":"...",
  "suggestions":["..."],
  "links":["..."]
}
` ))
      }
    }; // end promptsMap

    // --- validate action and select prompt ---
    const allowedActions = Object.keys(promptsMap);
    const act = allowedActions.includes(action) ? action : 'generic';
    const promptTemplate = promptsMap[act].system(language, metadata.targetWords || null);

    // Input length check for text-based actions
    if (['rewrite', 'feedback', 'shorten', 'paraphrase', 'cv_bullets'].includes(act)) {
      if (!text || text.trim().length < 8) {
        return res.status(400).json({ ok:false, error: 'text is required and should be non-empty for this action' });
      }
    }

    // Build user message: include metadata and explicit parsing instructions
    const userMsgParts = [
      `Action: ${act}`,
      `Language: ${language}`,
      `Tone: ${tone}`,
      `Metadata: ${JSON.stringify(metadata || {})}`,
      'OriginalText:',
      text || '(none)'
    ];
    const userMessage = userMsgParts.join('\n\n');

    // Call OpenRouter / provider
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
    if (!OPENROUTER_API_KEY) {
      return res.status(500).json({ ok:false, error: 'Server misconfiguration: OPENROUTER_API_KEY (or OPENAI_API_KEY) not set.' });
    }

    const model = process.env.MODEL || 'deepseek/deepseek-r1-distill-llama-70b:free'; // change as needed
    const payload = {
      model,
      messages: [
        { role: 'system', content: promptTemplate },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.05,
      max_tokens: Number(process.env.MAX_TOKENS || 1600)
    };

    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const txt = await resp.text();
      return res.status(resp.status).json({ ok:false, error: 'Upstream error', detail: txt });
    }

    const data = await resp.json();
    const assistantText = data?.choices?.[0]?.message?.content || '';

    // try to parse JSON from assistant (since we ask JSON-only)
    let parsed = null;
    try {
      // find first JSON-looking substring
      const jsonStart = assistantText.indexOf('{');
      if (jsonStart !== -1) {
        const possible = assistantText.slice(jsonStart);
        parsed = JSON.parse(possible);
      }
    } catch (e) {
      // parsing failed — leave parsed null and return raw text for debugging
      parsed = null;
    }

    return res.status(200).json({
      ok: true,
      action: act,
      description: promptsMap[act].desc,
      result: {
        raw: assistantText,
        json: parsed
      },
      raw_response: data
    });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ ok:false, error: err.message || String(err) });
  }
}
