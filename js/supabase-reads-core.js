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

  /**
   * Phase 6.7c: maps an `nba2k27_effective_players` row (the Phase 6.7a
   * view — nba2k27_pool joined to nba2k_players, with overrides already
   * resolved and invalid/UNASSIGNED rows already filtered out server-side)
   * to the same effective-player shape LiveNba2k27PoolCache.getEntries()
   * already returns in js/data.js, so a later caller can treat a
   * Supabase-sourced live player identically to an in-memory one.
   *
   * Deliberately separate from mapPlayerRow() above and never reused by
   * getAllPlayers()/getPlayer(): this is the LIVE NBA2K27 pool
   * (nba2k27_pool + nba2k_players, computed), not the old/promoted
   * `players` table those two functions read — see this file's 2K26/2K27
   * HISTORICAL DATA SAFETY note. The two mappers, and the two read paths
   * they back, stay independent.
   *
   * seasonId is always the LIVE_NBA2K27_POOL_SCOPE sentinel, exactly as
   * LiveNba2k27PoolCache.buildEntries() sets it in js/data.js — never a
   * per-call argument, since the live pool itself is global, not season-
   * specific (see the Phase 6.7b design note on where the season-scoping
   * decision actually belongs — NOT in this file). LIVE_NBA2K27_POOL_SCOPE
   * is defined in js/data.js, which loads AFTER this file in both
   * index.html and admin.html — safe here because this identifier is
   * only resolved at CALL time, when one of the three functions below
   * actually runs, not when this file itself loads; nothing calls them
   * yet (this whole file remains dormant), and by the time anything ever
   * does, data.js will already have run.
   */
  function mapEffectiveLivePlayerRow(row) {
    if (!row) return null;
    return {
      id: row.live_id,
      name: row.name,
      position: row.position,
      overall: row.overall,
      pool: row.pool,
      variantGroup: row.variant_group_id,
      nba2kRef: row.nba2k_ref,
      seasonId: LIVE_NBA2K27_POOL_SCOPE,
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

  // ── Live NBA2K27 pool (Phase 6.7c — nba2k27_effective_players view) ───
  // Dormant, exactly like every other function in this file: nothing
  // calls these yet. GLOBAL, not season-scoped — these three functions
  // take no seasonId, matching the live pool's own nature (see
  // mapEffectiveLivePlayerRow's comment above and the Phase 6.7b design).
  // Whether a given season should even ask for this pool
  // (playerPoolScope === LIVE_NBA2K27_POOL_SCOPE) is a decision for the
  // future LeagueData-equivalent data layer to make BEFORE calling
  // getLiveNba2k27Players() — that integration is a later phase and is
  // NOT implemented here.
  async function getLiveNba2k27Players() {
    const rows = await SupabaseQuery.select(
      "nba2k27_effective_players",
      (qb) => qb
    );
    return rows.map(mapEffectiveLivePlayerRow);
  }

  async function getLiveNba2k27Player(liveId) {
    const rows = await SupabaseQuery.select(
      "nba2k27_effective_players",
      (qb) => qb.eq("live_id", liveId).limit(1)
    );
    return rows.length ? mapEffectiveLivePlayerRow(rows[0]) : null;
  }

  async function getLiveNba2k27PlayerBySlug(slug) {
    const rows = await SupabaseQuery.select(
      "nba2k27_effective_players",
      (qb) => qb.eq("nba2k_ref", slug).limit(1)
    );
    return rows.length ? mapEffectiveLivePlayerRow(rows[0]) : null;
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
    getLiveNba2k27Players,
    getLiveNba2k27Player,
    getLiveNba2k27PlayerBySlug,
  };
})();
