// ─── Types ──────────────────────────────────────────────────────

export type RiceItem = {
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
  doneAt?: string;
  subtasks?: { text: string; done: boolean }[];
  nextAction?: string;
  createdAt: number;
};

export type OracleSession = {
  weekStart: string; // ISO YYYY-MM-DD of the Sunday that starts the week
  items: RiceItem[];
  transcript: string;
  riseEntries?: RizeEntry[];
  rizeUploadedAt?: number;
  manualEntries?: RizeEntry[]; // entries added via chat (e.g. Personal time)
  categoryOverrides?: CategoryOverride[]; // user-driven recategorizations
  hiddenEntryIds?: string[]; // entries the user has hidden from the time tracker
  calendarImage?: string; // data URL
  calendarUploadedAt?: number;
  calendarEvents?: CalEvent[];
  calendarFetchedAt?: number;
  chat?: ChatMessage[];
  debrief?: Debrief;
};

export type CategoryOverride = {
  /** Substring (case-insensitive) match against entry description. */
  pattern?: string;
  /** Match entries whose CURRENT sub equals this (case-insensitive). */
  fromSub?: string;
  group: "Work" | "Personal";
  sub: string;
};

export type Debrief = {
  status: "idle" | "in_progress" | "finalizing" | "ready";
  messages?: ChatMessage[];
  summary?: DebriefSummary;
  generatedAt?: number;
  // Legacy fields kept so older sessions don't crash on load
  questions?: { id: string; text: string; answer?: string }[];
};

export type DebriefSummary = {
  headline: string;
  sections: { title: string; body: string }[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text?: string;
  toolCalls?: ChatToolCall[];
  createdAt: number;
};

export type ChatToolCall = {
  name: string;
  input: Record<string, unknown>;
  result?: string; // human-readable summary of what was applied
};

export type RizeEntry = {
  id?: string; // stable id so entries can be hidden / edited
  startISO: string;
  endISO: string;
  description: string;
  minutes: number;
  group: "Work" | "Personal" | "Uncategorized";
  sub: string; // sub-category name within the group
};

/** Diverse, distinct hues per sub-category — each one is its own color on
 * the dark background so the eye can separate them at a glance. Brand gold
 * stays as the accent for the *headline* numbers; this palette is for data
 * points. */
export const SUB_COLORS: Record<string, string> = {
  // Work — varied saturated tones, all distinct from each other
  Projects: "#5fb886",            // green
  Strategy: "#a884e0",            // purple
  "Social media content": "#f08a3c", // orange
  Meetings: "#5b9cd4",            // blue
  Connections: "#d96fa6",         // pink
  // Personal — warm + cool mix
  Meditation: "#5fc9c4",          // teal
  Workouts: "#ef6b5e",            // coral
  Sauna: "#e6b252",               // warm gold (only one that stays gold-ish)
  "Cold plunge": "#7eb6e8",       // ice blue
  Dates: "#c79ce8",               // lavender
  // Fallback
  Uncategorized: "#9b9b9b",
};

/** Deterministic fallback color for any sub the user adds at runtime — picks
 * from a fixed extended palette by hashing the sub name so the same custom
 * name always gets the same color. */
const EXTENDED_PALETTE = [
  "#88c473", "#f2a83f", "#6798e0", "#c474c0", "#5fbcb5",
  "#e8775c", "#a8c45b", "#7c8de8", "#d8aa4a", "#c46a4a",
  "#5fa888", "#b87cd4", "#e89c5c", "#7cb8c8", "#d48ea2",
];

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function colorForSub(
  sub: string,
  _group: "Work" | "Personal" | "Uncategorized",
): string {
  if (SUB_COLORS[sub]) return SUB_COLORS[sub];
  if (!sub || _group === "Uncategorized") return SUB_COLORS.Uncategorized;
  return EXTENDED_PALETTE[hashString(sub) % EXTENDED_PALETTE.length];
}

export type SpirosState = {
  version: 1;
  sessions: Record<string, OracleSession>; // keyed by weekStart
  calendarIcalUrl?: string;
};

export type CalEvent = {
  uid: string;
  title: string;
  startISO: string;
  endISO: string;
  minutes: number;
  description?: string;
  location?: string;
  attendees?: string[];
  organizer?: string;
};

export type DateRangeId =
  | "today"
  | "yesterday"
  | "7d"
  | "30d"
  | "60d"
  | "90d";

// ─── Constants ──────────────────────────────────────────────────

export const STORAGE_KEY = "spiros.state.v1";

export const DATE_RANGES: {
  id: DateRangeId;
  label: string;
  multiplier: number;
  description: string;
}[] = [
  { id: "today",     label: "Today",     multiplier: 0.14, description: "today" },
  { id: "yesterday", label: "Yesterday", multiplier: 0.13, description: "yesterday" },
  { id: "7d",        label: "7 days",    multiplier: 1,    description: "last 7 days" },
  { id: "30d",       label: "30 days",   multiplier: 4.2,  description: "last 30 days" },
  { id: "60d",       label: "60 days",   multiplier: 8.4,  description: "last 60 days" },
  { id: "90d",       label: "90 days",   multiplier: 12.6, description: "last 90 days" },
];

// EDIT ME: replace with the projects / buckets you actually have on your
// plate. These show up in dropdowns when creating priorities and when the
// LLM tags them.
export const DEFAULT_CATEGORIES = [
  "Project A",
  "Project B",
  "Email",
  "Personal",
  "Other",
];

// ─── Date helpers ───────────────────────────────────────────────

/** Returns the ISO date (YYYY-MM-DD) of the Sunday that starts the
 * most recently COMPLETED Sun–Sat week — i.e., the Oracle window Nick reviews.
 * On Sun May 24 → May 17; on any other day → the Sunday before this one. */
export function weekStartFor(d: Date = new Date()): string {
  const local = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = local.getDay(); // Sun = 0 … Sat = 6
  local.setDate(local.getDate() - day - 7);
  return toISODate(local);
}

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function fromISODate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** "May 17 – May 23" for a Sunday-start ISO date */
export function formatWeekRange(weekStartISO: string): string {
  const start = fromISODate(weekStartISO);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const fmt = (d: Date) =>
    d.toLocaleString("en-US", { month: "short", day: "numeric" });
  return `${fmt(start)} – ${fmt(end)}`;
}

// ─── RICE math ──────────────────────────────────────────────────

export function riceScore(i: RiceItem): number {
  return +(((i.reach * i.impact * i.confidence) / Math.max(1, i.effort)).toFixed(1));
}

export function hoursLeft(i: RiceItem): number {
  return +((i.estHours * (1 - i.progress / 100)).toFixed(1));
}

// ─── Formatting ─────────────────────────────────────────────────

export function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function fmtHours(h: number): string {
  const whole = Math.floor(h);
  const m = Math.round((h - whole) * 60);
  if (whole === 0) return `${m}m`;
  if (m === 0) return `${whole}h`;
  return `${whole}h ${m}m`;
}

// ─── Storage ────────────────────────────────────────────────────

export function loadState(): SpirosState {
  if (typeof window === "undefined") return emptyState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as SpirosState;
    if (parsed?.version !== 1 || !parsed.sessions) return emptyState();
    return migrateEntryIds(migrateOracleKeys(parsed));
  } catch {
    return emptyState();
  }
}

/** Ensure every Rize + manual entry has a stable id. Without this, the
 * UI-side `ensureId` backfill generates a fresh id on every render — which
 * means hide / clear / per-entry operations stop working because the next
 * render swaps the id out from under us. */
function migrateEntryIds(state: SpirosState): SpirosState {
  let anyChange = false;
  const next: SpirosState["sessions"] = {};
  for (const [weekStart, s] of Object.entries(state.sessions)) {
    const fix = (e: RizeEntry): RizeEntry => {
      if (e.id) return e;
      anyChange = true;
      return { ...e, id: makeEntryId() };
    };
    const riseEntries = s.riseEntries?.map(fix);
    const manualEntries = s.manualEntries?.map(fix);
    next[weekStart] = { ...s, riseEntries, manualEntries };
  }
  return anyChange ? { ...state, sessions: next } : state;
}

/** One-time migration for the 2026-05-24 fix: weekStartFor used to return
 * THIS week's Sunday; now returns the previous Sunday. If the user has data
 * under a key that's exactly 7 days ahead of the current Oracle window AND
 * the current window is empty, relabel it. Safe no-op for fresh users. */
function migrateOracleKeys(state: SpirosState): SpirosState {
  const want = weekStartFor();
  if (state.sessions[want]) return state; // already correct
  const wantDate = fromISODate(want);
  const future = new Date(wantDate);
  future.setDate(future.getDate() + 7);
  const futureKey = toISODate(future);
  const futureSession = state.sessions[futureKey];
  if (!futureSession) return state; // nothing to migrate
  // Move the misplaced future session into the correct key.
  const { [futureKey]: _drop, ...rest } = state.sessions;
  return {
    ...state,
    sessions: {
      ...rest,
      [want]: { ...futureSession, weekStart: want },
    },
  };
}

export function saveState(state: SpirosState): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function emptyState(): SpirosState {
  return { version: 1, sessions: {} };
}

export function ensureSession(
  state: SpirosState,
  weekStart: string,
): SpirosState {
  if (state.sessions[weekStart]) return state;
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [weekStart]: { weekStart, items: [], transcript: "" },
    },
  };
}

export function newItem(partial: Partial<RiceItem> & { title: string }): RiceItem {
  return {
    id: crypto.randomUUID(),
    title: partial.title,
    note: partial.note,
    reach: partial.reach ?? 5,
    impact: partial.impact ?? 5,
    confidence: partial.confidence ?? 5,
    effort: partial.effort ?? 5,
    estHours: partial.estHours ?? 1,
    progress: partial.progress ?? 0,
    category: partial.category,
    subtasks: partial.subtasks,
    nextAction: partial.nextAction,
    createdAt: Date.now(),
  };
}

// ─── Seed data (only used on first visit when localStorage empty) ──

// Generic examples so first-time users see what the structure looks like
// without inheriting anyone's actual priorities. Delete these or hit
// "delete priority" on each card once you've added your own.

export function seedSession(weekStart: string): OracleSession {
  return {
    weekStart,
    transcript: `Welcome to Spiros — your weekly Oracle. This is the brain dump area.
Paste or type a stream-of-consciousness about what's on your plate
right now (projects, fires, ideas, blockers), then hit Process → RICE
and Spiros (Claude) will extract the discrete priorities and score
each one with RICE.`,
    items: [
      newItem({
        title: "Example priority — replace with something real",
        note: "Click expand on this card to see the full edit view: notes, sub-tasks, Next Action, RICE sliders. Hit 'Delete priority' to clear this example.",
        reach: 5, impact: 5, confidence: 5, effort: 3,
        estHours: 2, progress: 25,
        category: "Other",
        nextAction: "Delete me and add your own first priority",
      }),
    ],
  };
}

// ─── Rize CSV parsing & categorization ──────────────────────────

/** Parse a single CSV row, handling quoted fields with commas. */
function parseCSVRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

type CategoryRule = {
  pattern: RegExp;
  group: "Work" | "Personal";
  sub: string;
};

/** First match wins — list more specific patterns first. */
const CATEGORY_RULES: CategoryRule[] = [
  // Personal — specific first
  { pattern: /\b(cold plunge|ice bath)\b/i, group: "Personal", sub: "Cold plunge" },
  { pattern: /\bsauna\b/i, group: "Personal", sub: "Sauna" },
  { pattern: /\b(meditat\w*|breathwork)\b/i, group: "Personal", sub: "Meditation" },
  { pattern: /\b(workout|exercise|gym|lift\w*|cardio|run\b|running|yoga)\b/i, group: "Personal", sub: "Workouts" },
  { pattern: /\b(date with|dinner with|lunch with|date night|with my partner|with my girlfriend|with my wife)\b/i, group: "Personal", sub: "Dates" },

  // Work — meetings & connections
  { pattern: /\b(meeting|zoom|google meet|hangout|standup|stand-up|1:1|one on one|interview|call w\/|call with|video conference|conference call|met (with|for)|discovery session|onboarding session|onboarding call)\b/i, group: "Work", sub: "Meetings" },
  { pattern: /\b(reach\s*out|intro|introduction|networking|dm\b|outreach|follow up with|coffee with|coffee chat)\b/i, group: "Work", sub: "Connections" },

  // Work — social media content
  { pattern: /\b(metricool|instagram|tiktok|youtube|short-form|short form|video clip|video asset|video editing|edit video|podcast|buzzsprout|streamyard|social media|canva|design\w* (a )?banner|content schedul\w*|content plan)\b/i, group: "Work", sub: "Social media content" },

  // Work — strategy
  { pattern: /\b(strategy|strategic|roadmap|prioritiz\w*|planning|plan for|decision\w*|review (the )?week|weekly review|oracle|workshop|presentation|brainstorm\w*)\b/i, group: "Work", sub: "Strategy" },

  // Work — projects (catch-all for hands-on build work). EDIT THIS to
  // include keywords that match your specific projects/tools/codebases.
  { pattern: /\b(codebase|debug\w*|build\w*|deploy\w*|fix\w*|webhook|api|develop\w*|coding|review (the )?code|engineering|programming)\b/i, group: "Work", sub: "Projects" },
];

export function categorize(description: string): {
  group: "Work" | "Personal" | "Uncategorized";
  sub: string;
} {
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(description)) {
      return { group: rule.group, sub: rule.sub };
    }
  }
  return { group: "Uncategorized", sub: "Uncategorized" };
}

export function parseRizeCSV(text: string): RizeEntry[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = parseCSVRow(lines[0]).map((h) => h.trim());
  const idx = {
    start: header.indexOf("Start Time"),
    end: header.indexOf("End Time"),
    description: header.indexOf("Description"),
    length: header.indexOf("Length (seconds)"),
  };
  if (idx.start < 0 || idx.description < 0 || idx.length < 0) return [];

  const out: RizeEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVRow(lines[i]);
    const description = (row[idx.description] ?? "").trim();
    const seconds = parseInt(row[idx.length] ?? "0", 10);
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    const { group, sub } = categorize(description);
    out.push({
      id: makeEntryId(),
      startISO: row[idx.start] ?? "",
      endISO: row[idx.end] ?? "",
      description,
      minutes: Math.round(seconds / 60),
      group,
      sub,
    });
  }
  return out;
}

export function makeEntryId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `e_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Combine raw Rize entries + manual entries and apply category overrides.
 * Overrides are applied at read-time so Nick can undo them by clearing the
 * override list. Pattern match is case-insensitive substring. */
export function getEffectiveEntries(
  riseEntries?: RizeEntry[],
  manualEntries?: RizeEntry[],
  overrides?: CategoryOverride[],
  hiddenIds?: string[],
): RizeEntry[] {
  const hidden = new Set(hiddenIds ?? []);
  // Backfill ids for older entries that were saved before we tracked them.
  const ensureId = (e: RizeEntry): RizeEntry =>
    e.id ? e : { ...e, id: makeEntryId() };
  const all: RizeEntry[] = [
    ...(riseEntries ?? []).map(ensureId),
    ...(manualEntries ?? []).map(ensureId),
  ].filter((e) => !hidden.has(e.id!));
  if (!overrides || overrides.length === 0) return all;
  return all.map((e) => {
    for (const o of overrides) {
      const p = o.pattern?.toLowerCase();
      const fromSub = o.fromSub?.toLowerCase();
      const matchesPattern =
        !!p && e.description.toLowerCase().includes(p);
      const matchesSub =
        !!fromSub && e.sub.toLowerCase() === fromSub;
      if (matchesPattern || matchesSub) {
        return { ...e, group: o.group, sub: o.sub };
      }
    }
    return e;
  });
}

/** Filter Rize entries to a date window relative to `now`. */
export function filterEntriesByRange(
  entries: RizeEntry[],
  range: DateRangeId,
  now: Date = new Date(),
): RizeEntry[] {
  if (entries.length === 0) return [];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let startDate: Date;
  let endDate: Date | null = null;
  switch (range) {
    case "today":
      startDate = today;
      endDate = new Date(today.getTime() + 24 * 60 * 60 * 1000);
      break;
    case "yesterday":
      endDate = today;
      startDate = new Date(today.getTime() - 24 * 60 * 60 * 1000);
      break;
    case "7d":
      startDate = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case "30d":
      startDate = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case "60d":
      startDate = new Date(today.getTime() - 60 * 24 * 60 * 60 * 1000);
      break;
    case "90d":
      startDate = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
      break;
  }
  return entries.filter((e) => {
    const t = new Date(e.startISO).getTime();
    if (Number.isNaN(t)) return false;
    if (t < startDate.getTime()) return false;
    if (endDate && t >= endDate.getTime()) return false;
    return true;
  });
}

export type DayBucket = {
  dayISO: string; // YYYY-MM-DD
  dayLabel: string; // "Mon May 18"
  totalMinutes: number;
  entries: RizeEntry[];
};

/** Group entries by local calendar day, sorted earliest first. */
export function groupByDay(entries: RizeEntry[]): DayBucket[] {
  const map = new Map<string, RizeEntry[]>();
  for (const e of entries) {
    const t = new Date(e.startISO);
    if (Number.isNaN(t.getTime())) continue;
    const key = toISODate(t);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(e);
  }
  const out: DayBucket[] = [];
  for (const [key, group] of map) {
    const sorted = [...group].sort(
      (a, b) =>
        new Date(a.startISO).getTime() - new Date(b.startISO).getTime(),
    );
    out.push({
      dayISO: key,
      dayLabel: new Date(key + "T00:00:00").toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      }),
      totalMinutes: sorted.reduce((s, e) => s + e.minutes, 0),
      entries: sorted,
    });
  }
  return out.sort((a, b) => a.dayISO.localeCompare(b.dayISO));
}

/** Format an ISO timestamp into local HH:MM. */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Aggregate filtered entries into the bucket shape the UI expects. */
export function aggregateEntries(entries: RizeEntry[]): {
  totalMinutes: number;
  groups: CategoryGroup[];
  uncategorized: RizeEntry[];
} {
  const work = new Map<string, number>();
  const personal = new Map<string, number>();
  const uncat: RizeEntry[] = [];
  let total = 0;

  for (const e of entries) {
    total += e.minutes;
    if (e.group === "Work") {
      work.set(e.sub, (work.get(e.sub) ?? 0) + e.minutes);
    } else if (e.group === "Personal") {
      personal.set(e.sub, (personal.get(e.sub) ?? 0) + e.minutes);
    } else {
      uncat.push(e);
    }
  }

  const toGroup = (
    name: "Work" | "Personal",
    color: "gold" | "champagne",
    map: Map<string, number>,
  ): CategoryGroup => ({
    name,
    color,
    subs: [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, minutes]) => ({ name, minutes })),
  });

  return {
    totalMinutes: total,
    groups: [
      toGroup("Work", "gold", work),
      toGroup("Personal", "champagne", personal),
    ],
    uncategorized: uncat,
  };
}

// ─── Time tracker (still sample data for v1) ────────────────────

export type SubCategory = { name: string; minutes: number };
export type CategoryGroup = {
  name: "Work" | "Personal";
  color: "gold" | "champagne";
  subs: SubCategory[];
};

export const sampleTimeWeek = {
  weekLabel: "Week 21 · May 18 – 24, 2026",
  totalMinutes: 2261,
  deltaVsLastWeekMinutes: 143,
  groups: [
    {
      name: "Work",
      color: "gold",
      subs: [
        { name: "Projects",             minutes: 570 },
        { name: "Strategy",             minutes: 310 },
        { name: "Social media content", minutes: 225 },
        { name: "Meetings",             minutes: 260 },
        { name: "Connections",          minutes: 87  },
      ],
    },
    {
      name: "Personal",
      color: "champagne",
      subs: [
        { name: "Meditation",  minutes: 125 },
        { name: "Workouts",    minutes: 240 },
        { name: "Sauna",       minutes: 55  },
        { name: "Cold plunge", minutes: 28  },
        { name: "Dates",       minutes: 95  },
      ],
    },
  ] as CategoryGroup[],
};
