/**
 * supabase-reads-draft.js
 *
 * Phase 6.4: dormant read functions for draft order, draft picks, draft
 * skips, computed draft schedule/turn state, and draft-time position
 * status. Built on SupabaseQuery (generic scaffold) and
 * SupabaseReadsCore (season/participant/player, Phase 6.3).
 *
 * PHASE 6.4 STATUS: dormant. Nothing calls SupabaseReadsDraft yet.
 * LeagueData/AdminActions are untouched.
 *
 * CRITICAL DESIGN RULE FOLLOWED HERE — no business-rule duplication:
 * computeDraftSchedule() and computePositionState() in the current
 * Firebase code both already have exact server-side equivalents in the
 * Supabase RPC layer (compute_draft_schedule, compute_position_state),
 * including every Joker-effective-position and phased-Blue-rule detail
 * from the Phase 5.5 corrective work. This file calls those RPCs and
 * reshapes their output to match the current JS function's return
 * shape — it does NOT reimplement the skip/bonus-pick replay logic or
 * the effective-position computation in JavaScript. See getDraftState()
 * and getPositionState() below.
 *
 * KNOWN LIMITATION (expected, not a bug): compute_draft_schedule,
 * compute_position_state, and get_player_classification are still
 * internal-only in Supabase (no EXECUTE grant to authenticated/anon —
 * confirmed by direct catalog query before writing this file). Calling
 * getDraftState()/getPositionState() below will fail with a permission
 * error until those grants are added, which is a separate, explicitly
 * approval-gated step (Phase 6 readiness report §1) — not done here.
 * This file is written correctly against the RPCs as they will work
 * once granted; it is not expected to succeed end-to-end yet.
 *
 * 2K26/2K27 HISTORICAL DATA SAFETY: every function in this file is a
 * pure read (draft_picks/draft_skips/players SELECTs and read-only RPC
 * calls). Nothing here writes, and nothing here touches the `players`
 * table's mutable fields — draft history for any past season, 2K26
 * included, is unaffected by anything in this file.
 */

const SupabaseReadsDraft = (() => {
  const CORE_POSITIONS = ["PG", "SG", "SF", "PF", "C"];

  function mapDraftPickRow(row) {
    return {
      round: row.round,
      pick: row.pick,
      participantId: row.participant_id,
      playerId: row.player_id,
      isJoker: row.is_joker,
      jokerPosition: row.joker_position || undefined,
    };
  }

  function mapDraftSkipRow(row) {
    return {
      participantId: row.participant_id,
      round: row.round,
      afterPickCount: row.after_pick_count,
    };
  }

  // ── Draft order (as participant objects, matching current shape) ───────
  async function getPlayerDraftOrder(seasonId) {
    const season = await SupabaseReadsCore.getSeason(seasonId);
    if (!season) return [];
    const participants = await SupabaseReadsCore.getParticipants(seasonId);
    const byId = Object.fromEntries(participants.map((p) => [p.id, p]));
    return season.playerDraftOrder.map((id) => byId[id]).filter(Boolean);
  }

  // ── Draft picks (raw, in pick order — matches season.playerDraftPicks) ──
  async function getDraftPicks(seasonId) {
    const rows = await SupabaseQuery.select("draft_picks", (qb) =>
      qb.eq("season_id", seasonId).order("pick", { ascending: true })
    );
    return rows.map(mapDraftPickRow);
  }

  // ── Draft skips (matches season.draftSkips) ─────────────────────────────
  async function getDraftSkips(seasonId) {
    const rows = await SupabaseQuery.select("draft_skips", (qb) =>
      qb.eq("season_id", seasonId).order("after_pick_count", { ascending: true })
    );
    return rows.map(mapDraftSkipRow);
  }

  // ── Available players (global pool minus every drafted playerId) ───────
  async function getAvailablePlayers(seasonId) {
    const [allPlayers, picks] = await Promise.all([
      SupabaseReadsCore.getAllPlayers(),
      getDraftPicks(seasonId),
    ]);
    const drafted = new Set(picks.map((p) => p.playerId));
    return allPlayers.filter((p) => !drafted.has(p.id));
  }

  // ── Computed draft schedule/turn state ──────────────────────────────────
  // Calls compute_draft_schedule (RPC) — never reimplements the skip/
  // bonus-pick replay logic client-side. See KNOWN LIMITATION above re:
  // the grant this currently needs.
  async function getDraftState(seasonId) {
    const season = await SupabaseReadsCore.getSeason(seasonId);
    if (!season) return null;

    const n = season.playerDraftOrder.length;
    const [picks, skips, availablePlayers, participants] = await Promise.all([
      getDraftPicks(seasonId),
      getDraftSkips(seasonId),
      getAvailablePlayers(seasonId),
      SupabaseReadsCore.getParticipants(seasonId),
    ]);
    const participantsById = Object.fromEntries(participants.map((p) => [p.id, p]));
    const totalPicksMade = picks.length;

    let schedule = null;
    if (n > 0) {
      const result = await SupabaseQuery.callReadRpc("compute_draft_schedule", {
        p_season_id: seasonId,
      });
      // compute_draft_schedule returns a one-row table (SETOF-style),
      // matching the shape supabase-js gives back for a table-returning
      // RPC: an array with exactly one row.
      const row = Array.isArray(result) ? result[0] : result;
      schedule = row
        ? {
            currentParticipantId: row.current_participant_id,
            currentRound: row.current_round,
            isBonusTurn: row.is_bonus_turn,
            picksTakenThisTurn: row.picks_taken_this_turn,
            picksNeededThisTurn: row.picks_needed_this_turn,
            bonusPicks: row.bonus_picks || {},
          }
        : null;
    }
    const currentParticipantId = schedule ? schedule.currentParticipantId : null;

    return {
      n,
      totalPicksMade,
      currentRound: schedule ? schedule.currentRound : null,
      // turnIndex isn't part of compute_draft_schedule's return shape
      // (it's an internal loop variable in the SQL, not exposed) — the
      // current JS derives currentPickInRound from it. Recomputing this
      // one small piece of arithmetic client-side (not a business rule,
      // just presentation) from already-known n/currentRound/picks is
      // deferred to the actual LeagueData rewrite step once the exact
      // call site's needs are confirmed against the live RPC output —
      // left unset here rather than guessed at.
      currentPickInRound: null,
      currentPickOverall: currentParticipantId ? totalPicksMade + 1 : null,
      currentParticipantId,
      currentParticipant: currentParticipantId ? participantsById[currentParticipantId] || null : null,
      isBonusTurn: schedule ? schedule.isBonusTurn : false,
      picksTakenThisTurn: schedule ? schedule.picksTakenThisTurn : 0,
      picksNeededThisTurn: schedule ? schedule.picksNeededThisTurn : 1,
      bonusPicks: schedule ? schedule.bonusPicks : {},
      skipCount: skips.length,
      draftComplete: season.draftComplete,
      poolExhausted: availablePlayers.length === 0,
      picks,
      availablePlayers,
    };
  }

  // ── Draft-time position state (mandatory-first-five tracking) ──────────
  // Calls compute_position_state (RPC) — never reimplements the
  // Joker-effective-position logic client-side.
  async function getPositionState(seasonId, participantId) {
    const season = await SupabaseReadsCore.getSeason(seasonId);
    if (!season) return null;

    const rows = await SupabaseQuery.callReadRpc("compute_position_state", {
      p_season_id: seasonId,
      p_participant_id: participantId,
    });
    const filled = {};
    CORE_POSITIONS.forEach((pos) => { filled[pos] = false; });
    (rows || []).forEach((r) => { filled[r.pos_name] = r.filled; });
    const missing = CORE_POSITIONS.filter((pos) => !filled[pos]);
    return { filled, missing, allFilled: missing.length === 0 };
  }

  // ── Draft pool status (every player, annotated per-participant) ────────
  async function getDraftPoolStatus(seasonId, participantId) {
    const season = await SupabaseReadsCore.getSeason(seasonId);
    if (!season) return [];

    const [allPlayers, picks] = await Promise.all([
      SupabaseReadsCore.getAllPlayers(),
      getDraftPicks(seasonId),
    ]);
    const playersById = Object.fromEntries(allPlayers.map((p) => [p.id, p]));

    const draftedIds = new Set(picks.map((p) => p.playerId));
    const draftedVariantGroups = new Set(
      picks
        .map((p) => playersById[p.playerId] && playersById[p.playerId].variantGroup)
        .filter(Boolean)
    );

    const posState = participantId ? await getPositionState(seasonId, participantId) : null;

    return allPlayers.map((player) => {
      let status = "available";
      if (draftedIds.has(player.id)) {
        status = "drafted";
      } else if (player.variantGroup && draftedVariantGroups.has(player.variantGroup)) {
        status = "variant-locked";
      } else if (posState && !posState.allFilled) {
        if (!CORE_POSITIONS.includes(player.position)) {
          status = "no-position";
        } else if (posState.filled[player.position]) {
          status = "position-locked";
        }
      }
      return { player, status };
    });
  }

  return {
    getPlayerDraftOrder,
    getDraftPicks,
    getDraftSkips,
    getAvailablePlayers,
    getDraftState,
    getPositionState,
    getDraftPoolStatus,
  };
})();
