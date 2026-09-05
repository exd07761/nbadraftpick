/**
 * supabase-reads-roster.js
 *
 * Phase 6.5: dormant read functions for current rosters, roster
 * summaries, transaction-picker rosters, swap-eligible free agents, and
 * Joker lookups. Built on SupabaseQuery/SupabaseReadsCore/
 * SupabaseReadsDraft (Phases 6.2-6.4).
 *
 * PHASE 6.5 STATUS: dormant. Nothing calls SupabaseReadsRoster yet.
 * LeagueData/AdminActions are untouched. Every function here is a pure
 * read — no write path exists in this file at all.
 *
 * BUSINESS-RULE OWNERSHIP — two different things are easy to conflate,
 * kept deliberately distinct here exactly as the current app does:
 *
 * 1. effectivePosition (Joker overlay on POSITION) — a two-line ternary
 *    (isJoker && jokerPosition ? jokerPosition : player.position). In
 *    the CURRENT FIREBASE APP ITSELF this is a plain client-side helper
 *    (getEffectivePosition in data.js), not a server call — there is no
 *    existing RPC being bypassed by mirroring it here, because the
 *    source of truth for this exact computation already lives in
 *    client-side JS today. It is display-only here (nothing in this
 *    file uses it to validate or gate anything) — the RPCs that
 *    actually enforce position rules (compute_position_state,
 *    check_resulting_positions) were already built Joker-aware in
 *    Phase 5.5 and are used for validation elsewhere, untouched.
 *
 * 2. classification (RED/YELLOW/PINK overlay) — a real algorithm
 *    (own-pick-number derivation, chained through
 *    classification_source_player_id for manual-replace bookkeeping)
 *    with a dedicated RPC, get_player_classification. Every function
 *    below that needs a classification value calls that RPC — none of
 *    them reimplement the pick-number/chaining logic in JavaScript.
 *    (Known, currently-ungranted — see Phase 6.4's note; unchanged
 *    here, not fixed in this step.)
 *
 * PERFORMANCE NOTE (not a fix, just documented): classification is
 * fetched per-player via get_player_classification, exactly mirroring
 * how the current Firebase code also computes it per-entry inside a
 * .map() — but each call here is a real network round trip, not a free
 * in-memory function call. For a roster of 10 this is 10 RPC calls.
 * Worth optimizing later (e.g. a batch RPC) but out of scope for this
 * dormant checkpoint — flagging, not solving.
 *
 * 2K26/2K27 HISTORICAL DATA SAFETY: everything in this file reads
 * roster_entries/draft_picks/players — never writes. Reading a 2K26
 * season's roster does not touch the global `players` table's mutable
 * fields in any way, so nothing here can affect 2K27 pool curation or
 * vice versa.
 */

const SupabaseReadsRoster = (() => {
  function getEffectivePosition(entry, player) {
    if (entry.isJoker && entry.jokerPosition) return entry.jokerPosition;
    return player ? player.position : undefined;
  }

  async function getClassification(seasonId, playerId) {
    if (!playerId) return null;
    const result = await SupabaseQuery.callReadRpc("get_player_classification", {
      p_season_id: seasonId,
      p_player_id: playerId,
    });
    const row = Array.isArray(result) ? result[0] : result;
    return row ? row.classification : null;
  }

  function mapRosterEntryRow(row) {
    return {
      playerId: row.player_id || undefined,
      source: row.source,
      isJoker: row.is_joker,
      jokerPosition: row.joker_position || undefined,
      draftSlot: row.draft_slot,
      classificationSourcePlayerId: row.classification_source_player_id || undefined,
    };
  }

  // ── Current roster (post-init: roster_entries; pre-init: draft_picks
  // fallback, matching current Firebase behavior exactly) ────────────────
  async function getCurrentRoster(seasonId, participantId) {
    const season = await SupabaseReadsCore.getSeason(seasonId);
    if (!season) return [];

    if (season.rostersInitialized) {
      const rows = await SupabaseQuery.select("roster_entries", (qb) =>
        qb
          .eq("season_id", seasonId)
          .eq("participant_id", participantId)
          .order("draft_slot", { ascending: true, nullsFirst: false })
      );
      const entries = rows.map(mapRosterEntryRow);
      return Promise.all(
        entries.map(async (entry) => {
          const player = entry.playerId ? await SupabaseReadsCore.getPlayer(entry.playerId) : null;
          return {
            ...entry,
            player,
            effectivePosition: player ? getEffectivePosition(entry, player) : null,
            classification: player ? await getClassification(seasonId, entry.playerId) : null,
          };
        })
      );
    }

    // Pre-initialization fallback — derive from draft_picks, exactly
    // matching the current Firebase code's fallback branch (including a
    // Draft Joker Pick's isJoker/jokerPosition, which lives directly on
    // the draft_picks row already at this stage — see Phase 6.4).
    const picks = await SupabaseReadsDraft.getDraftPicks(seasonId);
    const ownPicks = picks.filter((p) => p.participantId === participantId);
    return Promise.all(
      ownPicks.map(async (p, i) => {
        const player = await SupabaseReadsCore.getPlayer(p.playerId);
        return {
          playerId: p.playerId,
          source: "draft",
          player,
          effectivePosition: player ? getEffectivePosition(p, player) : null,
          draftSlot: i + 1,
          isJoker: !!p.isJoker,
          jokerPosition: p.jokerPosition,
          classification: player ? await getClassification(seasonId, p.playerId) : null,
        };
      })
    );
  }

  // ── Roster summary across every participant, ordered like the current
  // Firebase code: playerDraftOrder first, then any participant missing
  // from it (e.g. added before an order existed) appended sorted by id.
  async function getRosterSummary(seasonId) {
    const season = await SupabaseReadsCore.getSeason(seasonId);
    if (!season) return [];
    const cap = season.ratingCap ?? 875;

    const participants = await SupabaseReadsCore.getParticipants(seasonId);
    const byId = Object.fromEntries(participants.map((p) => [p.id, p]));
    const orderedIds = [...(season.playerDraftOrder || [])];
    const orderedSet = new Set(orderedIds);
    const fallbackIds = participants
      .map((p) => p.id)
      .filter((id) => !orderedSet.has(id))
      .sort();
    const orderedParticipants = [...orderedIds, ...fallbackIds].map((id) => byId[id]).filter(Boolean);

    return Promise.all(
      orderedParticipants.map(async (participant) => {
        const entries = await getCurrentRoster(seasonId, participant.id);
        const totalRating = entries.reduce((sum, e) => sum + (e.player ? e.player.overall : 0), 0);
        return {
          participant,
          rosterEntries: entries,
          totalRating,
          ratingCap: cap,
          remaining: cap - totalRating,
          isOverCap: totalRating > cap,
        };
      })
    );
  }

  // ── Roster for the Trade/Swap builder UI (no pre-init fallback — same
  // as current Firebase behavior: reads only the initialized roster) ────
  async function getRosterForTransactions(seasonId, participantId) {
    const rows = await SupabaseQuery.select("roster_entries", (qb) =>
      qb.eq("season_id", seasonId).eq("participant_id", participantId)
    );
    const entries = rows.map(mapRosterEntryRow).filter((e) => e.playerId);
    return Promise.all(
      entries.map(async (entry) => {
        const player = await SupabaseReadsCore.getPlayer(entry.playerId);
        return {
          ...entry,
          player,
          effectivePosition: player ? getEffectivePosition(entry, player) : null,
          classification: await getClassification(seasonId, entry.playerId),
        };
      })
    );
  }

  // ── Free agents eligible as a swap replacement (unowned by any
  // participant's roster_entries in this season, optionally pool-filtered) ─
  async function getSwapEligibleReplacements(seasonId, pool) {
    const [allPlayers, ownedRows] = await Promise.all([
      SupabaseReadsCore.getAllPlayers(),
      SupabaseQuery.select("roster_entries", (qb) =>
        qb.eq("season_id", seasonId).not("player_id", "is", null)
      ),
    ]);
    const ownedIds = new Set(ownedRows.map((r) => r.player_id));
    const eligible = allPlayers.filter((p) => !ownedIds.has(p.id) && (!pool || p.pool === pool));
    return Promise.all(
      eligible.map(async (p) => ({ ...p, classification: await getClassification(seasonId, p.id) }))
    );
  }

  // ── A participant's current Joker entry, if any ─────────────────────────
  async function getJoker(seasonId, participantId) {
    const rows = await SupabaseQuery.select("roster_entries", (qb) =>
      qb.eq("season_id", seasonId).eq("participant_id", participantId).eq("is_joker", true).limit(1)
    );
    if (!rows.length) return null;
    const entry = mapRosterEntryRow(rows[0]);
    const player = entry.playerId ? await SupabaseReadsCore.getPlayer(entry.playerId) : null;
    return { ...entry, player };
  }

  // ── Players eligible to become a participant's Joker: currently on
  // their roster, occupying one of their own draft picks #1-10 ──────────
  async function getJokerEligiblePlayers(seasonId, participantId) {
    const rows = await SupabaseQuery.select("roster_entries", (qb) =>
      qb
        .eq("season_id", seasonId)
        .eq("participant_id", participantId)
        .not("player_id", "is", null)
        .gte("draft_slot", 1)
        .lte("draft_slot", 10)
    );
    return Promise.all(
      rows.map(async (row) => ({
        playerId: row.player_id,
        player: await SupabaseReadsCore.getPlayer(row.player_id),
        ownPickNumber: row.draft_slot,
      }))
    );
  }

  return {
    getCurrentRoster,
    getRosterSummary,
    getRosterForTransactions,
    getSwapEligibleReplacements,
    getJoker,
    getJokerEligiblePlayers,
  };
})();
