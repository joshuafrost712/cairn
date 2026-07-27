// draft-scenario — turn an uploaded curriculum/competency document into a draft
// evaluation scenario (events + questions + wiring) as JSON.
//
// Why an Edge Function: it holds the Gemini API key server-side so the key is never
// shipped in the client bundle, and it ports unchanged from the managed Supabase
// project to a self-hosted Supabase on SIL infrastructure. The client validates the
// output against src/ai/scenarioContract.ts before using it — this function is a
// thin, purpose-bound Gemini call, not a source of truth for the shape.
//
// The prompt rules below MIRROR SCENARIO_RULES in src/ai/scenarioContract.ts; keep
// them in sync. verify_jwt is on by default, so only authenticated users can call.
//
// Config: set the GEMINI_API_KEY secret (Gemini free tier — Google AI Studio key).
//   supabase secrets set GEMINI_API_KEY=...
// Optional GEMINI_MODEL (default gemini-2.5-flash).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const RULES = `You design evaluation scenarios for an Oral Bible Translation (OBT) consultant-development workshop.

You are given a curriculum, syllabus, or competency document. Turn it into a workshop evaluation scenario as a JSON object with these keys:
- "workshop" (optional): { "name", "location", "start_date" (YYYY-MM-DD or null), "end_date", "languages": [] }
- "activities": [ { "title", "genre_group" (optional), "sort_order" (0-based integer) } ] — the sessions an evaluator observes.
- "ksas": [ { "code" (short unique uppercase), "area", "short_label", "description", "evaluator_facing_prompt" (a neutral "How did they…?" cue, not yes/no), "evidence_levels": { "0","1","2","3" } (what earns each rating; 0 = none, 3 = strong), "guiding_questions": [2-4 look/listen-for prompts] } ]
- "wiring": [ { "activity_title" (matches an activity title exactly), "ksa_codes": [codes defined in ksas] } ]

Rules:
- Derive everything from the document; do not invent competencies it does not support.
- Every ksa_code in wiring must be defined in ksas; every activity_title must match an activity title exactly; codes are unique.
- Return ONLY the JSON object — no prose, no markdown fences.`

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const apiKey = Deno.env.get('GEMINI_API_KEY')
    if (!apiKey) {
      return json({ error: 'GEMINI_API_KEY is not configured on the server.' }, 500)
    }
    const model = Deno.env.get('GEMINI_MODEL') ?? 'gemini-2.5-flash'

    const { document } = await req.json().catch(() => ({}))
    if (typeof document !== 'string' || !document.trim()) {
      return json({ error: 'Provide a non-empty "document" string.' }, 400)
    }

    const prompt = `${RULES}

--- BEGIN SOURCE DOCUMENT ---
${document}
--- END SOURCE DOCUMENT ---

Return only the JSON object.`

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        }),
      },
    )

    if (!res.ok) {
      const detail = await res.text()
      return json({ error: `Gemini request failed (${res.status}): ${detail.slice(0, 500)}` }, 502)
    }

    const data = await res.json()
    const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) return json({ error: 'Gemini returned no content.' }, 502)

    // Try to parse; return the parsed object under "scenario" when possible, else
    // the raw text so the client's tolerant parser can recover it.
    try {
      return json({ scenario: JSON.parse(text) }, 200)
    } catch {
      return json({ raw: text }, 200)
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Unexpected error.' }, 500)
  }
})

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  })
}
