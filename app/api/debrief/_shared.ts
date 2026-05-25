export type DebriefStateSnapshot = {
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
        group: string;
        sub: string;
        description: string;
      }>;
    }>;
  };
  manualEntries?: Array<{
    dayISO: string;
    startHHMM: string;
    minutes: number;
    sub: string;
    description: string;
  }>;
  calendarEvents?: Array<{
    title: string;
    startISO: string;
    minutes: number;
    attendees?: string[];
    location?: string;
    description?: string;
  }>;
};

export function buildContextBlock(state: DebriefStateSnapshot): string {
  const itemsList =
    state.items.length === 0
      ? "(none)"
      : state.items
          .map(
            (i) =>
              `- ${i.done ? "[DONE] " : ""}${i.title} | RICE ${i.reach}/${i.impact}/${i.confidence}/${i.effort} | est ${i.estHours}h, ${i.progress}% done${i.category ? ` | ${i.category}` : ""}${i.note ? ` | note: ${i.note}` : ""}`,
          )
          .join("\n");

  const timeBlock = state.timeSummary
    ? `Total tracked: ${Math.floor(state.timeSummary.totalMinutes / 60)}h ${state.timeSummary.totalMinutes % 60}m

Work breakdown:
${state.timeSummary.work.map((s) => `  - ${s.name}: ${Math.round(s.minutes)}m`).join("\n") || "  (none)"}

Personal breakdown:
${state.timeSummary.personal.map((s) => `  - ${s.name}: ${Math.round(s.minutes)}m`).join("\n") || "  (none)"}

Uncategorized: ${state.timeSummary.uncategorized.count} entries, ${state.timeSummary.uncategorized.minutes}m

Day-by-day Rize entries:
${
  state.timeSummary.days
    ?.map(
      (d) =>
        `### ${d.dayLabel} — ${Math.floor(d.totalMinutes / 60)}h ${d.totalMinutes % 60}m\n${d.entries
          .map(
            (e) =>
              `- ${e.time} (${e.minutes}m, ${e.group}/${e.sub}): ${e.description}`,
          )
          .join("\n")}`,
    )
    .join("\n\n") ?? ""
}`
    : "(no Rize data uploaded)";

  const calendarBlock =
    state.calendarEvents && state.calendarEvents.length > 0
      ? `## Google Calendar events (${state.calendarEvents.length})
${state.calendarEvents
  .map((e) => {
    const start = new Date(e.startISO);
    const day = start.toLocaleDateString("en-US", {
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
        ? ` with ${e.attendees.slice(0, 5).join(", ")}${e.attendees.length > 5 ? ` +${e.attendees.length - 5}` : ""}`
        : "";
    return `- ${day} ${time} (${e.minutes}m): "${e.title}"${att}${e.location ? ` @ ${e.location}` : ""}${e.description ? ` — ${e.description.slice(0, 120)}` : ""}`;
  })
  .join("\n")}`
      : "## Google Calendar\n(not connected)";

  const manualBlock =
    state.manualEntries && state.manualEntries.length > 0
      ? `## Manual entries already logged this Oracle (DO NOT duplicate these)
${state.manualEntries
  .map(
    (e) =>
      `- ${e.dayISO} ${e.startHHMM} (${e.minutes}m) ${e.sub}: ${e.description}`,
  )
  .join("\n")}`
      : "## Manual entries already logged this Oracle\n(none yet)";

  return `# Oracle: ${state.weekStart}

## Priorities the user set
${itemsList}

## Brain dump
${state.transcript || "(empty)"}

## Time tracker (Rize)
${timeBlock}

${manualBlock}

${calendarBlock}`;
}
