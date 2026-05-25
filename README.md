# Spiros — Prioritization OS

A personal weekly review app: **brain dump in, RICE-scored priorities out**, plus a time tracker grounded in your real Rize CSV exports + Google Calendar events.

The ritual: every Sunday you run **The Oracle** — Spiros (Claude) walks you through your past week conversationally, asks specific questions about the meetings and time blocks it sees, then writes you a structured debrief (and reads it aloud if you want).

## What you get

- **Weekly Debrief** — Jarvis-style chat. Spiros sees your Rize entries + calendar events + brain dump and runs a guided conversation. You answer in plain text; it captures personal time you mention, recategorizes Rize blocks you clarify, and finalizes a 5-section recap. Web Speech API TTS plays the debrief back at 1×, 1.5×, or 2×.
- **Time Tracker** — Upload your weekly Rize CSV export. Entries get keyword-categorized into Work / Personal sub-buckets. Donut chart, day-by-day breakdown, color-coded sub-categories. Click any sub to drill into its entries; clear or recategorize sub-categories from the UI.
- **Google Calendar (read-only)** — Paste your iCal subscription URL once. Events for the current Oracle week pull automatically every Sunday.
- **RICE Priorities** — Reach × Impact × Confidence ÷ Effort. Create them via "+ New priority", or by chatting with Spiros (`"Add a priority: ship the new landing page, RICE around 7/8/8/3, ~4 hours"`). Click any priority to expand: notes, sub-tasks, Next Action, editable RICE sliders, manual progress slider with auto-burndown of estimated hours.
- **Talk to Spiros** — A persistent chat panel with full Oracle context (priorities + time data + calendar). Use it to ask analytical questions ("how much time did I spend in meetings vs deep work?") or to edit/add/done priorities by voice.

All data lives in your browser's `localStorage` — single-device. No accounts, no shared backend. Your own Anthropic API key talks to Claude directly through your Vercel deployment.

## Deploy your own

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/nickvarapkiles-netizen/spiros&env=ANTHROPIC_API_KEY&envDescription=Anthropic+API+key+for+Claude+chat+%2B+debrief+%2B+brain+dump+features&envLink=https://console.anthropic.com/settings/keys&project-name=spiros&repository-name=spiros)

Click that, sign into Vercel, paste your Anthropic API key, hit Deploy. ~2 minutes to a live URL.

### Manual setup (if you'd rather not use the button)

```bash
git clone https://github.com/nickvarapkiles-netizen/spiros.git
cd spiros
npm install
npm run dev   # http://localhost:3000
```

For the brain dump + Oracle + chat features to work locally, you need an Anthropic API key in `.env.local`:

```
ANTHROPIC_API_KEY=sk-ant-api03-...
```

Get one at https://console.anthropic.com/settings/keys (~$5 minimum to start; a full Oracle session costs roughly $0.05–0.20).

To deploy to Vercel from the CLI:

```bash
npm install -g vercel
vercel link
vercel env add ANTHROPIC_API_KEY production   # paste your key when prompted
vercel deploy --prod
```

## Connecting your data

### Rize (time tracking) — manual weekly CSV upload

Spiros doesn't have a Rize API integration (Rize doesn't expose one as of writing), so each week you'll export your CSV and upload it.

1. In Rize, generate your weekly report → export as CSV
2. In Spiros, scroll to the **Time Tracker** section → click **Upload CSV**
3. Entries get auto-categorized via keyword rules into Work (Projects, Strategy, Social media content, Meetings, Connections) and Personal (Meditation, Workouts, Sauna, Cold plunge, Dates). Anything unmatched lands in an "Uncategorized" drawer you can review.

The keyword rules live in [`lib/spiros.ts`](lib/spiros.ts) under `CATEGORY_RULES`. **Edit these for your work** — the defaults are generic (e.g. "deploy" → Projects). Add your project names, tools, recurring meeting types, etc.

### Google Calendar — one-time iCal URL paste

1. Open Google Calendar → ⚙ **Settings** → click the calendar you want under **Settings for my calendars**
2. Scroll to **Integrate calendar** → copy **"Secret address in iCal format"**
3. In Spiros, scroll to the **Calendar** section → paste the URL → **Connect**
4. Events for the current Oracle week pull automatically. When a new Sunday rolls in, Spiros refetches automatically.

**Caveat**: the secret URL is sensitive (anyone with it can read that calendar). It's stored only in your browser's localStorage and sent to your Vercel deployment's server route per fetch — not logged, not persisted server-side. If it ever leaks, reset it from the same Google Calendar settings page.

## Customizing for yourself

A few hardcoded things you'll probably want to edit:

- **Project categories** — [`lib/spiros.ts`](lib/spiros.ts) → `DEFAULT_CATEGORIES`. These show up in dropdowns when creating priorities.
- **Rize keyword categorizer** — [`lib/spiros.ts`](lib/spiros.ts) → `CATEGORY_RULES`. Order-matters list of (regex, group, sub-category). First match wins. The defaults catch generic build/meeting/workout terms; add your specific project names, tools, and recurring meeting types here.
- **Sub-category colors** — [`lib/spiros.ts`](lib/spiros.ts) → `SUB_COLORS`. Hardcoded hue per sub-category for the time tracker bars/badges. New sub-categories created at runtime get a color from `EXTENDED_PALETTE` (deterministic by name hash).
- **Default sub-categories shown in the manual entry form** — [`app/page.tsx`](app/page.tsx) → search for `subOptions` inside `ManualEntryAdder`.

## Architecture (one paragraph)

Next.js 16 App Router on Vercel (Node.js runtime). State lives in `localStorage` (no DB) — one `SpirosState` blob keyed under `spiros.state.v1` with `sessions` map keyed by week-start Sunday ISO. Three API routes (`/api/process-dump`, `/api/chat`, `/api/debrief/*`) call Anthropic's Messages API directly via `@anthropic-ai/sdk` using tool use for state mutations. iCal calendar parsing is hand-rolled in [`app/api/calendar/route.ts`](app/api/calendar/route.ts) — handles simple events + DAILY/WEEKLY/MONTHLY/YEARLY recurrence with BYDAY/UNTIL/COUNT (the common Google export cases). TTS is the browser's built-in `window.speechSynthesis`. No auth, no DB, no backend state — bring your own API key and your data stays with you.

## License

MIT — do whatever, no warranty.
