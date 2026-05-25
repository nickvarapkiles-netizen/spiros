import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { buildContextBlock, DebriefStateSnapshot } from "../_shared";

export const runtime = "nodejs";
export const maxDuration = 60;

const SYSTEM = `You are Spiros, the user's prioritization assistant. Write the user's weekly Oracle debrief — a structured summary of the week that just ended.

The user is a busy operator. They want signal, not summary-of-summary. The debrief should make them feel "yes, you SAW my week."

You have full context: Rize entries, Google Calendar events, their priorities, their brain dump, AND their answers to your clarifying questions (treat answers as ground truth — use them).

Return ONLY this JSON shape, no prose, no markdown fences:
{
  "headline": "one punchy sentence summing up the week (<80 chars)",
  "sections": [
    { "title": "The Week in Numbers", "body": "..." },
    { "title": "What you actually did", "body": "..." },
    { "title": "Where time went vs priorities", "body": "..." },
    { "title": "Patterns worth noting", "body": "..." },
    { "title": "For next week", "body": "..." }
  ]
}

Section rules:
- **The Week in Numbers**: total tracked, work/personal split, top 3 categories with hours, # meetings, # standout long blocks. Tight, data-forward.
- **What you actually did**: a narrative paragraph (5–8 sentences) that reads like a smart friend recapping your week. Reference specific projects, people, and moments. Be SPECIFIC — use names from calendar/Rize, not generic phrases.
- **Where time went vs priorities**: did the user's actual time align with the RICE priorities they set? Call out specific mismatches. If a high-score priority got 0 hours, flag it. If a low-score thing absorbed many hours, name it.
- **Patterns worth noting**: 2–4 specific observations. "You had 4 meetings with the same person" or "Wednesday was 6h of context-switching across 11 short blocks" or "Personal time was front-loaded into the weekend". Be observational, not preachy.
- **For next week**: 2–4 concrete recommendations grounded in what you saw. NOT generic advice — specific moves like "block 2h Mon for the webhook fix" or "decline the Friday standup if it's still not delivering value".

Voice:
- Direct, declarative, no hedging
- Match the user's voice — brief, observational, no fluff
- Bullet lists with "- " for the more list-y sections (Numbers, Patterns, Next week) using \\n between bullets
- Use real names and specific data points constantly`;

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY not set" },
      { status: 503 },
    );
  }

  let body: {
    state?: DebriefStateSnapshot;
    answers?: Array<{ question: string; answer: string }>;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.state) {
    return Response.json({ error: "state is required" }, { status: 400 });
  }

  const answersBlock =
    body.answers && body.answers.length > 0
      ? `\n\n## Clarifying answers from Nick\n${body.answers
          .map(
            (a, i) =>
              `Q${i + 1}: ${a.question}\nA${i + 1}: ${a.answer || "(skipped)"}`,
          )
          .join("\n\n")}`
      : "\n\n## Clarifying answers from Nick\n(Nick skipped the clarifying step)";

  const client = new Anthropic();
  try {
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `Write the weekly Oracle debrief for Nick.\n\n${buildContextBlock(body.state)}${answersBlock}`,
        },
      ],
    });

    const textBlock = resp.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return Response.json(
        { error: "No text response" },
        { status: 502 },
      );
    }
    const cleaned = textBlock.text
      .trim()
      .replace(/^```(?:json)?\s*|\s*```$/g, "");
    let parsed: {
      headline?: string;
      sections?: Array<{ title: string; body: string }>;
    };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return Response.json(
        { error: "Non-JSON response", raw: textBlock.text.slice(0, 600) },
        { status: 502 },
      );
    }
    if (!parsed.headline || !Array.isArray(parsed.sections)) {
      return Response.json(
        { error: "Missing headline or sections" },
        { status: 502 },
      );
    }
    return Response.json({
      summary: {
        headline: parsed.headline,
        sections: parsed.sections,
      },
      usage: resp.usage,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      typeof err === "object" && err !== null && "status" in err
        ? Number((err as { status: number }).status) || 500
        : 500;
    return Response.json({ error: message }, { status });
  }
}
