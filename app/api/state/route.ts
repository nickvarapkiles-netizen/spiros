import { NextRequest } from "next/server";
import { ensureSchema, getSql, SPIROS_USER_ID } from "@/lib/db";
import type { SpirosState } from "@/lib/spiros";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/state
 * Returns the current persisted SpirosState, or null if the user
 * has no row yet (fresh install — client should seed locally).
 */
export async function GET() {
  try {
    await ensureSchema();
    const sql = getSql();
    const rows = (await sql`
      SELECT state, updated_at
      FROM spiros_state
      WHERE user_id = ${SPIROS_USER_ID}
      LIMIT 1
    `) as Array<{ state: SpirosState; updated_at: string }>;

    if (rows.length === 0) {
      return Response.json({ state: null, updatedAt: null });
    }
    return Response.json({
      state: rows[0].state,
      updatedAt: rows[0].updated_at,
    });
  } catch (err) {
    console.error("[/api/state GET] failed", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/state
 * Body: { state: SpirosState }
 * Upserts the full state blob. Whole-document replacement is
 * intentional — Spiros state is small and atomic.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { state?: SpirosState };
    if (!body?.state || typeof body.state !== "object") {
      return Response.json(
        { error: "Missing or invalid `state` in body" },
        { status: 400 },
      );
    }
    await ensureSchema();
    const sql = getSql();
    const rows = (await sql`
      INSERT INTO spiros_state (user_id, state, updated_at)
      VALUES (${SPIROS_USER_ID}, ${JSON.stringify(body.state)}::jsonb, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()
      RETURNING updated_at
    `) as Array<{ updated_at: string }>;

    return Response.json({ ok: true, updatedAt: rows[0]?.updated_at });
  } catch (err) {
    console.error("[/api/state POST] failed", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "unknown error" },
      { status: 500 },
    );
  }
}
