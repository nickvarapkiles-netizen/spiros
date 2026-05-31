"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalEvent,
  CategoryGroup,
  CategoryOverride,
  ChatMessage,
  ChatToolCall,
  DATE_RANGES,
  DEFAULT_CATEGORIES,
  DateRangeId,
  Debrief,
  DebriefSummary,
  OracleSession,
  RiceItem,
  RizeEntry,
  SpirosState,
  aggregateEntries,
  colorForSub,
  computeReadiness,
  emptyState,
  ensureSession,
  loadStateFromServer,
  saveStateToServer,
  type ReadinessRow,
  type ReadinessRowId,
  type ReadinessState,
  filterEntriesByRange,
  fmtHours,
  fmtMinutes,
  fmtTime,
  formatWeekRange,
  fromISODate,
  getEffectiveEntries,
  groupByDay,
  hoursLeft,
  loadState,
  newItem,
  parseRizeCSV,
  riceScore,
  saveState,
  seedSession,
  toISODate,
  weekStartFor,
} from "@/lib/spiros";
import {
  speak as ttsSpeak,
  speakDebrief as ttsSpeakDebrief,
  stop as ttsStop,
  ttsSupported,
} from "@/lib/tts";

export default function Home() {
  const [hydrated, setHydrated] = useState(false);
  const [state, setState] = useState<SpirosState>(emptyState());
  // serverSynced gates writes to /api/state: we never POST until we've
  // first GET'd the canonical state, otherwise a fresh browser would
  // clobber the server with its empty initial state.
  const [serverSynced, setServerSynced] = useState(false);
  const [syncStatus, setSyncStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [range, setRange] = useState<DateRangeId>("7d");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function flashToast(message: string) {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3000);
  }

  const todaysWeek = weekStartFor();
  const [viewedWeek, setViewedWeek] = useState<string>(todaysWeek);

  // Load order (so the UI is instant AND the server is the source of truth):
  //   1. Read localStorage immediately so the user sees their last cached
  //      state with no spinner.
  //   2. Fetch /api/state. If the server has data, it wins (handles the
  //      "different browser / cleared storage / new deploy URL" cases).
  //   3. If the server has no row yet, push the local state up so we
  //      seed the DB. From then on, every change is debounced-POSTed.
  useEffect(() => {
    let cancelled = false;
    let loaded = loadState();
    if (Object.keys(loaded.sessions).length === 0) {
      const seeded = seedSession(todaysWeek);
      loaded = { ...loaded, sessions: { [todaysWeek]: seeded } };
    } else if (!loaded.sessions[todaysWeek]) {
      // New week — pull forward last week's unfinished priorities so
      // Nick doesn't lose them every Sunday.
      loaded = ensureSession(loaded, todaysWeek, true);
    }
    setState(loaded);
    setHydrated(true);

    // Async: reconcile with server.
    (async () => {
      try {
        const serverState = await loadStateFromServer();
        if (cancelled) return;
        // Server "wins" only if it actually has session data. An empty
        // `{sessions:{}}` row (e.g. left behind by a dev/test seed)
        // should NOT clobber a browser that has real local data —
        // otherwise refreshing wipes the user. If both are empty,
        // local wins trivially and seeds the DB on first save.
        const serverHasData =
          serverState !== null &&
          Object.keys(serverState.sessions).length > 0;
        if (serverHasData) {
          let next = serverState!;
          if (!next.sessions[todaysWeek]) {
            // Same carry-forward rule as the local-load path.
            next = ensureSession(next, todaysWeek, true);
          }
          setState(next);
        } else {
          // Server is empty (no row, or stub row with no sessions) —
          // push the local cache up so the DB gets seeded with real
          // data on first run.
          await saveStateToServer(loaded);
        }
        if (!cancelled) setServerSynced(true);
      } catch (err) {
        console.warn("[spiros] server sync failed, using local cache", err);
        if (!cancelled) {
          // We failed to read the server. Don't enable server writes —
          // we'd risk overwriting good server data with stale local
          // data. localStorage keeps working as before.
          setSyncStatus("error");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // If a past Oracle exists but today's is empty, default the view to the
    // most recent week that ACTUALLY has data so the user lands on something
    // useful (their last work) instead of an empty new Oracle.
    const todaysSession = loaded.sessions[todaysWeek];
    const todaysIsEmpty =
      !todaysSession ||
      ((todaysSession.items?.length ?? 0) === 0 &&
        (todaysSession.riseEntries?.length ?? 0) === 0 &&
        (todaysSession.manualEntries?.length ?? 0) === 0);
    if (todaysIsEmpty) {
      const past = Object.keys(loaded.sessions)
        .filter((k) => k < todaysWeek)
        .filter((k) => {
          const s = loaded.sessions[k];
          return (
            (s.items?.length ?? 0) > 0 ||
            (s.riseEntries?.length ?? 0) > 0 ||
            (s.manualEntries?.length ?? 0) > 0
          );
        })
        .sort()
        .reverse();
      if (past.length > 0) setViewedWeek(past[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Make sure whichever week the user navigates to has at least an empty
  // session in state (so patchSession etc. work) — but never seed past weeks
  // with example data.
  useEffect(() => {
    if (!hydrated) return;
    if (state.sessions[viewedWeek]) return;
    setState((prev) => ensureSession(prev, viewedWeek));
  }, [viewedWeek, hydrated, state.sessions]);

  // Persist on every change after hydration.
  //   - localStorage write is synchronous and immediate (instant cache,
  //     also survives offline).
  //   - Server POST is debounced ~800ms after the last change so rapid
  //     edits (typing, slider drags) coalesce into one round trip.
  useEffect(() => {
    if (!hydrated) return;
    saveState(state);
    if (!serverSynced) return; // wait until we've reconciled with server

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSyncStatus("saving");
    saveTimerRef.current = setTimeout(async () => {
      try {
        await saveStateToServer(state);
        setSyncStatus("saved");
      } catch (err) {
        console.warn("[spiros] server save failed", err);
        setSyncStatus("error");
      }
    }, 800);
  }, [state, hydrated, serverSynced]);

  const session: OracleSession =
    state.sessions[viewedWeek] ?? {
      weekStart: viewedWeek,
      items: [],
      transcript: "",
    };

  function patchSession(
    patchOrUpdater:
      | Partial<OracleSession>
      | ((current: OracleSession) => Partial<OracleSession>),
  ) {
    setState((prev) => {
      const existing: OracleSession =
        prev.sessions[viewedWeek] ?? {
          weekStart: viewedWeek,
          items: [],
          transcript: "",
        };
      const patch =
        typeof patchOrUpdater === "function"
          ? patchOrUpdater(existing)
          : patchOrUpdater;
      return {
        ...prev,
        sessions: {
          ...prev.sessions,
          [viewedWeek]: { ...existing, ...patch },
        },
      };
    });
  }

  function setTranscript(t: string) {
    patchSession({ transcript: t });
  }

  function addItem(partial: Partial<RiceItem> & { title: string }) {
    patchSession({ items: [...session.items, newItem(partial)] });
    setShowNewForm(false);
  }

  function addItems(partials: (Partial<RiceItem> & { title: string })[]) {
    patchSession({
      items: [...session.items, ...partials.map((p) => newItem(p))],
    });
  }

  function setRiseEntries(entries: RizeEntry[]) {
    patchSession({
      riseEntries: entries,
      rizeUploadedAt: Date.now(),
    });
  }

  function setCalendarImage(dataUrl: string | null) {
    patchSession({
      calendarImage: dataUrl ?? undefined,
      calendarUploadedAt: dataUrl ? Date.now() : undefined,
    });
  }

  function setCalendarIcalUrl(url: string | null) {
    setState((prev) => ({
      ...prev,
      calendarIcalUrl: url ?? undefined,
    }));
  }

  function setCalendarEvents(events: CalEvent[] | null) {
    patchSession({
      calendarEvents: events ?? undefined,
      calendarFetchedAt: events ? Date.now() : undefined,
    });
  }

  function toggleLock(id: ReadinessRowId) {
    patchSession((cur) => {
      const cur_ = cur.lockedInputs ?? {};
      return {
        lockedInputs: { ...cur_, [id]: !cur_[id] },
      };
    });
  }

  function setDebrief(debrief: Debrief | null) {
    patchSession({ debrief: debrief ?? undefined });
  }

  function hideEntry(id: string) {
    patchSession((cur) => ({
      hiddenEntryIds: [...(cur.hiddenEntryIds ?? []), id],
    }));
  }

  function unhideAllEntries() {
    if (!confirm("Restore all hidden time-tracker entries?")) return;
    patchSession({ hiddenEntryIds: [] });
  }

  function addManualEntry(entry: RizeEntry) {
    patchSession((cur) => ({
      manualEntries: [...(cur.manualEntries ?? []), entry],
    }));
  }

  function updateManualEntry(id: string, patch: Partial<RizeEntry>) {
    patchSession((cur) => ({
      manualEntries: (cur.manualEntries ?? []).map((e) =>
        e.id === id ? { ...e, ...patch } : e,
      ),
    }));
  }

  /** Hide every entry whose CURRENT effective sub matches `sub`. Reads from
   * the latest state to include manual entries + overrides. */
  function clearSub(sub: string) {
    let appliedCount = 0;
    patchSession((cur) => {
      const effective = getEffectiveEntries(
        cur.riseEntries,
        cur.manualEntries,
        cur.categoryOverrides,
        cur.hiddenEntryIds,
      );
      const idsToHide = effective
        .filter((e) => e.sub.toLowerCase() === sub.toLowerCase())
        .map((e) => e.id!)
        .filter(Boolean);
      appliedCount = idsToHide.length;
      if (idsToHide.length === 0) return {};
      return {
        hiddenEntryIds: [
          ...(cur.hiddenEntryIds ?? []),
          ...idsToHide,
        ],
      };
    });
    if (appliedCount > 0) {
      flashToast(`✓ Hid ${appliedCount} entr${appliedCount === 1 ? "y" : "ies"} from "${sub}"`);
    } else {
      flashToast(`No entries found in "${sub}" — nothing to hide`);
    }
  }

  /** Move a single time-tracker entry into a new group+sub. Used when
   * Nick clicks "move" on one row inside an expanded bucket. Persists
   * as a CategoryOverride so the move survives refresh and shows up
   * everywhere the entry is rendered. */
  function recategorizeEntry(
    entryId: string,
    toGroup: "Work" | "Personal",
    toSub: string,
  ) {
    patchSession((cur) => {
      // Drop any existing per-entry override for this entry so we don't
      // accumulate stale overrides on repeated moves.
      const filtered = (cur.categoryOverrides ?? []).filter(
        (o) => o.entryId !== entryId,
      );
      return {
        categoryOverrides: [
          ...filtered,
          { entryId, group: toGroup, sub: toSub },
        ],
      };
    });
    flashToast(`✓ Moved entry → ${toGroup}/${toSub}`);
  }

  /** Add a sub→sub override so all entries currently tagged with `fromSub`
   * display under the new group/sub. */
  function recategorizeSub(
    fromSub: string,
    toGroup: "Work" | "Personal",
    toSub: string,
  ) {
    let matchCount = 0;
    patchSession((cur) => {
      const effective = getEffectiveEntries(
        cur.riseEntries,
        cur.manualEntries,
        cur.categoryOverrides,
        cur.hiddenEntryIds,
      );
      matchCount = effective.filter(
        (e) => e.sub.toLowerCase() === fromSub.toLowerCase(),
      ).length;
      return {
        categoryOverrides: [
          ...(cur.categoryOverrides ?? []),
          { fromSub, group: toGroup, sub: toSub },
        ],
      };
    });
    if (matchCount > 0) {
      flashToast(
        `✓ Moved ${matchCount} entr${matchCount === 1 ? "y" : "ies"} from "${fromSub}" → ${toGroup}/${toSub}`,
      );
    } else {
      flashToast(`No entries found in "${fromSub}" — override saved anyway`);
    }
  }

  function updateItem(id: string, patch: Partial<RiceItem>) {
    patchSession({
      items: session.items.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    });
  }

  function deleteItem(id: string) {
    patchSession({ items: session.items.filter((i) => i.id !== id) });
    if (expandedId === id) setExpandedId(null);
  }

  function markDone(id: string) {
    updateItem(id, {
      done: true,
      doneAt: new Date().toISOString().slice(0, 10),
    });
    if (expandedId === id) setExpandedId(null);
  }

  function reopen(id: string) {
    updateItem(id, { done: false, doneAt: undefined });
  }

  const active = session.items.filter((i) => !i.done);
  const done = session.items.filter((i) => i.done);

  const ranked = useMemo(
    () =>
      [...active]
        .map((i) => ({ ...i, score: riceScore(i) }))
        .sort((a, b) => b.score - a.score),
    [active],
  );
  const topScore = ranked[0]?.score ?? 1;

  return (
    <main className="mx-auto max-w-7xl px-6 py-8 w-full">
      <Header weekStart={viewedWeek} />
      <WeekPicker
        viewedWeek={viewedWeek}
        todaysWeek={todaysWeek}
        sessions={state.sessions}
        onPick={setViewedWeek}
      />
      <WeeklyReadinessStrip
        readiness={computeReadiness(session)}
        onToggleLock={toggleLock}
        syncStatus={syncStatus}
      />
      <DebriefPanel
        session={session}
        onSetDebrief={setDebrief}
        onPatchSession={patchSession}
        buildStateSnapshot={() => buildDebriefSnapshot(session)}
      />
      <ChatPanel
        session={session}
        onPatchSession={patchSession}
        onAddItem={addItem}
        onUpdateItem={updateItem}
        onMarkDone={markDone}
        onReopen={reopen}
        onDelete={deleteItem}
      />
      <TimeTrackerSection
        range={range}
        onRangeChange={setRange}
        session={session}
        icalUrl={state.calendarIcalUrl}
        onIcalUrlChange={setCalendarIcalUrl}
        onCalendarEvents={setCalendarEvents}
        onRiseUpload={setRiseEntries}
        onHideEntry={hideEntry}
        onUnhideAll={unhideAllEntries}
        onAddManualEntry={addManualEntry}
        onUpdateManualEntry={updateManualEntry}
        onClearSub={clearSub}
        onRecategorizeSub={recategorizeSub}
        onRecategorizeEntry={recategorizeEntry}
      />
      <StrategySection
        transcript={session.transcript}
        onTranscriptChange={setTranscript}
        ranked={ranked}
        topScore={topScore}
        expandedId={expandedId}
        onToggleExpand={(id) =>
          setExpandedId((cur) => (cur === id ? null : id))
        }
        onUpdateItem={updateItem}
        onMarkDone={markDone}
        onDelete={deleteItem}
        showNewForm={showNewForm}
        onShowNewForm={() => setShowNewForm(true)}
        onHideNewForm={() => setShowNewForm(false)}
        onAddItem={addItem}
        onAddItems={addItems}
      />
      {done.length > 0 && (
        <DoneSection
          items={done}
          onReopen={reopen}
          onDelete={deleteItem}
          rangeLabel={`this Oracle · ${formatWeekRange(viewedWeek)}`}
        />
      )}
      <footer className="mt-12 pt-6 border-t border-[var(--hairline)] text-xs opacity-50 flex justify-between">
        <span>Spiros · The Oracle · {formatWeekRange(viewedWeek)}</span>
        <span>v0.3 · Rize CSV · calendar · Claude brain dump</span>
      </footer>
      {toast && (
        <div
          style={{
            backgroundColor: "var(--gold)",
            color: "#000",
            boxShadow: "0 8px 32px rgba(212,175,55,0.35)",
          }}
          className="fixed bottom-6 right-6 z-50 rounded-lg px-4 py-3 text-sm font-semibold max-w-md animate-[fadeIn_0.2s_ease-out]"
        >
          {toast}
        </div>
      )}
    </main>
  );
}

/* ─── Debrief snapshot helper ────────────────────────────────── */

function buildDebriefSnapshot(session: OracleSession) {
  let timeSummary: object | undefined;
  const effective = getEffectiveEntries(
    session.riseEntries,
    session.manualEntries,
    session.categoryOverrides,
  );
  if (effective.length > 0) {
    const agg = aggregateEntries(effective);
    const work = agg.groups.find((g) => g.name === "Work");
    const personal = agg.groups.find((g) => g.name === "Personal");
    const days = groupByDay(effective).map((d) => ({
      dayLabel: d.dayLabel,
      totalMinutes: d.totalMinutes,
      entries: d.entries.map((e) => ({
        time: fmtTime(e.startISO),
        minutes: e.minutes,
        group: e.group,
        sub: e.sub,
        description: e.description,
      })),
    }));
    timeSummary = {
      totalMinutes: agg.totalMinutes,
      work: work?.subs ?? [],
      personal: personal?.subs ?? [],
      uncategorized: {
        count: agg.uncategorized.length,
        minutes: agg.uncategorized.reduce((s, e) => s + e.minutes, 0),
      },
      days,
    };
  }
  const calendarEvents = session.calendarEvents?.map((e) => ({
    title: e.title,
    startISO: e.startISO,
    minutes: e.minutes,
    attendees: e.attendees,
    location: e.location,
    description: e.description,
  }));
  return {
    weekStart: session.weekStart,
    items: session.items,
    transcript: session.transcript,
    timeSummary,
    calendarEvents,
  };
}

/* ─── Debrief panel (Jarvis-style chat) ──────────────────────── */

function DebriefPanel({
  session,
  onSetDebrief,
  onPatchSession,
  buildStateSnapshot,
}: {
  session: OracleSession;
  onSetDebrief: (d: Debrief | null) => void;
  onPatchSession: (
    patchOrUpdater:
      | Partial<OracleSession>
      | ((current: OracleSession) => Partial<OracleSession>),
  ) => void;
  buildStateSnapshot: () => object;
}) {
  const debrief = session.debrief;
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [ttsRate, setTtsRate] = useState(1.05);
  const [isReadingDebrief, setIsReadingDebrief] = useState(false);
  const [mounted, setMounted] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = debrief?.messages ?? [];

  // ttsSupported() reads window, so it differs SSR vs client — only
  // expose TTS controls after mount to avoid hydration mismatch.
  useEffect(() => {
    setMounted(true);
  }, []);
  const ttsOK = mounted && ttsSupported();

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length, loading]);

  // Stop any TTS when the component unmounts or the user navigates away.
  useEffect(() => {
    return () => ttsStop();
  }, []);

  function speakIfEnabled(text: string) {
    if (!ttsEnabled || !text.trim()) return;
    if (!ttsSupported()) return;
    ttsSpeak(text, { rate: ttsRate });
  }

  type ToolApply = (current: OracleSession) => Partial<OracleSession>;

  function applyToolCall(
    name: string,
    input: Record<string, unknown>,
  ): { result: string; apply: ToolApply | null } {
    try {
      if (name === "add_personal_entries") {
        const raw = (input.entries as Array<Record<string, unknown>>) ?? [];
        const added: RizeEntry[] = [];
        for (const e of raw) {
          const dayISO = String(e.dayISO ?? "");
          const startHHMM = String(e.startHHMM ?? "07:00");
          const minutes = Math.max(1, Math.round(Number(e.minutes) || 0));
          const sub = String(e.sub ?? "Other");
          const description = String(e.description ?? `${sub} time`);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dayISO) || minutes <= 0) continue;
          const [hh, mm] = startHHMM.split(":").map((s) => parseInt(s, 10));
          const [yy, mo, dd] = dayISO.split("-").map(Number);
          const start = new Date(yy, mo - 1, dd, hh || 7, mm || 0, 0);
          const end = new Date(start.getTime() + minutes * 60000);
          added.push({
            id:
              typeof crypto !== "undefined" && "randomUUID" in crypto
                ? crypto.randomUUID()
                : `s_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
            startISO: start.toISOString(),
            endISO: end.toISOString(),
            description,
            minutes,
            group: "Personal",
            sub,
          });
        }
        if (added.length === 0) {
          return { result: "no valid entries to add", apply: null };
        }
        const totalM = added.reduce((s, e) => s + e.minutes, 0);
        return {
          result: `added ${added.length} Personal ${added.length === 1 ? "entry" : "entries"} (${totalM}m total)`,
          apply: (cur) => ({
            manualEntries: [...(cur.manualEntries ?? []), ...added],
          }),
        };
      }
      if (
        name === "recategorize_entries" ||
        name === "recategorize_rize_entries"
      ) {
        const pattern = String(input.pattern ?? "").trim();
        const fromSub = String(input.fromSub ?? "").trim();
        const group = (input.group as "Work" | "Personal") ?? "Work";
        const sub = String(input.sub ?? "");
        if ((!pattern && !fromSub) || !sub) {
          return {
            result: "skipped — need pattern OR fromSub, plus a target sub",
            apply: null,
          };
        }
        const newOverride: CategoryOverride = { group, sub };
        if (pattern) newOverride.pattern = pattern;
        if (fromSub) newOverride.fromSub = fromSub;

        // Count matching entries for the result message. Look across Rize +
        // manual since the override applies to both.
        const allEntries: RizeEntry[] = [
          ...(session.riseEntries ?? []),
          ...(session.manualEntries ?? []),
        ];
        const matchCount = allEntries.filter((e) => {
          const matchesPattern =
            !!pattern &&
            e.description.toLowerCase().includes(pattern.toLowerCase());
          const matchesSub =
            !!fromSub &&
            e.sub.toLowerCase() === fromSub.toLowerCase();
          return matchesPattern || matchesSub;
        }).length;
        const filterDesc = fromSub
          ? `sub="${fromSub}"`
          : `pattern "${pattern}"`;
        return {
          result: `recategorized ${matchCount} ${matchCount === 1 ? "entry" : "entries"} matching ${filterDesc} → ${group}/${sub}`,
          apply: (cur) => ({
            categoryOverrides: [
              ...(cur.categoryOverrides ?? []),
              newOverride,
            ],
          }),
        };
      }
      return { result: `unknown tool ${name}`, apply: null };
    } catch (e) {
      return {
        result: `error: ${e instanceof Error ? e.message : "unknown"}`,
        apply: null,
      };
    }
  }

  async function startConversation() {
    setLoading(true);
    setError(null);
    onSetDebrief({ status: "in_progress", messages: [] });
    try {
      await processTurn([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
      onSetDebrief({ status: "idle" });
    } finally {
      setLoading(false);
    }
  }

  async function callApi(currentMessages: ChatMessage[]) {
    const turns = currentMessages.map((m) => {
      const turn: {
        role: "user" | "assistant";
        text?: string;
        toolUses?: Array<{ id: string; name: string; input: unknown }>;
        toolResults?: Array<{ tool_use_id: string; content: string }>;
      } = { role: m.role };
      if (m.text) turn.text = m.text;
      // Encode tool calls + their tool_result follow-up so the model gets
      // a coherent history.
      if (m.toolCalls && m.toolCalls.length > 0) {
        turn.toolUses = m.toolCalls.map((tc, i) => ({
          id: `${m.id}-${i}`,
          name: tc.name,
          input: tc.input,
        }));
      }
      return turn;
    });
    // For each assistant turn that had toolCalls, inject a synthetic user
    // tool_result turn right after it, since Anthropic requires that pattern.
    const expanded: typeof turns = [];
    for (const t of turns) {
      expanded.push(t);
      if (t.role === "assistant" && t.toolUses && t.toolUses.length > 0) {
        expanded.push({
          role: "user",
          toolResults: t.toolUses.map((tu) => ({
            tool_use_id: tu.id,
            content: "applied",
          })),
        });
      }
    }
    const res = await fetch("/api/debrief/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: buildStateSnapshot(),
        turns: expanded,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error ?? `Error ${res.status}`);
    }
    return data as
      | { kind: "message"; text: string }
      | {
          kind: "tool_use";
          text: string;
          toolUses: Array<{
            id: string;
            name: string;
            input: Record<string, unknown>;
          }>;
        }
      | {
          kind: "finalized";
          text: string;
          summary: DebriefSummary;
          toolUseId: string;
          toolUses?: Array<{
            id: string;
            name: string;
            input: Record<string, unknown>;
          }>;
        };
  }

  async function sendUserMessage(text: string) {
    if (!text.trim() || loading) return;
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      createdAt: Date.now(),
    };
    const next = [...messages, userMsg];
    onSetDebrief({ status: "in_progress", messages: next });
    setDraft("");
    setLoading(true);
    setError(null);
    ttsStop();
    try {
      await processTurn(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  /** Send `currentMessages` to the API. If the model used action tools,
   * apply them client-side, then loop with the assistant turn appended so
   * the model can react to the results. Cap at 3 tool-loop iterations. */
  async function processTurn(currentMessages: ChatMessage[]) {
    let history = currentMessages;
    let iters = 0;
    while (iters < 4) {
      iters++;
      const data = await callApi(history);

      // Aggregate any action tool calls (non-finalize) into a list of
      // appliers + toolCalls for the assistant message bubble.
      const actionUses =
        "toolUses" in data && Array.isArray(data.toolUses)
          ? data.toolUses.filter((tu) => tu.name !== "finalize_debrief")
          : [];

      const appliers: ToolApply[] = [];
      const toolCalls: ChatToolCall[] = [];
      for (const tu of actionUses) {
        const { result, apply } = applyToolCall(tu.name, tu.input);
        toolCalls.push({ name: tu.name, input: tu.input, result });
        if (apply) appliers.push(apply);
      }
      if (appliers.length > 0) {
        // Functional updater: each applier sees the latest state including
        // prior appliers' effects in this turn.
        onPatchSession((cur) => {
          let merged: Partial<OracleSession> = {};
          let working: OracleSession = cur;
          for (const apply of appliers) {
            const delta = apply(working);
            merged = { ...merged, ...delta };
            working = { ...working, ...delta };
          }
          return merged;
        });
      }

      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        text: data.text || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        createdAt: Date.now(),
      };

      if (data.kind === "finalized") {
        history = [...history, assistantMsg];
        onSetDebrief({
          status: "ready",
          messages: history,
          summary: data.summary,
          generatedAt: Date.now(),
        });
        speakIfEnabled(data.text || "Debrief ready.");
        return;
      }

      history = [...history, assistantMsg];
      onSetDebrief({
        status: "in_progress",
        messages: history,
      });
      if (data.text) speakIfEnabled(data.text);

      // If no tool was used, stop the loop and wait for user.
      if (data.kind !== "tool_use") return;

      // If the model only used tools and didn't produce text, loop again so
      // it can comment on the result. Otherwise stop — the text response IS
      // its turn.
      if (data.text && data.text.trim().length > 0) return;
    }
  }


  function wrapItUp() {
    sendUserMessage("Wrap it up — give me the debrief.");
  }

  function reset() {
    if (!confirm("Discard this debrief?")) return;
    ttsStop();
    onSetDebrief(null);
    setError(null);
    setDraft("");
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendUserMessage(draft);
    }
  }

  function playDebriefAloud() {
    if (!debrief?.summary) return;
    setIsReadingDebrief(true);
    ttsSpeakDebrief(
      debrief.summary.headline,
      debrief.summary.sections,
      { onEnd: () => setIsReadingDebrief(false), rate: ttsRate },
    );
  }

  function stopReading() {
    ttsStop();
    setIsReadingDebrief(false);
  }

  const hasData =
    (session.riseEntries && session.riseEntries.length > 0) ||
    (session.calendarEvents && session.calendarEvents.length > 0);

  return (
    <section className="mt-6">
      <div
        style={{ borderColor: "var(--hairline-strong)" }}
        className="rounded-xl border bg-[var(--surface)] shadow-[0_0_24px_rgba(212,175,55,0.08)]"
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-[var(--hairline)]">
          <div className="flex items-center gap-3">
            <span
              style={{
                borderColor: "var(--gold)",
                color: "var(--gold-bright)",
              }}
              className="h-7 w-7 rounded-full border-2 flex items-center justify-center font-bold text-sm"
            >
              ✦
            </span>
            <div>
              <div
                style={{ color: "var(--gold-bright)" }}
                className="text-sm font-semibold tracking-tight"
              >
                Weekly Debrief
              </div>
              <div className="text-[10px] opacity-50 uppercase tracking-wider">
                {debrief?.status === "ready"
                  ? `delivered ${debrief.generatedAt ? new Date(debrief.generatedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}`
                  : debrief?.status === "in_progress"
                    ? "in conversation"
                    : "Spiros walks you through your week → writes + reads the recap"}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {ttsOK && (
              <>
                <div
                  style={{ borderColor: "var(--hairline-strong)" }}
                  className="flex gap-0.5 rounded border bg-black/30 p-0.5"
                  title="Playback speed"
                >
                  {[1, 1.5, 2].map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setTtsRate(r === 1 ? 1.05 : r)}
                      style={
                        Math.abs(ttsRate - (r === 1 ? 1.05 : r)) < 0.05
                          ? { backgroundColor: "var(--gold)", color: "#000" }
                          : undefined
                      }
                      className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded transition ${
                        Math.abs(ttsRate - (r === 1 ? 1.05 : r)) < 0.05
                          ? "font-semibold"
                          : "opacity-50 hover:opacity-100"
                      }`}
                    >
                      {r}×
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (ttsEnabled) ttsStop();
                    setTtsEnabled((v) => !v);
                  }}
                  title={ttsEnabled ? "Turn voice off" : "Turn voice on"}
                  style={{
                    color: ttsEnabled ? "var(--gold)" : "var(--gold-dim)",
                    borderColor: ttsEnabled
                      ? "var(--gold)"
                      : "var(--gold-dim)",
                  }}
                  className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border hover:brightness-110 transition"
                >
                  {ttsEnabled ? "🔊 voice on" : "🔇 voice off"}
                </button>
              </>
            )}
            {debrief && (
              <button
                type="button"
                onClick={reset}
                className="text-[10px] uppercase tracking-wider opacity-50 hover:opacity-100"
              >
                {debrief.status === "ready" ? "Re-run" : "Cancel"}
              </button>
            )}
          </div>
        </header>

        <div className="px-5 py-4">
          {error && (
            <div className="mb-3 text-[11px] text-rose-300 rounded border border-rose-500/30 bg-rose-500/5 p-2">
              {error}
            </div>
          )}

          {(!debrief || debrief.status === "idle") && (
            <div className="flex flex-col items-start gap-3">
              <p className="text-xs opacity-70 leading-relaxed">
                A Jarvis-style walkthrough. Spiros opens with the shape of
                your week, then asks one specific thing at a time. When ready,
                it writes the structured debrief and reads it aloud.
                {!hasData && (
                  <span className="block mt-1 opacity-60">
                    (Tip: load your Rize CSV and/or connect Google Calendar
                    first for the richest debrief.)
                  </span>
                )}
              </p>
              <button
                type="button"
                onClick={startConversation}
                disabled={loading}
                style={{
                  backgroundColor: loading
                    ? "var(--gold-dim)"
                    : "var(--gold)",
                }}
                className="px-5 py-2 rounded-md text-black text-sm font-semibold transition-all hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed shadow-[0_4px_24px_rgba(212,175,55,0.2)]"
              >
                {loading ? "Opening…" : "Start the Oracle →"}
              </button>
            </div>
          )}

          {debrief?.status === "in_progress" && (
            <div className="space-y-4">
              <div
                ref={scrollRef}
                className="max-h-[480px] overflow-y-auto space-y-4 pr-1"
              >
                {messages.map((m) => (
                  <DebriefBubble
                    key={m.id}
                    msg={m}
                    ttsOK={ttsOK}
                    onReplay={() =>
                      m.text && ttsSpeak(m.text, { rate: ttsRate })
                    }
                  />
                ))}
                {loading && (
                  <div className="flex items-center gap-2 text-xs opacity-60">
                    <span
                      style={{ backgroundColor: "var(--gold)" }}
                      className="h-2 w-2 rounded-full animate-pulse"
                    />
                    Spiros is thinking…
                  </div>
                )}
              </div>

              <div className="border-t border-[var(--hairline)] pt-3">
                <div className="flex gap-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onKey}
                    placeholder="Your answer… (⌘↵ to send)"
                    rows={2}
                    className="flex-1 resize-none rounded-md border border-[var(--hairline)] bg-black/40 px-3 py-2 text-sm focus:outline-none focus:border-[var(--gold)]"
                  />
                  <div className="flex flex-col gap-2 self-end">
                    <button
                      type="button"
                      onClick={() => sendUserMessage(draft)}
                      disabled={loading || !draft.trim()}
                      style={{
                        backgroundColor:
                          loading || !draft.trim()
                            ? "var(--gold-dim)"
                            : "var(--gold)",
                      }}
                      className={`px-4 py-2 rounded-md text-black text-sm font-semibold transition-all ${
                        loading || !draft.trim()
                          ? "opacity-60 cursor-not-allowed"
                          : "hover:brightness-110"
                      }`}
                    >
                      {loading ? "…" : "Send"}
                    </button>
                  </div>
                </div>
                <div className="flex justify-end mt-2">
                  <button
                    type="button"
                    onClick={wrapItUp}
                    disabled={loading || messages.length < 2}
                    className="text-[10px] uppercase tracking-wider opacity-50 hover:opacity-100 disabled:opacity-25"
                    title="Tell Spiros you've answered enough — write the debrief now"
                  >
                    Wrap it up →
                  </button>
                </div>
              </div>
            </div>
          )}

          {debrief?.status === "ready" && debrief.summary && (
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-[var(--hairline)] pb-3">
                <div className="text-[10px] uppercase tracking-[0.18em] opacity-60">
                  Your debrief
                </div>
                {ttsOK && (
                  <div className="flex gap-2">
                    {isReadingDebrief ? (
                      <button
                        type="button"
                        onClick={stopReading}
                        style={{
                          borderColor: "var(--gold)",
                          color: "var(--gold)",
                        }}
                        className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border hover:brightness-110 transition"
                      >
                        ⏹ Stop
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={playDebriefAloud}
                        style={{
                          backgroundColor: "var(--gold)",
                        }}
                        className="text-[10px] uppercase tracking-wider px-3 py-1 rounded text-black font-semibold hover:brightness-110 transition"
                      >
                        🔊 Read aloud
                      </button>
                    )}
                  </div>
                )}
              </div>
              <DebriefView summary={debrief.summary} />
              {messages.length > 0 && (
                <details className="text-[11px] opacity-50 mt-4">
                  <summary className="cursor-pointer hover:opacity-100">
                    View the conversation ({messages.length} messages)
                  </summary>
                  <div className="mt-3 space-y-3 max-h-64 overflow-y-auto">
                    {messages.map((m) => (
                      <DebriefBubble key={m.id} msg={m} ttsOK={ttsOK} />
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function DebriefBubble({
  msg,
  onReplay,
  ttsOK = false,
}: {
  msg: ChatMessage;
  onReplay?: () => void;
  ttsOK?: boolean;
}) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} group`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          isUser ? "bg-black/40 border border-[var(--hairline)]" : ""
        }`}
        style={
          !isUser
            ? {
                borderLeft: "2px solid var(--gold)",
                paddingLeft: "0.75rem",
              }
            : undefined
        }
      >
        {msg.text && (
          <div className="whitespace-pre-wrap leading-relaxed">{msg.text}</div>
        )}
        {msg.toolCalls && msg.toolCalls.length > 0 && (
          <div className={`${msg.text ? "mt-2" : ""} space-y-1`}>
            {msg.toolCalls.map((tc, i) => (
              <div
                key={i}
                className="text-[11px] opacity-70 flex items-start gap-2"
              >
                <span
                  style={{ color: "var(--gold)" }}
                  className="font-mono shrink-0"
                >
                  ✓
                </span>
                <span>
                  <span style={{ color: "var(--gold)" }}>{tc.name}</span>
                  {" · "}
                  <span className="opacity-80">{tc.result}</span>
                </span>
              </div>
            ))}
          </div>
        )}
        {!isUser && onReplay && ttsOK && msg.text && (
          <button
            type="button"
            onClick={onReplay}
            className="mt-1 text-[10px] uppercase tracking-wider opacity-0 group-hover:opacity-50 hover:!opacity-100 transition"
            title="Replay this message"
          >
            🔊 replay
          </button>
        )}
      </div>
    </div>
  );
}

function DebriefView({ summary }: { summary: DebriefSummary }) {
  return (
    <article className="space-y-5">
      <h3
        style={{ color: "var(--gold-bright)" }}
        className="text-lg font-semibold leading-tight tracking-tight"
      >
        {summary.headline}
      </h3>
      <div className="space-y-5">
        {summary.sections.map((s, i) => (
          <section key={i}>
            <div
              style={{ color: "var(--gold)" }}
              className="text-[10px] uppercase tracking-[0.18em] font-semibold mb-2"
            >
              {s.title}
            </div>
            <div className="text-sm leading-relaxed opacity-90 whitespace-pre-wrap">
              {s.body}
            </div>
          </section>
        ))}
      </div>
    </article>
  );
}

/* ─── Chat panel ─────────────────────────────────────────────── */

function ChatPanel({
  session,
  onPatchSession,
  onAddItem,
  onUpdateItem,
  onMarkDone,
  onReopen,
  onDelete,
}: {
  session: OracleSession;
  onPatchSession: (patch: Partial<OracleSession>) => void;
  onAddItem: (partial: Partial<RiceItem> & { title: string }) => void;
  onUpdateItem: (id: string, patch: Partial<RiceItem>) => void;
  onMarkDone: (id: string) => void;
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = session.chat ?? [];

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length, loading]);

  function appendMessages(newMsgs: ChatMessage[]) {
    onPatchSession({ chat: [...messages, ...newMsgs] });
  }

  function clearChat() {
    if (
      messages.length > 0 &&
      !confirm("Clear this Oracle's chat history? Priorities you've made stay.")
    )
      return;
    onPatchSession({ chat: [] });
    setError(null);
  }

  function buildStateSnapshot() {
    let timeSummary: object | undefined;
    const effective = getEffectiveEntries(
      session.riseEntries,
      session.manualEntries,
      session.categoryOverrides,
      session.hiddenEntryIds,
    );
    if (effective.length > 0) {
      const agg = aggregateEntries(effective);
      const work = agg.groups.find((g) => g.name === "Work");
      const personal = agg.groups.find((g) => g.name === "Personal");
      const days = groupByDay(effective).map((d) => ({
        dayLabel: d.dayLabel,
        totalMinutes: d.totalMinutes,
        entries: d.entries.map((e) => ({
          time: fmtTime(e.startISO),
          minutes: e.minutes,
          group: e.group,
          sub: e.sub,
          description: e.description,
        })),
      }));
      timeSummary = {
        totalMinutes: agg.totalMinutes,
        work: work?.subs ?? [],
        personal: personal?.subs ?? [],
        uncategorized: {
          count: agg.uncategorized.length,
          minutes: agg.uncategorized.reduce((s, e) => s + e.minutes, 0),
        },
        days,
      };
    }
    const calendarEvents = session.calendarEvents?.map((e) => ({
      title: e.title,
      startISO: e.startISO,
      minutes: e.minutes,
      attendees: e.attendees,
      location: e.location,
      description: e.description,
    }));
    const manualEntries = (session.manualEntries ?? []).map((e) => ({
      dayISO: e.startISO.slice(0, 10),
      startHHMM: new Date(e.startISO).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      }),
      minutes: e.minutes,
      sub: e.sub,
      description: e.description,
    }));
    return {
      weekStart: session.weekStart,
      items: session.items,
      transcript: session.transcript,
      timeSummary,
      manualEntries,
      calendarImage: session.calendarImage,
      calendarEvents,
    };
  }

  /** Convert local chat history to the API's `messages` shape. */
  function toTurns(local: ChatMessage[]) {
    const out: Array<{
      role: "user" | "assistant";
      text?: string;
      toolUses?: Array<{ id: string; name: string; input: unknown }>;
      toolResults?: Array<{ tool_use_id: string; content: string }>;
    }> = [];
    for (const m of local) {
      if (m.role === "user") {
        out.push({ role: "user", text: m.text });
      } else {
        const turn: (typeof out)[number] = { role: "assistant" };
        if (m.text) turn.text = m.text;
        if (m.toolCalls && m.toolCalls.length > 0) {
          turn.toolUses = m.toolCalls.map((tc, idx) => ({
            id: `${m.id}-${idx}`,
            name: tc.name,
            input: tc.input,
          }));
          // synthesize a tool-result follow-up user turn
          out.push(turn);
          out.push({
            role: "user",
            toolResults: m.toolCalls.map((tc, idx) => ({
              tool_use_id: `${m.id}-${idx}`,
              content: tc.result ?? "applied",
            })),
          });
          continue;
        }
        out.push(turn);
      }
    }
    return out;
  }

  function applyToolCall(call: { name: string; input: Record<string, unknown> }): string {
    try {
      switch (call.name) {
        case "add_priority": {
          const partial: Partial<RiceItem> & { title: string } = {
            title: String(call.input.title ?? "").trim(),
            note: typeof call.input.note === "string" ? call.input.note : undefined,
            reach: clamp(Number(call.input.reach) || 5, 1, 10),
            impact: clamp(Number(call.input.impact) || 5, 1, 10),
            confidence: clamp(Number(call.input.confidence) || 5, 1, 10),
            effort: clamp(Number(call.input.effort) || 5, 1, 10),
            estHours: Math.max(0.25, Number(call.input.estHours) || 1),
            category:
              typeof call.input.category === "string"
                ? call.input.category
                : undefined,
            nextAction:
              typeof call.input.nextAction === "string"
                ? call.input.nextAction
                : undefined,
          };
          if (!partial.title) return "skipped — empty title";
          onAddItem(partial);
          return `added priority "${partial.title}"`;
        }
        case "update_priority": {
          const id = String(call.input.id ?? "");
          if (!id) return "skipped — missing id";
          const { id: _drop, ...rest } = call.input;
          const patch: Partial<RiceItem> = {};
          for (const k of [
            "title",
            "note",
            "reach",
            "impact",
            "confidence",
            "effort",
            "estHours",
            "progress",
            "category",
            "nextAction",
          ] as const) {
            if (k in rest && rest[k] !== undefined && rest[k] !== null) {
              (patch as Record<string, unknown>)[k] = rest[k];
            }
          }
          onUpdateItem(id, patch);
          return `updated ${id}: ${Object.keys(patch).join(", ")}`;
        }
        case "mark_done": {
          const id = String(call.input.id ?? "");
          if (!id) return "skipped — missing id";
          onMarkDone(id);
          return `marked ${id} done`;
        }
        case "reopen_priority": {
          const id = String(call.input.id ?? "");
          if (!id) return "skipped — missing id";
          onReopen(id);
          return `reopened ${id}`;
        }
        case "delete_priority": {
          const id = String(call.input.id ?? "");
          if (!id) return "skipped — missing id";
          onDelete(id);
          return `deleted ${id}`;
        }
        default:
          return `unknown tool ${call.name}`;
      }
    } catch (e) {
      return `error: ${e instanceof Error ? e.message : "unknown"}`;
    }
  }

  async function callApi(history: ChatMessage[]) {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: toTurns(history),
        state: buildStateSnapshot(),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(
        `${data.error ?? "Request failed"}${data.help ? `\n${data.help}` : ""}`,
      );
    }
    return data as {
      text: string;
      toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      stopReason: string;
    };
  }

  async function send() {
    const text = draft.trim();
    if (!text || loading) return;
    setDraft("");
    setError(null);
    setLoading(true);
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      createdAt: Date.now(),
    };
    let history = [...messages, userMsg];
    onPatchSession({ chat: history });

    try {
      // First turn
      let resp = await callApi(history);
      let toolCalls: ChatToolCall[] = resp.toolUses.map((tu) => ({
        name: tu.name,
        input: tu.input,
        result: applyToolCall({ name: tu.name, input: tu.input }),
      }));
      let assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        text: resp.text || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        createdAt: Date.now(),
      };
      history = [...history, assistantMsg];
      onPatchSession({ chat: history });

      // If the model used tools, follow up so it can comment on results.
      // Cap at 3 iterations to avoid runaway.
      let iters = 0;
      while (toolCalls.length > 0 && resp.stopReason === "tool_use" && iters < 3) {
        iters++;
        resp = await callApi(history);
        toolCalls = resp.toolUses.map((tu) => ({
          name: tu.name,
          input: tu.input,
          result: applyToolCall({ name: tu.name, input: tu.input }),
        }));
        assistantMsg = {
          id: crypto.randomUUID(),
          role: "assistant",
          text: resp.text || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          createdAt: Date.now(),
        };
        history = [...history, assistantMsg];
        onPatchSession({ chat: history });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  }

  const suggestions = [
    "What did I spend the most time on this week?",
    "Add a priority: draft the partnership contract, RICE around 8/9/8/2, maybe 3 hours",
    "What should I focus on tomorrow given my open priorities?",
    "Mark Ship Spiros v1 as done",
  ];

  return (
    <section className="mt-6">
      <div
        style={{ borderColor: "var(--hairline-strong)" }}
        className="rounded-xl border bg-[var(--surface)] shadow-[0_0_24px_rgba(212,175,55,0.08)]"
      >
        <header
          className="flex items-center justify-between px-5 py-3 border-b border-[var(--hairline)] cursor-pointer"
          onClick={() => setExpanded((v) => !v)}
        >
          <div className="flex items-center gap-3">
            <span
              style={{ backgroundColor: "var(--gold)" }}
              className="h-7 w-7 rounded-full flex items-center justify-center font-bold text-black text-sm"
            >
              S
            </span>
            <div>
              <div
                style={{ color: "var(--gold-bright)" }}
                className="text-sm font-semibold tracking-tight"
              >
                Talk to Spiros
              </div>
              <div className="text-[10px] opacity-50 uppercase tracking-wider">
                {messages.length === 0
                  ? "ask questions · edit priorities by voice"
                  : `${messages.length} message${messages.length === 1 ? "" : "s"} this Oracle`}
              </div>
            </div>
          </div>
          <div className="flex gap-3 items-center">
            {messages.length > 0 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  clearChat();
                }}
                className="text-[10px] uppercase tracking-wider opacity-50 hover:opacity-100"
              >
                Clear
              </button>
            )}
            <span className="text-[10px] opacity-50">
              {expanded ? "▾" : "▸"}
            </span>
          </div>
        </header>

        {expanded && (
          <>
            {messages.length > 0 ? (
              <div
                ref={scrollRef}
                className="max-h-[400px] overflow-y-auto px-5 py-4 space-y-4"
              >
                {messages.map((m) => (
                  <ChatBubble key={m.id} msg={m} />
                ))}
                {loading && (
                  <div className="flex items-center gap-2 text-xs opacity-60">
                    <span
                      style={{ backgroundColor: "var(--gold)" }}
                      className="h-2 w-2 rounded-full animate-pulse"
                    />
                    Spiros is thinking…
                  </div>
                )}
              </div>
            ) : (
              <div className="px-5 py-4 space-y-3">
                <div className="text-xs opacity-60">
                  Spiros has full context on this Oracle — your Rize data,
                  calendar screenshot, and current priorities. Try:
                </div>
                <div className="flex flex-wrap gap-2">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setDraft(s)}
                      style={{ borderColor: "var(--gold-dim)" }}
                      className="text-[11px] px-2.5 py-1 rounded border text-left opacity-70 hover:opacity-100 hover:border-[color:var(--gold)] transition"
                    >
                      "{s}"
                    </button>
                  ))}
                </div>
              </div>
            )}

            {error && (
              <div className="mx-5 mb-3 text-[11px] text-rose-300 rounded border border-rose-500/30 bg-rose-500/5 p-2 whitespace-pre-wrap">
                {error}
              </div>
            )}

            <div className="px-5 py-3 border-t border-[var(--hairline)]">
              <div className="flex gap-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKey}
                  placeholder="Talk to Spiros… (⌘↵ to send)"
                  rows={2}
                  className="flex-1 resize-none rounded-md border border-[var(--hairline)] bg-black/40 px-3 py-2 text-sm focus:outline-none focus:border-[var(--gold)]"
                />
                <button
                  type="button"
                  onClick={send}
                  disabled={loading || !draft.trim()}
                  style={{
                    backgroundColor:
                      loading || !draft.trim()
                        ? "var(--gold-dim)"
                        : "var(--gold)",
                  }}
                  className={`px-4 py-2 rounded-md text-black text-sm font-semibold transition-all self-end ${
                    loading || !draft.trim()
                      ? "opacity-60 cursor-not-allowed"
                      : "hover:brightness-110"
                  }`}
                >
                  {loading ? "…" : "Send"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function ChatBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          isUser ? "bg-black/40 border border-[var(--hairline)]" : ""
        }`}
        style={
          !isUser
            ? {
                borderLeft: "2px solid var(--gold)",
                paddingLeft: "0.75rem",
              }
            : undefined
        }
      >
        {msg.text && (
          <div className="whitespace-pre-wrap leading-relaxed">{msg.text}</div>
        )}
        {msg.toolCalls && msg.toolCalls.length > 0 && (
          <div className={`${msg.text ? "mt-2" : ""} space-y-1`}>
            {msg.toolCalls.map((tc, i) => (
              <div
                key={i}
                className="text-[11px] opacity-70 flex items-start gap-2"
              >
                <span
                  style={{ color: "var(--gold)" }}
                  className="font-mono shrink-0"
                >
                  ✓
                </span>
                <span>
                  <span style={{ color: "var(--gold)" }}>{tc.name}</span>
                  {" · "}
                  <span className="opacity-80">{tc.result}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Week picker ────────────────────────────────────────────── */

function WeekPicker({
  viewedWeek,
  todaysWeek,
  sessions,
  onPick,
}: {
  viewedWeek: string;
  todaysWeek: string;
  sessions: Record<string, OracleSession>;
  onPick: (weekStart: string) => void;
}) {
  // Show today's week + last N weeks always (even when empty) so Nick
  // can scrub back through recent history and backfill any week — not
  // just the ones with existing sessions. Older weeks that DO have
  // sessions still appear past the N-week window so historical data
  // is never hidden.
  const RECENT_WEEKS_WINDOW = 10;
  const weeks = useMemo(() => {
    const set = new Set<string>([todaysWeek, ...Object.keys(sessions)]);
    // Walk backward from today's week, adding each Sunday key. ISO
    // date string comparisons sort correctly, so we just append.
    const todayDate = fromISODate(todaysWeek);
    for (let i = 1; i <= RECENT_WEEKS_WINDOW; i++) {
      const d = new Date(todayDate);
      d.setDate(d.getDate() - 7 * i);
      set.add(toISODate(d));
    }
    return [...set].sort().reverse();
  }, [sessions, todaysWeek]);

  // Compute a quick "has data" hint per week so the picker shows which ones
  // actually have stuff in them.
  function hasData(weekStart: string): boolean {
    const s = sessions[weekStart];
    if (!s) return false;
    return (
      (s.items?.length ?? 0) > 0 ||
      (s.riseEntries?.length ?? 0) > 0 ||
      (s.manualEntries?.length ?? 0) > 0
    );
  }

  return (
    <section className="mt-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider opacity-60 mb-2">
        <span>Oracles</span>
        <span className="opacity-50">— click a week to view it</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {weeks.map((w) => {
          const isViewed = w === viewedWeek;
          const isToday = w === todaysWeek;
          const populated = hasData(w);
          return (
            <button
              key={w}
              type="button"
              onClick={() => onPick(w)}
              style={
                isViewed
                  ? { backgroundColor: "var(--gold)", color: "#000" }
                  : populated
                    ? { borderColor: "var(--gold)", color: "var(--gold)" }
                    : {
                        borderColor: "var(--gold-dim)",
                        color: "var(--gold-dim)",
                      }
              }
              className={`text-[11px] px-2.5 py-1 rounded-md transition-all tabular-nums ${
                isViewed
                  ? "font-semibold shadow-[0_0_12px_rgba(212,175,55,0.35)]"
                  : "border hover:brightness-110"
              }`}
              title={
                isToday
                  ? "This week's Oracle"
                  : populated
                    ? `Past Oracle — has data`
                    : `Past Oracle — empty`
              }
            >
              {formatWeekRange(w)}
              {isToday && (
                <span
                  className={`ml-1.5 text-[9px] uppercase tracking-wider ${
                    isViewed ? "opacity-70" : "opacity-60"
                  }`}
                >
                  this week
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ─── Weekly Readiness Strip ─────────────────────────────────── */

/** The "is this week ready?" checklist that lives at the top of the
 * page. Reads pure readiness state, surfaces per-input status, and
 * lets Nick check off each row when he's intentionally done with it.
 * Sticky so it stays in view as you scroll. */
function WeeklyReadinessStrip({
  readiness,
  onToggleLock,
  syncStatus,
}: {
  readiness: ReadinessState;
  onToggleLock: (id: ReadinessRowId) => void;
  syncStatus: "idle" | "saving" | "saved" | "error";
}) {
  const { rows, doneCount, totalCount } = readiness;
  const allDone = doneCount === totalCount;
  return (
    <div className="sticky top-0 z-20 -mx-6 px-6 py-3 mb-4 border-b border-[var(--hairline-strong)] bg-[var(--bg)]/95 backdrop-blur">
      <div className="flex items-center justify-between gap-4 mb-2">
        <div className="text-[10px] uppercase tracking-[0.18em] opacity-60">
          Weekly Readiness
        </div>
        <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider">
          <span
            className={
              allDone
                ? "text-emerald-400/90"
                : "opacity-60"
            }
          >
            {doneCount}/{totalCount} ready
          </span>
          <SyncDot status={syncStatus} />
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
        {rows.map((r) => (
          <ReadinessRowCard
            key={r.id}
            row={r}
            onToggleLock={() => onToggleLock(r.id)}
          />
        ))}
      </div>
    </div>
  );
}

function ReadinessRowCard({
  row,
  onToggleLock,
}: {
  row: ReadinessRow;
  onToggleLock: () => void;
}) {
  // A row is "done" when the system has detected enough data to call
  // it ready, OR when Nick has explicitly locked it (e.g. intentionally
  // skipping debrief this week). The checkbox auto-fills for ready rows
  // so he doesn't have to manually confirm what the system already sees.
  const isReady = row.status === "ready";
  const isPartial = row.status === "partial";
  const done = isReady || row.locked;
  const dot = done
    ? "bg-emerald-400"
    : isPartial
      ? "bg-amber-400"
      : "bg-white/20";
  // Click semantics:
  //   - ready & not locked   → click = "actually I'm not done" (sets locked → ... unlocks)
  //     (We treat lock as user override of system detection. Currently we just
  //      toggle; future: a separate "explicitly not done" override.)
  //   - empty / partial      → click = "I'm intentionally skipping this"
  //   - locked               → click = unlock
  return (
    <div
      className={`rounded-lg border px-3 py-2 flex items-center justify-between gap-2 ${
        done
          ? "border-emerald-500/40 bg-emerald-500/[0.04]"
          : "border-[var(--hairline)] bg-[var(--surface)]"
      }`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-xs">
          <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${dot}`} />
          <span className="opacity-90 truncate">{row.label}</span>
        </div>
        <div className="text-[10px] opacity-55 mt-0.5 truncate">
          {row.detail}
        </div>
      </div>
      <button
        type="button"
        onClick={onToggleLock}
        aria-label={
          done
            ? row.locked
              ? "Unlock input"
              : "Auto-detected as ready"
            : "Mark as done"
        }
        title={
          isReady && !row.locked
            ? "Auto-checked — system detected data is loaded"
            : row.locked
              ? "Manually marked done — click to unlock"
              : "Click to mark intentionally done / skipped"
        }
        className={`shrink-0 h-6 w-6 rounded-md border flex items-center justify-center text-[11px] transition ${
          done
            ? "border-emerald-400/60 bg-emerald-400/10 text-emerald-300 hover:bg-emerald-400/20"
            : "border-[var(--hairline-strong)] text-white/50 hover:text-white/90 hover:bg-white/5"
        }`}
      >
        {done ? "✓" : ""}
      </button>
    </div>
  );
}

function SyncDot({
  status,
}: {
  status: "idle" | "saving" | "saved" | "error";
}) {
  const map = {
    idle: { dot: "bg-white/30", label: "synced" },
    saving: { dot: "bg-amber-400 animate-pulse", label: "saving…" },
    saved: { dot: "bg-emerald-400", label: "saved" },
    error: { dot: "bg-rose-500", label: "save failed" },
  } as const;
  const { dot, label } = map[status];
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className="opacity-60">{label}</span>
    </span>
  );
}

/* ─── Header ─────────────────────────────────────────────────── */

function Header({ weekStart }: { weekStart: string }) {
  return (
    <header className="flex items-end justify-between gap-6 pb-6 border-b border-[var(--hairline-strong)]">
      <div>
        <div className="flex items-center gap-3">
          <div
            style={{ borderColor: "var(--gold)" }}
            className="h-10 w-10 rounded-md border-2 flex items-center justify-center bg-black"
          >
            <span
              style={{ color: "var(--gold-bright)" }}
              className="font-bold text-base tracking-widest"
            >
              S
            </span>
          </div>
          <h1
            style={{ color: "var(--gold-bright)" }}
            className="text-3xl font-semibold tracking-tight"
          >
            Spiros
          </h1>
        </div>
        <p className="text-sm mt-2 opacity-70">
          Where your time goes · What you should do next.{" "}
          <span style={{ color: "var(--gold)" }}>R · I · C · E</span>
        </p>
      </div>
      <div className="text-right text-xs hidden sm:block">
        <div className="opacity-60 uppercase tracking-wider">
          This Oracle
        </div>
        <div
          style={{ color: "var(--gold)" }}
          className="font-medium tabular-nums"
        >
          {formatWeekRange(weekStart)}
        </div>
      </div>
    </header>
  );
}

/* ─── Time Tracker ───────────────────────────────────────────── */

function TimeTrackerSection({
  range,
  onRangeChange,
  session,
  icalUrl,
  onIcalUrlChange,
  onCalendarEvents,
  onRiseUpload,
  onHideEntry,
  onUnhideAll,
  onAddManualEntry,
  onUpdateManualEntry,
  onClearSub,
  onRecategorizeSub,
  onRecategorizeEntry,
}: {
  range: DateRangeId;
  onRangeChange: (r: DateRangeId) => void;
  session: OracleSession;
  icalUrl?: string;
  onIcalUrlChange: (url: string | null) => void;
  onCalendarEvents: (events: CalEvent[] | null) => void;
  onRiseUpload: (entries: RizeEntry[]) => void;
  onHideEntry: (id: string) => void;
  onUnhideAll: () => void;
  onAddManualEntry: (entry: RizeEntry) => void;
  onUpdateManualEntry: (id: string, patch: Partial<RizeEntry>) => void;
  onClearSub: (sub: string) => void;
  onRecategorizeSub: (
    fromSub: string,
    toGroup: "Work" | "Personal",
    toSub: string,
  ) => void;
  onRecategorizeEntry: (
    entryId: string,
    toGroup: "Work" | "Personal",
    toSub: string,
  ) => void;
}) {
  const cfg = DATE_RANGES.find((r) => r.id === range)!;
  const hasReal = !!(session.riseEntries && session.riseEntries.length > 0) || !!(session.manualEntries && session.manualEntries.length > 0);

  // Manual-entry form open state lives here so a "+ add" in a bucket card
  // can pop the global form with the right group preset.
  const [adderOpen, setAdderOpen] = useState(false);
  const [adderGroup, setAdderGroup] = useState<"Work" | "Personal" | undefined>(
    undefined,
  );
  function openAdderForGroup(g: "Work" | "Personal") {
    setAdderGroup(g);
    setAdderOpen(true);
  }

  let totalMinutes: number;
  let deltaMinutes: number;
  let work: CategoryGroup;
  let personal: CategoryGroup;
  let uncategorized: RizeEntry[] = [];

  let filteredEntries: RizeEntry[] = [];
  if (hasReal) {
    const effective = getEffectiveEntries(
      session.riseEntries,
      session.manualEntries,
      session.categoryOverrides,
      session.hiddenEntryIds,
    );
    filteredEntries = filterEntriesByRange(effective, range);
    const agg = aggregateEntries(filteredEntries);
    totalMinutes = agg.totalMinutes;
    deltaMinutes = 0;
    work = agg.groups.find((g) => g.name === "Work") ?? {
      name: "Work",
      color: "gold",
      subs: [],
    };
    personal = agg.groups.find((g) => g.name === "Personal") ?? {
      name: "Personal",
      color: "champagne",
      subs: [],
    };
    uncategorized = agg.uncategorized;
  } else {
    // No real data this week — show a true empty state, not the
    // misleading sample dataset that used to live here. The
    // SampleBanner above now prompts an upload instead of pretending
    // the meditation/sauna/cold-plunge sub-buckets are real.
    totalMinutes = 0;
    deltaMinutes = 0;
    work = { name: "Work", color: "gold", subs: [] };
    personal = { name: "Personal", color: "champagne", subs: [] };
  }

  const workMin = work.subs.reduce((s, x) => s + x.minutes, 0);
  const personalMin = personal.subs.reduce((s, x) => s + x.minutes, 0);
  const sum = workMin + personalMin || 1;
  const workPct = Math.round((workMin / sum) * 100);
  const personalPct = 100 - workPct;

  return (
    <section className="mt-8">
      <SectionLabel
        label="Time Tracker"
        sub={hasReal ? "from your Rize CSV" : "from Rize + Calendar"}
        right={`tracked · ${cfg.description}`}
      />

      {!hasReal ? (
        <SampleBanner>
          No time data this week yet — upload your Rize CSV below (or add a
          manual entry) to populate the breakdown.
        </SampleBanner>
      ) : (
        <LoadedBanner session={session} />
      )}

      <div className="mt-3">
        <RangePicker value={range} onChange={onRangeChange} />
      </div>

      {hasReal && filteredEntries.length === 0 && (
        <EmptyRangeNotice
          range={range}
          entries={session.riseEntries ?? []}
          onPick={onRangeChange}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr_1fr] gap-5 mt-4">
        <div className="rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-5 flex flex-col items-center justify-center">
          <Donut workPct={workPct} personalPct={personalPct} />
          <div className="mt-4 text-center">
            <div
              style={{ color: "var(--gold-bright)" }}
              className="text-3xl font-semibold tabular-nums"
            >
              {fmtMinutes(totalMinutes)}
            </div>
            <div className="text-[11px] uppercase tracking-wider opacity-60 mt-1">
              tracked · {cfg.description}
            </div>
            {!hasReal && (
              <div
                className={`text-xs mt-2 tabular-nums ${
                  deltaMinutes >= 0
                    ? "text-emerald-400/80"
                    : "text-rose-400/80"
                }`}
              >
                {deltaMinutes >= 0 ? "▲" : "▼"}{" "}
                {fmtMinutes(Math.abs(deltaMinutes))} vs prior period
              </div>
            )}
          </div>
          <div className="mt-5 w-full flex gap-3 text-[11px]">
            <div className="flex-1 flex flex-col items-center">
              <span
                style={{ backgroundColor: "var(--gold)" }}
                className="h-2 w-full rounded"
              />
              <span className="mt-1 opacity-70">Work {workPct}%</span>
            </div>
            <div className="flex-1 flex flex-col items-center">
              <span
                style={{ backgroundColor: "var(--champagne)" }}
                className="h-2 w-full rounded"
              />
              <span className="mt-1 opacity-70">Personal {personalPct}%</span>
            </div>
          </div>
        </div>

        <CategoryGroupCard
          group={work}
          accent="var(--gold)"
          accentDim="var(--gold-dim)"
          entries={filteredEntries.filter((e) => e.group === "Work")}
          grandTotalMinutes={workMin + personalMin}
          onHideEntry={onHideEntry}
          onClearSub={onClearSub}
          onRecategorizeSub={onRecategorizeSub}
          onRecategorizeEntry={onRecategorizeEntry}
          onAddSubInGroup={openAdderForGroup}
        />
        <CategoryGroupCard
          group={personal}
          accent="var(--champagne)"
          accentDim="var(--champagne-dim)"
          entries={filteredEntries.filter((e) => e.group === "Personal")}
          grandTotalMinutes={workMin + personalMin}
          onHideEntry={onHideEntry}
          onClearSub={onClearSub}
          onRecategorizeSub={onRecategorizeSub}
          onRecategorizeEntry={onRecategorizeEntry}
          onAddSubInGroup={openAdderForGroup}
        />
      </div>

      {uncategorized.length > 0 && (
        <UncategorizedBlock entries={uncategorized} />
      )}

      {hasReal && filteredEntries.length > 0 && (
        <DailyBreakdown
          entries={filteredEntries}
          onHideEntry={onHideEntry}
        />
      )}

      {(session.hiddenEntryIds?.length ?? 0) > 0 && (
        <div className="mt-2 text-[10px] uppercase tracking-wider opacity-50 text-right">
          {session.hiddenEntryIds!.length} entry
          {session.hiddenEntryIds!.length === 1 ? "" : "s"} hidden ·{" "}
          <button
            type="button"
            onClick={onUnhideAll}
            className="underline underline-offset-2 hover:opacity-100"
          >
            restore all
          </button>
        </div>
      )}

      <ManualEntryAdder
        weekStartISO={session.weekStart}
        onAdd={onAddManualEntry}
        open={adderOpen}
        onOpenChange={setAdderOpen}
        presetGroup={adderGroup}
      />

      <CalendarSection
        session={session}
        icalUrl={icalUrl}
        onIcalUrlChange={onIcalUrlChange}
        onCalendarEvents={onCalendarEvents}
      />

      <div className="mt-4">
        <RizeUpload
          session={session}
          onUpload={onRiseUpload}
        />
      </div>
    </section>
  );
}

function CalendarSection({
  session,
  icalUrl,
  onIcalUrlChange,
  onCalendarEvents,
}: {
  session: OracleSession;
  icalUrl?: string;
  onIcalUrlChange: (url: string | null) => void;
  onCalendarEvents: (events: CalEvent[] | null) => void;
}) {
  const [urlDraft, setUrlDraft] = useState(icalUrl ?? "");
  const [editing, setEditing] = useState(!icalUrl);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrlDraft(icalUrl ?? "");
  }, [icalUrl]);

  // When the Oracle week changes (new Sunday rolls in) and we have a saved
  // iCal URL but no events for this session, auto-fetch so Nick doesn't
  // have to remember to refresh.
  useEffect(() => {
    if (!icalUrl) return;
    if (session.calendarEvents && session.calendarEvents.length > 0) return;
    if (loading) return;
    fetchEvents(icalUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [icalUrl, session.weekStart]);

  async function fetchEvents(url: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          icalUrl: url,
          weekStartISO: session.weekStart,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Error ${res.status}`);
        return;
      }
      onCalendarEvents(data.events as CalEvent[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fetch failed");
    } finally {
      setLoading(false);
    }
  }

  function save() {
    const trimmed = urlDraft.trim();
    if (!trimmed) {
      onIcalUrlChange(null);
      onCalendarEvents(null);
      setEditing(true);
      return;
    }
    if (!/^https?:\/\//.test(trimmed)) {
      setError("URL must start with http:// or https://");
      return;
    }
    onIcalUrlChange(trimmed);
    setEditing(false);
    fetchEvents(trimmed);
  }

  function disconnect() {
    if (!confirm("Disconnect calendar? Your iCal URL will be cleared.")) return;
    onIcalUrlChange(null);
    onCalendarEvents(null);
    setUrlDraft("");
    setEditing(true);
  }

  const events = session.calendarEvents ?? [];
  // Calendar list is long — default collapsed once events are loaded.
  const [listOpen, setListOpen] = useState(false);
  const days = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const e of events) {
      const key = e.startISO.slice(0, 10);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([dayISO, evs]) => ({
        dayISO,
        dayLabel: new Date(dayISO + "T00:00:00").toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
        }),
        events: evs,
      }));
  }, [events]);

  return (
    <section className="mt-8">
      <div className="flex items-end justify-between mb-3">
        <div className="flex items-baseline gap-3">
          <div className="text-xs uppercase tracking-[0.18em] opacity-60 font-semibold">
            Calendar
          </div>
          <span className="text-[10px] opacity-50 uppercase tracking-wider">
            {icalUrl
              ? `Google Calendar · ${events.length} events this Oracle`
              : "Paste your Google Calendar iCal URL to load events"}
          </span>
        </div>
        <div className="flex gap-3 text-[10px]">
          {icalUrl && !editing && (
            <>
              <button
                type="button"
                onClick={() => fetchEvents(icalUrl)}
                disabled={loading}
                className="uppercase tracking-wider opacity-60 hover:opacity-100 disabled:opacity-30"
              >
                {loading ? "syncing…" : "refresh"}
              </button>
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="uppercase tracking-wider opacity-60 hover:opacity-100"
              >
                edit URL
              </button>
              <button
                type="button"
                onClick={disconnect}
                className="uppercase tracking-wider opacity-40 hover:opacity-100 hover:text-rose-400"
              >
                disconnect
              </button>
            </>
          )}
        </div>
      </div>

      {(editing || !icalUrl) && (
        <div
          style={{ borderColor: "var(--gold-dim)" }}
          className="rounded-xl border border-dashed bg-black/30 px-4 py-4"
        >
          <div className="text-[11px] opacity-60 mb-2">
            Google Calendar → ⚙ Settings → pick your calendar → scroll to{" "}
            <span style={{ color: "var(--gold)" }}>
              "Secret address in iCal format"
            </span>{" "}
            → copy URL → paste here.
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="https://calendar.google.com/calendar/ical/.../private-XXXXX/basic.ics"
              className="flex-1 rounded-md border border-[var(--hairline)] bg-black/40 px-3 py-2 text-xs font-mono focus:outline-none focus:border-[var(--gold)]"
            />
            <button
              type="button"
              onClick={save}
              disabled={loading || !urlDraft.trim()}
              style={{
                backgroundColor:
                  loading || !urlDraft.trim()
                    ? "var(--gold-dim)"
                    : "var(--gold)",
              }}
              className={`px-4 py-2 rounded-md text-black text-xs font-semibold transition-all ${
                loading || !urlDraft.trim()
                  ? "opacity-60 cursor-not-allowed"
                  : "hover:brightness-110"
              }`}
            >
              {loading ? "Loading…" : "Connect"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-2 text-[11px] text-rose-300 rounded border border-rose-500/30 bg-rose-500/5 p-2">
          {error}
        </div>
      )}

      {icalUrl && !editing && events.length === 0 && !loading && !error && (
        <div className="text-xs opacity-60 px-4 py-3 rounded border border-dashed border-[var(--hairline)]">
          No events found for {formatWeekRange(session.weekStart)}. Hit
          "refresh" or check your iCal URL.
        </div>
      )}

      {icalUrl && days.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setListOpen((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-2 rounded-lg border border-[var(--hairline)] bg-[var(--surface)] hover:bg-black/30 text-xs"
          >
            <span className="opacity-80">
              {listOpen ? "▾" : "▸"} {events.length} events across{" "}
              {days.length} day{days.length === 1 ? "" : "s"}
            </span>
            <span className="opacity-50">
              {listOpen ? "hide" : "show events"}
            </span>
          </button>
          {listOpen && (
            <div className="mt-2 space-y-2">
              {days.map((d) => (
                <CalendarDayCard key={d.dayISO} day={d} />
              ))}
            </div>
          )}
          {session.calendarFetchedAt && (
            <div className="text-[10px] opacity-40 text-right mt-2">
              fetched{" "}
              {new Date(session.calendarFetchedAt).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function CalendarDayCard({
  day,
}: {
  day: { dayISO: string; dayLabel: string; events: CalEvent[] };
}) {
  const [open, setOpen] = useState(true);
  const totalMin = day.events.reduce((s, e) => s + e.minutes, 0);
  return (
    <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface)] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-black/20 transition"
      >
        <div className="flex items-center gap-4">
          <span
            style={{ color: "var(--gold-bright)" }}
            className="text-sm font-semibold tracking-tight"
          >
            {day.dayLabel}
          </span>
          <span className="text-xs opacity-60">
            {day.events.length} event{day.events.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span
            style={{ color: "var(--gold)" }}
            className="text-sm tabular-nums"
          >
            {fmtMinutes(totalMin)}
          </span>
          <span className="text-[10px] opacity-50">{open ? "▾" : "▸"}</span>
        </div>
      </button>
      {open && (
        <ul className="border-t border-[var(--hairline)] divide-y divide-[var(--hairline)]">
          {day.events.map((e) => (
            <li key={e.uid} className="px-4 py-2.5 text-xs">
              <div className="flex gap-3 items-start">
                <span className="w-14 shrink-0 tabular-nums opacity-60">
                  {fmtTime(e.startISO)}
                </span>
                <span className="w-12 shrink-0 tabular-nums text-right opacity-80">
                  {e.minutes}m
                </span>
                <div className="flex-1 min-w-0">
                  <div
                    style={{ color: "var(--gold)" }}
                    className="font-medium leading-snug"
                  >
                    {e.title}
                  </div>
                  {(e.attendees?.length ?? 0) > 0 && (
                    <div className="text-[10px] opacity-60 mt-0.5 truncate">
                      with {e.attendees!.slice(0, 4).join(", ")}
                      {(e.attendees?.length ?? 0) > 4 &&
                        ` +${(e.attendees?.length ?? 0) - 4}`}
                    </div>
                  )}
                  {e.location && (
                    <div className="text-[10px] opacity-50 mt-0.5 truncate">
                      📍 {e.location}
                    </div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SubActions({
  sub,
  groupName,
  count,
  totalMin,
  color,
  onClearSub,
  onRecategorizeSub,
}: {
  sub: string;
  groupName: "Work" | "Personal";
  count: number;
  totalMin: number;
  color: string;
  onClearSub?: (sub: string) => void;
  onRecategorizeSub?: (
    fromSub: string,
    toGroup: "Work" | "Personal",
    toSub: string,
  ) => void;
}) {
  const [showMove, setShowMove] = useState(false);
  const [toGroup, setToGroup] = useState<"Work" | "Personal">(groupName);
  const [toSub, setToSub] = useState("");

  if (count === 0 && !showMove) return null;

  return (
    <div className="mt-2 mb-1 flex items-center justify-end gap-3 text-[10px] uppercase tracking-wider">
      <span className="opacity-50">
        {count} entr{count === 1 ? "y" : "ies"} · {fmtMinutes(totalMin)}
      </span>
      {onRecategorizeSub && (
        <button
          type="button"
          onClick={() => setShowMove((v) => !v)}
          style={{ color }}
          className="opacity-70 hover:opacity-100"
          title="Move all entries in this sub to a different sub"
        >
          {showMove ? "cancel" : "↪ move all"}
        </button>
      )}
      {onClearSub && (
        <button
          type="button"
          onClick={() => {
            if (
              confirm(
                `Hide all ${count} entries currently in "${sub}"? You can restore via "restore all" under the time tracker.`,
              )
            ) {
              onClearSub(sub);
            }
          }}
          className="opacity-50 hover:opacity-100 hover:text-rose-400"
          title="Hide all entries in this sub-category"
        >
          ✕ clear all
        </button>
      )}
      {showMove && onRecategorizeSub && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const target = toSub.trim();
            if (!target) return;
            onRecategorizeSub(sub, toGroup, target);
            setShowMove(false);
            setToSub("");
          }}
          className="flex items-center gap-1 normal-case tracking-normal"
        >
          <select
            value={toGroup}
            onChange={(e) =>
              setToGroup(e.target.value as "Work" | "Personal")
            }
            className="text-[10px] px-1 py-0.5 rounded bg-black/40 border border-[var(--hairline)] focus:outline-none focus:border-[var(--gold)]"
          >
            <option value="Work">Work</option>
            <option value="Personal">Personal</option>
          </select>
          <input
            type="text"
            value={toSub}
            onChange={(e) => setToSub(e.target.value)}
            placeholder="new sub"
            autoFocus
            className="text-[10px] px-1.5 py-0.5 rounded bg-black/40 border border-[var(--hairline)] focus:outline-none focus:border-[var(--gold)] w-24"
          />
          <button
            type="submit"
            disabled={!toSub.trim()}
            style={{
              backgroundColor: toSub.trim() ? "var(--gold)" : "var(--gold-dim)",
              color: "#000",
            }}
            className="text-[10px] px-2 py-0.5 rounded font-semibold disabled:opacity-50"
          >
            move
          </button>
        </form>
      )}
    </div>
  );
}

function ManualEntryAdder({
  weekStartISO,
  onAdd,
  open: openProp,
  onOpenChange,
  presetGroup,
}: {
  weekStartISO: string;
  onAdd: (entry: RizeEntry) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  presetGroup?: "Work" | "Personal";
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const setOpen = (next: boolean) => {
    setInternalOpen(next);
    onOpenChange?.(next);
  };
  // Build 7 day options for this Oracle week
  const dayOptions = useMemo(() => {
    const [y, m, d] = weekStartISO.split("-").map(Number);
    const out: { iso: string; label: string }[] = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(y, m - 1, d + i);
      const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      const label = day.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      out.push({ iso, label });
    }
    return out;
  }, [weekStartISO]);

  const [dayISO, setDayISO] = useState(dayOptions[0].iso);
  const [startHHMM, setStartHHMM] = useState("09:00");
  const [minutes, setMinutes] = useState<string>("30");
  const [group, setGroup] = useState<"Work" | "Personal">(
    presetGroup ?? "Personal",
  );
  const [sub, setSub] = useState(
    presetGroup === "Work" ? "Projects" : "Workouts",
  );
  const [description, setDescription] = useState("");

  // When parent opens the form with a presetGroup, sync the group state.
  useEffect(() => {
    if (open && presetGroup) {
      setGroup(presetGroup);
      setSub(presetGroup === "Work" ? "Projects" : "Workouts");
    }
  }, [open, presetGroup]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const min = Math.max(1, Math.round(parseFloat(minutes) || 0));
    if (!min) return;
    const [hh, mm] = startHHMM.split(":").map((s) => parseInt(s, 10));
    const [y, m, d] = dayISO.split("-").map(Number);
    const start = new Date(y, m - 1, d, hh || 0, mm || 0, 0);
    const end = new Date(start.getTime() + min * 60000);
    onAdd({
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `m_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      description: description.trim() || sub,
      minutes: min,
      group,
      sub: sub.trim() || "Other",
    });
    setDescription("");
    setMinutes("30");
  }

  if (!open) {
    return (
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{ borderColor: "var(--gold)", color: "var(--gold)" }}
          className="text-xs px-3 py-1.5 rounded border hover:brightness-110 transition"
        >
          ＋ Add manual entry
        </button>
      </div>
    );
  }

  const subOptions = group === "Work"
    ? ["Projects", "Strategy", "Social media content", "Meetings", "Connections", "Other"]
    : ["Meditation", "Workouts", "Sauna", "Cold plunge", "Dates", "Distracted", "Recovery", "Family", "Other"];

  return (
    <form
      onSubmit={submit}
      style={{ borderColor: "var(--gold)" }}
      className="mt-3 rounded-xl border bg-[var(--surface)] p-4 grid grid-cols-1 sm:grid-cols-[1fr_1fr_90px_110px_140px_1fr_auto] gap-2 items-end"
    >
      <label className="text-[10px] uppercase tracking-wider opacity-60 flex flex-col gap-1">
        Day
        <select
          value={dayISO}
          onChange={(e) => setDayISO(e.target.value)}
          className="rounded-md border border-[var(--hairline)] bg-black/40 px-2 py-1.5 text-xs focus:outline-none focus:border-[var(--gold)] normal-case tracking-normal"
        >
          {dayOptions.map((d) => (
            <option key={d.iso} value={d.iso}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      <label className="text-[10px] uppercase tracking-wider opacity-60 flex flex-col gap-1">
        Start
        <input
          type="time"
          value={startHHMM}
          onChange={(e) => setStartHHMM(e.target.value)}
          className="rounded-md border border-[var(--hairline)] bg-black/40 px-2 py-1.5 text-xs focus:outline-none focus:border-[var(--gold)] tabular-nums"
        />
      </label>
      <label className="text-[10px] uppercase tracking-wider opacity-60 flex flex-col gap-1">
        Minutes
        <input
          type="number"
          min={1}
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          className="rounded-md border border-[var(--hairline)] bg-black/40 px-2 py-1.5 text-xs focus:outline-none focus:border-[var(--gold)] tabular-nums"
        />
      </label>
      <label className="text-[10px] uppercase tracking-wider opacity-60 flex flex-col gap-1">
        Bucket
        <select
          value={group}
          onChange={(e) => {
            const g = e.target.value as "Work" | "Personal";
            setGroup(g);
            setSub(g === "Work" ? "Projects" : "Workouts");
          }}
          className="rounded-md border border-[var(--hairline)] bg-black/40 px-2 py-1.5 text-xs focus:outline-none focus:border-[var(--gold)] normal-case tracking-normal"
        >
          <option value="Work">Work</option>
          <option value="Personal">Personal</option>
        </select>
      </label>
      <label className="text-[10px] uppercase tracking-wider opacity-60 flex flex-col gap-1">
        Sub-category
        <input
          type="text"
          list="sub-options"
          value={sub}
          onChange={(e) => setSub(e.target.value)}
          className="rounded-md border border-[var(--hairline)] bg-black/40 px-2 py-1.5 text-xs focus:outline-none focus:border-[var(--gold)] normal-case tracking-normal"
        />
        <datalist id="sub-options">
          {subOptions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </label>
      <label className="text-[10px] uppercase tracking-wider opacity-60 flex flex-col gap-1">
        Description
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="optional"
          className="rounded-md border border-[var(--hairline)] bg-black/40 px-2 py-1.5 text-xs focus:outline-none focus:border-[var(--gold)] normal-case tracking-normal"
        />
      </label>
      <div className="flex gap-1.5 self-end">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs px-2 py-1.5 rounded-md opacity-60 hover:opacity-100"
        >
          Cancel
        </button>
        <button
          type="submit"
          style={{ backgroundColor: "var(--gold)" }}
          className="text-xs px-3 py-1.5 rounded-md text-black font-semibold hover:brightness-110 transition"
        >
          Add
        </button>
      </div>
    </form>
  );
}

function truncate(s: string, max = 60): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function DailyBreakdown({
  entries,
  onHideEntry,
}: {
  entries: RizeEntry[];
  onHideEntry: (id: string) => void;
}) {
  const days = useMemo(() => groupByDay(entries), [entries]);
  // Section + per-day both default CLOSED so the page isn't a wall on load.
  const [sectionOpen, setSectionOpen] = useState(false);
  const [openDays, setOpenDays] = useState<Set<string>>(() => new Set());

  function toggle(dayISO: string) {
    setOpenDays((prev) => {
      const next = new Set(prev);
      if (next.has(dayISO)) next.delete(dayISO);
      else next.add(dayISO);
      return next;
    });
  }

  const totalEntries = entries.length;
  const totalMin = entries.reduce((s, e) => s + e.minutes, 0);

  return (
    <section className="mt-6">
      <button
        type="button"
        onClick={() => setSectionOpen((v) => !v)}
        className="w-full flex items-end justify-between mb-3 text-left hover:opacity-100 group"
      >
        <div className="flex items-baseline gap-3">
          <div className="text-xs uppercase tracking-[0.18em] opacity-60 font-semibold group-hover:opacity-100">
            Daily breakdown
            <span className="ml-2 text-[10px] opacity-60">
              {sectionOpen ? "▾" : "▸"}
            </span>
          </div>
          <span className="text-[10px] opacity-50 uppercase tracking-wider">
            {totalEntries} entries · {fmtMinutes(totalMin)} ·{" "}
            {sectionOpen ? "click to collapse" : "click to expand"}
          </span>
        </div>
        {sectionOpen && (
          <div className="flex gap-3 text-[10px]">
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                setOpenDays(new Set(days.map((d) => d.dayISO)));
              }}
              className="uppercase tracking-wider opacity-60 hover:opacity-100 cursor-pointer"
            >
              expand all
            </span>
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                setOpenDays(new Set());
              }}
              className="uppercase tracking-wider opacity-60 hover:opacity-100 cursor-pointer"
            >
              collapse all
            </span>
          </div>
        )}
      </button>

      {sectionOpen && (
      <div className="space-y-2">
        {days.map((d) => {
          const open = openDays.has(d.dayISO);
          return (
            <div
              key={d.dayISO}
              className="rounded-lg border border-[var(--hairline)] bg-[var(--surface)] overflow-hidden"
            >
              <button
                type="button"
                onClick={() => toggle(d.dayISO)}
                className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-black/20 transition"
              >
                <div className="flex items-center gap-4">
                  <span
                    style={{ color: "var(--gold-bright)" }}
                    className="text-sm font-semibold tracking-tight"
                  >
                    {d.dayLabel}
                  </span>
                  <span className="text-xs opacity-60">
                    {d.entries.length} entries
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <span
                    style={{ color: "var(--gold)" }}
                    className="text-sm tabular-nums"
                  >
                    {fmtMinutes(d.totalMinutes)}
                  </span>
                  <span className="text-[10px] opacity-50">
                    {open ? "▾" : "▸"}
                  </span>
                </div>
              </button>
              {open && (
                <ul className="border-t border-[var(--hairline)] divide-y divide-[var(--hairline)]">
                  {d.entries.map((e, i) => {
                    const color = colorForSub(e.sub, e.group);
                    return (
                      <li
                        key={e.id ?? i}
                        className="px-4 py-2 flex gap-3 items-center text-xs group/entry hover:bg-black/20"
                      >
                        <span
                          className="h-2 w-2 rounded-full shrink-0"
                          style={{ backgroundColor: color }}
                        />
                        <span className="w-14 shrink-0 tabular-nums opacity-60">
                          {fmtTime(e.startISO)}
                        </span>
                        <span className="w-12 shrink-0 tabular-nums text-right opacity-80">
                          {e.minutes}m
                        </span>
                        <span
                          style={{
                            color,
                            borderColor: color,
                          }}
                          className="shrink-0 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border"
                        >
                          {e.sub}
                        </span>
                        <span
                          className="flex-1 opacity-85 leading-snug truncate"
                          title={e.description}
                        >
                          {truncate(e.description, 72)}
                        </span>
                        {e.id && (
                          <button
                            type="button"
                            onClick={() => onHideEntry(e.id!)}
                            className="opacity-0 group-hover/entry:opacity-50 hover:!opacity-100 hover:text-rose-400 text-[10px] tabular-nums transition shrink-0"
                            aria-label="Hide entry"
                            title="Hide this entry from the time tracker"
                          >
                            ✕
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      )}
    </section>
  );
}

function RizeUpload({
  session,
  onUpload,
}: {
  session: OracleSession;
  onUpload: (entries: RizeEntry[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const hasReal = !!session.riseEntries && session.riseEntries.length > 0;

  async function handleFile(file: File) {
    setError(null);
    try {
      const text = await file.text();
      const entries = parseRizeCSV(text);
      if (entries.length === 0) {
        setError("Couldn't parse any rows. Is this a Rize CSV export?");
        return;
      }
      onUpload(entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    }
  }

  return (
    <div
      style={{
        borderColor: hasReal ? "var(--gold-dim)" : "var(--gold)",
      }}
      className={`rounded-xl border border-dashed px-4 py-3 ${
        hasReal ? "bg-black/30" : "bg-[var(--gold)]/5"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div
            style={{ color: "var(--gold)" }}
            className="text-xs uppercase tracking-wider font-semibold"
          >
            Rize CSV — this Oracle
          </div>
          {hasReal ? (
            <div className="text-[11px] opacity-70 truncate">
              ✓ {session.riseEntries!.length} entries loaded for{" "}
              {formatWeekRange(session.weekStart)}
              {session.rizeUploadedAt &&
                ` · uploaded ${new Date(session.rizeUploadedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`}
            </div>
          ) : (
            <div className="text-[11px] opacity-80">
              No Rize data yet for {formatWeekRange(session.weekStart)} —
              export your weekly Rize report and drop the CSV here.
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          style={
            hasReal
              ? { borderColor: "var(--gold)", color: "var(--gold)" }
              : { backgroundColor: "var(--gold)", color: "#000" }
          }
          className={`text-xs px-3 py-1.5 rounded transition shrink-0 ${
            hasReal
              ? "border hover:brightness-110"
              : "font-semibold hover:brightness-110"
          }`}
        >
          {hasReal ? "Replace CSV" : "Upload CSV"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = "";
          }}
        />
      </div>
      {error && (
        <div className="mt-2 text-[11px] text-rose-400/80">{error}</div>
      )}
    </div>
  );
}

function CalendarUpload({
  session,
  onUpload,
  onClear,
}: {
  session: OracleSession;
  onUpload: (dataUrl: string) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFull, setShowFull] = useState(false);

  async function handleFile(file: File) {
    setError(null);
    if (!file.type.startsWith("image/")) {
      setError("Pick an image file");
      return;
    }
    if (file.size > 4_500_000) {
      setError("Image too large (>4.5MB). Take a fresh screenshot or compress it.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => onUpload(String(reader.result));
    reader.onerror = () => setError("Couldn't read image");
    reader.readAsDataURL(file);
  }

  return (
    <>
      <div className="rounded-xl border border-dashed border-[var(--gold-dim)] bg-black/30 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {session.calendarImage && (
              <button
                type="button"
                onClick={() => setShowFull(true)}
                className="h-12 w-12 rounded border border-[var(--hairline)] overflow-hidden shrink-0"
                aria-label="View full calendar"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={session.calendarImage}
                  alt="Calendar thumb"
                  className="h-full w-full object-cover"
                />
              </button>
            )}
            <div className="min-w-0">
              <div
                style={{ color: "var(--gold)" }}
                className="text-xs uppercase tracking-wider font-semibold"
              >
                Calendar screenshot
              </div>
              {session.calendarImage ? (
                <div className="text-[11px] opacity-70 truncate">
                  Uploaded
                  {session.calendarUploadedAt &&
                    ` · ${new Date(session.calendarUploadedAt).toLocaleString()}`}
                </div>
              ) : (
                <div className="text-[11px] opacity-50">
                  Drag a screenshot of your week
                </div>
              )}
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            {session.calendarImage && (
              <button
                type="button"
                onClick={onClear}
                className="text-[10px] uppercase tracking-wider opacity-50 hover:opacity-100"
              >
                Clear
              </button>
            )}
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              style={{ borderColor: "var(--gold)", color: "var(--gold)" }}
              className="text-xs px-3 py-1.5 rounded border hover:brightness-110 transition"
            >
              {session.calendarImage ? "Replace" : "Upload"}
            </button>
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = "";
              }}
            />
          </div>
        </div>
        {error && (
          <div className="mt-2 text-[11px] text-rose-400/80">{error}</div>
        )}
      </div>

      {showFull && session.calendarImage && (
        <div
          onClick={() => setShowFull(false)}
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-6 cursor-zoom-out"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={session.calendarImage}
            alt="Calendar"
            className="max-h-full max-w-full rounded-lg shadow-2xl"
          />
        </div>
      )}
    </>
  );
}

function UncategorizedBlock({ entries }: { entries: RizeEntry[] }) {
  const [open, setOpen] = useState(false);
  const totalMin = entries.reduce((s, e) => s + e.minutes, 0);
  return (
    <div
      style={{ borderColor: "var(--gold-dim)" }}
      className="mt-4 rounded-xl border border-dashed bg-black/20 px-4 py-3"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 text-left"
      >
        <div>
          <div
            style={{ color: "var(--gold-dim)" }}
            className="text-xs uppercase tracking-wider font-semibold"
          >
            Uncategorized
          </div>
          <div className="text-[11px] opacity-60">
            {entries.length} entries · {fmtMinutes(totalMin)} — keyword rules
            need a tweak
          </div>
        </div>
        <span className="text-xs opacity-50">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <ul className="mt-3 space-y-1 max-h-48 overflow-y-auto text-[11px] opacity-80">
          {entries.map((e, i) => (
            <li key={i} className="flex gap-3">
              <span className="tabular-nums opacity-60 shrink-0">
                {fmtMinutes(e.minutes)}
              </span>
              <span className="truncate">{e.description}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LoadedBanner({ session }: { session: OracleSession }) {
  const entries = session.riseEntries ?? [];
  const totalMin = entries.reduce((s, e) => s + e.minutes, 0);
  const days = groupByDay(entries);
  const first = days[0];
  const last = days[days.length - 1];
  const rangeLabel =
    first && last && first.dayISO !== last.dayISO
      ? `${first.dayLabel} → ${last.dayLabel}`
      : first?.dayLabel ?? "—";
  const uploaded = session.rizeUploadedAt
    ? new Date(session.rizeUploadedAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
  return (
    <div
      style={{ borderColor: "var(--gold)" }}
      className="mt-3 rounded-lg border bg-emerald-500/5 px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs"
    >
      <span
        style={{ color: "var(--gold-bright)" }}
        className="font-semibold tracking-wide"
      >
        ✓ Loaded
      </span>
      <span>
        <span style={{ color: "var(--gold)" }} className="tabular-nums">
          {entries.length}
        </span>{" "}
        <span className="opacity-60">entries</span>
      </span>
      <span>
        <span style={{ color: "var(--gold)" }} className="tabular-nums">
          {fmtMinutes(totalMin)}
        </span>{" "}
        <span className="opacity-60">tracked</span>
      </span>
      <span className="opacity-80 tabular-nums">{rangeLabel}</span>
      {session.calendarImage && (
        <span className="opacity-60">· calendar screenshot attached</span>
      )}
      {uploaded && (
        <span className="opacity-40 ml-auto text-[10px]">
          uploaded {uploaded}
        </span>
      )}
    </div>
  );
}

function EmptyRangeNotice({
  range,
  entries,
  onPick,
}: {
  range: DateRangeId;
  entries: RizeEntry[];
  onPick: (r: DateRangeId) => void;
}) {
  const cfg = DATE_RANGES.find((r) => r.id === range)!;
  const sorted = [...entries].sort((a, b) =>
    a.startISO.localeCompare(b.startISO),
  );
  const first = sorted[0]?.startISO
    ? new Date(sorted[0].startISO).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : null;
  const last = sorted[sorted.length - 1]?.startISO
    ? new Date(sorted[sorted.length - 1].startISO).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : null;
  return (
    <div
      style={{ borderColor: "var(--gold-dim)" }}
      className="mt-4 rounded-xl border border-dashed bg-black/20 px-4 py-4 text-sm"
    >
      <div className="opacity-80">
        No tracked time for <span style={{ color: "var(--gold)" }}>{cfg.description}</span>.
      </div>
      {first && last && (
        <div className="mt-1 text-xs opacity-60">
          Your loaded Rize data covers{" "}
          <span style={{ color: "var(--gold-dim)" }}>{first} → {last}</span>.{" "}
          <button
            type="button"
            onClick={() => onPick("7d")}
            style={{ color: "var(--gold)" }}
            className="underline underline-offset-2 hover:brightness-110"
          >
            Switch to 7 days
          </button>
          {" "}or upload a fresher CSV.
        </div>
      )}
    </div>
  );
}

function SampleBanner({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{ borderColor: "var(--gold-dim)" }}
      className="mt-3 text-[11px] px-3 py-2 rounded border border-dashed opacity-70"
    >
      <span style={{ color: "var(--gold-dim)" }} className="font-semibold mr-1">
        SAMPLE
      </span>
      {children}
    </div>
  );
}

function RangePicker({
  value,
  onChange,
}: {
  value: DateRangeId;
  onChange: (r: DateRangeId) => void;
}) {
  return (
    <div className="inline-flex gap-1 p-1 rounded-lg border border-[var(--hairline)] bg-black/30">
      {DATE_RANGES.map((r) => {
        const active = r.id === value;
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onChange(r.id)}
            style={
              active
                ? { backgroundColor: "var(--gold)", color: "#000" }
                : undefined
            }
            className={`px-3 py-1.5 text-xs rounded-md transition-all ${
              active
                ? "font-semibold"
                : "opacity-60 hover:opacity-100 hover:bg-black/40"
            }`}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}

function CategoryGroupCard({
  group,
  accent,
  accentDim,
  entries = [],
  grandTotalMinutes,
  onHideEntry,
  onClearSub,
  onRecategorizeSub,
  onRecategorizeEntry,
  onAddSubInGroup,
}: {
  group: CategoryGroup;
  accent: string;
  accentDim: string;
  entries?: RizeEntry[];
  /** Sum of minutes across Work + Personal for the viewed range —
   * used as the denominator when computing each sub's % so the
   * numbers add up to ~100% across the whole week, not within just
   * one bucket. */
  grandTotalMinutes?: number;
  onHideEntry?: (id: string) => void;
  onClearSub?: (sub: string) => void;
  onRecategorizeSub?: (
    fromSub: string,
    toGroup: "Work" | "Personal",
    toSub: string,
  ) => void;
  onRecategorizeEntry?: (
    entryId: string,
    toGroup: "Work" | "Personal",
    toSub: string,
  ) => void;
  onAddSubInGroup?: (group: "Work" | "Personal") => void;
}) {
  const total = group.subs.reduce((s, x) => s + x.minutes, 0);
  const max = Math.max(1, ...group.subs.map((s) => s.minutes));
  // Fall back to bucket total if parent didn't pass a grand total
  // (keeps the component standalone-safe for any future caller).
  const denominator =
    grandTotalMinutes && grandTotalMinutes > 0 ? grandTotalMinutes : total;
  const [openSub, setOpenSub] = useState<string | null>(null);
  const hasEntries = entries.length > 0;

  return (
    <div className="rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-5">
      <div className="flex items-end justify-between mb-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] opacity-60">
            {group.name === "Work" ? "Bucket · work" : "Bucket · personal"}
          </div>
          <div
            style={{ color: accent }}
            className="text-lg font-semibold mt-0.5"
          >
            {group.name}
          </div>
        </div>
        <div
          style={{ color: accent }}
          className="text-2xl font-semibold tabular-nums"
        >
          {fmtMinutes(total)}
        </div>
      </div>

      <ul className="space-y-2.5">
        {group.subs.map((s) => {
          // `pct` is the bar width relative to the largest sub in this
          // bucket — used for visual scale only. `shareOfTotal` is the
          // actual % this sub represents out of ALL tracked time
          // (Work + Personal combined), so Nick can answer "what % of
          // my week went to Workouts" without doing mental math.
          const pct = Math.round((s.minutes / max) * 100);
          const shareOfTotal =
            denominator > 0
              ? Math.round((s.minutes / denominator) * 100)
              : 0;
          const isOpen = openSub === s.name;
          const subColor = colorForSub(s.name, group.name);
          const subEntries = entries
            .filter((e) => e.sub === s.name)
            .sort(
              (a, b) =>
                new Date(b.startISO).getTime() -
                new Date(a.startISO).getTime(),
            );

          return (
            <li key={s.name}>
              <button
                type="button"
                onClick={() => hasEntries && setOpenSub(isOpen ? null : s.name)}
                disabled={!hasEntries}
                className={`w-full text-left ${hasEntries ? "cursor-pointer hover:opacity-100" : "cursor-default"}`}
              >
                <div className="flex justify-between text-xs">
                  <span className="opacity-85 flex items-center gap-2">
                    <span
                      className="h-2 w-2 rounded-full shrink-0"
                      style={{ backgroundColor: subColor }}
                    />
                    {s.name}
                    {hasEntries && (
                      <span className="text-[9px] opacity-50">
                        {isOpen ? "▾" : "▸"}
                      </span>
                    )}
                  </span>
                  <span
                    style={{ color: subColor }}
                    className="tabular-nums"
                  >
                    {fmtMinutes(s.minutes)}
                    <span className="opacity-55 ml-1.5 text-[10px]">
                      {shareOfTotal}%
                    </span>
                  </span>
                </div>
                <div className="h-1.5 mt-1 rounded bg-black/60 overflow-hidden">
                  <div
                    className="h-full rounded"
                    style={{ width: `${pct}%`, backgroundColor: subColor }}
                  />
                </div>
              </button>
              {isOpen && (
                <SubActions
                  sub={s.name}
                  groupName={group.name}
                  count={subEntries.length}
                  totalMin={s.minutes}
                  color={subColor}
                  onClearSub={onClearSub}
                  onRecategorizeSub={onRecategorizeSub}
                />
              )}
              {isOpen && subEntries.length > 0 && (
                <ul className="mt-2 ml-2 pl-2 border-l space-y-1 max-h-64 overflow-y-auto"
                  style={{ borderColor: subColor + "55" }}
                >
                  {subEntries.map((e, i) => (
                    <EntryRow
                      key={e.id ?? i}
                      entry={e}
                      subColor={subColor}
                      onHideEntry={onHideEntry}
                      onRecategorizeEntry={onRecategorizeEntry}
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {onAddSubInGroup && (
        <button
          type="button"
          onClick={() => onAddSubInGroup(group.name)}
          className="mt-4 text-[10px] uppercase tracking-wider opacity-50 hover:opacity-100 transition-opacity"
        >
          ＋ add entry / sub-category
        </button>
      )}
    </div>
  );
}

/* ─── Single time-tracker entry row + per-entry move popover ───── */

/** Hardcoded list of available sub-buckets per group. Kept in sync
 * with the ManualEntryAdder list at the top of the file. If we ever
 * make these user-configurable, factor this out into a constant in
 * lib/spiros.ts. */
const SUB_OPTIONS = {
  Work: [
    "Projects",
    "Strategy",
    "Social media content",
    "Meetings",
    "Connections",
    "Other",
  ],
  Personal: [
    "Meditation",
    "Workouts",
    "Sauna",
    "Cold plunge",
    "Dates",
    "Distracted",
    "Recovery",
    "Family",
    "Other",
  ],
} as const;

function EntryRow({
  entry,
  subColor,
  onHideEntry,
  onRecategorizeEntry,
}: {
  entry: RizeEntry;
  subColor: string;
  onHideEntry?: (id: string) => void;
  onRecategorizeEntry?: (
    entryId: string,
    toGroup: "Work" | "Personal",
    toSub: string,
  ) => void;
}) {
  const [moveOpen, setMoveOpen] = useState(false);
  return (
    <li className="relative text-[11px] flex gap-2 leading-snug items-center group/sub hover:bg-black/20 -mx-1 px-1 py-0.5 rounded">
      <span className="tabular-nums opacity-50 shrink-0 w-12">
        {fmtTime(entry.startISO)}
      </span>
      <span
        style={{ color: subColor }}
        className="tabular-nums shrink-0 w-10 text-right"
      >
        {entry.minutes}m
      </span>
      <span
        className="opacity-80 flex-1 truncate"
        title={entry.description}
      >
        {truncate(entry.description, 60)}
      </span>
      {entry.id && onRecategorizeEntry && (
        <button
          type="button"
          onClick={(ev) => {
            ev.stopPropagation();
            setMoveOpen((v) => !v);
          }}
          className={`transition text-[10px] shrink-0 ${
            moveOpen
              ? "opacity-100 text-white"
              : "opacity-0 group-hover/sub:opacity-50 hover:!opacity-100"
          }`}
          aria-label="Move entry to another bucket"
          title="Move this entry to another bucket"
        >
          ↗
        </button>
      )}
      {entry.id && onHideEntry && (
        <button
          type="button"
          onClick={(ev) => {
            ev.stopPropagation();
            onHideEntry(entry.id!);
          }}
          className="opacity-0 group-hover/sub:opacity-50 hover:!opacity-100 hover:text-rose-400 transition text-[10px] shrink-0"
          aria-label="Hide entry"
          title="Hide this entry"
        >
          ✕
        </button>
      )}
      {moveOpen && entry.id && onRecategorizeEntry && (
        <EntryMover
          currentGroup={entry.group === "Uncategorized" ? "Work" : entry.group}
          currentSub={entry.sub}
          onPick={(toGroup, toSub) => {
            setMoveOpen(false);
            onRecategorizeEntry(entry.id!, toGroup, toSub);
          }}
          onClose={() => setMoveOpen(false)}
        />
      )}
    </li>
  );
}

/** Compact popover anchored to the EntryRow. Shows Work + Personal
 * sub options as a two-column grid; clicking one commits the move. */
function EntryMover({
  currentGroup,
  currentSub,
  onPick,
  onClose,
}: {
  currentGroup: "Work" | "Personal";
  currentSub: string;
  onPick: (toGroup: "Work" | "Personal", toSub: string) => void;
  onClose: () => void;
}) {
  // Close on Escape so the popover is keyboard-dismissible.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="absolute right-0 top-full mt-1 z-30 w-[280px] rounded-lg border border-[var(--hairline-strong)] bg-black/95 backdrop-blur shadow-xl p-3"
      onClick={(ev) => ev.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-wider opacity-60">
          Move to
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-[10px] opacity-50 hover:opacity-100"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <MoverColumn
          label="Work"
          color="var(--gold)"
          subs={SUB_OPTIONS.Work as unknown as string[]}
          currentGroup={currentGroup}
          currentSub={currentSub}
          onPick={(sub) => onPick("Work", sub)}
        />
        <MoverColumn
          label="Personal"
          color="var(--champagne)"
          subs={SUB_OPTIONS.Personal as unknown as string[]}
          currentGroup={currentGroup}
          currentSub={currentSub}
          onPick={(sub) => onPick("Personal", sub)}
        />
      </div>
    </div>
  );
}

function MoverColumn({
  label,
  color,
  subs,
  currentGroup,
  currentSub,
  onPick,
}: {
  label: "Work" | "Personal";
  color: string;
  subs: string[];
  currentGroup: "Work" | "Personal";
  currentSub: string;
  onPick: (sub: string) => void;
}) {
  return (
    <div>
      <div
        style={{ color }}
        className="text-[10px] uppercase tracking-wider mb-1 font-semibold"
      >
        {label}
      </div>
      <ul className="space-y-0.5">
        {subs.map((s) => {
          const isCurrent =
            currentGroup === label && currentSub.toLowerCase() === s.toLowerCase();
          return (
            <li key={s}>
              <button
                type="button"
                disabled={isCurrent}
                onClick={() => onPick(s)}
                className={`w-full text-left text-[11px] px-1.5 py-1 rounded transition ${
                  isCurrent
                    ? "opacity-40 cursor-default bg-white/[0.04]"
                    : "opacity-80 hover:opacity-100 hover:bg-white/10"
                }`}
                title={
                  isCurrent
                    ? "Already in this bucket"
                    : `Move to ${label} / ${s}`
                }
              >
                {s}
                {isCurrent && (
                  <span className="ml-1 text-[9px] opacity-50">· current</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Donut({
  workPct,
  personalPct,
}: {
  workPct: number;
  personalPct: number;
}) {
  const R = 50;
  const C = 2 * Math.PI * R;
  const workLen = (workPct / 100) * C;
  return (
    <svg viewBox="0 0 120 120" className="h-32 w-32 -rotate-90">
      <circle cx="60" cy="60" r={R} fill="none" stroke="#000" strokeWidth="14" />
      <circle
        cx="60"
        cy="60"
        r={R}
        fill="none"
        stroke="var(--champagne)"
        strokeWidth="14"
      />
      <circle
        cx="60"
        cy="60"
        r={R}
        fill="none"
        stroke="var(--gold)"
        strokeWidth="14"
        strokeDasharray={`${workLen} ${C - workLen}`}
      />
      <text
        x="60"
        y="60"
        textAnchor="middle"
        dominantBaseline="central"
        transform="rotate(90 60 60)"
        fill="var(--gold-bright)"
        fontSize="18"
        fontWeight="600"
      >
        {workPct}/{personalPct}
      </text>
    </svg>
  );
}

/* ─── Strategy ───────────────────────────────────────────────── */

function StrategySection({
  transcript,
  onTranscriptChange,
  ranked,
  topScore,
  expandedId,
  onToggleExpand,
  onUpdateItem,
  onMarkDone,
  onDelete,
  showNewForm,
  onShowNewForm,
  onHideNewForm,
  onAddItem,
  onAddItems,
}: {
  transcript: string;
  onTranscriptChange: (v: string) => void;
  ranked: (RiceItem & { score: number })[];
  topScore: number;
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
  onUpdateItem: (id: string, patch: Partial<RiceItem>) => void;
  onMarkDone: (id: string) => void;
  onDelete: (id: string) => void;
  showNewForm: boolean;
  onShowNewForm: () => void;
  onHideNewForm: () => void;
  onAddItem: (partial: Partial<RiceItem> & { title: string }) => void;
  onAddItems: (partials: (Partial<RiceItem> & { title: string })[]) => void;
}) {
  const totalLeft = ranked.reduce((s, i) => s + hoursLeft(i), 0);
  return (
    <section className="mt-12">
      <SectionLabel
        label="Strategy"
        sub="brain dump → RICE priorities"
        right={`${ranked.length} open · ${fmtHours(totalLeft)} left`}
      />

      <BrainDumpCard
        transcript={transcript}
        onChange={onTranscriptChange}
        onItemsExtracted={onAddItems}
      />

      <div className="mt-5 flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-[0.18em] opacity-60">
          Priorities
        </div>
        {!showNewForm && (
          <button
            type="button"
            onClick={onShowNewForm}
            style={{ backgroundColor: "var(--gold)" }}
            className="text-xs px-3 py-1.5 rounded-md text-black font-semibold hover:brightness-110 transition-all"
          >
            ＋ New priority
          </button>
        )}
      </div>

      {showNewForm && (
        <NewItemForm onCancel={onHideNewForm} onSubmit={onAddItem} />
      )}

      <div className="mt-3 space-y-3">
        {ranked.length === 0 && !showNewForm ? (
          <div className="rounded-xl border border-dashed border-[var(--hairline)] p-10 text-center opacity-60 text-sm">
            <p>No priorities yet for this Oracle.</p>
            <p className="text-xs opacity-70 mt-1">
              Hit ＋ New priority to add one, or paste a brain dump above.
            </p>
          </div>
        ) : (
          ranked.map((item, idx) => (
            <PriorityCard
              key={item.id}
              item={item}
              rank={idx + 1}
              topScore={topScore}
              expanded={expandedId === item.id}
              onToggleExpand={() => onToggleExpand(item.id)}
              onUpdateItem={onUpdateItem}
              onMarkDone={() => onMarkDone(item.id)}
              onDelete={() => onDelete(item.id)}
            />
          ))
        )}
      </div>
    </section>
  );
}

function NewItemForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (partial: Partial<RiceItem> & { title: string }) => void;
}) {
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [category, setCategory] = useState<string>("");
  const [reach, setReach] = useState(5);
  const [impact, setImpact] = useState(5);
  const [confidence, setConfidence] = useState(5);
  const [effort, setEffort] = useState(5);
  const [estHours, setEstHours] = useState(1);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit({
      title: title.trim(),
      note: note.trim() || undefined,
      category: category || undefined,
      reach,
      impact,
      confidence,
      effort,
      estHours,
      progress: 0,
    });
  }

  const preview =
    Math.round(((reach * impact * confidence) / Math.max(1, effort)) * 10) /
    10;

  return (
    <form
      onSubmit={submit}
      style={{ borderColor: "var(--gold)" }}
      className="mt-3 rounded-xl border bg-[var(--surface)] p-5 space-y-4 shadow-[0_0_24px_rgba(212,175,55,0.15)]"
    >
      <div className="flex items-center justify-between">
        <h3
          style={{ color: "var(--gold-bright)" }}
          className="text-sm font-semibold uppercase tracking-wider"
        >
          New priority
        </h3>
        <div
          style={{ color: "var(--gold-bright)" }}
          className="text-xs tabular-nums"
        >
          live score: <span className="font-semibold">{preview}</span>
        </div>
      </div>

      <div>
        <label className="block text-[10px] uppercase tracking-wider opacity-60 mb-1">
          Title
        </label>
        <input
          autoFocus
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What's the decision or initiative?"
          className="w-full rounded-md border border-[var(--hairline)] bg-black/40 px-3 py-2 text-sm focus:outline-none focus:border-[var(--gold)]"
          required
        />
      </div>

      <div>
        <label className="block text-[10px] uppercase tracking-wider opacity-60 mb-1">
          Note (optional)
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Context, why it matters, what success looks like"
          className="w-full h-20 resize-none rounded-md border border-[var(--hairline)] bg-black/40 px-3 py-2 text-sm focus:outline-none focus:border-[var(--gold)]"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr] gap-4">
        <div>
          <label className="block text-[10px] uppercase tracking-wider opacity-60 mb-1">
            Category
          </label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full rounded-md border border-[var(--hairline)] bg-black/40 px-3 py-2 text-sm focus:outline-none focus:border-[var(--gold)]"
          >
            <option value="">— pick one —</option>
            {DEFAULT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-wider opacity-60 mb-1">
            Est. hours
          </label>
          <input
            type="number"
            min={0.25}
            step={0.25}
            value={estHours}
            onChange={(e) => setEstHours(parseFloat(e.target.value) || 0)}
            className="w-full rounded-md border border-[var(--hairline)] bg-black/40 px-3 py-2 text-sm focus:outline-none focus:border-[var(--gold)] tabular-nums"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <RiceSlider label="Reach" value={reach} onChange={setReach} />
        <RiceSlider label="Impact" value={impact} onChange={setImpact} />
        <RiceSlider
          label="Confidence"
          value={confidence}
          onChange={setConfidence}
        />
        <RiceSlider label="Effort" value={effort} onChange={setEffort} />
      </div>

      <div className="flex justify-end gap-2 pt-2 border-t border-[var(--hairline)]">
        <button
          type="button"
          onClick={onCancel}
          className="text-xs px-3 py-1.5 rounded-md opacity-60 hover:opacity-100"
        >
          Cancel
        </button>
        <button
          type="submit"
          style={{ backgroundColor: "var(--gold)" }}
          className="text-xs px-4 py-1.5 rounded-md text-black font-semibold hover:brightness-110 transition-all"
        >
          Add to Oracle
        </button>
      </div>
    </form>
  );
}

function BrainDumpCard({
  transcript,
  onChange,
  onItemsExtracted,
}: {
  transcript: string;
  onChange: (v: string) => void;
  onItemsExtracted: (items: (Partial<RiceItem> & { title: string })[]) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [help, setHelp] = useState<string | null>(null);
  const [lastAdded, setLastAdded] = useState<number | null>(null);

  async function process() {
    if (!transcript.trim()) return;
    setLoading(true);
    setError(null);
    setHelp(null);
    setLastAdded(null);
    try {
      const res = await fetch("/api/process-dump", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Error ${res.status}`);
        if (data.help) setHelp(data.help);
        return;
      }
      const items = (data.items as Array<Record<string, unknown>>)
        .filter((i) => typeof i.title === "string" && (i.title as string).trim())
        .map((i) => ({
          title: String(i.title),
          note: typeof i.note === "string" ? i.note : undefined,
          reach: clamp(Number(i.reach) || 5, 1, 10),
          impact: clamp(Number(i.impact) || 5, 1, 10),
          confidence: clamp(Number(i.confidence) || 5, 1, 10),
          effort: clamp(Number(i.effort) || 5, 1, 10),
          estHours: Math.max(0.25, Number(i.estHours) || 1),
          category:
            typeof i.category === "string" && i.category !== "null"
              ? i.category
              : undefined,
          nextAction:
            typeof i.nextAction === "string" ? i.nextAction : undefined,
        }));
      if (items.length === 0) {
        setError("No items extracted. Try a more detailed dump.");
        return;
      }
      onItemsExtracted(items);
      setLastAdded(items.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="rounded-xl border border-[var(--hairline)] bg-[var(--surface)] p-5 mt-4">
      <div className="flex items-center justify-between mb-4">
        <div className="text-[10px] uppercase tracking-[0.18em] opacity-60">
          Brain dump
        </div>
        <span className="text-[10px] opacity-50">
          Persisted to this Oracle · Claude extracts RICE items
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[140px_1fr] gap-4">
        <button
          type="button"
          disabled
          className="group flex flex-col items-center justify-center gap-2 rounded-lg border border-[var(--gold-dim)] bg-black/40 px-3 py-6 opacity-60 cursor-not-allowed"
          title="Voice recording coming in a future round"
        >
          <span
            style={{ backgroundColor: "var(--gold-dim)" }}
            className="h-12 w-12 rounded-full text-black flex items-center justify-center font-bold text-xl"
          >
            ●
          </span>
          <span
            style={{ color: "var(--gold-dim)" }}
            className="text-xs uppercase tracking-wider"
          >
            Record
          </span>
          <span className="text-[10px] opacity-50">soon</span>
        </button>

        <div className="relative">
          <textarea
            value={transcript}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Talk like you're talking to me — projects, fires, ideas, blockers. Spiros will extract them as priorities."
            className="w-full h-40 resize-none rounded-lg border border-[var(--hairline)] bg-black/40 p-3 text-sm leading-relaxed font-mono focus:outline-none focus:border-[var(--gold)]"
          />
          <div className="absolute bottom-3 right-3 text-[10px] opacity-40">
            {transcript.length} chars
          </div>
        </div>
      </div>

      {error && (
        <div
          style={{ borderColor: "var(--gold-dim)" }}
          className="mt-3 rounded-md border border-dashed bg-rose-500/5 p-3 text-xs"
        >
          <div className="text-rose-300 font-semibold mb-1">{error}</div>
          {help && <div className="opacity-70 text-[11px]">{help}</div>}
        </div>
      )}

      {lastAdded !== null && !error && (
        <div
          style={{ borderColor: "var(--gold)" }}
          className="mt-3 rounded-md border border-dashed bg-emerald-500/5 p-3 text-xs text-emerald-300"
        >
          ✓ Added {lastAdded} {lastAdded === 1 ? "priority" : "priorities"} to
          this Oracle. Scroll down to review.
        </div>
      )}

      <div className="flex justify-end mt-4">
        <button
          type="button"
          onClick={process}
          disabled={loading || !transcript.trim()}
          style={{
            backgroundColor: loading || !transcript.trim()
              ? "var(--gold-dim)"
              : "var(--gold)",
          }}
          className={`px-5 py-2 rounded-md text-black text-sm font-semibold transition-all shadow-[0_4px_24px_rgba(212,175,55,0.2)] ${
            loading || !transcript.trim()
              ? "opacity-60 cursor-not-allowed"
              : "hover:brightness-110"
          }`}
        >
          {loading ? "Processing…" : "Process → RICE"}
        </button>
      </div>
    </section>
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function PriorityCard({
  item,
  rank,
  topScore,
  expanded,
  onToggleExpand,
  onUpdateItem,
  onMarkDone,
  onDelete,
}: {
  item: RiceItem & { score: number };
  rank: number;
  topScore: number;
  expanded: boolean;
  onToggleExpand: () => void;
  onUpdateItem: (id: string, patch: Partial<RiceItem>) => void;
  onMarkDone: () => void;
  onDelete: () => void;
}) {
  const left = hoursLeft(item);
  const scoreBarPct = Math.max(6, (item.score / topScore) * 100);

  return (
    <article
      className={`rounded-xl border bg-[var(--surface)] transition-all cursor-pointer ${
        expanded
          ? "border-[var(--gold)] shadow-[0_0_24px_rgba(212,175,55,0.15)]"
          : "border-[var(--hairline)] hover:border-[var(--hairline-strong)]"
      }`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-stop]")) return;
        onToggleExpand();
      }}
    >
      <div className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-[60px_1fr_auto] gap-4 items-start">
          <div className="flex flex-col items-center">
            <div
              style={{
                borderColor: rank === 1 ? "var(--gold)" : "var(--gold-dim)",
                color:
                  rank === 1 ? "var(--gold-bright)" : "var(--gold-dim)",
              }}
              className="h-10 w-10 rounded-full border-2 flex items-center justify-center font-bold text-sm"
            >
              {rank}
            </div>
            <div className="mt-2 text-[10px] uppercase tracking-wider opacity-50">
              rank
            </div>
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="font-medium text-base leading-snug">
                {item.title}
              </h3>
              {item.category && (
                <span
                  style={{
                    color: "var(--gold-dim)",
                    borderColor: "var(--gold-dim)",
                  }}
                  className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border"
                >
                  {item.category}
                </span>
              )}
            </div>
            {item.note && !expanded && (
              <p className="text-sm opacity-60 mt-1 leading-snug line-clamp-1">
                {item.note}
              </p>
            )}

            <div className="flex gap-2 mt-3 flex-wrap">
              <RicePill label="R" value={item.reach} />
              <RicePill label="I" value={item.impact} />
              <RicePill label="C" value={item.confidence} />
              <RicePill label="E" value={item.effort} dim />
            </div>

            <div
              data-stop
              className="mt-4 grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-center"
            >
              <div>
                <div className="flex justify-between text-[11px] mb-1">
                  <span className="opacity-60">
                    Progress · {item.progress}%
                  </span>
                  <span
                    style={{ color: "var(--gold)" }}
                    className="tabular-nums"
                  >
                    {fmtHours(left)} left of {fmtHours(item.estHours)}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={item.progress}
                  onChange={(e) =>
                    onUpdateItem(item.id, {
                      progress: parseInt(e.target.value, 10),
                    })
                  }
                  className="spiros-range w-full"
                />
              </div>
            </div>
          </div>

          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider opacity-50">
              Score
            </div>
            <div
              style={{ color: "var(--gold-bright)" }}
              className="text-3xl font-semibold tabular-nums leading-none mt-1"
            >
              {item.score}
            </div>
            <div className="h-1 mt-2 w-24 rounded bg-black/60 overflow-hidden ml-auto">
              <div
                className="h-full"
                style={{
                  width: `${scoreBarPct}%`,
                  backgroundColor: "var(--gold)",
                }}
              />
            </div>
            <div
              data-stop
              className="mt-3 flex justify-end gap-2 items-center"
            >
              <button
                type="button"
                onClick={onMarkDone}
                style={{ borderColor: "var(--gold)", color: "var(--gold)" }}
                className="text-[10px] uppercase tracking-wider px-2 py-1 rounded border hover:brightness-110 transition"
              >
                ✓ done
              </button>
              <button
                type="button"
                onClick={onToggleExpand}
                className="text-[10px] uppercase tracking-wider opacity-50 hover:opacity-100"
              >
                {expanded ? "collapse" : "expand"}
              </button>
            </div>
          </div>
        </div>

        {expanded && (
          <PriorityDetail
            item={item}
            onUpdateItem={onUpdateItem}
            onDelete={onDelete}
          />
        )}
      </div>

      <style jsx>{`
        .spiros-range {
          -webkit-appearance: none;
          appearance: none;
          height: 6px;
          border-radius: 999px;
          background: linear-gradient(
            to right,
            var(--gold) 0%,
            var(--gold) ${item.progress}%,
            rgba(255, 255, 255, 0.08) ${item.progress}%,
            rgba(255, 255, 255, 0.08) 100%
          );
          outline: none;
        }
        .spiros-range::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          height: 16px;
          width: 16px;
          border-radius: 50%;
          background: var(--gold-bright);
          border: 2px solid #000;
          cursor: pointer;
          box-shadow: 0 0 8px rgba(212, 175, 55, 0.6);
        }
        .spiros-range::-moz-range-thumb {
          height: 16px;
          width: 16px;
          border-radius: 50%;
          background: var(--gold-bright);
          border: 2px solid #000;
          cursor: pointer;
        }
      `}</style>
    </article>
  );
}

function PriorityDetail({
  item,
  onUpdateItem,
  onDelete,
}: {
  item: RiceItem;
  onUpdateItem: (id: string, patch: Partial<RiceItem>) => void;
  onDelete: () => void;
}) {
  function toggleSub(idx: number) {
    if (!item.subtasks) return;
    const next = item.subtasks.map((s, i) =>
      i === idx ? { ...s, done: !s.done } : s,
    );
    onUpdateItem(item.id, { subtasks: next });
  }

  function addSub() {
    const next = [...(item.subtasks ?? []), { text: "", done: false }];
    onUpdateItem(item.id, { subtasks: next });
  }

  function updateSub(idx: number, text: string) {
    if (!item.subtasks) return;
    const next = item.subtasks.map((s, i) =>
      i === idx ? { ...s, text } : s,
    );
    onUpdateItem(item.id, { subtasks: next });
  }

  function removeSub(idx: number) {
    if (!item.subtasks) return;
    onUpdateItem(item.id, {
      subtasks: item.subtasks.filter((_, i) => i !== idx),
    });
  }

  return (
    <div
      data-stop
      className="mt-5 pt-5 border-t border-[var(--hairline)] grid grid-cols-1 md:grid-cols-[1fr_280px] gap-6"
    >
      <div className="space-y-5">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] opacity-60 mb-1">
            Title
          </div>
          <input
            type="text"
            value={item.title}
            onChange={(e) => onUpdateItem(item.id, { title: e.target.value })}
            placeholder="Priority title"
            className="w-full rounded-md border border-[var(--hairline)] bg-black/40 px-3 py-2 text-sm font-medium focus:outline-none focus:border-[var(--gold)]"
          />
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] opacity-60 mb-1">
            Notes
          </div>
          <textarea
            value={item.note ?? ""}
            onChange={(e) => onUpdateItem(item.id, { note: e.target.value })}
            placeholder="Why this matters, what's the context"
            className="w-full h-24 resize-none rounded-md border border-[var(--hairline)] bg-black/40 px-3 py-2 text-sm focus:outline-none focus:border-[var(--gold)]"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] uppercase tracking-[0.18em] opacity-60">
              Sub-tasks
            </div>
            <button
              type="button"
              onClick={addSub}
              className="text-[10px] uppercase tracking-wider opacity-50 hover:opacity-100"
            >
              ＋ add
            </button>
          </div>
          {item.subtasks && item.subtasks.length > 0 ? (
            <ul className="space-y-1.5">
              {item.subtasks.map((s, i) => (
                <li key={i} className="flex items-center gap-2 group">
                  <button
                    type="button"
                    onClick={() => toggleSub(i)}
                    style={{
                      borderColor: s.done
                        ? "var(--gold)"
                        : "var(--gold-dim)",
                      backgroundColor: s.done ? "var(--gold)" : "transparent",
                    }}
                    className="h-4 w-4 rounded border flex items-center justify-center text-[10px] text-black font-bold shrink-0"
                  >
                    {s.done ? "✓" : ""}
                  </button>
                  <input
                    type="text"
                    value={s.text}
                    onChange={(e) => updateSub(i, e.target.value)}
                    placeholder="next sub-task"
                    className={`flex-1 bg-transparent border-none px-1 py-0.5 text-sm focus:outline-none focus:bg-black/40 rounded ${
                      s.done ? "opacity-50 line-through" : "opacity-90"
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => removeSub(i)}
                    className="opacity-0 group-hover:opacity-50 hover:!opacity-100 text-xs transition-opacity"
                    aria-label="Remove sub-task"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs opacity-40">No sub-tasks. Click ＋ add.</p>
          )}
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] opacity-60 mb-2">
            Next action
          </div>
          <input
            type="text"
            value={item.nextAction ?? ""}
            onChange={(e) =>
              onUpdateItem(item.id, { nextAction: e.target.value })
            }
            placeholder="What's the single next physical action?"
            className="w-full rounded-md border border-[var(--hairline)] bg-black/40 px-3 py-2 text-sm focus:outline-none focus:border-[var(--gold)]"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider opacity-60 mb-1">
              Category
            </label>
            <select
              value={item.category ?? ""}
              onChange={(e) =>
                onUpdateItem(item.id, { category: e.target.value || undefined })
              }
              className="w-full rounded-md border border-[var(--hairline)] bg-black/40 px-3 py-2 text-sm focus:outline-none focus:border-[var(--gold)]"
            >
              <option value="">—</option>
              {DEFAULT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider opacity-60 mb-1">
              Est. hours
            </label>
            <input
              type="number"
              min={0.25}
              step={0.25}
              value={item.estHours}
              onChange={(e) =>
                onUpdateItem(item.id, {
                  estHours: parseFloat(e.target.value) || 0,
                })
              }
              className="w-full rounded-md border border-[var(--hairline)] bg-black/40 px-3 py-2 text-sm focus:outline-none focus:border-[var(--gold)] tabular-nums"
            />
          </div>
        </div>
      </div>

      <aside className="space-y-4">
        <div className="rounded-lg border border-[var(--hairline)] bg-black/30 p-4">
          <div className="text-[10px] uppercase tracking-[0.18em] opacity-60 mb-2">
            RICE math
          </div>
          <div className="text-xs space-y-1 font-mono opacity-80">
            <div>R × I × C ÷ E</div>
            <div className="opacity-70">
              {item.reach} × {item.impact} × {item.confidence} ÷ {item.effort}
            </div>
            <div
              style={{ color: "var(--gold-bright)" }}
              className="text-lg font-semibold pt-1"
            >
              = {riceScore(item)}
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-[var(--hairline)] bg-black/30 p-4">
          <div className="text-[10px] uppercase tracking-[0.18em] opacity-60 mb-2">
            Edit RICE values
          </div>
          <div className="space-y-2">
            <RiceSlider
              label="Reach"
              value={item.reach}
              onChange={(v) => onUpdateItem(item.id, { reach: v })}
            />
            <RiceSlider
              label="Impact"
              value={item.impact}
              onChange={(v) => onUpdateItem(item.id, { impact: v })}
            />
            <RiceSlider
              label="Confidence"
              value={item.confidence}
              onChange={(v) => onUpdateItem(item.id, { confidence: v })}
            />
            <RiceSlider
              label="Effort"
              value={item.effort}
              onChange={(v) => onUpdateItem(item.id, { effort: v })}
            />
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            if (confirm(`Delete "${item.title}"? This can't be undone.`)) {
              onDelete();
            }
          }}
          className="w-full text-[10px] uppercase tracking-wider opacity-40 hover:opacity-100 hover:text-rose-400 py-2 transition-colors"
        >
          Delete priority
        </button>
      </aside>
    </div>
  );
}

function RiceSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex justify-between text-[10px] mb-1">
        <span className="opacity-60 uppercase tracking-wider">{label}</span>
        <span
          style={{ color: "var(--gold)" }}
          className="tabular-nums font-semibold"
        >
          {value}
        </span>
      </div>
      <input
        type="range"
        min={1}
        max={10}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="w-full accent-[color:var(--gold)]"
      />
    </div>
  );
}

function RicePill({
  label,
  value,
  dim = false,
}: {
  label: string;
  value: number;
  dim?: boolean;
}) {
  return (
    <span
      style={{
        borderColor: dim ? "var(--gold-dim)" : "var(--gold)",
        color: dim ? "var(--gold-dim)" : "var(--gold)",
      }}
      className="text-xs px-2 py-0.5 rounded border tabular-nums"
    >
      <span className="opacity-70 mr-1">{label}</span>
      <span className="font-semibold">{value}</span>
    </span>
  );
}

/* ─── Done ───────────────────────────────────────────────────── */

function DoneSection({
  items,
  onReopen,
  onDelete,
  rangeLabel,
}: {
  items: RiceItem[];
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
  rangeLabel: string;
}) {
  return (
    <section className="mt-10">
      <SectionLabel
        label="Knocked off"
        sub={rangeLabel}
        right={`${items.length} done`}
      />
      <ul className="mt-4 space-y-2">
        {items.map((i) => (
          <li
            key={i.id}
            className="rounded-lg border border-[var(--hairline)] bg-black/20 px-4 py-3 flex items-center justify-between gap-4"
          >
            <div className="flex items-center gap-3 min-w-0">
              <span
                style={{ backgroundColor: "var(--gold-dim)" }}
                className="h-5 w-5 rounded-full flex items-center justify-center text-black font-bold text-xs shrink-0"
              >
                ✓
              </span>
              <span className="text-sm opacity-70 line-through truncate">
                {i.title}
              </span>
              {i.category && (
                <span
                  style={{ color: "var(--gold-dim)" }}
                  className="text-[10px] uppercase tracking-wider opacity-70 shrink-0"
                >
                  {i.category}
                </span>
              )}
            </div>
            <div className="flex gap-3 shrink-0">
              <button
                type="button"
                onClick={() => onReopen(i.id)}
                className="text-[10px] uppercase tracking-wider opacity-50 hover:opacity-100"
              >
                reopen
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Delete "${i.title}"?`)) onDelete(i.id);
                }}
                className="text-[10px] uppercase tracking-wider opacity-30 hover:opacity-100 hover:text-rose-400"
              >
                delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ─── Shared ─────────────────────────────────────────────────── */

function SectionLabel({
  label,
  sub,
  right,
}: {
  label: string;
  sub?: string;
  right?: string;
}) {
  return (
    <div className="flex items-end justify-between gap-4 border-b border-[var(--hairline)] pb-3">
      <div className="flex items-baseline gap-3">
        <h2
          style={{ color: "var(--gold-bright)" }}
          className="text-xl font-semibold tracking-tight"
        >
          {label}
        </h2>
        {sub && (
          <span className="text-xs opacity-50 uppercase tracking-wider">
            {sub}
          </span>
        )}
      </div>
      {right && (
        <span
          style={{ color: "var(--gold-dim)" }}
          className="text-xs tabular-nums"
        >
          {right}
        </span>
      )}
    </div>
  );
}
