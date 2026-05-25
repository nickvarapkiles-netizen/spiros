import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";
import { buildContextBlock, DebriefStateSnapshot } from "../_shared";

export const runtime = "nodejs";
export const maxDuration = 30;

const SYSTEM = `You are Spiros, the user's prioritization assistant, running the weekly Oracle debrief.

You have access to the user's full week: priorities they set, their brain dump, every Rize time entry, and their Google Calendar events.

Your job RIGHT NOW is to come up with 3–5 SPECIFIC clarifying questions that will help you write a much better weekly debrief. Good questions are:
- Grounded in actual data (reference a specific time block, meeting, person, or pattern you see)
- About things you can't infer from the raw data alone — context, intent, outcomes
- Designed to surface signal the user wants noticed (was that 3h block deep work or distraction? what was the actual outcome of that meeting? was the personal time intentional or reactive?)
- Brief — one sentence each

DO NOT ask:
- Generic questions like "how was your week?" or "what are your goals?"
- Things obvious from the data ("how much time did you spend on meetings?" — the data answers this)
- More than 5 questions

Return ONLY a JSON object, no prose, no markdown fences:
{
  "questions": [
    { "text": "specific question 1" },
    { "text": "specific question 2" },
    ...
  ]
}`;

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY not set" },
      { status: 503 },
    );
  }

  let body: { state?: DebriefStateSnapshot };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.state) {
    return Response.json({ error: "state is required" }, { status: 400 });
  }

  const client = new Anthropic();
  try {
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `Here's everything from this Oracle. Give me 3–5 clarifying questions before I write the debrief.\n\n${buildContextBlock(body.state)}`,
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
    let parsed: { questions?: Array<{ text: string }> };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return Response.json(
        { error: "Non-JSON response", raw: textBlock.text.slice(0, 400) },
        { status: 502 },
      );
    }
    const qs = (parsed.questions ?? [])
      .filter((q) => typeof q.text === "string" && q.text.trim().length > 0)
      .map((q, i) => ({ id: `q${i + 1}`, text: q.text.trim() }));
    return Response.json({ questions: qs });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const status =
      typeof err === "object" && err !== null && "status" in err
        ? Number((err as { status: number }).status) || 500
        : 500;
    return Response.json({ error: message }, { status });
  }
}
