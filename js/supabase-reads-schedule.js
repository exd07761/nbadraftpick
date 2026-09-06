/**
 * supabase-reads-schedule.js
 *
 * Phase 6.6: dormant read functions for the regular-season schedule,
 * Group Stage state/standings, team/streamer statistics, and the full
 * playoff bracket. Built on SupabaseQuery/SupabaseReadsCore (Phases
 * 6.2-6.3).
 *
 * PHASE 6.6 STATUS: dormant. Nothing calls SupabaseReadsSchedule yet.
 * LeagueData/AdminActions are untouched. Every function here is a pure
 * read — grepped and confirmed zero .insert()/.update()/.delete()/
 * .upsert() calls exist in this file.
 *
 * ============================================================
 * IMPORTANT FIELD-NAME FINDING (re-read from source, not assumed):
 * The current app's matchup objects use `home`/`away` (short names),
 * NOT `homeParticipantId`/`awayParticipantId` — confirmed via
 * assignRound1HomeCourt/assignRound2HomeCourt in data.js. Mapped that
 * way below. Group/stage fields are `stage`/`group` (not `groupName`).
 * These are absent entirely on Round Robin matchups (only present on
 * Group Stage ones) — mirrored here via `|| undefined`.
 * ============================================================
 *
 * ============================================================
 * IMPORTANT PLAYOFF SHAPE FINDING (re-read from source, not assumed):
 * Round 1 matches and the Finals semifinals/championship use
 * `teamA`/`teamB`. Round 2 series do NOT — they use `seed` (which
 * seed this series belongs to, 1/2/3/4) and `opponent` (the resolved
 * opponent once selectPlayoffOpponent has run), confirmed via
 * makePlayoffSeries/selectPlayoffOpponent/cascadePlayoffAdvancement in
 * data.js. A round 2 series' OWN participant identity isn't stored on
 * the series at all in the current app — it's derived by looking up
 * `seeds` for that series' `seed` number. My Supabase playoff_series
 * table stores team_a/team_b uniformly across every kind (including
 * round2, where team_a holds the seed-holder's own identity — internal
 * bookkeeping added during the Phase 5.5 corrective work, with no
 * equivalent field exposed in the current app's round2 series shape).
 * getPlayoffs()/getPlayoffItem() below reconstruct the EXACT current
 * shape: round2 series get {id, seed, opponent, games, winner, status}
 * — team_a is used only internally to resolve `seed`'s owner, never
 * exposed as `teamA` on a round2 series, matching current behavior
 * exactly rather than the Supabase table's own internal shape.
 * ============================================================
 *
 * ============================================================
 * IMPORTANT STANDINGS FINDING (re-read from source, not assumed):
 * The current computeTeamStandings() returns, per team: participantId,
 * participantName, nbaTeam, gamesPlayed, wins, losses, winPct,
 * pointsFor, pointsAgainst, pointDifferential, gamesRemaining.
 * get_team_statistics/get_group_stage_standings (built in Phases 5/5.5)
 * return only: pid/participant_id, wins, losses, win_pct,
 * point_diff (the COMBINED difference — pointsFor/pointsAgainst
 * individually are not returned at all), games_played. Three fields
 * are simply missing (participantName, nbaTeam, gamesRemaining) and
 * two more (pointsFor, pointsAgainst) cannot be recovered from what
 * the RPC currently returns.
 * Per "use the existing RPC for computed logic, never duplicate it":
 * the RPC's actual computed logic — the ranking itself (win% desc,
 * point-diff desc), win/loss/games-played counting — is used AS IS,
 * not reimplemented. participantName/nbaTeam/gamesRemaining are pure
 * enrichment from data already being fetched anyway (participants,
 * nba_team_assignments, matchups) — not a second ranking engine.
 * pointsFor/pointsAgainst are left `null` below rather than computed
 * independently in JS, because that WOULD mean quietly re-deriving
 * part of the same aggregation the RPC already owns. This is a real
 * gap in the RPC's return shape, flagged for a future approved change
 * to get_team_statistics/get_group_stage_standings (add points_for/
 * points_against to their SELECT) — not something to route around
 * client-side.
 * ============================================================
 *
 * 2K26/2K27 HISTORICAL DATA SAFETY: everything here reads matchups,
 * schedule_rounds, group_stage_state, the playoff tables, and
 * financial_transactions — never writes, never touches players,
 * nba2k_players, or nba2k27_pool.
 */

const SupabaseReadsSchedule = (() => {
  const GROUP_NAMES = ["A", "B", "C", "D"];

  function mapMatchupRow(row) {
    return {
      id: row.id,
      teamA: row.team_a,
      teamB: row.team_b,
      status: row.status,
      scoreA: row.score_a,
      scoreB: row.score_b,
      winner: row.winner,
      streamer: row.streamer,
      playedAt: row.played_at,
      stage: row.stage || undefined,
      group: row.group_name || undefined,
      home: row.home_participant_id || undefined,
      away: row.away_participant_id || undefined,
    };
  }

  // ── Regular-season / Group Stage schedule (rounds of matchups) ─────────
  async function getSchedule(seasonId) {
    const [rounds, matchupRows] = await Promise.all([
      SupabaseQuery.select("schedule_rounds", (qb) =>
        qb.eq("season_id", seasonId).order("round_number", { ascending: true })
      ),
      SupabaseQuery.select("matchups", (qb) => qb.eq("season_id", seasonId)),
    ]);
    const matchupsByRound = {};
    matchupRows.forEach((row) => {
      (matchupsByRound[row.round_id] ||= []).push(mapMatchupRow(row));
    });
    return rounds.map((r) => ({
      round: r.round_number,
      matchups: matchupsByRound[r.id] || [],
    }));
  }

  async function getMatchup(seasonId, matchupId) {
    const schedule = await getSchedule(seasonId);
    for (const round of schedule) {
      const matchup = round.matchups.find((m) => m.id === matchupId);
      if (matchup) return { matchup, round: round.round };
    }
    return null;
  }

  async function getScheduleState(seasonId) {
    const [season, schedule] = await Promise.all([
      SupabaseReadsCore.getSeason(seasonId),
      getSchedule(seasonId),
    ]);
    if (!season) return null;

    const allMatchups = schedule.flatMap((r) => r.matchups);
    const realMatchups = allMatchups.filter((m) => m.teamB !== null);
    const completed = realMatchups.filter((m) => m.status === "completed");

    return {
      generated: schedule.length > 0,
      generatedAt: season.scheduleGeneratedAt,
      totalRounds: schedule.length,
      realMatchupCount: realMatchups.length,
      completedCount: completed.length,
      hasCompletedGames: completed.length > 0,
      teamsCount: new Set(allMatchups.flatMap((m) => [m.teamA, m.teamB]).filter(Boolean)).size,
    };
  }

  // ── Team statistics (uses get_team_statistics RPC for the ranking —
  // see the STANDINGS FINDING note above for what's enriched vs. left null) ─
  //
  // SECOND STANDINGS FINDING, discovered by live-testing this function
  // (not assumed): get_team_statistics only returns a row for a
  // participant with at least one COMPLETED game (its query is a
  // GROUP BY over completed matchups, no LEFT JOIN against every
  // assigned team) — a team that hasn't played yet is simply absent
  // from its result set. The current app's computeTeamStandings()
  // always returns one row per assigned team, zeros and all. A season
  // with zero games played would show an empty array here vs. every
  // team at 0-0 in the current app. Flagged for a future approved fix
  // to get_team_statistics (a LEFT JOIN against the assigned-teams
  // list) — not routed around client-side, since re-deriving "every
  // assigned team" and re-joining it against the RPC's rows here would
  // mean partially reimplementing the RPC's own FROM clause.
  async function getTeamStatistics(seasonId) {
    const [rows, participants, assignmentRows, schedule] = await Promise.all([
      SupabaseQuery.callReadRpc("get_team_statistics", { p_season_id: seasonId }),
      SupabaseReadsCore.getParticipants(seasonId),
      SupabaseQuery.select("nba_team_assignments", (qb) => qb.eq("season_id", seasonId)),
      getSchedule(seasonId),
    ]);
    const participantsById = Object.fromEntries(participants.map((p) => [p.id, p]));
    const nbaTeamByParticipant = Object.fromEntries(
      assignmentRows.map((r) => [r.participant_id, r.nba_team_abbr])
    );
    const allMatchups = schedule.flatMap((r) => r.matchups);

    return (rows || []).map((row) => {
      const pid = row.participant_id;
      const scheduledReal = allMatchups.filter(
        (m) => m.teamB !== null && m.status !== "completed" && (m.teamA === pid || m.teamB === pid)
      );
      return {
        participantId: pid,
        participantName: participantsById[pid] ? participantsById[pid].name : null,
        nbaTeam: nbaTeamByParticipant[pid] || null,
        gamesPlayed: row.games_played,
        wins: row.wins,
        losses: row.losses,
        winPct: Number(row.win_pct),
        pointsFor: null, // see STANDINGS FINDING — not returned by get_team_statistics today
        pointsAgainst: null, // see STANDINGS FINDING
        pointDifferential: row.point_diff,
        gamesRemaining: scheduledReal.length,
      };
    });
  }

  // ── Group Stage standings (uses get_group_stage_standings RPC) ─────────
  async function getGroupStageStandings(seasonId, stage) {
    const season = await SupabaseReadsCore.getSeason(seasonId);
    if (!season) return null;

    const gsRows = await SupabaseQuery.select("group_stage_state", (qb) =>
      qb.eq("season_id", seasonId).limit(1)
    );
    if (!gsRows.length) return null;
    const targetStage = stage || gsRows[0].stage;

    const rpcResult = await SupabaseQuery.callReadRpc("get_group_stage_standings", {
      p_season_id: seasonId,
      p_stage: targetStage,
    });
    if (!rpcResult) return null;

    const [participants, assignmentRows] = await Promise.all([
      SupabaseReadsCore.getParticipants(seasonId),
      SupabaseQuery.select("nba_team_assignments", (qb) => qb.eq("season_id", seasonId)),
    ]);
    const participantsById = Object.fromEntries(participants.map((p) => [p.id, p]));
    const nbaTeamByParticipant = Object.fromEntries(
      assignmentRows.map((r) => [r.participant_id, r.nba_team_abbr])
    );

    const result = {};
    GROUP_NAMES.forEach((g) => {
      result[g] = (rpcResult[g] || []).map((row) => ({
        participantId: row.participantId,
        participantName: participantsById[row.participantId] ? participantsById[row.participantId].name : null,
        nbaTeam: nbaTeamByParticipant[row.participantId] || null,
        gamesPlayed: row.gamesPlayed,
        wins: row.wins,
        losses: row.losses,
        winPct: row.winPct,
        pointsFor: row.pointsFor,
        pointsAgainst: row.pointsAgainst,
        pointDifferential: row.pointDifferential,
        // gamesRemaining intentionally omitted: get_group_stage_standings's
        // JSON rows don't currently include per-team scheduled-not-yet-
        // played counts scoped to a stage/group, and deriving it
        // correctly here would mean re-deriving which matchups belong to
        // which group/stage in JS — exactly the aggregation the RPC
        // already owns. Left out rather than approximated.
      }));
    });
    return result;
  }

  // ── Streamer statistics (pure aggregation over matchups.streamer —
  // no RPC exists for this read; get_streamer_statistics is the RPC used
  // by the WRITE path (record_streamer_salaries) and is internal-only.
  // This mirrors getStreamerStatistics()'s exact client-side counting —
  // there is no business RULE here beyond counting, so no duplication
  // concern (the eligibility RULE — >=14 games — lives only in
  // record_streamer_salaries and getStreamerSalaryPlan, Phase 6.7). ────
  async function getStreamerStatistics(seasonId) {
    const schedule = await getSchedule(seasonId);
    const completedReal = schedule
      .flatMap((r) => r.matchups)
      .filter((m) => m.teamB !== null && m.status === "completed");

    const counts = new Map();
    completedReal.forEach((m) => counts.set(m.streamer, (counts.get(m.streamer) || 0) + 1));

    return [...counts.entries()]
      .map(([streamer, gamesStreamed]) => ({ streamer, gamesStreamed }))
      .sort((a, b) => b.gamesStreamed - a.gamesStreamed);
  }

  // ── Playoffs: full bracket reconstruction (see PLAYOFF SHAPE FINDING) ──
  function mapGameRow(row) {
    return {
      gameNumber: row.game_number,
      scoreA: row.score_a,
      scoreB: row.score_b,
      winner: row.winner,
      streamer: row.streamer,
      playedAt: row.played_at,
      status: row.status,
    };
  }

  async function getPlayoffs(seasonId) {
    const bracketRows = await SupabaseQuery.select("playoff_brackets", (qb) =>
      qb.eq("season_id", seasonId).limit(1)
    );
    if (!bracketRows.length) return null;
    const bracket = bracketRows[0];

    const [seriesRows, sourceRows, gameRows] = await Promise.all([
      SupabaseQuery.select("playoff_series", (qb) => qb.eq("season_id", seasonId)),
      SupabaseQuery.select("playoff_series_sources", (qb) => qb),
      SupabaseQuery.select("playoff_games", (qb) => qb),
    ]);
    const seriesIds = new Set(seriesRows.map((s) => s.id));
    const sourcesBySeriesId = {};
    sourceRows.forEach((r) => {
      if (!seriesIds.has(r.series_id)) return;
      (sourcesBySeriesId[r.series_id] ||= []).push(r.source_series_id);
    });
    const gamesBySeriesId = {};
    gameRows.forEach((g) => {
      (gamesBySeriesId[g.series_id] ||= []).push(g);
    });
    const gamesFor = (seriesId) =>
      (gamesBySeriesId[seriesId] || [])
        .sort((a, b) => a.game_number - b.game_number)
        .map(mapGameRow);

    const round1Series = seriesRows.filter((s) => s.kind === "round1");
    const round2Series = seriesRows.filter((s) => s.kind === "round2");
    const semifinalSeries = seriesRows.filter((s) => s.kind === "semifinal");
    const championshipSeries = seriesRows.find((s) => s.kind === "championship") || null;

    const round1Matches = round1Series
      .sort((a, b) => a.seed_a - b.seed_a)
      .map((s) => ({
        id: s.id,
        seedA: s.seed_a,
        seedB: s.seed_b,
        teamA: s.team_a,
        teamB: s.team_b,
        games: gamesFor(s.id),
        winner: s.winner,
        status: s.status,
      }));

    function buildPool(poolName, chooserSeed) {
      const poolSeries = round2Series
        .filter((s) => s.pool_name === poolName)
        .sort((a, b) => (a.seed_a === chooserSeed ? -1 : 1)); // chooser's own series first, matching series[0]/series[1] order
      const sourceMatchIds = poolSeries.length ? sourcesBySeriesId[poolSeries[0].id] || [] : [];
      const chooserSeries = poolSeries.find((s) => s.seed_a === chooserSeed);
      return {
        name: poolName,
        sourceMatchIds,
        chooserSeed,
        selection: chooserSeries ? chooserSeries.selection : null,
        series: poolSeries.map((s) => ({
          id: s.id,
          seed: s.seed_a,
          opponent: s.team_b || null, // see PLAYOFF SHAPE FINDING — never teamA/teamB here
          games: gamesFor(s.id),
          winner: s.winner,
          status: s.status,
        })),
      };
    }

    const semifinals = semifinalSeries.map((s) => ({
      id: s.id,
      sourceSeriesIds: sourcesBySeriesId[s.id] || [],
      teamA: s.team_a,
      teamB: s.team_b,
      games: gamesFor(s.id),
      winner: s.winner,
      status: s.status,
    }));

    const championship = championshipSeries
      ? {
          id: championshipSeries.id,
          sourceSeriesIds: sourcesBySeriesId[championshipSeries.id] || [],
          teamA: championshipSeries.team_a,
          teamB: championshipSeries.team_b,
          games: gamesFor(championshipSeries.id),
          winner: championshipSeries.winner,
          status: championshipSeries.status,
        }
      : null;

    return {
      status: bracket.status,
      generatedAt: bracket.created_at,
      seeds: bracket.seeds,
      round1: { format: "bo1", matches: round1Matches },
      round2: {
        format: "bo3",
        pools: [buildPool("top", 3), buildPool("bottom", 1)],
      },
      finals: { format: "bo3", semifinals, championship },
      champion: bracket.champion_participant_id,
    };
  }

  async function getPlayoffItem(seasonId, itemId) {
    const playoffs = await getPlayoffs(seasonId);
    if (!playoffs) return null;
    const r1 = playoffs.round1.matches.find((m) => m.id === itemId);
    if (r1) return { item: r1, kind: "round1" };
    for (const pool of playoffs.round2.pools) {
      const s = pool.series.find((s) => s.id === itemId);
      if (s) return { item: s, kind: "round2", pool };
    }
    const sf = playoffs.finals.semifinals.find((s) => s.id === itemId);
    if (sf) return { item: sf, kind: "semifinal" };
    if (playoffs.finals.championship && playoffs.finals.championship.id === itemId) {
      return { item: playoffs.finals.championship, kind: "championship" };
    }
    return null;
  }

  return {
    getSchedule,
    getMatchup,
    getScheduleState,
    getTeamStatistics,
    getGroupStageStandings,
    getStreamerStatistics,
    getPlayoffs,
    getPlayoffItem,
  };
})();
