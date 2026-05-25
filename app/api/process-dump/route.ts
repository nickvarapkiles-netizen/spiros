import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const SYSTEM_PROMPT = `You are Spiros, the user's prioritization assistant. The user will paste a free-form "brain dump" — a stream-of-consciousness about everything on their plate (work, life, fires, ideas). Your job is to extract discrete priorities and score each one using the RICE framework.

RICE = Reach × Impact × Confidence ÷ Effort
- Reach: 1–10. How many people/projects does this touch? (1 = just me, narrow; 10 = broad reach)
- Impact: 1–10. How much does it move the needle? (1 = trivial; 10 = transformational)
- Confidence: 1–10. How sure are you it will produce the expected result? (1 = guessing; 10 = certain)
- Effort: 1–10. How much work? (1 = quick; 10 = massive undertaking)
- estHours: a realistic estimated hours number (e.g. 0.5, 2, 8, 40). Do NOT just multiply effort by something — think about actual hours.

Use the category that best fits if one is obvious from the user's wording (e.g. "Project A", "Email", "Personal", "Other"). Otherwise omit category.

Guidelines:
- Be specific in titles. "Fix the bug" is bad; "Fix payment webhook 500s on retries" is good.
- Write notes in the user's voice — a single sentence of context, not boilerplate.
- nextAction should be one concrete physical step the user can do today.
- Don't invent priorities they didn't mention. If the dump only has 2 things, return 2 items.
- If the dump is vague, do your best but lean conservative on confidence.

Return ONLY a JSON object matching this schema, no prose, no markdown fences:
{
  "items": [
    {
      "title": string,
      "note": string,
      "reach": number (1-10),
      "impact": number (1-10),
      "confidence": number (1-10),
      "effort": number (1-10),
      "estHours": number,
      "category": string | null,
      "nextAction": string
    }
  ]
}`;

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      {
        error: "ANTHROPIC_API_KEY not set",
        help: "In Vercel: project Settings → Environment Variables → add ANTHROPIC_API_KEY with a key from https://console.anthropic.com/settings/keys, then redeploy.",
      },
      { status: 503 },
    );
  }

  let transcript: string;
  try {
    const body = await req.json();
    transcript = String(body?.transcript ?? "").trim();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!transcript) {
    return Response.json(
      { error: "transcript is required" },
      { status: 400 },
    );
  }

  const client = new Anthropic();

  try {
    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: `Brain dump:\n\n${transcript}`,
        },
      ],
    });

    const textBlock = msg.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return Response.json(
        { error: "No text response from model" },
        { status: 502 },
      );
    }

    const raw = textBlock.text.trim();
    // Strip optional code fences just in case
    const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();

    let parsed: { items: unknown };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return Response.json(
        {
          error: "Model returned non-JSON",
          raw: raw.slice(0, 500),
        },
        { status: 502 },
      );
    }

    if (!Array.isArray((parsed as { items?: unknown }).items)) {
      return Response.json(
        { error: "Response missing 'items' array", got: parsed },
        { status: 502 },
      );
    }

    return Response.json({
      items: parsed.items,
      usage: msg.usage,
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
