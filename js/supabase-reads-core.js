/**
 * supabase-reads-core.js
 *
 * Phase 6.3: dormant read functions for seasons, participants, and
 * players — the first entity group in the incremental LeagueData
 * migration. Built on top of the generic SupabaseQuery scaffold
 * (supabase-query.js).
 *
 * PHASE 6.3 STATUS: dormant. Nothing calls SupabaseReadsCore yet.
 * LeagueData/AdminActions are untouched — this file exists so each
 * function can be tested and compared against current Firebase output
 * in isolation before any UI code depends on it.
 *
 * IMPORTANT SCOPE NOTE — read this before assuming feature parity:
 * The current Firebase LeagueData.getSeason()/getCurrentSeason() return
 * the ENTIRE nested season object — participants, playerDraftPicks,
 * draftSkips, bonusPicks, nbaTeamAssignments, currentRosters, schedule,
 * transactions, all of it — because Firestore stores the whole season
 * as one document subtree. The functions below intentionally return
 * ONLY the season's own row-level fields (status, dates, settings,
 * flags) for now. The nested collections are separate entity groups
 * with their own checkpoints per the approved Phase 6 plan:
 *   - participants: THIS file (getParticipants/getParticipant)
 *   - draft (playerDraftPicks/draftSkips/bonusPicks): Phase 6.4
 *   - rosters (currentRosters): Phase 6.5
 *   - schedule/Group Stage/playoffs: Phase 6.6
 *   - financial (transactions): Phase 6.7
 * A getSeason() that matches the current full nested shape will be
 * assembled later (Phase 6.9, the actual LeagueData rewrite) by calling
 * every entity group's read functions and merging them — not by this
 * file alone. Do not wire this into LeagueData expecting full parity
 * yet; it isn't there yet, by design.
 *
 * 2K26/2K27 HISTORICAL DATA SAFETY (per your requirement):
 * getAllPlayers()/getPlayer() below are pure reads — they never write,
 * and reading a player's current row is exactly what the current
 * Firebase getPlayer() already does (live-referenced, not snapshotted —
 * see the Phase 6.2 architectural inspection). Nothing here changes
 * that characteristic in either direction. No 2K27 curation logic is
 * implemented in this file — this is unrelated groundwork.
 */

const SupabaseReadsCore = (() => {
  /**
   * Maps a `seasons` row to the field names/shape the current
   * Firebase-backed season object uses at the row level (see
   * createSeason() in data.js). financialSettings is reassembled as a
   * nested object to match, even though the columns are flat in
   * Supabase — so a later caller can destructure `season.financialSettings.entryFee`
   * exactly like it does today.
   */
  function mapSeasonRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      createdAt: row.created_at,
      isCurrent: row.is_current, // new field, not in the Firebase shape — additive, nothing currently reads it via LeagueData so nothing breaks
      playerDraftOrder: row.player_draft_order || [],
      draftComplete: row.draft_complete,
      teamAssignmentOrder: row.team_assignment_order || [],
      teamAssignmentComplete: row.team_assignment_complete,
      ratingCap: row.rating_cap,
      rostersInitialized: row.rosters_initialized,
      pot: Number(row.pot),
      currentSeasonDay: row.current_season_day,
      financialSettings: {
        entryFee: Number(row.entry_fee),
        freeTrades: row.free_trades,
        freeSwaps: row.free_swaps,
      },
      scheduleGeneratedAt: row.schedule_generated_at,
      scheduleFormat: row.schedule_format,
    };
  }

  function mapParticipantRow(row) {
    if (!row) return null;
    return { id: row.id, name: row.name };
  }

  function mapPlayerRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      position: row.position,
      overall: row.overall,
      pool: row.pool || undefined,
      variantGroup: row.variant_group || undefined,
      createdAt: row.created_at,
      nba2kRef: row.nba2k_ref || undefined,
    };
  }

  // ── Settings / current season ─────────────────────────────────────────
  // getSettings() in Firebase is just { currentSeasonId }. There is no
  // settings table in Supabase (per your Decision 2 — is_current lives
  // directly on seasons) — this reconstructs the same shape from that.
  async function getSettings() {
    const id = await getCurrentSeasonId();
    return { currentSeasonId: id };
  }

  async function getCurrentSeasonId() {
    const rows = await SupabaseQuery.select("seasons", (qb) =>
      qb.eq("is_current", true).limit(1)
    );
    return rows.length ? rows[0].id : null;
  }

  // ── Seasons ──────────────────────────────────────────────────────────
  async function getAllSeasons() {
    const rows = await SupabaseQuery.select("seasons", (qb) =>
      qb.order("created_at", { ascending: false })
    );
    return rows.map(mapSeasonRow);
  }

  async function getSeason(seasonId) {
    const rows = await SupabaseQuery.select("seasons", (qb) =>
      qb.eq("id", seasonId).limit(1)
    );
    return rows.length ? mapSeasonRow(rows[0]) : null;
  }

  async function getCurrentSeason() {
    const rows = await SupabaseQuery.select("seasons", (qb) =>
      qb.eq("is_current", true).limit(1)
    );
    return rows.length ? mapSeasonRow(rows[0]) : null;
  }

  // ── Participants ─────────────────────────────────────────────────────
  async function getParticipants(seasonId) {
    const rows = await SupabaseQuery.select("participants", (qb) =>
      qb.eq("season_id", seasonId)
    );
    return rows.map(mapParticipantRow);
  }

  async function getParticipant(seasonId, participantId) {
    const rows = await SupabaseQuery.select("participants", (qb) =>
      qb.eq("season_id", seasonId).eq("id", participantId).limit(1)
    );
    return rows.length ? mapParticipantRow(rows[0]) : null;
  }

  // ── Players (global pool — see 2K26/2K27 note above) ────────────────
  async function getAllPlayers() {
    const rows = await SupabaseQuery.select("players", (qb) => qb);
    return rows.map(mapPlayerRow);
  }

  async function getPlayer(playerId) {
    const rows = await SupabaseQuery.select("players", (qb) =>
      qb.eq("id", playerId).limit(1)
    );
    return rows.length ? mapPlayerRow(rows[0]) : null;
  }

  return {
    getSettings,
    getCurrentSeasonId,
    getAllSeasons,
    getSeason,
    getCurrentSeason,
    getParticipants,
    getParticipant,
    getAllPlayers,
    getPlayer,
  };
})();
