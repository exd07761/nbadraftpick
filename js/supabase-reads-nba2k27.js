/**
 * supabase-reads-nba2k27.js
 *
 * Phase 8.4: read functions for the public NBA 2K27 player lookup pages
 * (js/views/players.js, js/views/nba2k27.js) — the `nba2k27_pool` and
 * `nba2k_players` tables, joined by slug. Built on SupabaseQuery, same
 * generic scaffold every other supabase-reads-*.js module sits on.
 *
 * PHASE 8.4 STATUS: live, not dormant. Unlike supabase-reads-core.js/
 * -draft.js/-roster.js/-schedule.js (which remain dormant pending their
 * own later LeagueData-wiring phases), this module is consumed directly
 * by the two public view files in this same phase. This mirrors how
 * js/admin/nba2k-database.js's own equivalent migration (Phase 8.1A) was
 * a single, self-contained cutover rather than a dormant-then-wired-
 * later two-step — exactly like that file, the reads here are fully
 * self-contained and never touch LeagueData/FirebaseSync/AdminActions or
 * league/main in any way. Nothing here writes anything, anywhere.
 *
 * ROW NORMALIZATION
 * `mapPoolRow` follows the exact convention established in
 * js/admin/nba2k-database.js's nba2k27NormalizePoolRow() (Phase 8.1E/
 * 8.2): nba2k27_pool's snake_case columns become the camelCase shape
 * this application's existing join/render logic already expects
 * (nameOverride, overallOverride, variantGroupId, variantLabel, etc.).
 * `mapPlayerRow` keeps nba2k_players fields close to the shape the
 * existing Firestore documents already had — camelCase for the fields
 * both public view files already read by camelCase name (playerImage,
 * teamImg, playerUrl, lastUpdated, importedAt), unchanged for everything
 * else (name, team, overall, positions, attributes, badges, build,
 * height, weight, wingspan already match on both sides). `id` is added
 * to mirror the `{ id: d.id, ...d.data() }` shape both files' current
 * Firestore reads already produce.
 *
 * API SURFACE — deliberately minimal, only what the two public pages
 * need. Both functions return their rows keyed by slug, matching the
 * exact object shape `_ensureLoaded()`'s `this._pool27`/`this._players`
 * (or `this._players27`) already store in both files today, so each
 * view's own join/render logic (`_buildEntries()`/`_buildRows()` and
 * everything downstream of them) needs no changes beyond the fetch call
 * itself.
 *
 * 2K26/2K27 HISTORICAL DATA SAFETY: both functions are pure reads.
 * Nothing here writes, and nothing here touches draft picks, rosters,
 * trades, financials, schedules, or playoffs.
 */
const SupabaseReadsNba2k27 = (() => {
  // Postgres/PostgREST has no Firestore-style 10-item `in`-query cap,
  // but `.in()` is sent as a GET query-string filter, so a defensive
  // chunk size is still used to avoid an oversized URL for a very large
  // slug list — same reasoning (and the same chunk size) already used by
  // js/admin/nba2k-import.js's _fetchExistingPlayers().
  const PLAYERS_CHUNK_SIZE = 200;

  function mapPoolRow(row) {
    return {
      nba2kRef: row.nba2k_ref,
      pool: row.pool,
      position: row.position,
      selectedAt: row.selected_at,
      updatedAt: row.updated_at,
      overallOverride: row.overall_override,
      nameOverride: row.name_override,
      variantGroupId: row.variant_group_id,
      variantLabel: row.variant_label,
    };
  }

  function mapPlayerRow(row) {
    return {
      id: row.slug,
      name: row.name,
      team: row.team,
      teamType: row.team_type,
      overall: row.overall,
      positions: row.positions,
      build: row.build,
      height: row.height,
      weight: row.weight,
      wingspan: row.wingspan,
      attributes: row.attributes,
      badges: row.badges,
      playerUrl: row.player_url,
      playerImage: row.player_image,
      teamImg: row.team_img,
      lastUpdated: row.last_updated,
      importedAt: row.imported_at,
    };
  }

  // Phase 8.4.1: Supabase/PostgREST returns at most 1000 rows per
  // request by default — with nba2k27_pool at ~1,987 rows (and growing),
  // an unpaginated read silently truncated to the first 1,000. Same
  // page size and `.range()` pagination pattern already established in
  // js/admin/nba2k-database.js's own `_ensureLoaded()` (Phase 8.1A).
  const POOL_PAGE_SIZE = 1000;

  /**
   * Reads the entire nba2k27_pool table, keyed by slug (nba2k_ref) — the
   * Supabase equivalent of
   * `firebase.firestore().collection('nba2k27_pool').get()`. Each row is
   * normalized to the camelCase shape the existing join logic in both
   * public view files already expects. Paginated via deterministic
   * `nba2k_ref` ordering + `.range()` so the full table is retrieved
   * regardless of row count — see POOL_PAGE_SIZE above for why this is
   * necessary, not optional.
   */
  async function getNba2k27PoolRows() {
    const bySlug = {};
    let offset = 0;

    while (true) {
      const page = await SupabaseQuery.select("nba2k27_pool", (qb) =>
        qb
          .order("nba2k_ref", { ascending: true })
          .range(offset, offset + POOL_PAGE_SIZE - 1)
      );

      page.forEach((row) => { bySlug[row.nba2k_ref] = mapPoolRow(row); });

      if (page.length < POOL_PAGE_SIZE) break;
      offset += POOL_PAGE_SIZE;
    }

    return bySlug;
  }

  /**
   * Reads nba2k_players rows for exactly the given slugs, keyed by
   * slug — the Supabase equivalent of the chunked
   * `.where(FieldPath.documentId(), 'in', chunk)` Firestore query both
   * public view files currently perform. Fetches nothing when `slugs` is
   * empty, matching the existing behavior (an empty pool needs no player
   * fetch).
   *
   * Fires every chunk query in parallel — same performance intent as the
   * Firestore version this replaces (see js/views/nba2k27.js's own
   * "PERFORMANCE" comment on why this matters: total wall-clock time is
   * bounded by the slowest single chunk, not the sum of all of them).
   * Each chunk's own failure is caught individually so one bad chunk
   * never discards the others' results — mirrors the per-chunk
   * `.then()/.catch()` pattern both public view files already use. If
   * EVERY chunk fails, that's a systemic problem (not just "this one
   * player's doc doesn't resolve," which is handled per-row as an
   * "orphan" card by each view's existing, unmodified render logic) — in
   * that case this rethrows the last error for the caller's own
   * load-error state handling.
   */
  async function getNba2k27PlayersBySlugs(slugs) {
    const bySlug = {};
    if (!Array.isArray(slugs) || slugs.length === 0) return bySlug;

    const chunks = [];
    for (let i = 0; i < slugs.length; i += PLAYERS_CHUNK_SIZE) {
      chunks.push(slugs.slice(i, i + PLAYERS_CHUNK_SIZE));
    }

    const chunkResults = await Promise.all(
      chunks.map((chunk) =>
        SupabaseQuery.select("nba2k_players", (qb) => qb.in("slug", chunk))
          .then((rows) => ({ ok: true, rows }))
          .catch((err) => ({ ok: false, err }))
      )
    );

    let anyOk = false;
    let lastError = null;
    chunkResults.forEach((result) => {
      if (result.ok) {
        anyOk = true;
        result.rows.forEach((row) => { bySlug[row.slug] = mapPlayerRow(row); });
      } else {
        lastError = result.err;
      }
    });

    if (!anyOk && lastError) throw lastError;
    return bySlug;
  }

  return {
    getNba2k27PoolRows,
    getNba2k27PlayersBySlugs,
  };
})();
