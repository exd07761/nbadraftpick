/**
 * supabase-query.js
 *
 * Generic read/query abstraction layer over the Supabase client. This is
 * the shared plumbing every entity-specific read function (built in
 * Phase 6.3 onward — season/participant/player, draft, roster, schedule/
 * Group Stage/playoff, financial/streamer) will sit on top of, so error
 * handling and call shape are consistent everywhere instead of each read
 * function reinventing it.
 *
 * PHASE 6.2 STATUS: this file is dormant infrastructure, exactly like
 * supabase-config.js. Nothing in js/data.js or anywhere else calls
 * SupabaseQuery yet — LeagueData/AdminActions are untouched. Loading
 * this file changes no application behavior.
 *
 * Design principles carried over from the RPC layer built in Phases
 * 5/5.5/6.1:
 *  - Every read is async (a genuine architectural change from the
 *    current synchronous loadData()-backed LeagueData — see the Phase 6
 *    readiness report §8). Callers will need `await`.
 *  - Errors are normalized to a single shape so calling code doesn't
 *    need to branch on PostgREST vs. RPC error formats.
 *  - No business logic lives here — only the mechanics of talking to
 *    Supabase. Validation, aggregation, and derived-state computation
 *    stay server-side, in the RPCs already built (e.g. get_team_statistics,
 *    compute_draft_schedule) — this layer never recomputes what a
 *    read-RPC already computes.
 */

const SupabaseQuery = (() => {
  /**
   * Runs a plain SELECT against a table via the Supabase client.
   * @param {string} table
   * @param {(qb: any) => any} build - receives the query builder
   *   (supabase.from(table).select(...)) and returns it after applying
   *   filters/ordering, e.g. qb => qb.eq('season_id', seasonId)
   * @returns {Promise<any[]>}
   */
  async function select(table, build) {
    if (!SupabaseClient) {
      throw new Error(
        "SupabaseQuery.select: SupabaseClient is not initialized (check supabase-config.js load order)."
      );
    }
    let qb = SupabaseClient.from(table).select("*");
    if (typeof build === "function") qb = build(qb);
    const { data, error } = await qb;
    if (error) throw normalizeError(error, `select ${table}`);
    return data;
  }

  /**
   * Calls a read-only RPC (one of the internal aggregation helpers —
   * get_team_statistics, get_group_stage_standings, get_streamer_statistics,
   * f6_participant_breakdown, get_player_classification, compute_draft_schedule,
   * compute_position_state — once each is granted EXECUTE per the Phase 6
   * readiness report §1. Calling one of these before its grant is added
   * will fail with a permission error, exactly as it does today from SQL.)
   * @param {string} fnName
   * @param {object} params
   * @returns {Promise<any>}
   */
  async function callReadRpc(fnName, params) {
    if (!SupabaseClient) {
      throw new Error(
        "SupabaseQuery.callReadRpc: SupabaseClient is not initialized (check supabase-config.js load order)."
      );
    }
    const { data, error } = await SupabaseClient.rpc(fnName, params);
    if (error) throw normalizeError(error, `rpc ${fnName}`);
    return data;
  }

  /**
   * Normalizes a Supabase/PostgREST error into a single shape so callers
   * don't need to know whether it came from a table SELECT or an RPC.
   * Mirrors how the current Firebase-backed code surfaces a plain Error
   * with a human-readable .message (see the Phase 6 readiness report §6
   * on error-handling transition) rather than exposing Postgres error
   * codes to the UI layer.
   */
  function normalizeError(error, context) {
    const message = error && error.message ? error.message : String(error);
    const wrapped = new Error(message);
    wrapped.context = context;
    wrapped.cause = error;
    return wrapped;
  }

  return { select, callReadRpc };
})();
