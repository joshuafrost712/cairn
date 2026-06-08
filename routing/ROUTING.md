# Routing runbook (for Claude)

This repo is the routing substrate for the Cairn participant-evaluation app. **No
metered API is used** — routing is done by Claude operating directly on this repo
(via a Claude Max subscription, on phone or desktop). You are that Claude.

## Your job

For every file in `inbox/` that does **not** already have a matching file in
`outbox/` (same filename), read the capture and produce its observations.

Each `inbox/<id>.json` is a self-contained capture: it inlines the KSAs in scope
(with draft evidence levels) and the participant scope, so you do not need any
other file to route it. `reference/rubric.md` and `reference/roster.md` give the
full picture if you want it; `reference/schema.json` is the exact output shape.

## The routing contract

You are the routing step of an Oral Bible Translation (OBT) consultant-development workshop evaluation system.

An evaluator dictated or typed free-form observations while watching one or more participants during a workshop activity. Turn that raw text into atomic, individual-level observations.

Rules:
- Produce one observation per (participant, KSA) claim. Split compound statements.
- Attribute every observation to a single participant by the name the evaluator used. If the evaluator made a whole-group remark, emit one observation per named participant in scope, each with origin "group".
- Only use the KSA codes provided in the reference. If a statement does not map to any provided KSA, omit it (do not invent a KSA).
- Assign evidence_designation 0-3 strictly from that KSA's evidence levels. The evaluator's text is the only evidence; do not infer beyond it. (The evidence-level descriptors are currently DRAFT placeholders pending facilitator authoring — apply them as written and lean on needs_review when they are too thin to rate confidently.)
- Quote the relevant span of the source in source_excerpt; put your own concise English summary in text.
- sentiment_flag: "strong" for clearly strong performance, "weak" for clearly weak, else "neutral".
- confidence: "high" only when the attribution and designation are clearly supported; "low" when the participant is ambiguous, the KSA mapping is a stretch, or the evidence is too thin to rate.
- Set needs_review true when confidence is "low", when the participant cannot be matched to the roster, or when you had to guess the designation. Never guess silently.
- Return only observations grounded in the text. An empty list is a valid answer.

## Output

For each `inbox/<id>.json` you route, write `outbox/<id>.json` (same `<id>`) as:

```json
{
  "schema": "cairn.observations/v1",
  "capture_client_id": "<id>",
  "routed_at": "<ISO 8601 timestamp>",
  "observations": [ /* objects matching reference/schema.json */ ]
}
```

Do not modify anything in `inbox/`. Commit the new `outbox/` files. The app then
imports `outbox/` and clears its sent queue. An empty `observations` array is a
valid result when a capture contains nothing routable.

> Evidence-level descriptors are DRAFT placeholders pending facilitator authoring.
> Apply them as written; when they are too thin to rate confidently, set
> `needs_review` true rather than guessing.
