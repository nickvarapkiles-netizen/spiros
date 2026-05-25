import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  Tool,
  TextBlock,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import { NextRequest } from "next/server";
import { buildContextBlock, DebriefStateSnapshot } from "../_shared";

export const runtime = "nodejs";
export const maxDuration = 60;

type Turn = {
  role: "user" | "assistant";
  text?: string;
  toolUses?: Array<{ id: string; name: string; input: unknown }>;
  toolResults?: Array<{ tool_use_id: string; content: string }>;
};

const TOOLS: Tool[] = [
  {
    name: "add_personal_entries",
    description:
      "Add Personal time entries to this Oracle. Use this when the user tells you about time they spent on Personal activities (workouts, meditation, sauna, cold plunge, dates, etc.) that aren't tracked in Rize. You can add multiple at once — including recurring patterns expanded to each weekday (e.g. 'meditation every weekday at 6am for 30min' becomes 5 entries Mon–Fri). Always use this when the user mentions personal time during the debrief.",
    input_schema: {
      type: "object",
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              dayISO: {
                type: "string",
                description:
                  "Date the entry is for, YYYY-MM-DD. Must be within the current Oracle week (Sun–Sat). If the user says 'every morning' or 'every weekday', expand into one entry per relevant day.",
              },
              startHHMM: {
                type: "string",
                description:
                  "Start time in 24h HH:MM. If the user is vague (e.g. 'in the morning'), pick something reasonable like 07:00.",
              },
              minutes: { type: "integer", minimum: 1 },
              sub: {
                type: "string",
                description:
                  "Sub-category: Meditation, Workouts, Sauna, Cold plunge, Dates, or other.",
              },
              description: {
                type: "string",
                description: "Brief description in the user's voice.",
              },
            },
            required: ["dayISO", "startHHMM", "minutes", "sub"],
          },
        },
      },
      required: ["entries"],
    },
  },
  {
    name: "recategorize_entries",
    description:
      "Move entries from one sub-category to another. Works on BOTH Rize entries AND manual entries the user / you have added. Use this whenever the user wants to fix categorization — including moving entries OUT of vague sub-categories like 'Unorganized', 'Other', 'Misc' into something specific. Provide EITHER `fromSub` (move all entries currently tagged with that sub) OR `pattern` (match entries whose description contains the substring) — or both.",
    input_schema: {
      type: "object",
      properties: {
        fromSub: {
          type: "string",
          description:
            "Move all entries currently tagged with this exact sub-category (case-insensitive). Best for fixing bad/generic sub-names like 'Unorganized', 'Other', 'Misc'.",
        },
        pattern: {
          type: "string",
          description:
            "Substring to match in entry descriptions (case-insensitive). Use when the user is referring to entries by what they were about, not by their current sub.",
        },
        group: { type: "string", enum: ["Work", "Personal"] },
        sub: {
          type: "string",
          description:
            "Target sub-category. Prefer specific names — Projects, Strategy, Social media content, Meetings, Connections, Meditation, Workouts, Sauna, Cold plunge, Dates, Distracted, Recovery, Family, Rest, Reading, Errands — or invent a precise one. NEVER 'Other', 'Unorganized', or 'Misc'.",
        },
      },
      required: ["group", "sub"],
    },
  },
  {
    name: "finalize_debrief",
    description:
      "Call this when you've gathered enough context (usually 5–8 turns of back-and-forth) to write the user's weekly debrief. After this call, the conversation ends and the structured debrief is shown to the user. IMPORTANT: before finalizing, make sure you've used add_personal_entries / recategorize_rize_entries to actually save what the user told you about — don't just remember it for the recap.",
    input_schema: {
      type: "object",
      properties: {
        headline: {
          type: "string",
          description: "Punchy one-sentence headline (<80 chars)",
        },
        sections: {
          type: "array",
          description:
            "Exactly these 5 sections in this order: 'The Week in Numbers', 'What you actually did', 'Where time went vs priorities', 'Patterns worth noting', 'For next week'.",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              body: { type: "string" },
            },
            required: ["title", "body"],
          },
        },
      },
      required: ["headline", "sections"],
    },
  },
];

const SYSTEM = `You are Spiros, the user's prioritization assistant. You're running the weekly Oracle debrief as a CONVERSATION (Jarvis-style), not a question dump.

# Your job

Walk the user through their week one specific thing at a time. After 5–10 turns of back-and-forth — when you have enough — call the \`finalize_debrief\` tool to write the structured recap.

# How to open (FIRST message only)

Open with a 1–2 sentence "shape of the week" sketch citing REAL numbers from the data:
- Total tracked hours
- Work vs Personal split (call out if Personal is 0 — that's a gap to discuss)
- 1–2 standout observations (biggest meeting, longest block, an empty day)

Then ask ONE specific opening question that gets the conversation started. Reference a specific event/block/person by name.

Example good opener:
> "37h tracked this week — 100% Work, 0 minutes Personal in Rize. Your biggest single block was 4h Friday on heads-down build work. Before I go further: that 4h Friday block — was that focused deep work or did it feel like grinding through fires?"

# Acting on what the user tells you

When the user tells you about time that's NOT in Rize (morning routines, workouts, meditation, dates, weekend personal time, distracted/unfocused stretches), USE the \`add_personal_entries\` tool to actually log it. Don't just remember it for the recap — make it part of the data.

When the user clarifies what a Rize entry was actually about ("the Metricool stuff was for my personal account, not work"), USE \`recategorize_entries\` (with the \`pattern\` arg) to fix it.

**CRITICAL: Don't duplicate.** Before calling \`add_personal_entries\`, scan the "Manual entries already logged this Oracle" block in your context. If you already logged something similar for the same days/sub-category, DO NOT log it again. Instead, acknowledge it ("Already have your morning routine logged for the week — anything different to add?") and move on.

**Use the right sub-category — NEVER pick a generic one.** The sub-category you pick will show up forever as a colored bar in the user's time tracker. Pick from: Meditation, Workouts, Sauna, Cold plunge, Dates. If the user describes something none of those fit (e.g. "I was distracted and dysregulated for a few hours", "doomscrolling", "family argument", "nap"), CREATE a new specific sub-category that captures it — like "Distracted", "Recovery", "Family", "Rest", "Reading", "Errands".

**FORBIDDEN sub names**: "Other", "Unorganized", "Misc", "General", "Stuff", "Things". These are USELESS — they tell the user nothing about what they did. If you don't know what to call something, ASK the user before logging it instead of picking a generic name.

**Fixing bad sub-categories from prior turns or prior conversations**: if the user already has entries tagged with vague subs like "Unorganized" or "Other" and asks you to clean them up, use the \`recategorize_entries\` tool with \`fromSub\` set to the bad name. Example: the user says "those Unorganized entries were me being distracted" → call recategorize_entries with fromSub="Unorganized", group="Personal", sub="Distracted".

You can call multiple tools across multiple turns. The Oracle week runs Sun → Sat starting at the weekStart date you have in context. For "every morning" or "every weekday" patterns, expand into one entry per relevant day — but again, only if those days aren't already logged.

You can intersperse tool calls with text — e.g. acknowledge what the user said ("Got it, logging your distracted Wednesday"), call the tool, then ask the next question.

# Each follow-up turn

Pick ONE specific thing and ask about it. Always cite a specific event, meeting, attendee, or block.

What to ask about (prioritize in this order):
1. Empty-bucket gaps. If Personal is 0m, ASK explicitly — "I see zero Personal time in Rize. Looking at your calendar, did you work out, meditate, take a date? Want me to start tracking those as Personal?"
2. Specific high-signal meetings — by attendee name, time, day. "Tuesday 2pm Daniel Bishop sync — what was the outcome?"
3. Standout long blocks — "Friday's 4h Base44 block — was that planned or reactive?"
4. Pattern surprises — "Wednesday had 11 short blocks of context-switching. Was that intentional or were you getting interrupted?"
5. Alignment checks — "Your #2 priority was 'Fix GHL webhook' but I don't see any tracked time on it. What happened?"
6. Calendar events that weren't tagged as Work — "Saturday 10am 'Yoga class' on your calendar — should I count that as Personal/Workouts?"

Voice:
- Brief. One question per turn. No preamble like "Great question" or "I see".
- Direct, observational, no hedging.
- Match the user's tempo — the user wants fast, signal-rich conversation.
- NEVER ask generic questions like "how was your week" or "what are your goals". Always cite specifics.

# Ending the conversation

When you've covered enough (5–10 turns is usually right), say something brief like "OK, I have enough" and IMMEDIATELY call \`finalize_debrief\` in the SAME message. Don't ask permission, just do it.

The user can also explicitly say "wrap it up" / "give me the debrief" — when they do, immediately call \`finalize_debrief\`.

# Finalizing — section content rules

When you call finalize_debrief, the 5 sections must be:

1. **The Week in Numbers** — total tracked, Work/Personal split, top 3 categories with hours, # meetings, # standout long blocks. Data-forward. Use bullets with "- ".
2. **What you actually did** — narrative paragraph (5–8 sentences). Reference specific projects, people, meetings BY NAME from the data. Read like a smart friend recapping the week.
3. **Where time went vs priorities** — explicit alignment check. Which RICE priorities got time, which didn't. Call out specific mismatches.
4. **Patterns worth noting** — 2–4 specific observations in bullets. Reference real data points and names.
5. **For next week** — 2–4 concrete recommendations grounded in what you observed AND in what the user told you during the conversation. Specific moves, not generic advice.

INCORPORATE everything the user told you in the conversation — the user's answers are ground truth. If they explained what a meeting was about, use that detail. If they said their weekend was personal time even though Rize didn't track it, factor that in.`;

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "ANTHROPIC_API_KEY not set" },
      { status: 503 },
    );
  }

  let body: {
    state?: DebriefStateSnapshot;
    turns?: Turn[];
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.state) {
    return Response.json({ error: "state is required" }, { status: 400 });
  }

  const turns = body.turns ?? [];

  // Build the messages array. The conversation always starts with a user turn
  // that prompts Spiros to open the debrief. If `turns` is empty, we inject a
  // synthetic "Start the Oracle debrief." user message so the model produces
  // the opening.
  const messages: MessageParam[] = [];
  if (turns.length === 0) {
    messages.push({
      role: "user",
      content:
        "Start the Oracle debrief. Open with the shape of my week + your first specific question.",
    });
  } else {
    for (const t of turns) {
      if (t.role === "user") {
        if (t.toolResults && t.toolResults.length > 0) {
          messages.push({
            role: "user",
            content: t.toolResults.map((tr) => ({
              type: "tool_result" as const,
              tool_use_id: tr.tool_use_id,
              content: tr.content,
            })),
          });
        } else {
          messages.push({ role: "user", content: t.text ?? "" });
        }
      } else {
        const blocks: Array<TextBlock | ToolUseBlock> = [];
        if (t.text) {
          blocks.push({
            type: "text",
            text: t.text,
            citations: null,
          } as TextBlock);
        }
        for (const tu of t.toolUses ?? []) {
          blocks.push({
            type: "tool_use",
            id: tu.id,
            name: tu.name,
            input: tu.input as Record<string, unknown>,
          } as ToolUseBlock);
        }
        messages.push({ role: "assistant", content: blocks });
      }
    }
  }

  const fullSystem = `${SYSTEM}\n\n# Context for this Oracle\n\n${buildContextBlock(body.state)}`;

  const client = new Anthropic();
  try {
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      system: [
        {
          type: "text",
          text: fullSystem,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: TOOLS,
      messages,
    });

    const text = resp.content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    const allToolUses = resp.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );

    const finalizeUse = allToolUses.find(
      (b) => b.name === "finalize_debrief",
    );

    if (finalizeUse) {
      const input = finalizeUse.input as {
        headline?: string;
        sections?: Array<{ title: string; body: string }>;
      };
      if (!input.headline || !Array.isArray(input.sections)) {
        return Response.json(
          { error: "finalize_debrief missing required fields" },
          { status: 502 },
        );
      }
      // Even when finalizing, surface any sibling action tools so the client
      // can still apply them before showing the recap.
      const sideTools = allToolUses
        .filter((b) => b.name !== "finalize_debrief")
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));
      return Response.json({
        kind: "finalized",
        text,
        summary: {
          headline: input.headline,
          sections: input.sections,
        },
        toolUseId: finalizeUse.id,
        toolUses: sideTools,
        usage: resp.usage,
      });
    }

    if (allToolUses.length > 0) {
      return Response.json({
        kind: "tool_use",
        text,
        toolUses: allToolUses.map((b) => ({
          id: b.id,
          name: b.name,
          input: b.input,
        })),
        stopReason: resp.stop_reason,
        usage: resp.usage,
      });
    }

    return Response.json({
      kind: "message",
      text,
      stopReason: resp.stop_reason,
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
