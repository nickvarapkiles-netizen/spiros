import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

type CalEvent = {
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

type ParsedProp = {
  key: string;
  params: Record<string, string>;
  value: string;
};

type ParsedEvent = Map<string, ParsedProp[]>;

/** Unfold lines per RFC 5545: lines starting with space/tab continue the previous. */
function unfold(text: string): string[] {
  const raw = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function parseProp(line: string): ParsedProp | null {
  // Split on the first ":" that's not inside quotes
  let colon = -1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = left.split(";");
  const key = parts[0].toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf("=");
    if (eq > 0) {
      params[parts[i].slice(0, eq).toUpperCase()] = parts[i]
        .slice(eq + 1)
        .replace(/^"|"$/g, "");
    }
  }
  return { key, params, value: unescapeText(value) };
}

function unescapeText(s: string): string {
  return s
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/** Parse a date-time value. Supports YYYYMMDDTHHMMSSZ, YYYYMMDDTHHMMSS (local
 * w/ TZID), and YYYYMMDD (date-only). Returns a UTC Date. */
function parseDateTime(val: string, params: Record<string, string>): Date | null {
  const m = val.match(
    /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/,
  );
  if (!m) return null;
  const [, y, mo, d, hh = "0", mm = "0", ss = "0", z] = m;
  const yi = +y,
    moi = +mo - 1,
    di = +d,
    hi = +hh,
    mi = +mm,
    si = +ss;

  if (!m[4]) {
    // DATE only — treat as start of day UTC for our purposes
    return new Date(Date.UTC(yi, moi, di, 0, 0, 0));
  }
  if (z === "Z") {
    return new Date(Date.UTC(yi, moi, di, hi, mi, si));
  }
  // Has TZID or floating local time — without full TZ database support,
  // treat as UTC. Close enough for displaying day-level info from a Google
  // calendar (which exports nearly everything as UTC anyway).
  return new Date(Date.UTC(yi, moi, di, hi, mi, si));
}

function attendeeName(p: ParsedProp): string | null {
  if (p.params.CN) return p.params.CN;
  if (p.value) return p.value.replace(/^mailto:/i, "");
  return null;
}

type RRule = {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  byDay?: string[]; // SU MO TU WE TH FR SA
  until?: Date;
  count?: number;
};

function parseRRule(val: string): RRule | null {
  const parts = val.split(";").reduce(
    (acc, p) => {
      const [k, v] = p.split("=");
      if (k && v) acc[k.toUpperCase()] = v;
      return acc;
    },
    {} as Record<string, string>,
  );
  const freq = parts.FREQ?.toUpperCase();
  if (!freq || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq))
    return null;
  const rule: RRule = {
    freq: freq as RRule["freq"],
    interval: parseInt(parts.INTERVAL ?? "1", 10) || 1,
  };
  if (parts.BYDAY) rule.byDay = parts.BYDAY.split(",");
  if (parts.UNTIL) {
    const u = parseDateTime(parts.UNTIL, {});
    if (u) rule.until = u;
  }
  if (parts.COUNT) rule.count = parseInt(parts.COUNT, 10) || undefined;
  return rule;
}

const DAY_MAP: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

/** Expand an RRULE into start-dates within [windowStart, windowEnd). */
function expandRRule(
  baseStart: Date,
  rule: RRule,
  windowStart: Date,
  windowEnd: Date,
): Date[] {
  const out: Date[] = [];
  const maxIter = 5000; // safety
  let iter = 0;
  let count = 0;

  // Hard upper bound for iteration regardless of rule
  const absoluteEnd = rule.until && rule.until < windowEnd ? rule.until : windowEnd;

  if (rule.freq === "DAILY") {
    let cur = new Date(baseStart);
    while (cur < absoluteEnd && iter++ < maxIter) {
      if (cur >= windowStart) {
        out.push(new Date(cur));
        count++;
        if (rule.count && count >= rule.count) break;
      }
      cur = new Date(cur.getTime() + rule.interval * 86400000);
    }
  } else if (rule.freq === "WEEKLY") {
    const targetDays = rule.byDay
      ? rule.byDay.map((d) => DAY_MAP[d]).filter((n) => n !== undefined)
      : [baseStart.getUTCDay()];
    // Walk week-by-week from base. Each week, check each target day.
    let weekStart = new Date(baseStart);
    // Snap weekStart to Sunday of its week (UTC)
    weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
    while (weekStart < absoluteEnd && iter++ < maxIter) {
      for (const day of targetDays) {
        const candidate = new Date(weekStart);
        candidate.setUTCDate(weekStart.getUTCDate() + day);
        candidate.setUTCHours(
          baseStart.getUTCHours(),
          baseStart.getUTCMinutes(),
          baseStart.getUTCSeconds(),
        );
        if (candidate < baseStart) continue;
        if (candidate < windowStart) continue;
        if (candidate >= absoluteEnd) continue;
        out.push(candidate);
        count++;
        if (rule.count && count >= rule.count) return out;
      }
      weekStart = new Date(
        weekStart.getTime() + rule.interval * 7 * 86400000,
      );
    }
  } else if (rule.freq === "MONTHLY") {
    // Same day-of-month as baseStart, monthly.
    let cur = new Date(baseStart);
    while (cur < absoluteEnd && iter++ < maxIter) {
      if (cur >= windowStart) {
        out.push(new Date(cur));
        count++;
        if (rule.count && count >= rule.count) break;
      }
      cur = new Date(
        Date.UTC(
          cur.getUTCFullYear(),
          cur.getUTCMonth() + rule.interval,
          cur.getUTCDate(),
          cur.getUTCHours(),
          cur.getUTCMinutes(),
          cur.getUTCSeconds(),
        ),
      );
    }
  } else if (rule.freq === "YEARLY") {
    let cur = new Date(baseStart);
    while (cur < absoluteEnd && iter++ < maxIter) {
      if (cur >= windowStart) {
        out.push(new Date(cur));
        count++;
        if (rule.count && count >= rule.count) break;
      }
      cur = new Date(
        Date.UTC(
          cur.getUTCFullYear() + rule.interval,
          cur.getUTCMonth(),
          cur.getUTCDate(),
          cur.getUTCHours(),
          cur.getUTCMinutes(),
          cur.getUTCSeconds(),
        ),
      );
    }
  }

  return out;
}

function parseICS(text: string): ParsedEvent[] {
  const lines = unfold(text);
  const events: ParsedEvent[] = [];
  let current: ParsedEvent | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = new Map();
    } else if (line === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
    } else if (current) {
      const prop = parseProp(line);
      if (!prop) continue;
      const list = current.get(prop.key) ?? [];
      list.push(prop);
      current.set(prop.key, list);
    }
  }
  return events;
}

function firstValue(ev: ParsedEvent, key: string): ParsedProp | undefined {
  return ev.get(key)?.[0];
}

export async function POST(req: NextRequest) {
  let body: { icalUrl?: string; weekStartISO?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const url = String(body.icalUrl ?? "").trim();
  const weekStartISO = String(body.weekStartISO ?? "").trim();

  if (!url) {
    return Response.json({ error: "icalUrl is required" }, { status: 400 });
  }
  if (!/^https?:\/\//.test(url)) {
    return Response.json(
      { error: "icalUrl must be http(s)" },
      { status: 400 },
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStartISO)) {
    return Response.json(
      { error: "weekStartISO must be YYYY-MM-DD" },
      { status: 400 },
    );
  }

  const [y, m, d] = weekStartISO.split("-").map(Number);
  // Window is the local-day Sunday→Sunday range. Use UTC date math so it
  // matches our UTC date parsing above.
  const windowStart = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const windowEnd = new Date(Date.UTC(y, m - 1, d + 7, 0, 0, 0));

  let icsText: string;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Spiros/1.0" },
      cache: "no-store",
    });
    if (!res.ok) {
      return Response.json(
        { error: `Calendar URL returned ${res.status}` },
        { status: 502 },
      );
    }
    icsText = await res.text();
  } catch (e) {
    return Response.json(
      {
        error: "Couldn't fetch calendar URL",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 502 },
    );
  }

  let parsed: ParsedEvent[];
  try {
    parsed = parseICS(icsText);
  } catch (e) {
    return Response.json(
      {
        error: "Couldn't parse iCal content",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 502 },
    );
  }

  const events: CalEvent[] = [];

  for (const ev of parsed) {
    const summary = firstValue(ev, "SUMMARY")?.value ?? "(no title)";
    const description = firstValue(ev, "DESCRIPTION")?.value;
    const location = firstValue(ev, "LOCATION")?.value;
    const uid = firstValue(ev, "UID")?.value ?? Math.random().toString(36);
    const startProp = firstValue(ev, "DTSTART");
    const endProp = firstValue(ev, "DTEND");
    const rruleProp = firstValue(ev, "RRULE");
    if (!startProp) continue;
    const start = parseDateTime(startProp.value, startProp.params);
    if (!start) continue;
    const end =
      endProp && parseDateTime(endProp.value, endProp.params)
        ? parseDateTime(endProp.value, endProp.params)!
        : new Date(start.getTime() + 30 * 60 * 1000);
    const duration = end.getTime() - start.getTime();

    const attendeeProps = ev.get("ATTENDEE") ?? [];
    const attendees = attendeeProps
      .map((p) => attendeeName(p))
      .filter((s): s is string => !!s);

    const organizerProp = firstValue(ev, "ORGANIZER");
    const organizer = organizerProp ? attendeeName(organizerProp) : undefined;

    let occurrences: Date[];
    if (rruleProp) {
      const rule = parseRRule(rruleProp.value);
      if (!rule) {
        const t = start.getTime();
        occurrences =
          t >= windowStart.getTime() && t < windowEnd.getTime()
            ? [start]
            : [];
      } else {
        occurrences = expandRRule(start, rule, windowStart, windowEnd);
      }
    } else {
      const t = start.getTime();
      occurrences =
        t >= windowStart.getTime() && t < windowEnd.getTime() ? [start] : [];
    }

    for (const occStart of occurrences) {
      const occEnd = new Date(occStart.getTime() + duration);
      events.push({
        uid: `${uid}-${occStart.toISOString()}`,
        title: summary,
        startISO: occStart.toISOString(),
        endISO: occEnd.toISOString(),
        minutes: Math.round(duration / 60000),
        description,
        location,
        attendees: attendees.length > 0 ? attendees : undefined,
        organizer: organizer ?? undefined,
      });
    }
  }

  events.sort((a, b) => a.startISO.localeCompare(b.startISO));

  return Response.json({
    events,
    count: events.length,
    windowStartISO: windowStart.toISOString(),
    windowEndISO: windowEnd.toISOString(),
  });
}
