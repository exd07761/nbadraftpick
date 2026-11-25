/**
 * data.js — Single source of truth for all league data.
 *
 * All reads and writes go through this module.
 * Public (read-only) functions are exported at the bottom.
 * Write functions are clearly marked and called only from admin context,
 * behind the auth boundary in auth-boundary.js.
 *
 * Storage: Firestore, collection "league" doc "main" — see the
 * FirebaseSync module below. Requires js/firebase-config.js (Firebase SDK
 * init) to have already run before this file loads.
 */

// ─── NBA Teams (static reference data) ───────────────────────────────────────

// Presentation-only fields (color, colorAlt, logo) — see shared-utils.js:
// teamBadge(). `logo` points at a local self-contained SVG under
// assets/logos/ (added Phase 10.2, supplied by the project owner — no
// external URLs, no CDNs, nothing hotlinked). `color`/`colorAlt` remain
// as the fallback badge's colors if a logo file is ever missing or fails
// to load. None of these fields carry ownership meaning: participant ->
// NBA team ownership is decided exclusively by season.nbaTeamAssignments,
// never by anything here.
const NBA_TEAMS = [
  { abbr: "ATL", name: "Atlanta Hawks",          color: "#E03A3E", colorAlt: "#26282A", logo: "assets/logos/atlanta-hawks.svg" },
  { abbr: "BOS", name: "Boston Celtics",         color: "#007A33", colorAlt: "#BA9653", logo: "assets/logos/boston-celtics.svg" },
  { abbr: "BKN", name: "Brooklyn Nets",          color: "#000000", colorAlt: "#FFFFFF", logo: "assets/logos/brooklyn-nets.svg" },
  { abbr: "CHA", name: "Charlotte Hornets",      color: "#1D1160", colorAlt: "#00788C", logo: "assets/logos/charlotte-hornets.svg" },
  { abbr: "CHI", name: "Chicago Bulls",          color: "#CE1141", colorAlt: "#000000", logo: "assets/logos/chicago-bulls.svg" },
  { abbr: "CLE", name: "Cleveland Cavaliers",    color: "#860038", colorAlt: "#FDBB30", logo: "assets/logos/cleveland-cavaliers.svg" },
  { abbr: "DAL", name: "Dallas Mavericks",       color: "#00538C", colorAlt: "#002B5E", logo: "assets/logos/dallas-mavericks.svg" },
  { abbr: "DEN", name: "Denver Nuggets",         color: "#0E2240", colorAlt: "#FEC524", logo: "assets/logos/denver-nuggets.svg" },
  { abbr: "DET", name: "Detroit Pistons",        color: "#C8102E", colorAlt: "#1D42BA", logo: "assets/logos/detroit-pistons.svg" },
  { abbr: "GSW", name: "Golden State Warriors",  color: "#1D428A", colorAlt: "#FFC72C", logo: "assets/logos/golden-state-warriors.svg" },
  { abbr: "HOU", name: "Houston Rockets",        color: "#CE1141", colorAlt: "#000000", logo: "assets/logos/houston-rockets.svg" },
  { abbr: "IND", name: "Indiana Pacers",         color: "#002D62", colorAlt: "#FDBB30", logo: "assets/logos/indiana-pacers.svg" },
  { abbr: "LAC", name: "LA Clippers",            color: "#C8102E", colorAlt: "#1D428A", logo: "assets/logos/la-clippers.svg" },
  { abbr: "LAL", name: "Los Angeles Lakers",     color: "#552583", colorAlt: "#FDB927", logo: "assets/logos/los-angeles-lakers.svg" },
  { abbr: "MEM", name: "Memphis Grizzlies",      color: "#5D76A9", colorAlt: "#12173F", logo: "assets/logos/memphis-grizzlies.svg" },
  { abbr: "MIA", name: "Miami Heat",             color: "#98002E", colorAlt: "#F9A01B", logo: "assets/logos/miami-heat.svg" },
  { abbr: "MIL", name: "Milwaukee Bucks",        color: "#00471B", colorAlt: "#EEE1C6", logo: "assets/logos/milwaukee-bucks.svg" },
  { abbr: "MIN", name: "Minnesota Timberwolves", color: "#0C2340", colorAlt: "#236192", logo: "assets/logos/minnesota-timberwolves.svg" },
  { abbr: "NOP", name: "New Orleans Pelicans",   color: "#0C2340", colorAlt: "#C8102E", logo: "assets/logos/new-orleans-pelicans.svg" },
  { abbr: "NYK", name: "New York Knicks",        color: "#006BB6", colorAlt: "#F58426", logo: "assets/logos/new-york-knicks.svg" },
  { abbr: "OKC", name: "Oklahoma City Thunder",  color: "#007AC1", colorAlt: "#EF3B24", logo: "assets/logos/oklahoma-city-thunder.svg" },
  { abbr: "ORL", name: "Orlando Magic",          color: "#0077C0", colorAlt: "#C4CED4", logo: "assets/logos/orlando-magic.svg" },
  { abbr: "PHI", name: "Philadelphia 76ers",     color: "#006BB6", colorAlt: "#ED174C", logo: "assets/logos/philadelphia-76ers.svg" },
  { abbr: "PHX", name: "Phoenix Suns",           color: "#1D1160", colorAlt: "#E56020", logo: "assets/logos/phoenix-suns.svg" },
  { abbr: "POR", name: "Portland Trail Blazers", color: "#E03A3E", colorAlt: "#000000", logo: "assets/logos/portland-trail-blazers.svg" },
  { abbr: "SAC", name: "Sacramento Kings",       color: "#5A2D81", colorAlt: "#63727A", logo: "assets/logos/sacramento-kings.svg" },
  { abbr: "SAS", name: "San Antonio Spurs",      color: "#C4CED4", colorAlt: "#000000", logo: "assets/logos/san-antonio-spurs.svg" },
  { abbr: "TOR", name: "Toronto Raptors",        color: "#CE1141", colorAlt: "#000000", logo: "assets/logos/toronto-raptors.svg" },
  { abbr: "UTA", name: "Utah Jazz",              color: "#002B5C", colorAlt: "#F9A01B", logo: "assets/logos/utah-jazz.svg" },
  { abbr: "WAS", name: "Washington Wizards",     color: "#002B5C", colorAlt: "#E31837", logo: "assets/logos/washington-wizards.svg" },
];

// ── Phase 4B: Player Draft core positions ──────────────────────────────────
// The five positions every participant must fill before drafting a second
// player at any position (see computePositionState / makeDraftPick below).
const CORE_POSITIONS = ["PG", "SG", "SF", "PF", "C"];

// ─── Schema Factories ─────────────────────────────────────────────────────────

/**
 * Creates a new season object.
 * All season data is self-contained here — previous seasons are never mutated.
 */
function createSeason(id, name) {
  return {
    id,
    name,
    status: "setup", // setup | draft | team_assignment | regular_season | playoffs | complete
    createdAt: new Date().toISOString(),
    // NBA2K27 season-cutover feature: absent for every season created
    // before this feature existed (including the frozen NBA2K26 season)
    // and for any season that doesn't opt in — getAvailablePlayers()/
    // getDraftPoolStatus() below only apply scoped filtering when this
    // is actually set, so omitting it here (the existing default for
    // every existing caller) is a guaranteed no-op, not a new default
    // behavior. When set (see AdminActions.createSeason's third
    // parameter), its value is always this season's own `id` — it marks
    // "this season's draft pool is limited to players seeded for it",
    // not a reference to some other season.
    playerPoolScope: undefined,

    // Participants: keyed by participant ID
    // Supports any number of teams — no hardcoded length.
    participants: {},

    // ── Process 1: Player Draft ──────────────────────────────────────────────
    // Manually entered from DuckRace result. Never randomized by this app.
    playerDraftOrder: [],   // array of participantIds in draft order

    // One entry per pick. Round/pick are stored explicitly for display.
    // Snake direction derived from round number (odd = ascending, even = descending).
    playerDraftPicks: [],   // [{ round, pick, participantId, playerId }]

    draftComplete: false,

    // ── Revision 1: Phase 2 Draft Skip ───────────────────────────────────────
    // Append-only audit trail of every Skip action, mirroring how
    // playerDraftPicks is itself the audit trail for picks — a skip is
    // NEVER written into playerDraftPicks (that array's meaning — "the
    // players this participant has actually drafted" — is relied on all
    // over this file via ownPickNumber/roster-cap/position-state counts,
    // and must stay exactly as it always has been).
    // afterPickCount anchors each skip to its exact place in history: the
    // length of playerDraftPicks at the moment the skip happened.
    //
    // Draft-Skip Revision 3 — accumulated pick opportunities: draftSkips
    // remains a full, append-only history/audit log — who skipped, when,
    // never rewritten or migrated — used for stats/history display AND
    // (unlike the short-lived Revision 2) it also still feeds the live
    // turn schedule again: a Skip banks one extra "pick opportunity" for
    // that participant's next draft turn, so an AFK participant doesn't
    // lose the chance to pick, they just catch up later. Crucially this
    // is NOT the old Revision-1 rigid "next turn forces exactly 2 picks,
    // cannot skip" rule — see computeDraftSchedule()'s doc comment for
    // the full flexible-opportunity model.
    draftSkips: [],   // [{ participantId, round, afterPickCount, timestamp }]

    // Draft-Skip Revision 3: banked pick opportunities awaiting a
    // participant's next draft turn — { [participantId]: number }. This
    // is a materialized snapshot of what computeDraftSchedule already
    // derives from draftSkips/playerDraftPicks on every read; kept in
    // sync by AdminActions.skipDraftPick/makeDraftPick/undoLastDraftPick
    // purely so it's visible as its own named piece of state.
    // computeDraftSchedule's own replay remains the authoritative source
    // of truth for whose turn it is and how many opportunities they have.
    bonusPicks: {},   // { [participantId]: number }

    // ── Process 2: NBA Team Assignment ───────────────────────────────────────
    // Completely separate from Process 1. Second DuckRace result entered independently.
    teamAssignmentOrder: [], // array of participantIds — NEVER assumed to equal playerDraftOrder

    // participantId → NBA team abbreviation
    nbaTeamAssignments: {},

    teamAssignmentComplete: false,

    // ── Phase 4A: Current Rosters ─────────────────────────────────────────────
    // Separate from playerDraftPicks so trades/swaps can mutate rosters without
    // touching the immutable draft history. Initialized by AdminActions.initializeRostersFromDraft().
    // currentRosters[participantId] = [{ playerId, source }]
    //   source: 'draft' | 'trade' | 'swap'  (only 'draft' used in Phase 4A)
    // Single source of truth for "who has which player right now".
    ratingCap: 875,       // max total OVR allowed per roster; enforced at draft time (makeDraftPick) and by Phase 5 trades/swaps
    rostersInitialized: false,
    // currentRosters[participantId] = [{ playerId, source, isJoker?, jokerPosition?, jokerOriginalPosition?, draftSlot? }]
    //   source: 'draft' | 'trade' | 'swap' | 'manual' | 'empty'
    //   isJoker/jokerPosition: set only for the participant's designated Joker
    //   (Phase 5) — see AdminActions.designateJoker. Absent on every other entry.
    //   draftSlot: the participant's own 1-based original pick number this
    //   roster row represents (Revision — Preserve Original Draft Pick
    //   Slot). Set for every entry at initializeRostersFromDraft() and
    //   preserved by manual Replace/Remove even when the occupant changes
    //   to a player with no playerDraftPicks record of their own — a
    //   roster-display concept only, never read by the Joker/classification
    //   system (which still looks up ownPickNumber from playerDraftPicks by
    //   the CURRENT occupant's own playerId, unaffected by this field).
    //   Absent/null on a manually-Added entry with no original slot, and on
    //   an 'empty' placeholder's occupant (source:'empty' has playerId:null
    //   but keeps its draftSlot so the vacancy still shows its original
    //   number rather than being silently renumbered away — see
    //   manualRemovePlayerFromRoster).
    //   classificationSourcePlayerId: set only when a slot has been
    //   manually replaced — the playerId whose ORIGINAL playerDraftPicks
    //   record getPlayerClassificationInfo should use for this entry's
    //   Red/Yellow tag instead of the current occupant's own playerId (who
    //   was never personally drafted). Chained across repeated
    //   replacements so the tag traces back to the slot's true original
    //   draft pick. Absent on every entry that has never been manually
    //   replaced — normal draft/trade/swap classification is completely
    //   unaffected.
    currentRosters: {},   // { [participantId]: [{ playerId, source }] }

    /**
   * Rule C (revised): ordinarily designates one of a participant's own
   * picks #1-10 as their Joker (PINK). A second Joker is permitted only
   * when the first four chronological picks are Green; ordinary designation
   * still rejects a third. The explicit manualRosterEdit option skips Joker
   * gameplay eligibility/count restrictions only for PIN-gated manual edits.
   * Designating another eligible player preserves existing Joker flags. The player's original
   * draft history (playerDraftPicks) is untouched, and their original
   * Red/Yellow classification (picks #1-2 / #3-5) is simply overridden by
   * PINK while they remain the Joker — see getPlayerClassificationInfo.
   *
   * options.bypassRosterRules (Revision 3 — Manual Roster Edit coexistence,
   * default false): when true, skips the resulting-position check below
   * (the same "Position requirements"/"Position completion" family of
   * normal roster rules Manual Roster Edit already bypasses in
   * manualAddPlayerToRoster/manualReplacePlayerOnRoster). Set ONLY by
   * js/admin/roster.js's Joker Swap entry point inside the PIN-gated
   * manual editor. admin/trades.js's ordinary Joker tab calls this with no
   * options, so normal Joker designation is completely unaffected. This is
   * options.allowSecondJokerManual (default false) skips only the
   * first-four-Green second-Joker restriction. It is set only by the
   * PIN-gated Manual Roster Edit flow after the user confirms. A third Joker
   * remains prohibited for every caller. options.bypassRosterRules affects
   * only the resulting-position check. options.captureJokerOriginalPosition
   * records the pre-designation effective position for safe Manual Roster
   * Edit removal; ordinary designation does not add this field.
   */
  designateJoker(seasonId, participantId, playerId, jokerPosition, options = {}) {
    if (!jokerPosition) throw new Error("A Joker requires an assigned roster position.");
    const data = loadData(seasonId);
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    if (!season.rostersInitialized) throw new Error("Rosters must be initialized before designating a Joker.");
    ensureRosterDraftSlots(season); // backfill for seasons predating "Preserve Original Draft Pick Slot"

    const roster = season.currentRosters[participantId];
    const entry = roster && roster.find((e) => e.playerId === playerId);
    if (!entry) throw new Error("Player is not currently on this participant's roster.");

    // Own-pick eligibility is read from the roster entry's CURRENT
    // draftSlot (see getJokerEligiblePlayers), not from the immutable
    // playerDraftPicks history, so a manually-added player filling one of
    // this participant's own vacated pick slots #1-10 is eligible too —
    // matching what getJokerEligiblePlayers already offers as eligible.
    // Revision — Joker Eligibility for Plain Manual Additions: a plain
    // "+ Add Player" entry (source "manual", draftSlot null — no slot to
    // inherit at all) is ALSO eligible now, via the same
    // isJokerEligibleRosterEntry rule getJokerEligiblePlayers uses, so
    // the 🃏 button and this check can never disagree.
    if (!options.manualRosterEdit && !isJokerEligibleRosterEntry({ ownPickNumber: entry.draftSlot, source: entry.source, draftSlot: entry.draftSlot })) {
      throw new Error(
        "Joker must be one of this participant's own picks #1-10, or a manually added player."
      );
    }

    const existingJokers = roster.filter((e) => e.isJoker).length;
    if (!options.manualRosterEdit && !entry.isJoker && existingJokers >= 2) {
      throw new Error("A participant may have at most two Jokers.");
    }
    if (!options.manualRosterEdit && !entry.isJoker && existingJokers === 1) {
      const participantPicks = (season.playerDraftPicks || [])
        .filter((pick) => pick.participantId === participantId);
      const firstFourAreGreen = participantPicks.length >= 4 && participantPicks
        .slice(0, 4)
        .every((pick) => data.players[pick.playerId]?.pool === "green");
      if (!firstFourAreGreen) {
        throw new Error("A second Joker is allowed only when the participant's first four picks are all Green Pool players.");
      }
    }

    const player = data.players[playerId];
    const afterEntries = roster.map((e) => {
      if (e.playerId !== playerId) return { ...e };
      const updated = { ...e, isJoker: true, jokerPosition };
      // Only the PIN-gated manual editor captures the pre-Joker assigned
      // position. Legacy entries remain unknown; removal asks for explicit
      // confirmation before using the player's canonical position as fallback.
      if (!e.isJoker && options.captureJokerOriginalPosition) {
        updated.jokerOriginalPosition = e.rosterPosition || getEffectivePosition(e, player);
      }
      return updated;
    });
    if (!options.bypassRosterRules) {
      const posCheck = validateResultingPositions(roster, afterEntries, data.players);
      if (!posCheck.valid) throw new Error(posCheck.reason);
    }

    season.currentRosters[participantId] = afterEntries;



    saveData(data);
  },

  /** Removes a Joker only for Manual Roster Edit, restoring its saved position. */
  manualRemoveJoker(seasonId, participantId, playerId, options = {}) {
    const data = loadData(seasonId);
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    if (!season.rostersInitialized) throw new Error("Rosters must be initialized before removing a Joker.");
    const roster = season.currentRosters?.[participantId];
    const entry = roster?.find((e) => e.playerId === playerId);
    if (!entry || !entry.isJoker) throw new Error("Player is not currently designated as a Joker.");
    const savedPosition = entry.jokerOriginalPosition;
    if (!savedPosition && !options.confirmedFallback) {
      throw new Error("Original position is unknown. Confirm removal to restore the player's canonical position as a fallback.");
    }
    const restoredPosition = savedPosition || data.players[playerId]?.position;
    if (!CORE_POSITIONS.includes(restoredPosition)) {
      throw new Error("Cannot remove this Joker because no valid canonical fallback position is available.");
    }

    season.currentRosters[participantId] = roster.map((e) => {
      if (e.playerId !== playerId) return { ...e };
      const restored = { ...e };
      delete restored.isJoker;
      delete restored.jokerPosition;
      delete restored.jokerOriginalPosition;
      restored.rosterPosition = restoredPosition;
      return restored;
    });
    saveData(data);
  },

  // ── Revision 2/3: Manual Roster Edit — commissioner override mode ───────
  //
  // A restricted, PIN-gated administrative capability (see
  // js/admin/roster.js — reuses the same _DELETE_ALL_PLAYERS_PIN check
  // js/admin/players.js's Delete All Players already uses, rather than a
  // second PIN) for correcting roster assignments without the full Phase 5
  // trade/swap workflow.
  //
  // Revision 3 — Override normal roster/game rules: manualAddPlayerToRoster
  // and manualReplacePlayerOnRoster are reachable ONLY from the PIN-gated
  // Manual Roster Edit UI (js/admin/roster.js — no other call site exists),
  // so they intentionally do NOT run the normal Phase 5 roster/game-rule
  // validators (validateResultingPositions, validateBlueComposition,
  // validateMinimumRating, validateRatingCap). The commissioner is meant to
  // be able to write a roster state that a normal trade/swap/draft pick
  // could NOT have produced, in order to correct a bad roster. Normal
  // drafting (makeDraftPick), trades/swaps (commitTrade/commitSwap/
  // evaluateSwap), and Joker designation from the ordinary Joker tab
  // (designateJoker with no options) are untouched and still enforce every
  // rule exactly as before — only these two manual-edit entry points bypass
  // them.
  //
  // What is NEVER bypassed, in any of the three operations below, because
  // it is basic data integrity rather than a league/game rule:
  //   - duplicate ownership (findCurrentRosterEntry — a player can't be
  //     assigned to two different teams at once)
  //   - player identity (the playerId must resolve to a real player record)
  //   - Firestore/document structure, auth, and the PIN gate itself
  // "Available" is never a separately stored list — exactly like
  // current roster ownership checks already does for Phase 5, a player is
  // available the instant they are absent from every entry of every
  // season.currentRosters[*] array, and unavailable the instant they're
  // present in one. Player ID (never name) is the identity used
  // throughout, so this works unchanged for Green, Blue, Classics,
  // All-Time, or any future imported pool — pool membership/size is never
  // hard-coded here.

  /**
   * Manually assigns a currently-unowned player onto a participant's
   * roster. The player leaves the available pool the moment this write
   * lands, because "available" is derived from currentRosters membership,
   * not tracked separately.
   *
   * targetDraftSlot (optional): when provided, fills that specific
   * vacated original draft-pick slot (an 'empty' placeholder entry left by
   * manualRemovePlayerFromRoster — see that function) in place, so the
   * new player inherits the original draft-pick slot number rather than
   * being appended as a brand-new, slot-less entry. Omit it to append a
   * genuinely new roster entry with no original draft slot (draftSlot:
   * null) — e.g. when there is no vacancy to fill.
   */
  manualAddPlayerToRoster(seasonId, participantId, playerId, targetDraftSlot = null) {
    const data = loadData(seasonId);
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    if (!season.rostersInitialized) {
      throw new Error("Rosters must be initialized (post-draft) before manual roster editing.");
    }
    ensureRosterDraftSlots(season, participantId);
    ensureRosterDisplayPickNumbers(season, participantId);
    if (!season.participants[participantId]) throw new Error("Participant not found.");
    const player = data.players[playerId];
    if (!player) throw new Error("Player not found.");

    const owner = findCurrentRosterEntry(season, playerId);
    if (owner) {
      const ownerName = season.participants[owner.participantId]?.name || "another team";
      throw new Error(`${player.name} is already on ${ownerName}'s roster — cannot be assigned twice.`);
    }

    const roster = (season.currentRosters[participantId] || []).slice();
    const activePlayerCount = roster.filter(entry => entry.source !== "empty" && entry.playerId).length;
    if (targetDraftSlot == null) {
      const vacancy = roster
        .filter(entry => entry.source === "empty" && Number.isInteger(entry.draftSlot))
        .sort((a, b) => a.draftSlot - b.draftSlot)[0];
      if (vacancy) targetDraftSlot = vacancy.draftSlot;
      else if (activePlayerCount >= 10) throw new Error("This roster is full (10 players).");
    }
    let afterEntries;
    if (targetDraftSlot != null) {
      const slotIndex = roster.findIndex((e) => e.source === "empty" && e.draftSlot === targetDraftSlot);
      if (slotIndex === -1) {
        throw new Error(`Draft slot #${targetDraftSlot} is not an open vacancy on this roster.`);
      }
      const vacatedEntry = roster[slotIndex];
      afterEntries = roster.slice();
      // Inherit the vacancy's classification anchor (if any) so refilling
      // an emptied slot restores its Red/Yellow tag exactly like a direct
      // Replace would — see getPlayerClassificationInfo.
      const inheritedClassificationSource = vacatedEntry.classificationSourcePlayerId ?? null;
      afterEntries[slotIndex] = {
        playerId, source: "signed", draftSlot: targetDraftSlot, displayPickNumber: targetDraftSlot,
        ...(inheritedClassificationSource ? { classificationSourcePlayerId: inheritedClassificationSource } : {}),
      };
    } else {
      const displayPickNumber = nextManualRosterDisplayPickNumber(roster);
      if (displayPickNumber == null) throw new Error("This roster is full (10 players).");
      afterEntries = [...roster, { playerId, source: "signed", draftSlot: null, displayPickNumber }];
    }

    // Revision 3 — Manual Override: normal roster/game rules (position
    // requirements, Blue/Green composition, minimum rating, rating cap)
    // are intentionally NOT enforced here — see the Revision 2/3 header
    // comment above. Duplicate-ownership was already rejected above via
    // findCurrentRosterEntry, and `player` above already confirms the
    // playerId resolves to a real record — both are data integrity, not a
    // game rule, and remain enforced unconditionally.

    season.currentRosters[participantId] = afterEntries;



    saveData(data);
  },

  /** Assign a free agent or atomically transfer an owned player to a roster.
   * The draft history is deliberately untouched; filling a vacancy retains
   * that existing slot number without creating a draft-pick record. */
  manualSignPlayerToRoster(seasonId, participantId, playerId, transfer = false, targetDraftSlot = null, expectedOwnerId = null) {
    const data = loadData(seasonId);
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    if (!season.rostersInitialized) throw new Error("Rosters must be initialized before signing players.");
    ensureRosterDraftSlots(season, participantId);
    ensureRosterDisplayPickNumbers(season, participantId);
    if (!season.participants[participantId]) throw new Error("Participant not found.");
    const player = data.players[playerId];
    if (!player) throw new Error("Player not found.");

    const owner = findCurrentRosterEntry(season, playerId);
    if (owner && !transfer) {
      const ownerName = season.participants[owner.participantId]?.name || "another participant";
      throw new Error(`${player.name} already belongs to ${ownerName}. Confirm Transfer & Sign to move them.`);
    }
    if (owner?.participantId === participantId) throw new Error(`${player.name} is already on this roster.`);
    if (transfer) {
      if (!owner || !expectedOwnerId || owner.participantId !== expectedOwnerId) {
        throw new Error("The selected player's current owner changed. Reopen the transfer confirmation and try again.");
      }
      const activeAssignments = Object.entries(season.currentRosters || {}).flatMap(([pid, entries]) =>
        entries.filter(e => e.source !== "empty" && e.playerId === playerId).map(() => pid));
      if (activeAssignments.length !== 1 || activeAssignments[0] !== expectedOwnerId) {
        throw new Error(`${player.name} has inconsistent active roster ownership. Resolve that roster conflict before transferring.`);
      }
    }

    const destination = (season.currentRosters[participantId] || []).slice();
    const activePlayerCount = destination.filter(entry => entry.source !== "empty" && entry.playerId).length;
    if (targetDraftSlot == null) {
      const vacancy = destination
        .filter(entry => entry.source === "empty" && Number.isInteger(entry.draftSlot))
        .sort((a, b) => a.draftSlot - b.draftSlot)[0];
      if (vacancy) targetDraftSlot = vacancy.draftSlot;
      else if (activePlayerCount >= 10) throw new Error("This roster is full (10 players).");
    }
    let insertionIndex = destination.length;
    if (targetDraftSlot != null) {
      insertionIndex = destination.findIndex(e => e.source === "empty" && e.draftSlot === targetDraftSlot);
      if (insertionIndex < 0) throw new Error(`Draft slot #${targetDraftSlot} is not an open vacancy on this roster.`);
    }
    const inheritedClassificationSource = targetDraftSlot != null
      ? destination[insertionIndex].classificationSourcePlayerId ?? null
      : null;
    // Player existence, requested vacancy, and active ownership are checked
    // before mutation. Roster compliance remains the separate Validate Rosters action.
    if (owner) {
      const oldRoster = (season.currentRosters[owner.participantId] || []).slice();
      const oldIndex = oldRoster.findIndex(e => e.playerId === playerId);
      const oldEntry = oldRoster[oldIndex];
      if (oldEntry.draftSlot != null) {
        oldRoster[oldIndex] = { source: "empty", playerId: null, draftSlot: oldEntry.draftSlot,
          classificationSourcePlayerId: oldEntry.classificationSourcePlayerId ?? oldEntry.playerId };
      } else oldRoster.splice(oldIndex, 1);
      season.currentRosters[owner.participantId] = oldRoster;
    }
    const transferSource = owner
      ? (owner.entry.source === "manual" ? "signed" : owner.entry.source)
      : "signed";
    const manualDisplayNumber = targetDraftSlot == null ? nextManualRosterDisplayPickNumber(destination) : null;
    if (targetDraftSlot == null && manualDisplayNumber == null) throw new Error("This roster is full (10 players).");
    const signedEntry = { playerId, source: transferSource, draftSlot: targetDraftSlot ?? null,
      displayPickNumber: targetDraftSlot ?? manualDisplayNumber,
      ...(inheritedClassificationSource ? { classificationSourcePlayerId: inheritedClassificationSource } : {}) };
    destination.splice(insertionIndex, 1, signedEntry);
    season.currentRosters[participantId] = destination;

    saveData(data);
  },

  /**
   * Manually removes a player from a participant's roster. This ONLY
   * removes their season.currentRosters entry — it never deletes the
   * player from the global database (js/admin/players.js's Delete
   * Player/Delete All Players is the only thing that does that) — so the
   * player is immediately draftable/assignable again everywhere
   * "available" is derived from currentRosters (current roster ownership checks,
   * the roster display helpers, and this same manual editor).
   *
   * If the removed entry carried an original draftSlot (Revision —
   * Preserve Original Draft Pick Slot), that slot is never simply deleted
   * from the array (which would silently renumber every later entry) —
   * it's replaced in place with an 'empty' placeholder that keeps the same
   * draftSlot, so the vacancy displays as e.g. "Pick #1 — EMPTY" and can
   * later be refilled at that same slot via manualAddPlayerToRoster's
   * targetDraftSlot. A manually-added entry with no original slot
   * (draftSlot: null) has nothing to preserve, so it's removed outright.
   */
  manualRemovePlayerFromRoster(seasonId, participantId, playerId) {
    const data = loadData(seasonId);
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    if (!season.rostersInitialized) {
      throw new Error("Rosters must be initialized (post-draft) before manual roster editing.");
    }
    ensureRosterDraftSlots(season, participantId);
    const roster = season.currentRosters[participantId] || [];
    const idx = roster.findIndex((e) => e.playerId === playerId);
    if (idx === -1) throw new Error("Player is not currently on this participant's roster.");
    const entry = roster[idx];

    const afterEntries = roster.slice();
    if (entry.draftSlot != null) {
      // Carry the vacancy's classification anchor forward too — whichever
      // player's original draft record this slot's Red/Yellow tag should
      // trace back to (itself, if never replaced before; or whatever it
      // already inherited, if this is a re-removal of an already-replaced
      // slot) — so a later refill via manualAddPlayerToRoster's
      // targetDraftSlot can restore the tag exactly as a direct Replace
      // would. See getPlayerClassificationInfo.
      const classificationSourcePlayerId = entry.classificationSourcePlayerId ?? entry.playerId;
      afterEntries[idx] = {
        source: "empty", playerId: null, draftSlot: entry.draftSlot, classificationSourcePlayerId,
      };
    } else {
      afterEntries.splice(idx, 1);
    }
    season.currentRosters[participantId] = afterEntries;

    const player = data.players[playerId];


    saveData(data);
  },

  /**
   * Manually replaces one roster player with a currently-unowned one, in
   * a single atomic write — equivalent to remove + add, but validated as
   * one operation so an in-between invalid state is never possible (and
   * never persisted, since either the whole write happens or an Error is
   * thrown before saveData is called).
   *
   * The replacement is written in place at the outgoing entry's own array
   * position and inherits its draftSlot unchanged (Revision — Preserve
   * Original Draft Pick Slot): the draft-pick slot belongs to the roster
   * slot being replaced, never to the specific player variant occupying
   * it, so a Blue↔Green (or any) swap never loses, renumbers, or invents a
   * pick number — this works identically whether the outgoing player was
   * originally drafted (draftSlot set) or was themselves a slot-less
   * manual addition (draftSlot: null, and it stays null after the swap).
   *
   * It also inherits a classificationSourcePlayerId (Revision — Preserve
   * Trade/Swap Red Tag): whichever playerId's ORIGINAL draft record this
   * slot's Red/Yellow tag should be read from (see
   * getPlayerClassificationInfo), defaulting to the OUTGOING player's own
   * id the first time a slot is ever replaced, and chained forward
   * unchanged on every replacement after that — so the tag always traces
   * back to whoever was truly drafted into this slot, no matter how many
   * times it's since been manually replaced. isJoker/jokerPosition are
   * deliberately NOT carried over: Joker is a designation earned by the
   * specific player who holds it (see designateJoker's own eligibility
   * check), not a property of the slot, so a replacement is never
   * accidentally made a Joker just by occupying a Joker's old spot.
   */
  manualReplacePlayerOnRoster(seasonId, participantId, outgoingPlayerId, incomingPlayerId, options = {}) {
    const data = loadData(seasonId);
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    if (!season.rostersInitialized) {
      throw new Error("Rosters must be initialized (post-draft) before manual roster editing.");
    }
    ensureRosterDraftSlots(season, participantId);
    ensureRosterDisplayPickNumbers(season, participantId);
    if (outgoingPlayerId === incomingPlayerId) {
      throw new Error("Outgoing and incoming player cannot be the same.");
    }

    const roster = season.currentRosters[participantId] || [];
    const idx = roster.findIndex((e) => e.playerId === outgoingPlayerId);
    if (idx === -1) throw new Error("Outgoing player is not currently on this participant's roster.");
    const outEntry = roster[idx];

    const incomingPlayer = data.players[incomingPlayerId];
    if (!incomingPlayer) throw new Error("Incoming player not found.");
    const owner = findCurrentRosterEntry(season, incomingPlayerId);
    const isTransfer = !!options.transferOwnerId;
    if (owner && (!isTransfer || owner.participantId !== options.transferOwnerId)) {
      const ownerName = season.participants[owner.participantId]?.name || "another team";
      throw new Error(`${incomingPlayer.name} is already on ${ownerName}'s roster — cannot be assigned twice.`);
    }
    if (isTransfer && (!owner || owner.participantId === participantId)) {
      throw new Error("The selected player is no longer owned by the participant shown in the transfer confirmation.");
    }

    if (isTransfer) {
      const assignments = Object.entries(season.currentRosters || {}).flatMap(([pid, entries]) =>
        entries.filter(e => e.source !== "empty" && e.playerId === incomingPlayerId).map(() => pid));
      if (assignments.length !== 1 || assignments[0] !== options.transferOwnerId) {
        throw new Error(`${incomingPlayer.name} has inconsistent active roster ownership. Resolve that roster conflict before transferring.`);
      }
    }

    const preservedDraftSlot = outEntry.draftSlot ?? null;
    const preservedDisplayPickNumber = outEntry.displayPickNumber ?? preservedDraftSlot;
    const classificationSourcePlayerId = outEntry.classificationSourcePlayerId ?? outgoingPlayerId;
    const afterEntries = roster.slice();
    const replacementSource = owner
      ? (owner.entry.source === "manual" ? "signed" : owner.entry.source)
      : "signed";
    afterEntries[idx] = {
      playerId: incomingPlayerId, source: replacementSource, draftSlot: preservedDraftSlot,
      displayPickNumber: preservedDisplayPickNumber, classificationSourcePlayerId,
    };

    // Ownership integrity remains enforced here; roster-rule checks are
    // intentionally left to the independent Validate Rosters action.

    if (isTransfer) {
      const ownerRoster = (season.currentRosters[owner.participantId] || []).slice();
      const ownerIndex = ownerRoster.findIndex(e => e.playerId === incomingPlayerId);
      const ownerEntry = ownerRoster[ownerIndex];
      if (ownerEntry.draftSlot != null) {
        ownerRoster[ownerIndex] = {
          source: "empty", playerId: null, draftSlot: ownerEntry.draftSlot,
          classificationSourcePlayerId: ownerEntry.classificationSourcePlayerId ?? ownerEntry.playerId,
        };
      } else ownerRoster.splice(ownerIndex, 1);
      season.currentRosters[owner.participantId] = ownerRoster;
    }
    season.currentRosters[participantId] = afterEntries;

    const outgoingPlayer = data.players[outgoingPlayerId];


    saveData(data);
  },

  // ── Player Database ────────────────────────────────────────────────────────

  addPlayer({ name, position, overall, pool, variantGroup, nba2kRef }) {
    const data = loadData();
    const id = generateId("pl");
    const player = createPlayer(id, { name, position, overall, pool, variantGroup, nba2kRef });
    data.players[id] = player;
    saveData(data);
    return player;
  },

  updatePlayer(playerId, fields) {
    const data = loadData();
    if (!data.players[playerId]) throw new Error("Player not found");
    Object.assign(data.players[playerId], fields);
    saveData(data);
  },

  deletePlayer(playerId) {
    const data = loadData();
    if (!data.players[playerId]) throw new Error("Player not found");
    delete data.players[playerId];
    saveData(data);
  },

  /**
   * Deletes every player from the global player database ONLY.
   * Reuses the existing load-mutate-save-whole-document pattern (see the
   * Storage section above) — every other top-level key on `data`
   * (seasons, settings, etc.) is loaded and re-saved completely
   * untouched, so seasons/participants/draft history/rosters/standings/
   * schedules are never affected by this call.
   *
   * Callers (see AdminPlayersView._confirmDeleteAllPlayers in
   * admin/players.js) are responsible for the destructive-action
   * confirmation flow — this function performs the deletion with no
   * further checks beyond the caller having already passed
   * AuthBoundary.requireAuth().
   *
   * Returns the number of players that were deleted.
   */
  deleteAllPlayers() {
    const data = loadData();
    const count = Object.keys(data.players).length;
    data.players = {};
    saveData(data);
    return count;
  },

  /**
   * Import players from parsed CSV rows.
   *
   * Column headers are matched case-insensitively and with surrounding
   * whitespace trimmed, so "Name", "name", "NAME", and " Name " all
   * match. A small alias list also covers common variants like
   * "Player Name" for the name column. See FIELD_ALIASES below for the
   * exact list of recognized header text per field.
   *
   * Duplicate validation (against normalizePlayerName — see that
   * function for why `name` is the player identity):
   *   - a row whose normalized name matches a player already in the
   *     database is skipped and reported under skippedExistingNames
   *   - a row whose normalized name matches an EARLIER row in this same
   *     CSV (e.g. "Stephen Curry" listed twice) is skipped and reported
   *     under skippedDuplicateInCsvNames — only the first occurrence is
   *     imported
   * Both checks run against the full in-memory data set loaded at the
   * start of this call and are applied synchronously before saveData()
   * writes the single Firestore document back, so there's no window for
   * a second in-flight import in the same tab to race this one; see the
   * Storage section above for the accepted last-write-wins risk across
   * two admins saving at literally the same moment (unchanged/pre-existing).
   *
   * Returns { imported, skippedExisting, skippedDuplicateInCsv,
   *   skippedInvalid, skipped, skippedExistingNames,
   *   skippedDuplicateInCsvNames, errors, notes }
   * `skipped` is the sum of the three skip counts, kept for callers that
   * only care about a total.
   */
  importPlayersFromCSV(rows) {
    const data = loadData();
    let imported = 0;
    let skippedExisting = 0;
    let skippedDuplicateInCsv = 0;
    let skippedInvalid = 0;
    const errors = [];
    const notes = [];
    const skippedExistingNames = [];
    const skippedDuplicateInCsvNames = [];

    // Identities already in the database before this import started.
    const existingNames = new Set(
      Object.values(data.players).map((p) => normalizePlayerName(p.name))
    );
    // Identities accepted so far from THIS CSV — separate from
    // existingNames so a name that's new-to-the-database but repeated
    // within the file is correctly reported as "duplicate in CSV"
    // rather than "already exists".
    const seenInThisImport = new Set();

    // Recognized header text per field, already lowercase/trimmed —
    // matched against normalized (lowercased + trimmed) CSV headers.
    const FIELD_ALIASES = {
      name: ["name", "player name", "player"],
      position: ["position", "pos"],
      overall: ["overall", "ovr", "rating"],
      pool: ["pool"],
      variantGroup: ["variantgroup", "variant group", "group", "identity"],
    };

    const getField = (normalizedRow, field) => {
      for (const alias of FIELD_ALIASES[field]) {
        if (normalizedRow[alias] !== undefined) return normalizedRow[alias];
      }
      return "";
    };

    for (const row of rows) {
      try {
        // Normalize this row's headers once: lowercase + trim every key
        // so lookups below don't need to guess casing or spacing.
        const normalizedRow = {};
        for (const key in row) {
          normalizedRow[key.toLowerCase().trim()] = row[key];
        }

        const name = String(getField(normalizedRow, "name") || "").trim();
        const position = String(getField(normalizedRow, "position") || "").trim().toUpperCase();
        const overall = parseInt(getField(normalizedRow, "overall"), 10);

        // pool: only 'green' or 'blue' are recognized. Anything else
        // (including blank) is left undefined — never guessed. An
        // unrecognized non-blank value is reported as a soft note but
        // does not skip the row.
        const rawPool = String(getField(normalizedRow, "pool") || "").trim().toLowerCase();
        let pool;
        if (rawPool === "green" || rawPool === "blue") {
          pool = rawPool;
        } else if (rawPool) {
          notes.push(`Note on "${name || "row"}": pool value "${rawPool}" not recognized (expected green/blue) — left unassigned.`);
        }

        // variantGroup: free-text identifier, used as-is (trimmed). Never
        // inferred from name/position/overall — blank stays undefined.
        const variantGroup = String(getField(normalizedRow, "variantGroup") || "").trim() || undefined;

        if (!name) { skippedInvalid++; continue; }
        if (isNaN(overall)) { errors.push(`Skipped "${name}": invalid overall`); skippedInvalid++; continue; }

        const key = normalizePlayerName(name);

        if (existingNames.has(key)) {
          skippedExisting++;
          skippedExistingNames.push(name);
          continue;
        }
        if (seenInThisImport.has(key)) {
          skippedDuplicateInCsv++;
          skippedDuplicateInCsvNames.push(name);
          continue;
        }

        const id = generateId("pl");
        data.players[id] = createPlayer(id, { name, position, overall, pool, variantGroup });
        seenInThisImport.add(key);
        imported++;
      } catch (e) {
        errors.push(`Row error: ${e.message}`);
        skippedInvalid++;
      }
    }

    saveData(data);
    return {
      imported,
      skippedExisting,
      skippedDuplicateInCsv,
      skippedInvalid,
      skipped: skippedExisting + skippedDuplicateInCsv + skippedInvalid,
      skippedExistingNames,
      skippedDuplicateInCsvNames,
      errors,
      notes,
    };
  },

  // Dev/debug only — wipe all data (Firestore doc + local cache)
  _resetAllData() {
    const fresh = getDefaultData();
    saveData(fresh);
  },
};

// Freeze public API to prevent accidental mutation
Object.freeze(LeagueData);