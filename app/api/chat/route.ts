import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  Tool,
  TextBlock,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

type StateSnapshot = {
  weekStart: string;
  items: Array<{
    id: string;
    title: string;
    note?: string;
    reach: number;
    impact: number;
    confidence: number;
    effort: number;
    estHours: number;
    progress: number;
    category?: string;
    done?: boolean;
    nextAction?: string;
  }>;
  transcript: string;
  timeSummary?: {
    totalMinutes: number;
    work: { name: string; minutes: number }[];
    personal: { name: string; minutes: number }[];
    uncategorized: { count: number; minutes: number };
    days?: Array<{
      dayLabel: string;
      totalMinutes: number;
      entries: Array<{
        time: string;
        minutes: number;
        sub: string;
        group: string;
        description: string;
      }>;
    }>;
  };
  calendarImage?: string; // data URL
  calendarEvents?: Array<{
    title: string;
    startISO: string;
    minutes: number;
    attendees?: string[];
    location?: string;
    description?: string;
  }>;
};

type Turn = {
  role: "user" | "assistant";
  text?: string;
  toolUses?: Array<{ id: string; name: string; input: unknown }>;
  toolResults?: Array<{ tool_use_id: string; content: string }>;
};

const TOOLS: Tool[] = [
  {
    name: "add_priority",
    description:
      "Add a new priority to the current Oracle. Use this when the user asks to add a task, decision, or initiative.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Specific, action-oriented title" },
        note: { type: "string", description: "One sentence of context" },
        reach: { type: "integer", minimum: 1, maximum: 10 },
        impact: { type: "integer", minimum: 1, maximum: 10 },
        confidence: { type: "integer", minimum: 1, maximum: 10 },
        effort: { type: "integer", minimum: 1, maximum: 10 },
        estHours: { type: "number", description: "Realistic hours estimate" },
        category: {
          type: "string",
          enum: [
            "VE Main",
            "VE Consumer Rebuild",
            "VE Intake Agent",
            "Spiros",
            "Email",
            "Personal",
            "Other",
          ],
        },
        nextAction: {
          type: "string",
          description: "Single next physical step",
        },
      },
      required: [
        "title",
        "reach",
        "impact",
        "confidence",
        "effort",
        "estHours",
      ],
    },
  },
  {
    name: "update_priority",
    description:
      "Update fields on an existing priority. Provide the id and only the fields that change.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        note: { type: "string" },
        reach: { type: "integer", minimum: 1, maximum: 10 },
        impact: { type: "integer", minimum: 1, maximum: 10 },
        confidence: { type: "integer", minimum: 1, maximum: 10 },
        effort: { type: "integer", minimum: 1, maximum: 10 },
        estHours: { type: "number" },
        progress: { type: "integer", minimum: 0, maximum: 100 },
        category: { type: "string" },
        nextAction: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "mark_done",
    description: "Mark a priority as done by id.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "reopen_priority",
    description: "Reopen a previously-done priority by id.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "delete_priority",
    description:
      "Delete a priority by id. Only use when the user is explicit about deletion.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
];

function buildSystemPrompt(state: StateSnapshot): string {
  const itemsList =
    state.items.length === 0
      ? "(none yet)"
      : state.items
          .map((i) => {
            const score = (
              (i.reach * i.impact * i.confidence) /
              Math.max(1, i.effort)
            ).toFixed(1);
            return `- id=${i.id} | "${i.title}" | RICE ${i.reach}/${i.impact}/${i.confidence}/${i.effort} score=${score} | ${i.estHours}h est, ${i.progress}% done${i.done ? " (DONE)" : ""}${i.category ? ` | ${i.category}` : ""}${i.note ? `\n  note: ${i.note}` : ""}${i.nextAction ? `\n  next: ${i.nextAction}` : ""}`;
          })
          .join("\n");

  const dayBlock = state.timeSummary?.days?.length
    ? `\n\n## Day-by-day entries (from Rize CSV)\n${state.timeSummary.days
        .map(
          (d) =>
            `### ${d.dayLabel} — ${Math.floor(d.totalMinutes / 60)}h ${d.totalMinutes % 60}m total\n${d.entries
              .map(
                (e) =>
                  `- ${e.time} (${e.minutes}m, ${e.group}/${e.sub}): ${e.description}`,
              )
              .join("\n")}`,
        )
        .join("\n\n")}`
    : "";

  const timeBlock = state.timeSummary
    ? `Time tracked this Oracle: ${Math.floor(state.timeSummary.totalMinutes / 60)}h ${state.timeSummary.totalMinutes % 60}m
Work:
${state.timeSummary.work.map((s) => `  - ${s.name}: ${Math.round(s.minutes)}m`).join("\n") || "  (nothing categorized as Work)"}
Personal:
${state.timeSummary.personal.map((s) => `  - ${s.name}: ${Math.round(s.minutes)}m`).join("\n") || "  (nothing categorized as Personal)"}
Uncategorized: ${state.timeSummary.uncategorized.count} entries, ${state.timeSummary.uncategorized.minutes}m${dayBlock}`
    : "No Rize data uploaded yet.";

  return `You are Spiros, the user's prioritization and time-tracking copilot. You operate ON their current Oracle (this week's session). You can read their current state and modify it through tools.

# Current Oracle: ${state.weekStart}

## Priorities (RICE = Reach × Impact × Confidence ÷ Effort)
${itemsList}

## Time tracker
${timeBlock}

## Brain dump (the user's notes for this week)
${state.transcript || "(empty)"}

${
  state.calendarEvents && state.calendarEvents.length > 0
    ? `## Google Calendar events this Oracle (${state.calendarEvents.length})
${state.calendarEvents
  .map((e) => {
    const start = new Date(e.startISO);
    const dayLabel = start.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const time = start.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
    const att =
      e.attendees && e.attendees.length > 0
        ? ` with ${e.attendees.slice(0, 4).join(", ")}${e.attendees.length > 4 ? ` +${e.attendees.length - 4}` : ""}`
        : "";
    return `- ${dayLabel} ${time} (${e.minutes}m): "${e.title}"${att}${e.location ? ` @ ${e.location}` : ""}`;
  })
  .join("\n")}`
    : ""
}

# How to operate

- When the user asks you to add a priority, call add_priority. Give realistic scores — be conservative on confidence if details are vague.
- When the user asks you to change scores, hours, category, or progress on an existing priority, call update_priority.
- When the user says something is done, call mark_done.
- When the user asks analytical questions ("what did I spend most time on", "is my time aligned with priorities"), answer in prose using the data above — no tool needed.
- When you can call a tool, do it directly rather than asking for confirmation. The user is iterating fast and trusts you to act. Only ask clarifying questions if a tool call would clearly be wrong without more info.
- Match the user's voice in your text: brief, direct, no hedging, no preamble like "I'd be happy to". Just do it and report what you did in one short sentence.
- Use the calendar screenshot (if attached) as visual reference for what the user actually had scheduled.`;
}

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      {
        error: "ANTHROPIC_API_KEY not set",
        help: "Add ANTHROPIC_API_KEY to Vercel env vars and redeploy.",
      },
      { status: 503 },
    );
  }

  let body: { messages?: Turn[]; state?: StateSnapshot };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const turns = body.messages ?? [];
  const state = body.state;
  if (!state) {
    return Response.json({ error: "state is required" }, { status: 400 });
  }

  // Convert turns to Anthropic message params
  const messages: MessageParam[] = turns.map((t) => {
    if (t.role === "user") {
      if (t.toolResults && t.toolResults.length > 0) {
        return {
          role: "user",
          content: t.toolResults.map((tr) => ({
            type: "tool_result" as const,
            tool_use_id: tr.tool_use_id,
            content: tr.content,
          })),
        };
      }
      // Plain text user turn — optionally attach calendar image on first turn
      return {
        role: "user",
        content: t.text ?? "",
      };
    }
    // assistant
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
    return { role: "assistant", content: blocks };
  });

  // Attach calendar image to the most recent user text turn (vision context)
  if (state.calendarImage) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "user") continue;
      if (typeof m.content !== "string") continue;
      const text = m.content;
      const match = state.calendarImage.match(
        /^data:(image\/[a-zA-Z+]+);base64,(.*)$/,
      );
      if (!match) break;
      const mediaType = match[1];
      const data = match[2];
      m.content = [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType as
              | "image/jpeg"
              | "image/png"
              | "image/gif"
              | "image/webp",
            data,
          },
        },
        { type: "text", text },
      ];
      break;
    }
  }

  if (messages.length === 0) {
    return Response.json(
      { error: "No messages to process" },
      { status: 400 },
    );
  }

  const client = new Anthropic();

  try {
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: [
        {
          type: "text",
          text: buildSystemPrompt(state),
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

    const toolUses = resp.content
      .filter((b): b is ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    return Response.json({
      text,
      toolUses,
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
