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
    // length of playerDraftPicks at the moment the skip happened. Together
    // with playerDraftPicks this lets computeDraftSchedule() below replay
    // the full chronological sequence of turns (picks interleaved with
    // skips) to figure out whose turn it is now, purely by derivation —
    // same "nothing stored, everything computed on read" philosophy
    // getDraftState already used before this revision.
    draftSkips: [],   // [{ participantId, round, afterPickCount, timestamp }]

    // Explicit, human-readable record of each participant's pending
    // future double-pick entitlement (see computeDraftSchedule) —
    // { [participantId]: number }. This is a materialized snapshot of
    // what computeDraftSchedule already derives from draftSkips/
    // playerDraftPicks on every read; it is kept in sync by
    // AdminActions.skipDraftPick/makeDraftPick/undoLastDraftPick purely
    // so the entitlement is visible as its own named piece of state
    // (rather than only implied by replaying history), per Revision 1's
    // explicit requirement not to represent this as a bare turn-index
    // manipulation. computeDraftSchedule's own replay remains the
    // authoritative source of truth for whose turn it is.
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
    // currentRosters[participantId] = [{ playerId, source, isJoker?, jokerPosition?, draftSlot? }]
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

    // ── Phase 5: Trading / Swap System ──────────────────────────────────────
    // pot: running total of all trade/swap/10th-pick-Blue fees collected this
    //   season (₱). Only ever incremented, only inside a successful atomic
    //   commit — never on a failed/rejected transaction.
    // currentSeasonDay: manual, commissioner-set integer (NOT derived from the
    //   calendar). Drives the Day 9-11 fee-doubling and Day 12-13 lockout
    //   rules. Independent of `status` above.
    // transactions: permanent, append-only history of every successful trade,
    //   swap, Joker designation, and 10th-pick-Blue fee. Never edited or
    //   removed. Original draft history (playerDraftPicks) is never rewritten
    //   by any Phase 5 action — trades/swaps only ever mutate currentRosters.
    pot: 0,
    currentSeasonDay: 1,
    transactions: [],

    // ── Financial Management (F1 — schema only) ──────────────────────────────
    // Season-specific financial configuration. Entirely separate from `pot`/
    // `transactions` above (Phase 5's existing trade/swap fee system, left
    // untouched by F1) — this is the foundation for the new Financial
    // Management system being built in later phases (F2+). Nothing yet reads
    // this field; AdminActions.createSeason accepts optional overrides at
    // creation time (see below), and old seasons safely lack this field
    // until ensureFinancialFields() backfills it, matching the
    // ensureTransactionFields() pattern above.
    financialSettings: {
      entryFee: 300,
      freeTrades: 2,
      freeSwaps: 2,
    },

    // ── Phase 7: Regular Season Schedule ──────────────────────────────────────
    // schedule[i] = { round: Number, matchups: [Matchup] }
    // Matchup = {
    //   id, teamA, teamB,        // teamA/teamB are participantIds (or teamB
    //                             // is null for a BYE — see generateSchedule)
    //   status,                  // 'scheduled' | 'completed'
    //   scoreA, scoreB, winner,  // winner is participantId, always derived
    //   streamer,                // free-text string, set at score-entry time
    //   playedAt,                // ISO string, set when the result is saved
    //   stage, group,            // Group Stage only (see below) — absent/
    //                            // undefined on every Round Robin matchup,
    //                            // so nothing that reads a Matchup needs to
    //                            // change for Round Robin to keep working.
    //                            // stage: 1 | 2. group: 'A'|'B'|'C'|'D'.
    //   home, away,              // Group Stage only — explicit home/away
    //                            // participantIds (see assignRound1HomeCourt/
    //                            // assignRound2HomeCourt below). Absent on
    //                            // every Round Robin matchup and on BYEs —
    //                            // the existing Round Robin format has no
    //                            // home-court concept and is untouched.
    // }
    // NBA team abbreviation is intentionally NOT stored here — look it up via
    // season.nbaTeamAssignments[participantId] (single source of truth,
    // see Process 2 above) rather than duplicating it onto the matchup.
    schedule: [],
    scheduleGeneratedAt: null, // ISO string, set each time generateSchedule() runs

    // Which scheduler produced season.schedule — 'roundRobin' (default/
    // legacy, every existing season implicitly means this) or 'groupStage'
    // (Revision — Group Stage format). Every reader of season.schedule
    // (getScheduleState, getTeamStatistics, getStreamerStatistics,
    // recordMatchResult, playoffs) works identically regardless of this
    // value — it only matters to the schedule UI (which display/generate
    // flow to show) and to recordMatchResult's Round-1-lock guard below.
    scheduleFormat: null, // null until a schedule is generated; 'roundRobin' | 'groupStage'

    // Group Stage-only bookkeeping — null for a Round Robin season (or any
    // season before a schedule is generated). Never read by anything
    // outside the Group Stage generation/display code; the actual games
    // always live in `schedule` above, in the exact same Matchup shape
    // Round Robin uses, so every other system (standings, streamers,
    // playoffs, financial) is unaffected by whichever format produced them.
    //   groups: { A: [participantId x4], B: [...], C: [...], D: [...] } —
    //     Round 1's group assignment, frozen at generation time.
    //   stage: 1 | 2 — which stage is currently in play / most recently generated.
    //   round1Standings: null until Round 2 is generated, then
    //     { A: [participantId x4 in finish order 1st..4th], B: [...], ... } —
    //     frozen the moment Round 2 is generated. Informational/audit only
    //     (Revision — Manual Online-Roulette Assignment: Round 2 group
    //     membership is no longer derived from this) — it records what
    //     Round 1 standings looked like at the moment the commissioner ran
    //     the roulette and generated Round 2, nothing more.
    //   round2Groups: null until Round 2 is generated, then the same shape
    //     as `groups` above, but holding the commissioner's manually
    //     entered Round 2 assignment (the external roulette result) —
    //     never computed by this app from round1Standings.
    groupStageState: null,

    // Reserved for Phase 8 (e.g. precomputed standings snapshots).
    // Completed matchups already carry their full result inline in
    // `schedule`, so this stays empty in Phase 7 to avoid a second
    // source of truth for the same facts.
    results: [],

    // ── Phase 9: Playoffs ──────────────────────────────────────────────────────
    // See PLAYOFF_ROUND1_PAIRS / buildPlayoffs() below for the exact shape.
    // Entirely separate from `schedule`/`results` (Phase 7) — a playoff game
    // is never written into the regular-season structure, and Phase 8's
    // standings never read from here.
    playoffs: null, // null until AdminActions.generatePlayoffs() runs
  };
}

/**
 * Creates a new participant object within a season.
 *
 * NBA team assignment is intentionally NOT stored here. The single
 * source of truth for "which NBA team does this participant have" is
 * season.nbaTeamAssignments[participantId] — look it up there (or via
 * LeagueData.getNBATeamAssignments) rather than adding a second field.
 */
function createParticipant(id, name) {
  return {
    id,
    name,
  };
}

/**
 * Phase 4B: Computes which of the five core positions a participant has
 * already filled, from their draft picks so far.
 *
 * Shared by LeagueData.getPositionState (read, for UI display) and
 * AdminActions.makeDraftPick (write-time enforcement) so the two can
 * never disagree — both call this same function against the same
 * already-loaded season/players data.
 *
 * A pick only counts toward a slot if the picked player's `position` is
 * exactly one of CORE_POSITIONS. A player with a missing or non-standard
 * position does not fill any slot (see makeDraftPick for how that
 * interacts with the mandatory-first-five rule).
 */
function computePositionState(season, playersById, participantId) {
  const filled = {};
  CORE_POSITIONS.forEach((pos) => { filled[pos] = false; });

  const picks = season.playerDraftPicks.filter(
    (p) => p.participantId === participantId
  );
  for (const pick of picks) {
    const player = playersById[pick.playerId];
    if (player && CORE_POSITIONS.includes(player.position)) {
      filled[player.position] = true;
    }
  }

  const missing = CORE_POSITIONS.filter((pos) => !filled[pos]);
  return { filled, missing, allFilled: missing.length === 0 };
}

// ─── Phase 5: Trading / Swap System ───────────────────────────────────────
//
// Two independent classification systems (never merged into one "color"):
//   pool             — 'green' | 'blue' (already existed, Phase 4B)
//   pick classification — 'RED' | 'YELLOW' | 'PINK' (Joker) | null (6th+ pick,
//                          not designated Joker) — derived, never stored,
//                          computed fresh from the immutable playerDraftPicks
//                          record plus the player's current currentRosters
//                          entry (for isJoker). Trading a player changes who
//                          currently owns them; it never changes this.
//
// All amounts are in ₱ (pesos), matching the league's Discord rules.

const BLUE_MIN_RATING = 84;
const GREEN_MIN_RATING = 75;
const MAX_BLUE_PLAYERS = 5;
const MAX_FIRST_THREE_BLUE_TOTAL = 380;
const MAX_FOURTH_BLUE_RATING = 99;
const MAX_TENTH_PICK_BLUE_RATING = 94;
const TENTH_PICK_BLUE_FEE = 100;
const MAX_PLAYERS_PER_POSITION = 2;
const MAX_ROSTER_SIZE = 10; // 5 core positions x 2 max — enforced at draft time too, not just Phase 5 transactions
const POOL_TRADE_FEE = { green: 100, blue: 200 };
const REGULAR_SWAP_FEE = 100;
const JOKER_SWAP_FEE = 300;
const TRADE_FEE_DOUBLE_DAYS = [9, 10, 11];
const TRANSACTIONS_LOCKED_DAYS = [12, 13];

/**
 * Finds a player's ORIGINAL draft pick record and where it falls in the
 * chronological sequence of picks made by the participant who originally
 * drafted them (never the current owner — ownership changes via trades
 * never touch playerDraftPicks, which stays the permanent historical
 * record). Returns null if the player was never drafted (shouldn't happen
 * for anything reachable via currentRosters, but guarded defensively).
 *
 * ownPickNumber is 1-based: the participant's own 1st, 2nd, 3rd... pick —
 * NOT the global round/pick number playerDraftPicks already stores. This
 * is what Red/Yellow classification and the Joker/10th-pick-Blue windows
 * are actually defined against ("their 5th pick", "the 10th pick").
 */
function getOriginalPickInfo(season, playerId) {
  const pickRecord = season.playerDraftPicks.find((p) => p.playerId === playerId);
  if (!pickRecord) return null;
  const ownPicks = season.playerDraftPicks.filter(
    (p) => p.participantId === pickRecord.participantId
  );
  const ownPickNumber = ownPicks.findIndex((p) => p.playerId === playerId) + 1;
  return {
    originalOwnerId: pickRecord.participantId,
    ownPickNumber,
    round: pickRecord.round,
    pick: pickRecord.pick,
  };
}

/** RED = original 1st/2nd pick, YELLOW = original 3rd-5th pick, else null. */
function classifyPickNumber(ownPickNumber) {
  if (ownPickNumber === 1 || ownPickNumber === 2) return "RED";
  if (ownPickNumber === 3 || ownPickNumber === 4 || ownPickNumber === 5) return "YELLOW";
  return null;
}

// ─── Revision 1: Phase 2 Draft Skip — turn schedule derivation ────────────

/** Backfills draftSkips/bonusPicks for seasons created before Revision 1. */
function ensureDraftSkipFields(season) {
  if (!Array.isArray(season.draftSkips)) season.draftSkips = [];
  if (!season.bonusPicks || typeof season.bonusPicks !== "object") season.bonusPicks = {};
}

/**
 * Derives whose turn it is in the live Phase 2 snake draft, accounting
 * for Skip/bonus-double-pick turns, by replaying the full chronological
 * history from scratch every time this is called. Nothing here is
 * stored — same "derived every render" approach getDraftState already
 * used pre-Revision-1 — so a page refresh, an Undo, or a remote Firestore
 * update can never leave a stale turn pointer behind.
 *
 * Model: the base rotation (the existing, UNCHANGED snake formula — odd
 * rounds forward through playerDraftOrder, even rounds reversed) assigns
 * each of n participants exactly one "turn slot" per round, in order,
 * regardless of skips. A turn slot normally resolves with exactly one
 * pick. Skipping a slot resolves it immediately with zero picks and
 * grants that participant a pending bonus; the NEXT time the rotation
 * reaches that same participant's slot, it requires two picks in a row
 * (their normal pick, then the bonus pick) before the rotation advances
 * to the next participant. This is why "the skipped participant's next
 * scheduled turn becomes a double-pick turn" rather than an immediate
 * extra pick — the bonus is only resolved when the base rotation would
 * have given them a turn anyway.
 *
 * playerDraftPicks and draftSkips are merged into one chronological
 * timeline using each skip's afterPickCount (the picks-so-far count at
 * the moment it happened) as the interleave point, then that timeline is
 * consumed turn slot by turn slot.
 */
function computeDraftSchedule(season) {
  const order = season.playerDraftOrder || [];
  const n = order.length;
  const picks = season.playerDraftPicks || [];
  const skips = season.draftSkips || [];

  const bonusPicks = {}; // replayed fresh — see doc comment on season.bonusPicks

  if (n === 0) {
    return {
      turnIndex: 0,
      currentParticipantId: null,
      currentRound: null,
      isBonusTurn: false,
      picksTakenThisTurn: 0,
      picksNeededThisTurn: 1,
      bonusPicks,
    };
  }

  // Merge picks + skips into one chronological timeline. For each point k
  // (0..picks.length), any skip recorded with afterPickCount === k
  // happened right before pick k+1 (or, if k === picks.length, is the
  // most recent event of all).
  const timeline = [];
  let skipCursor = 0;
  for (let k = 0; k <= picks.length; k++) {
    while (skipCursor < skips.length && skips[skipCursor].afterPickCount === k) {
      timeline.push({ type: "skip", participantId: skips[skipCursor].participantId });
      skipCursor++;
    }
    if (k < picks.length) {
      timeline.push({ type: "pick", pick: picks[k] });
    }
  }

  function baseTurnParticipant(turnIndex) {
    const round = Math.floor(turnIndex / n) + 1;
    const posInRound = turnIndex % n;
    const isEvenRound = round % 2 === 0;
    const orderIndex = isEvenRound ? n - 1 - posInRound : posInRound;
    return { participantId: order[orderIndex], round };
  }

  let turnIndex = 0;
  let eventPtr = 0;

  while (true) {
    const { participantId, round } = baseTurnParticipant(turnIndex);
    const isBonusTurn = (bonusPicks[participantId] || 0) > 0;
    const picksNeeded = isBonusTurn ? 2 : 1;

    let takenThisTurn = 0;
    let turnResolved = false;

    while (takenThisTurn < picksNeeded && eventPtr < timeline.length) {
      const ev = timeline[eventPtr];
      if (ev.type === "skip") {
        // A skip always resolves the whole slot immediately, whether or
        // not it was a bonus turn — bonus turns aren't expected to be
        // skippable (AdminActions.skipDraftPick rejects that), but if
        // history ever contains one anyway, don't get stuck.
        eventPtr++;
        bonusPicks[participantId] = (bonusPicks[participantId] || 0) + 1;
        takenThisTurn = picksNeeded;
        turnResolved = true;
        break;
      }
      eventPtr++;
      takenThisTurn++;
      if (takenThisTurn === picksNeeded) turnResolved = true;
    }

    if (!turnResolved) {
      // Timeline exhausted mid-turn — this is the current, in-progress turn.
      return {
        turnIndex,
        currentParticipantId: participantId,
        currentRound: round,
        isBonusTurn,
        picksTakenThisTurn: takenThisTurn,
        picksNeededThisTurn: picksNeeded,
        bonusPicks,
      };
    }

    if (isBonusTurn) bonusPicks[participantId] = 0; // entitlement consumed
    turnIndex++;
  }
}

/** Locates a player's current roster entry (and owner) across all participants. */
function findCurrentRosterEntry(season, playerId) {
  for (const participantId of Object.keys(season.currentRosters || {})) {
    const entries = season.currentRosters[participantId];
    const index = entries.findIndex((e) => e.playerId === playerId);
    if (index !== -1) {
      return { participantId, entry: entries[index], index };
    }
  }
  return null;
}

/**
 * Full classification info for a player, independent of who currently
 * owns them: { classification, ownPickNumber, originalOwnerId,
 * currentOwnerId, isJoker }.
 *
 * classification is 'PINK' if the player is the current Joker designee
 * (isJoker overrides Red/Yellow — see rule C), otherwise derived from
 * their ORIGINAL draft pick number, otherwise null (6th+ pick, no Joker).
 */
function getPlayerClassificationInfo(season, playerId) {
  const current = findCurrentRosterEntry(season, playerId);
  const isJoker = !!(current && current.entry.isJoker);
  // Revision — Preserve Trade/Swap Red Tag: a manually-replaced entry's
  // classification is anchored to whichever player's ORIGINAL draft
  // record the roster SLOT itself carries forward (see
  // manualReplacePlayerOnRoster's classificationSourcePlayerId), not the
  // current occupant's own playerId. Absent on every entry that has never
  // been manually replaced (normal draft picks, ordinary trades/swaps of
  // an actually-drafted player), so classification for those is exactly
  // what it always was — this only changes anything for a manually
  // replaced slot, which previously had no classification at all because
  // its new occupant was never personally drafted.
  const lookupPlayerId = (current && current.entry.classificationSourcePlayerId) || playerId;
  const originalPick = getOriginalPickInfo(season, lookupPlayerId);
  const classification = isJoker
    ? "PINK"
    : originalPick
      ? classifyPickNumber(originalPick.ownPickNumber)
      : null;
  return {
    classification,
    ownPickNumber: originalPick ? originalPick.ownPickNumber : null,
    originalOwnerId: originalPick ? originalPick.originalOwnerId : null,
    currentOwnerId: current ? current.participantId : null,
    isJoker,
  };
}

/**
 * A roster entry's effective position for the max-2-per-position rule:
 * the Joker's freely-assigned jokerPosition if this entry is the Joker
 * (rule 6 — Joker doesn't have to follow the card's natural position),
 * otherwise the player's normal position.
 */
function getEffectivePosition(entry, player) {
  if (entry.isJoker && entry.jokerPosition) return entry.jokerPosition;
  return player ? player.position : undefined;
}

/**
 * Per-position counts for a roster entries array, using each entry's
 * EFFECTIVE position (see getEffectivePosition).
 */
function countPositionsForRoster(entries, playersById) {
  const counts = {};
  for (const entry of entries) {
    const player = playersById[entry.playerId];
    if (!player) continue;
    const pos = getEffectivePosition(entry, player);
    if (!pos) continue;
    counts[pos] = (counts[pos] || 0) + 1;
  }
  return counts;
}

/**
 * Rule 3 / Ambiguity A: a transaction must not CREATE a new position-limit
 * violation. Pre-existing over-cap positions (possible because the draft's
 * own position rule never capped beyond the mandatory first five) are left
 * alone — only positions this transaction pushes past the cap are rejected.
 */
function validateResultingPositions(beforeEntries, afterEntries, playersById) {
  const before = countPositionsForRoster(beforeEntries, playersById);
  const after = countPositionsForRoster(afterEntries, playersById);
  for (const pos of Object.keys(after)) {
    if (after[pos] > MAX_PLAYERS_PER_POSITION && after[pos] > (before[pos] || 0)) {
      return {
        valid: false,
        reason: `This transaction would put ${after[pos]} players at ${pos} (max ${MAX_PLAYERS_PER_POSITION}).`,
      };
    }
  }
  return { valid: true, reason: null };
}

/** Rule 4: max 4 Blue, each Blue >= 84 OVR, first 3 combined <= 280, 4th <= 94 OVR. */
function validateBlueComposition(afterEntries, playersById) {
  const blues = afterEntries
    .map((e) => playersById[e.playerId])
    .filter((p) => p && p.pool === "blue");

  if (blues.length > MAX_BLUE_PLAYERS) {
    return {
      valid: false,
      reason: `Resulting roster would have ${blues.length} Blue players (max ${MAX_BLUE_PLAYERS}).`,
    };
  }
  for (const p of blues) {
    if (p.overall < BLUE_MIN_RATING) {
      return {
        valid: false,
        reason: `${p.name} (${p.overall} OVR) is below the Blue minimum rating (${BLUE_MIN_RATING}).`,
      };
    }
  }
  const firstThree = blues.slice(0, 3);
  const firstThreeTotal = firstThree.reduce((sum, p) => sum + p.overall, 0);
  if (firstThree.length === 3 && firstThreeTotal > MAX_FIRST_THREE_BLUE_TOTAL) {
    return {
      valid: false,
      reason: `First 3 Blue players combined OVR is ${firstThreeTotal} (max ${MAX_FIRST_THREE_BLUE_TOTAL}).`,
    };
  }
  const fourth = blues[3];
  if (fourth && fourth.overall > MAX_FOURTH_BLUE_RATING) {
    return {
      valid: false,
      reason: `4th Blue player ${fourth.name} is ${fourth.overall} OVR (max ${MAX_FOURTH_BLUE_RATING}).`,
    };
  }
  return { valid: true, reason: null };
}

/** Rule 2: minimum rating for a player entering a roster, by pool. */
function validateMinimumRating(player) {
  if (!player) return { valid: false, reason: "Unknown player." };
  if (player.pool === "green" && player.overall < GREEN_MIN_RATING) {
    return {
      valid: false,
      reason: `${player.name} (${player.overall} OVR) is below the Green minimum rating (${GREEN_MIN_RATING}).`,
    };
  }
  if (player.pool === "blue" && player.overall < BLUE_MIN_RATING) {
    return {
      valid: false,
      reason: `${player.name} (${player.overall} OVR) is below the Blue minimum rating (${BLUE_MIN_RATING}).`,
    };
  }
  return { valid: true, reason: null };
}

/** Rule G: existing flat total-OVR roster cap (875 default), unchanged by Phase 5. */
function validateRatingCap(afterEntries, playersById, cap) {
  const total = afterEntries.reduce((sum, e) => sum + (playersById[e.playerId]?.overall ?? 0), 0);
  if (total > cap) {
    return { valid: false, reason: `Resulting roster total is ${total} OVR (cap ${cap}).` };
  }
  return { valid: true, reason: null };
}

/**
 * Rule F: RED can only trade for RED, YELLOW only for YELLOW. Classification
 * is unaffected by current ownership — always derived from the ORIGINAL
 * draft pick (see getPlayerClassificationInfo).
 *
 * Per the commissioner's Phase 5 correction: no aggregate/pairing rule for
 * multi-player trades has been defined, and one must not be invented. Any
 * trade touching more than 2 players total that involves at least one
 * RED- or YELLOW-classified player fails safe with an explicit
 * "commissioner review required" reason rather than guessing a pairing.
 * A simple 1-for-1 trade is unambiguous: it is rejected only for the
 * explicitly prohibited RED<->YELLOW pairing.
 */
function validateRedYellowCompatibility(season, outgoingPlayerIds, incomingPlayerIds) {
  const allIds = [...outgoingPlayerIds, ...incomingPlayerIds];
  const classifications = allIds.map(
    (id) => getPlayerClassificationInfo(season, id).classification
  );
  const hasRedOrYellow = classifications.some((c) => c === "RED" || c === "YELLOW");

  if (allIds.length > 2) {
    if (hasRedOrYellow) {
      return {
        valid: false,
        reason: "Commissioner review required — Red/Yellow multi-player trade rule is not defined.",
      };
    }
    return { valid: true, reason: null };
  }

  if (allIds.length === 2) {
    const [a, b] = classifications;
    if ((a === "RED" && b === "YELLOW") || (a === "YELLOW" && b === "RED")) {
      return {
        valid: false,
        reason: "Red players can only be traded for Red players, and Yellow for Yellow.",
      };
    }
  }
  return { valid: true, reason: null };
}

/** Rule E: normal trade fee is by POOL only (Green=100, Blue=200), never Red/Yellow. */
function getPoolTradeFee(player) {
  return player.pool === "blue" ? POOL_TRADE_FEE.blue : POOL_TRADE_FEE.green;
}

function isFeeDoubleDay(day) {
  return TRADE_FEE_DOUBLE_DAYS.includes(day);
}

function isTransactionsLockedDay(day) {
  return TRANSACTIONS_LOCKED_DAYS.includes(day);
}

/**
 * Backfills pot/currentSeasonDay/transactions on a season object that
 * predates the Phase 5 schema addition — createSeason() only sets these
 * for seasons created after Phase 5 shipped, so any season already sitting
 * in localStorage from an earlier phase has none of them. Called at the
 * top of every AdminActions write that touches these fields, before any
 * push/increment, so a legacy season is backfilled in place rather than
 * throwing on `undefined.push`. Never overwrites a value that's already
 * present (e.g. a pot that's legitimately 0).
 */
function ensureTransactionFields(season) {
  if (!Array.isArray(season.transactions)) season.transactions = [];
  if (typeof season.pot !== "number") season.pot = 0;
  if (typeof season.currentSeasonDay !== "number") season.currentSeasonDay = 1;
}

/**
 * Backfills `draftSlot` on currentRosters entries for a season that
 * predates the "Preserve Original Draft Pick Slot" revision — same lazy,
 * in-place backfill pattern as ensureTransactionFields/ensureFinancialFields
 * above, called at the top of every manual-roster-edit write. For each
 * entry missing draftSlot: if its playerId still matches one of that
 * participant's own playerDraftPicks (i.e. this exact roster slot has
 * never been manually replaced since rosters were initialized), assign
 * that pick's ownPickNumber; otherwise leave draftSlot as null — matching
 * the "never invent a pick number" rule, since a slot already replaced
 * under the old code has no recoverable original number.
 */
function ensureRosterDraftSlots(season) {
  if (!season.rostersInitialized || !season.currentRosters) return;
  for (const participantId of Object.keys(season.currentRosters)) {
    const roster = season.currentRosters[participantId];
    if (!Array.isArray(roster) || !roster.length) continue;
    if (roster.every((e) => e.draftSlot !== undefined)) continue; // already backfilled
    const ownPicks = (season.playerDraftPicks || []).filter((p) => p.participantId === participantId);
    for (const entry of roster) {
      if (entry.draftSlot !== undefined) continue;
      const pickIdx = ownPicks.findIndex((p) => p.playerId === entry.playerId);
      entry.draftSlot = pickIdx === -1 ? null : pickIdx + 1;
    }
  }
}

/**
 * Backfills `financialSettings` on a season object that predates the F1
 * schema addition, following the exact same lazy/backfill pattern as
 * ensureTransactionFields() above — never a bulk migration, only applied
 * in place when a write path that legitimately needs the field calls this
 * first. Also repairs a present-but-malformed financialSettings (e.g. a
 * non-numeric value from a corrupted write) back to the same defaults,
 * rather than leaving a bad value in place.
 *
 * F1 does not yet wire this into any commit function — none of the
 * existing Phase 5 writes (commitTrade/commitSwap/designateJoker/
 * makeDraftPick) read or need financialSettings, and F1 intentionally adds
 * no new write path that does either. This is the foundation later phases
 * (F2+) will call before recording an entry fee, splitting a trade fee,
 * etc. — added now so those phases have a ready, already-reviewed helper
 * rather than each inventing its own backfill.
 */
function ensureFinancialFields(season) {
  const defaults = { entryFee: 300, freeTrades: 2, freeSwaps: 2 };
  if (!season.financialSettings || typeof season.financialSettings !== "object") {
    season.financialSettings = { ...defaults };
    return;
  }
  for (const key of Object.keys(defaults)) {
    if (typeof season.financialSettings[key] !== "number" || !Number.isFinite(season.financialSettings[key])) {
      season.financialSettings[key] = defaults[key];
    }
  }
}

// ── Financial Management (F6 — Adjustments, Refunds, Corrections) ──────────
// Audit-first: F6 never deletes or silently rewrites an existing
// transaction. Every correction is a NEW transaction that references the
// original via relatedTransactionId. See AdminActions.recordFinancialRefund/
// recordFinancialCredit/recordFinancialDebit/voidFinancialTransaction/
// payStreamerSalaries below, and the getParticipantFinancialAccount/
// getFinancialSummary/getStreamerSalaryPlan read-side updates.

// Transaction types whose `amount`/`fee` represents real money a specific
// participant (teamA) paid INTO the pot — the only types a refund or a void
// may target. Deliberately excludes `trade` (its fee is attributed via its
// two `tradeFeeSplit` children, which ARE in this list — refunding/voiding
// the trade itself would double-count against those splits, per the F6
// spec's explicit "a refund against a tradeFeeSplit must not also refund
// the original trade transaction" instruction) and excludes every F6 type
// itself (a correction cannot be refunded/voided — void it via a fresh void
// referencing it, or leave it be).
const F6_REFUNDABLE_TYPES = ["entryFee", "tradeFeeSplit", "swap", "jokerSwap", "tenthPickBlueFee", "payment"];
const F6_VOIDABLE_TYPES = ["entryFee", "tradeFeeSplit", "swap", "jokerSwap", "tenthPickBlueFee", "credit", "debit", "streamerSalary"];

const STREAMER_SALARY_MIN_GAMES = 14;
const STREAMER_SALARY_POOL_PCT = 0.30;

/** Amount actually represented by a ledger transaction, regardless of which of the two existing field-naming conventions it uses. */
function f6TransactionAmount(t) {
  return t.amount ?? t.fee ?? 0;
}

/** True if `transactions` contains a `void` record whose relatedTransactionId points at transactionId. */
function isF6Voided(transactions, transactionId) {
  return transactions.some((t) => t.type === "void" && t.relatedTransactionId === transactionId);
}

/** Sum of all `refund` amounts already recorded against one original transaction id. */
function f6TotalRefundedAgainst(transactions, originalTransactionId) {
  return transactions
    .filter((t) => t.type === "refund" && t.relatedTransactionId === originalTransactionId)
    .reduce((sum, t) => sum + (t.amount || 0), 0);
}

/**
 * True if a charge transaction (entryFee/tradeFeeSplit/swap/jokerSwap)
 * should still count toward the "collected" diagnostics
 * (getFinancialSummary's entryFeesCollected/tradeFeesCollected/
 * swapFeesCollected, and therefore totalCollected/potDifference/
 * expectedPot/potDifferenceV2) — i.e. whether season.pot still reflects
 * it. voidFinancialTransaction() only reverses pot for a charge that was
 * still `"pending"` (never collected) at the moment it was voided; a
 * charge that was already collected (paid) when voided keeps its pot
 * contribution untouched, exactly as void behaved before that fix. This
 * mirrors that same distinction here, so these diagnostics never drift
 * out of sync with what pot actually contains after a void.
 */
function f6StillCountsAsCollected(transactions, t) {
  if (!isF6Voided(transactions, t.id)) return true;
  return f6IsCollected(t);
}

// ── F6 Revision 2 — Charge vs. Payment ──────────────────────────────────
// The league's pot represents total money CHARGED to the league (not only
// physically collected) — see f6ParticipantBreakdown below and
// commitTrade/commitSwap/addParticipant/recordFinancialPayment for the
// full model. A transaction's own `status` field says whether IT
// specifically represents money already collected:
//   - status: "paid"    → collected at creation (legacy entryFee/
//                          tradeFeeSplit records, and every `payment`
//                          transaction, which is always paid by
//                          construction)
//   - status: "pending" → charged, not yet collected (new-model
//                          entryFee/tradeFeeSplit/swap/jokerSwap charges)
//   - status: undefined → legacy swap/jokerSwap/tenthPickBlueFee records
//                          that predate this revision, when commitSwap()/
//                          makeDraftPick() unconditionally collected the
//                          fee at creation with no status field at all —
//                          missing status on exactly these two types means
//                          "collected", not "unknown". (entryFee and
//                          tradeFeeSplit always explicitly wrote "paid",
//                          even before this revision, so there's no
//                          missing-status ambiguity for those two types.)
function f6IsCollected(t) {
  if (t.status === "paid") return true;
  if (t.status === "pending") return false;
  return t.type === "swap" || t.type === "jokerSwap" || t.type === "tenthPickBlueFee";
}

/**
 * Pure — computes one participant's Charged/Paid/Unpaid breakdown across
 * the three F6 Revision 2 categories (entryFee/tradeFee/swapFee), plus
 * totals. Reads only from the given `season` object (no storage access),
 * so the exact same function is used both by the read-only
 * getParticipantFinancialAccount (against a freshly loaded season) and by
 * AdminActions.recordFinancialPayment/recordEntryFeePayment (against the
 * in-memory season object mid-write, before validating/saving) — the two
 * can never disagree about what's currently outstanding.
 *
 * Charged: entryFeeCharged is either this participant's real `entryFee`
 * transaction amount (set the moment they joined — see addParticipant())
 * or, for a participant who predates this revision and has never
 * interacted with entry fee at all, the season's currently configured
 * entryFee (the same virtual fallback used before this revision — never
 * written anywhere, purely for display, until an actual action creates a
 * real transaction for them). tradeFeeCharged/swapFeeCharged sum every
 * tradeFeeSplit/swap/jokerSwap transaction regardless of status — a
 * charge is a charge whether it's since been paid or not.
 *
 * Paid: for each category, sums (a) any of that category's charge
 * transactions that are f6IsCollected() — i.e. legacy pre-revision
 * records, already-collected at creation — plus (b) every `payment`
 * transaction in that category, minus (c) refunds attributed back to
 * whichever category their original transaction belonged to (a `refund`
 * against a Trade Fee payment increases Trade Fee Unpaid specifically,
 * not just the participant's season-wide total — existing, tested F6
 * refund semantics, preserved exactly: a refund reduces effective paid).
 *
 * Unpaid: max(0, charged − paid) per category — never negative.
 */
function f6ParticipantBreakdown(season, participantId) {
  const transactions = season.transactions || [];
  const notVoided = (t) => !isF6Voided(transactions, t.id);
  const mine = (t) => t.teamA === participantId && notVoided(t);

  const defaultEntryFee = Number.isFinite(season.financialSettings?.entryFee)
    ? season.financialSettings.entryFee
    : 300;

  // entryFee is handled separately from the trade/swap loops below: unlike
  // those (which simply drop a voided charge from the sum), a voided
  // entryFee charge specifically must show as ZERO charged — not silently
  // fall back to the virtual "no transaction at all" default, which would
  // incorrectly re-manufacture an obligation the commissioner just voided.
  // The virtual fallback is reserved for the genuinely different case of a
  // participant who predates this revision and has no entryFee
  // transaction of any kind, voided or otherwise.
  const entryFeeTxnRaw = transactions.find((t) => t.type === "entryFee" && t.teamA === participantId) || null;
  const entryFeeVoided = !!(entryFeeTxnRaw && isF6Voided(transactions, entryFeeTxnRaw.id));
  const entryFeeTxn = entryFeeVoided ? null : entryFeeTxnRaw;
  const entryFeeCharged = entryFeeTxnRaw ? (entryFeeVoided ? 0 : f6TransactionAmount(entryFeeTxnRaw)) : defaultEntryFee;
  const entryFeeCollectedDirectly = (entryFeeTxnRaw && !entryFeeVoided && f6IsCollected(entryFeeTxnRaw))
    ? f6TransactionAmount(entryFeeTxnRaw)
    : 0;

  const tradeFeeTxns = transactions.filter((t) => t.type === "tradeFeeSplit" && mine(t));
  const tradeFeeCharged = tradeFeeTxns.reduce((sum, t) => sum + (t.amount || 0), 0);
  const tradeFeeCollectedDirectly = tradeFeeTxns
    .filter((t) => f6IsCollected(t))
    .reduce((sum, t) => sum + (t.amount || 0), 0);

  const swapFeeTxns = transactions.filter((t) => (t.type === "swap" || t.type === "jokerSwap") && mine(t));
  const swapFeeCharged = swapFeeTxns.reduce((sum, t) => sum + (t.fee || 0), 0);
  const swapFeeCollectedDirectly = swapFeeTxns
    .filter((t) => f6IsCollected(t))
    .reduce((sum, t) => sum + (t.fee || 0), 0);

  const paymentTxns = transactions.filter((t) => t.type === "payment" && mine(t));
  const paidByCategory = { entryFee: 0, tradeFee: 0, swapFee: 0 };
  for (const p of paymentTxns) {
    if (paidByCategory[p.paymentCategory] !== undefined) paidByCategory[p.paymentCategory] += p.amount || 0;
  }

  const refundTxns = transactions.filter((t) => t.type === "refund" && mine(t));
  const refundedByCategory = { entryFee: 0, tradeFee: 0, swapFee: 0 };
  let totalRefunded = 0;
  for (const r of refundTxns) {
    totalRefunded += r.amount || 0;
    const original = transactions.find((t) => t.id === r.relatedTransactionId);
    if (!original) continue;
    let cat = null;
    if (original.type === "entryFee") cat = "entryFee";
    else if (original.type === "tradeFeeSplit") cat = "tradeFee";
    else if (original.type === "swap" || original.type === "jokerSwap") cat = "swapFee";
    else if (original.type === "payment") cat = original.paymentCategory;
    if (cat && refundedByCategory[cat] !== undefined) refundedByCategory[cat] += r.amount || 0;
  }

  const entryFeePaid = Math.max(0, entryFeeCollectedDirectly + paidByCategory.entryFee - refundedByCategory.entryFee);
  const tradeFeePaid = Math.max(0, tradeFeeCollectedDirectly + paidByCategory.tradeFee - refundedByCategory.tradeFee);
  const swapFeePaid = Math.max(0, swapFeeCollectedDirectly + paidByCategory.swapFee - refundedByCategory.swapFee);

  const entryFeeUnpaid = Math.max(0, entryFeeCharged - entryFeePaid);
  const tradeFeeUnpaid = Math.max(0, tradeFeeCharged - tradeFeePaid);
  const swapFeeUnpaid = Math.max(0, swapFeeCharged - swapFeePaid);

  return {
    entryFee: { charged: entryFeeCharged, paid: entryFeePaid, unpaid: entryFeeUnpaid },
    tradeFee: { charged: tradeFeeCharged, paid: tradeFeePaid, unpaid: tradeFeeUnpaid },
    swapFee: { charged: swapFeeCharged, paid: swapFeePaid, unpaid: swapFeeUnpaid },
    totalCharged: entryFeeCharged + tradeFeeCharged + swapFeeCharged,
    totalPaid: entryFeePaid + tradeFeePaid + swapFeePaid,
    totalUnpaid: entryFeeUnpaid + tradeFeeUnpaid + swapFeeUnpaid,
    totalRefunded,
    entryFeeTransaction: entryFeeTxn,
    tradeFeeTransactions: tradeFeeTxns,
    swapFeeTransactions: swapFeeTxns,
    paymentTransactions: paymentTxns,
  };
}

/**
 * Phase 7: Generates a single round-robin schedule (standard circle method)
 * for an arbitrary list of participantIds — never a hardcoded team count.
 *
 * If teamIds.length is odd, a synthetic BYE (null) is added to make the
 * rotation even; whichever team lands opposite it that round gets a
 * matchup with teamB: null. A BYE is a scheduling artifact only — no
 * score/streamer/winner is ever attached to one.
 *
 * Guarantees: no team plays itself, no duplicate pairing across the
 * season, every real team appears exactly once per round (as an
 * opponent or the BYE).
 *
 * Returns the `schedule` array shape: [{ round, matchups: [...] }].
 * Pure function — does not read or write storage.
 */
function generateRoundRobinRounds(teamIds) {
  const ids = [...teamIds];
  if (ids.length % 2 !== 0) ids.push(null); // synthetic BYE slot

  const n = ids.length;
  const numRounds = n - 1;
  const half = n / 2;

  const fixed = ids[0];
  let rotating = ids.slice(1);

  const rounds = [];
  for (let r = 0; r < numRounds; r++) {
    const arrangement = [fixed, ...rotating];
    const matchups = [];
    for (let i = 0; i < half; i++) {
      const a = arrangement[i];
      const b = arrangement[n - 1 - i];
      if (a === null && b === null) continue; // can't both be the BYE
      const teamA = a === null ? b : a;
      const teamB = a === null || b === null ? null : b;
      matchups.push({
        id: generateId("m"),
        teamA,
        teamB, // null => BYE for teamA this round
        status: "scheduled",
        scoreA: null,
        scoreB: null,
        winner: null,
        streamer: null,
        playedAt: null,
      });
    }
    rounds.push({ round: r + 1, matchups });
    // Rotate: last element of `rotating` moves to the front.
    rotating = [rotating[rotating.length - 1], ...rotating.slice(0, -1)];
  }
  return rounds;
}

// ─── Group Stage (legacy 16-team / 4-group format) ─────────────────────────
//
// Reuses generateRoundRobinRounds() unchanged for each group's mini
// round-robin (4 teams -> exactly 3 rounds, 2 games/round, never an odd
// count so the BYE path in generateRoundRobinRounds never triggers) —
// nothing about pairing/rotation logic is duplicated. This file's ONLY new
// scheduling logic is how four separate mini-round-robins get interleaved
// into shared "global" rounds. Round 2 groups are entered manually by the
// commissioner (Revision — Manual Online-Roulette Assignment) rather than
// computed here.

const GROUP_NAMES = ["A", "B", "C", "D"];

/**
 * Builds one stage's worth of Group Stage rounds: runs a mini round-robin
 * (via the existing generateRoundRobinRounds) independently for each of
 * the 4 groups, then interleaves them so global round N contains every
 * group's Nth mini-round — this is what lets the existing round-tabs
 * admin/public UI display Group Stage exactly like Round Robin (one tab
 * per global round, every team appearing at most once per tab).
 *
 * groups: { A: [id,id,id,id], B: [...], C: [...], D: [...] } — each array
 * must have exactly 4 entries (validated by the caller, not here — this
 * is a pure function with no throwing/validation of its own, matching
 * generateRoundRobinRounds' own contract).
 *
 * Returns `schedule`-shaped rounds: [{ round, matchups }], with `round`
 * numbers starting at roundOffset + 1, and every matchup tagged with
 * { stage, group }.
 */
function generateGroupStageRounds(groups, stageNumber, roundOffset) {
  const perGroup = GROUP_NAMES.map((g) => ({
    group: g,
    rounds: generateRoundRobinRounds(groups[g]),
  }));
  const numMiniRounds = perGroup[0].rounds.length; // 3 for 4 teams, always
  const combined = [];
  for (let i = 0; i < numMiniRounds; i++) {
    const matchups = [];
    for (const { group, rounds } of perGroup) {
      for (const m of rounds[i].matchups) {
        matchups.push({ ...m, stage: stageNumber, group });
      }
    }
    combined.push({ round: roundOffset + i + 1, matchups });
  }
  return combined;
}

/**
 * Checks a proposed Round 2 groups object against the ACTUAL Round 1
 * matchups already played (never assumed, per the "add validation for
 * this rather than assuming" requirement — this matters even more now
 * that Round 2 groups are entered manually, since a roulette result could
 * legitimately produce a rematch). Returns an array of
 * { teamA, teamB, group } for every Round 2 pairing that already played
 * in Round 1 — empty array means clean.
 */
function findGroupStageRematches(round1Matchups, round2Groups) {
  const playedPairs = new Set(
    round1Matchups.map((m) => [m.teamA, m.teamB].sort().join("::"))
  );
  const rematches = [];
  for (const group of GROUP_NAMES) {
    const teams = round2Groups[group];
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        const key = [teams[i], teams[j]].sort().join("::");
        if (playedPairs.has(key)) {
          rematches.push({ teamA: teams[i], teamB: teams[j], group });
        }
      }
    }
  }
  return rematches;
}

// ─── Group Stage home-court rule (Revision — Home Court Rule) ──────────────
//
// Two DIFFERENT rules, one per round — neither is the Round Robin format's
// business (Round Robin has no home-court concept at all and is untouched):
//
//   Round 1: home court goes to the team with the HIGHER original
//     team-assignment pick number (season.teamAssignmentOrder is the
//     "DuckRace #2" order participants picked their NBA team in — position
//     0 = pick #1). Pick numbers are unique per team, so this never ties.
//
//   Round 2: home court goes to the team with the better (higher) Round 1
//     point differential. Tied point differential falls back to total
//     Round 1 points scored (pointsFor) — higher wins home court. In the
//     effectively-impossible event BOTH are tied, this falls back to the
//     same unique pick number Round 1 uses, purely so home court is always
//     determined rather than left undefined; it is never a league-facing
//     tie-break rule.
//
// Both helpers mutate each non-BYE matchup in place, adding explicit
// `home`/`away` participantId fields — never inferred later from teamA/
// teamB order at render time, per the "commissioner should NOT manually
// choose, and nothing should assume left==home" requirement.

/**
 * Round 1: assigns home/away by comparing pickNumberOf(teamA) vs
 * pickNumberOf(teamB) — higher pick number is HOME.
 */
function assignRound1HomeCourt(matchups, pickNumberOf) {
  for (const m of matchups) {
    if (m.teamB === null) continue; // BYE — no opponent to compare against
    const pickA = pickNumberOf(m.teamA);
    const pickB = pickNumberOf(m.teamB);
    if (pickA === pickB) {
      // teamAssignmentOrder positions are unique per team — this should be
      // unreachable. Fail loudly rather than silently guessing a side.
      throw new Error("Internal error: two teams share the same original pick number.");
    }
    if (pickA > pickB) {
      m.home = m.teamA;
      m.away = m.teamB;
    } else {
      m.home = m.teamB;
      m.away = m.teamA;
    }
  }
}

/**
 * Round 2: assigns home/away by comparing each team's Round 1 stat line
 * (statsOf(pid) -> { pointDifferential, pointsFor }, from
 * getGroupStageStandings(seasonId, 1)). Better pointDifferential is HOME;
 * a tie falls back to pointsFor; a further tie falls back to
 * pickNumberOf (see module-level comment above).
 */
function assignRound2HomeCourt(matchups, statsOf, pickNumberOf) {
  for (const m of matchups) {
    if (m.teamB === null) continue; // BYE — no opponent to compare against
    const a = statsOf(m.teamA);
    const b = statsOf(m.teamB);
    let aIsHome;
    if (a.pointDifferential !== b.pointDifferential) {
      aIsHome = a.pointDifferential > b.pointDifferential;
    } else if (a.pointsFor !== b.pointsFor) {
      aIsHome = a.pointsFor > b.pointsFor;
    } else {
      aIsHome = pickNumberOf(m.teamA) > pickNumberOf(m.teamB);
    }
    if (aIsHome) {
      m.home = m.teamA;
      m.away = m.teamB;
    } else {
      m.home = m.teamB;
      m.away = m.teamA;
    }
  }
}

// ── Phase 9: Playoffs ──────────────────────────────────────────────────────
//
// Confirmed bracket structure (nothing here is inferred beyond what was
// explicitly specified):
//
//   Round 1 (BO1): 5v12, 6v11, 7v10, 8v9 — seeds 1-4 bye.
//   Round 2 (BO3), two independent pools:
//     TOP pool    = winners of (5v12) and (6v11).
//       seed 3 picks one -> series "3 vs pick"; seed 4 auto-gets the other
//       -> series "4 vs leftover".
//     BOTTOM pool = winners of (7v10) and (8v9).
//       seed 1 picks one -> series "1 vs pick"; seed 2 auto-gets the other
//       -> series "2 vs leftover".
//   Finals (BO3):
//     semifinal A = winner(seed-3 series) vs winner(seed-4 series)
//     semifinal B = winner(seed-1 series) vs winner(seed-2 series)
//     championship = winner(semifinal A) vs winner(semifinal B)
//   Champion = winner(championship).
//
// A "Game" is the shared BO1/BO3 scoring unit, deliberately mirroring
// Phase 7's Matchup fields it reuses conceptually (tie-invalid,
// winner-derived, streamer-as-text, edit-in-place):
//   { gameNumber, scoreA, scoreB, winner, streamer, playedAt, status }

const PLAYOFF_ROUND1_PAIRS = [
  [5, 12],
  [6, 11],
  [7, 10],
  [8, 9],
];

function makePlayoffSeries(extra) {
  return { id: generateId("ps"), games: [], winner: null, status: "scheduled", ...extra };
}

/**
 * Builds the full (mostly empty) playoffs skeleton from a frozen seed list.
 * Only Round 1's teamA/teamB are populated up front — everything past that
 * is filled in incrementally as results come in and admin selections are
 * made (see AdminActions.recordPlayoffGameResult / selectPlayoffOpponent).
 */
function buildPlayoffsSkeleton(seeds) {
  const bySeed = Object.fromEntries(seeds.map((s) => [s.seed, s.participantId]));

  const round1Matches = PLAYOFF_ROUND1_PAIRS.map(([seedA, seedB]) => ({
    id: generateId("r1"),
    seedA,
    seedB,
    teamA: bySeed[seedA],
    teamB: bySeed[seedB],
    games: [],
    winner: null,
    status: "scheduled",
  }));

  const topSeries3 = makePlayoffSeries({ seed: 3, opponent: null });
  const topSeries4 = makePlayoffSeries({ seed: 4, opponent: null });
  const bottomSeries1 = makePlayoffSeries({ seed: 1, opponent: null });
  const bottomSeries2 = makePlayoffSeries({ seed: 2, opponent: null });

  return {
    status: "seeded",
    generatedAt: new Date().toISOString(),
    seeds,
    round1: { format: "bo1", matches: round1Matches },
    round2: {
      format: "bo3",
      pools: [
        {
          name: "top",
          sourceMatchIds: [round1Matches[0].id, round1Matches[1].id],
          chooserSeed: 3,
          selection: null,
          series: [topSeries3, topSeries4],
        },
        {
          name: "bottom",
          sourceMatchIds: [round1Matches[2].id, round1Matches[3].id],
          chooserSeed: 1,
          selection: null,
          series: [bottomSeries1, bottomSeries2],
        },
      ],
    },
    finals: {
      format: "bo3",
      semifinals: [
        makePlayoffSeries({ sourceSeriesIds: [topSeries3.id, topSeries4.id], teamA: null, teamB: null }),
        makePlayoffSeries({ sourceSeriesIds: [bottomSeries1.id, bottomSeries2.id], teamA: null, teamB: null }),
      ],
      championship: null, // built once both semifinal ids are known, see below
    },
    champion: null,
  };
}

/** Finds a Round-1 match, Round-2 series, semifinal, or championship series
 * by id anywhere in the playoffs structure. Returns { item, kind } or null.
 * kind is one of: 'round1' | 'round2' | 'semifinal' | 'championship'. */
function findPlayoffItem(playoffs, id) {
  if (!playoffs) return null;
  const r1 = playoffs.round1.matches.find((m) => m.id === id);
  if (r1) return { item: r1, kind: "round1" };
  for (const pool of playoffs.round2.pools) {
    const s = pool.series.find((s) => s.id === id);
    if (s) return { item: s, kind: "round2", pool };
  }
  const sf = playoffs.finals.semifinals.find((s) => s.id === id);
  if (sf) return { item: sf, kind: "semifinal" };
  if (playoffs.finals.championship && playoffs.finals.championship.id === id) {
    return { item: playoffs.finals.championship, kind: "championship" };
  }
  return null;
}

/** Recomputes winner/status for a Round-1 (bo1) match. */
function recomputeRound1Match(match) {
  const g = match.games[0];
  if (g && g.status === "completed") {
    match.winner = g.winner;
    match.status = "completed";
  } else {
    match.winner = null;
    match.status = match.games.length ? "in_progress" : "scheduled";
  }
}

/** Recomputes winner/status for a bo3 series/semifinal/championship, given
 * the ids of its two sides (participantId for round2 series: `seed` is
 * resolved by the caller into a participantId; semifinal/championship use
 * teamA/teamB directly). */
function recomputeBo3Result(item, sideAId, sideBId) {
  const winsA = item.games.filter((g) => g.status === "completed" && g.winner === sideAId).length;
  const winsB = item.games.filter((g) => g.status === "completed" && g.winner === sideBId).length;
  if (winsA >= 2) {
    item.winner = sideAId;
    item.status = "completed";
  } else if (winsB >= 2) {
    item.winner = sideBId;
    item.status = "completed";
  } else {
    item.winner = null;
    item.status = item.games.length ? "in_progress" : "scheduled";
  }
}

/**
 * After any playoff write, cascades auto-population downstream (round2
 * series -> finals semifinals -> championship -> champion) and recomputes
 * the season-level playoffs.status. Nothing here accepts a caller-supplied
 * winner — every winner is derived from games, matching Phase 7/8.
 */
function cascadePlayoffAdvancement(playoffs) {
  // Round 2 series -> Finals semifinals
  for (const semifinal of playoffs.finals.semifinals) {
    if (semifinal.teamA && semifinal.teamB) continue; // already populated
    const [srcAId, srcBId] = semifinal.sourceSeriesIds;
    let seriesA = null, seriesB = null;
    for (const pool of playoffs.round2.pools) {
      const found = pool.series.find((s) => s.id === srcAId);
      if (found) seriesA = found;
      const found2 = pool.series.find((s) => s.id === srcBId);
      if (found2) seriesB = found2;
    }
    if (seriesA && seriesA.winner && seriesB && seriesB.winner) {
      semifinal.teamA = seriesA.winner;
      semifinal.teamB = seriesB.winner;
    }
  }

  // Finals semifinals -> Championship (built lazily once both are known)
  if (!playoffs.finals.championship) {
    const [sfA, sfB] = playoffs.finals.semifinals;
    if (sfA.winner && sfB.winner) {
      playoffs.finals.championship = makePlayoffSeries({
        sourceSeriesIds: [sfA.id, sfB.id],
        teamA: sfA.winner,
        teamB: sfB.winner,
      });
    }
  }

  // Championship -> Champion
  if (playoffs.finals.championship && playoffs.finals.championship.winner) {
    playoffs.champion = playoffs.finals.championship.winner;
  }

  // Recompute overall status
  const round1Done = playoffs.round1.matches.every((m) => m.status === "completed");
  const round2Done = playoffs.round2.pools.every((p) => p.series.every((s) => s.status === "completed"));
  const semisDone = playoffs.finals.semifinals.every((s) => s.status === "completed");
  const champDone = !!playoffs.champion;

  if (champDone) playoffs.status = "complete";
  else if (playoffs.finals.championship && playoffs.finals.championship.games.length > 0) playoffs.status = "championship_in_progress";
  else if (semisDone) playoffs.status = "finals_semifinals_complete";
  else if (playoffs.finals.semifinals.some((s) => s.games.length > 0) || (playoffs.finals.semifinals[0].teamA)) playoffs.status = "finals_in_progress";
  else if (round2Done) playoffs.status = "round2_complete";
  else if (playoffs.round2.pools.some((p) => p.series.some((s) => s.games.length > 0)) || playoffs.round2.pools.some((p) => p.selection)) playoffs.status = "round2_in_progress";
  else if (round1Done) playoffs.status = "round1_complete";
  else if (playoffs.round1.matches.some((m) => m.games.length > 0)) playoffs.status = "round1_in_progress";
  else playoffs.status = "seeded";
}

/** True if ANY game anywhere in the playoffs has been recorded — used to
 * block regeneration, matching Phase 7's generateSchedule guard. */
function playoffsHaveAnyCompletedGame(playoffs) {
  if (!playoffs) return false;
  const allItems = [
    ...playoffs.round1.matches,
    ...playoffs.round2.pools.flatMap((p) => p.series),
    ...playoffs.finals.semifinals,
    ...(playoffs.finals.championship ? [playoffs.finals.championship] : []),
  ];
  return allItems.some((item) => item.games.some((g) => g.status === "completed"));
}

/**
 * True if editing an existing game on this item could invalidate data
 * that's already been built downstream from its current winner:
 *   round1 match   -> locked once its pool has made a selection
 *   round2 series  -> locked once the semifinal built from it has both sides
 *   semifinal      -> locked once the championship has been built
 *   championship   -> locked once a champion has been set
 */
function isPlayoffItemDownstreamLocked(playoffs, itemId, kind) {
  if (kind === "round1") {
    return playoffs.round2.pools.some(
      (p) => p.sourceMatchIds.includes(itemId) && p.selection !== null
    );
  }
  if (kind === "round2") {
    return playoffs.finals.semifinals.some(
      (sf) => sf.sourceSeriesIds.includes(itemId) && sf.teamA && sf.teamB
    );
  }
  if (kind === "semifinal") {
    return !!playoffs.finals.championship;
  }
  // Championship has nothing downstream of it — `champion` is *derived
  // from* the championship result, not a separate consumer of it, so
  // editing the championship's own games is always allowed.
  return false;
}

/**
 * Creates a player record for the global player database.
 * Players are referenced by ID in draft picks and rosters.
 * Unique IDs prevent collisions between similarly named players.
 *
 * Phase 4B fields:
 *   pool         — 'green' (current NBA2K26 players) | 'blue' (legendary/
 *                  prime/historical) | undefined (not yet categorized).
 *                  Never guessed — stays undefined until explicitly set.
 *   variantGroup — arbitrary string identifying the underlying player an
 *                  entry is a variant of (e.g. "lebron-james" shared by
 *                  "LEBRON JAMES (CLE)", "(MIA)", "(LAL)", "(PRIME)").
 *                  undefined means this player has no variants. Never
 *                  inferred from name/position/overall/id — must be set
 *                  explicitly via the Add Player form or CSV import.
 *                  Team/era information for Blue Pool variants lives in
 *                  the player's `name` (e.g. "LEBRON JAMES (PRIME)") —
 *                  there is no separate team field.
 *
 * pool and variantGroup are normalized to `undefined` (never an empty
 * string) when blank, so an accidental "" never matches another "" and
 * silently groups unrelated players — see makeDraftPick's `if
 * (player.variantGroup)` truthiness check, which relies on this.
 */
function createPlayer(id, { name, position, overall, pool, variantGroup, nba2kRef }) {
  return {
    id,
    name,        // e.g. "M. JORDAN" or "LEBRON JAMES (PRIME)"
    position,    // e.g. "SG"
    overall,     // e.g. 99
    pool: pool || undefined,               // 'green' | 'blue' | undefined
    variantGroup: variantGroup || undefined, // string | undefined
    createdAt: new Date().toISOString(),
    // Phase 3 (NBA2K promotion) — optional back-reference to the source
    // nba2k_players/<slug> document this player was promoted from. Every
    // existing caller (manual Add Player form, CSV import) never passes
    // this, so it's `undefined` for them exactly like `pool`/`variantGroup`
    // already are when omitted — no schema change for any existing player.
    nba2kRef: nba2kRef || undefined,
  };
}

/**
 * Normalizes a player `name` into a comparison key used to detect
 * duplicate players (CSV import — see importPlayersFromCSV).
 *
 * WHY `name` IS THE IDENTITY: the player schema (see createPlayer above)
 * has no separate "real world person" identifier — `id` is a randomly
 * generated storage key (see generateId), not an identity a CSV could
 * ever supply, and `variantGroup` intentionally does the OPPOSITE of
 * identifying a single player: it groups multiple *distinct* rows
 * ("LEBRON JAMES (CLE)", "LEBRON JAMES (MIA)", "LEBRON JAMES (PRIME)")
 * that are meant to coexist as separate entries. `name` — including any
 * team/era qualifier baked into it — is therefore the only field stable
 * enough to answer "is this the same player row as one we already have".
 *
 * Normalization only smooths over incidental text differences, never
 * semantic ones:
 *   - trims leading/trailing whitespace
 *   - collapses internal whitespace runs ("Stephen   Curry") to one space
 *   - lowercases
 * "LEBRON JAMES (CLE)" and "LEBRON JAMES (MIA)" still normalize to two
 * different keys (different text), so legitimate variants and two
 * unrelated people who happen to share a plain name are never merged —
 * only truly identical names (module whitespace/casing) collide.
 * `position`/`overall`/`pool` are deliberately NOT part of this key: a
 * re-imported row for an existing player with a corrected rating should
 * still be recognized as the same player, not treated as a new one.
 */
function normalizePlayerName(name) {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

// ─── Root Data Structure ──────────────────────────────────────────────────────

function getDefaultData() {
  return {
    // All seasons by ID. Adding a new season never touches existing ones.
    seasons: {},

    // Global player database, shared across seasons.
    // Players are never deleted once drafted — mark inactive instead.
    players: {},

    settings: {
      currentSeasonId: null,
    },
  };
}

// ─── Storage (Firestore-backed, single-document sync) ─────────────────────
//
// This app has always stored its entire state as one JSON blob under a
// single key (localStorage key "nba2k_league"). To keep every existing
// LeagueData/AdminActions function — and every view file that calls them —
// completely unchanged, this replaces ONLY what's inside loadData()/
// saveData() with a Firestore-backed in-memory cache, kept current by a
// real-time onSnapshot listener. The single-JSON-document shape is
// preserved exactly (collection "league", doc "main") rather than
// splitting into Firestore subcollections, which would require touching
// every read/write function individually for no real benefit at this data
// size — see FIREBASE_SETUP.md.
//
// Bootstrap: index.html / admin.html must call `FirebaseSync.init()` and
// wait for `FirebaseSync.ready` before any view renders (see admin.js /
// public-router.js) — loadData() has nothing to return before the first
// snapshot arrives.
//
// Concurrency note: saveData() always writes the FULL current document
// (matching the app's existing "load, mutate in memory, save whole thing
// back" pattern throughout AdminActions). Two admins saving at the same
// moment is last-write-wins, same risk profile as the original
// localStorage version had across browser tabs — acceptable for this
// app's single-commissioner-at-a-time usage; flagged here rather than
// silently shipped.

const FirebaseSync = (() => {
  let _cache = null; // latest known full data blob (or null before the first snapshot)
  let _unsubscribe = null;
  let _readyResolve;
  const ready = new Promise((resolve) => { _readyResolve = resolve; });
  const remoteChangeListeners = [];

  function docRef() {
    return firebase.firestore().collection("league").doc("main");
  }

  function init() {
    if (_unsubscribe) return ready; // already initialized — safe to call more than once

    try {
      // Offline persistence: lets the app keep working (read-only, from the
      // last-known cache) on a dropped connection. Non-fatal if it can't be
      // enabled (e.g. private browsing, or already enabled in another tab
      // without synchronizeTabs).
      firebase.firestore().enablePersistence({ synchronizeTabs: true }).catch((err) => {
        console.warn("[FirebaseSync] Offline persistence not enabled:", err.code || err);
      });
    } catch (e) {
      // enablePersistence() throws if called more than once across the app's
      // lifetime (e.g. hot reload during dev) — safe to ignore.
    }

    _unsubscribe = docRef().onSnapshot(
      (snap) => {
        const isFirstLoad = _cache === null;
        if (snap.exists) {
          _cache = snap.data();
        } else {
          // First-ever run against a brand-new Firestore project: seed the
          // document so subsequent writes have something to merge into.
          _cache = getDefaultData();
          docRef().set(_cache).catch((e) =>
            console.error("[FirebaseSync] Failed to seed initial document:", e)
          );
        }
        if (isFirstLoad) {
          _readyResolve();
        } else if (!snap.metadata.hasPendingWrites) {
          // hasPendingWrites is true for this tab's own optimistic write
          // echoing back — skip those (already reflected locally) and only
          // notify on changes that genuinely came from elsewhere (another
          // admin, another device/tab), so the UI can refresh to show them.
          remoteChangeListeners.forEach((fn) => {
            try { fn(_cache); } catch (e) { console.error("[FirebaseSync] remote-change listener error:", e); }
          });
        }
      },
      (err) => {
        console.error("[FirebaseSync] Firestore listener error:", err);
        if (_cache === null) {
          // Never got a first snapshot (offline with nothing cached yet, or
          // a rules/permission problem) — fall back to empty local data so
          // the app is at least usable rather than stuck on a loading screen.
          _cache = getDefaultData();
          _readyResolve();
        }
      }
    );
    return ready;
  }

  return {
    ready,
    init,
    getCache() {
      return _cache;
    },
    save(data) {
      _cache = data; // optimistic local update, synchronous — see saveData() below
      docRef().set(data).catch((err) => {
        console.error("[FirebaseSync] Cloud save failed:", err);
        if (typeof showToast === "function") {
          showToast("Saved locally, but the cloud sync failed — check your connection.", "error");
        }
      });
    },
    onRemoteChange(fn) {
      remoteChangeListeners.push(fn);
    },
  };
})();

function loadData() {
  const cache = FirebaseSync.getCache();
  if (!cache) return getDefaultData();
  // Deep clone on every call — every caller must get an independent copy,
  // exactly like the old JSON.parse(localStorage.getItem(...)) did. This is
  // load-bearing: AdminActions functions do `const data = loadData(); ...
  // mutate in place ...; if (invalid) throw;` and rely on an early throw
  // never touching shared state. Returning a live reference to the cache
  // here would let a function that mutates-then-throws permanently corrupt
  // data nothing ever actually saved.
  return JSON.parse(JSON.stringify(cache));
}

function saveData(data) {
  FirebaseSync.save(data);
}

// ─── ID Generation ────────────────────────────────────────────────────────────

function generateId(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Public Read API ──────────────────────────────────────────────────────────
// These functions are safe to call from public-facing pages.
// They never write to storage.

/**
 * Shared standings computation — used by both LeagueData.getTeamStatistics
 * (the whole season, every matchup) and LeagueData.getGroupStageStandings
 * (one group, one stage's matchups only). Pure function: does not read
 * season state itself, so it can never accidentally use the wrong scope
 * of matchups.
 *
 * Ranking rule (the only one this league defines): sort by winPct
 * descending; if winPct is equal, sort by pointDifferential descending.
 * No other tie-breaker exists — equal winPct AND equal pointDifferential
 * rows are left in their relative order (stable sort), never arbitrarily
 * separated.
 */
function computeTeamStandings(teamIds, matchups, participants, nbaTeamAssignments) {
  const completedReal = matchups.filter((m) => m.teamB !== null && m.status === "completed");
  const scheduledReal = matchups.filter((m) => m.teamB !== null && m.status !== "completed");

  const stats = teamIds.map((pid) => {
    const participant = participants[pid];
    const nbaTeam = nbaTeamAssignments[pid] || null;

    const played = completedReal.filter((m) => m.teamA === pid || m.teamB === pid);
    const wins = played.filter((m) => m.winner === pid).length;
    const gamesPlayed = played.length;
    const losses = gamesPlayed - wins;
    const winPct = gamesPlayed > 0 ? wins / gamesPlayed : 0;

    let pointsFor = 0;
    let pointsAgainst = 0;
    for (const m of played) {
      if (m.teamA === pid) {
        pointsFor += m.scoreA;
        pointsAgainst += m.scoreB;
      } else {
        pointsFor += m.scoreB;
        pointsAgainst += m.scoreA;
      }
    }
    const pointDifferential = pointsFor - pointsAgainst;

    const gamesRemaining = scheduledReal.filter((m) => m.teamA === pid || m.teamB === pid).length;

    return {
      participantId: pid,
      participantName: participant ? participant.name : null,
      nbaTeam,
      gamesPlayed,
      wins,
      losses,
      winPct,
      pointsFor,
      pointsAgainst,
      pointDifferential,
      gamesRemaining,
    };
  });

  // Array.prototype.sort is stable, so ties on BOTH remain in their
  // existing (caller-supplied teamIds) relative order rather than being
  // reshuffled — no additional tie-breaker is invented here.
  stats.sort((a, b) => {
    if (b.winPct !== a.winPct) return b.winPct - a.winPct;
    return b.pointDifferential - a.pointDifferential;
  });

  return stats;
}

const LeagueData = {
  // All NBA teams (static, no storage needed)
  getNBATeams() {
    return [...NBA_TEAMS];
  },

  getNBATeam(abbr) {
    return NBA_TEAMS.find((t) => t.abbr === abbr) || null;
  },

  // Settings
  getSettings() {
    return loadData().settings;
  },

  getCurrentSeasonId() {
    return loadData().settings.currentSeasonId;
  },

  // Seasons
  getAllSeasons() {
    const data = loadData();
    return Object.values(data.seasons).sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
  },

  getSeason(seasonId) {
    const data = loadData();
    return data.seasons[seasonId] || null;
  },

  getCurrentSeason() {
    const data = loadData();
    const id = data.settings.currentSeasonId;
    return id ? data.seasons[id] || null : null;
  },

  // Participants
  getParticipants(seasonId) {
    const season = this.getSeason(seasonId);
    if (!season) return [];
    return Object.values(season.participants);
  },

  getParticipant(seasonId, participantId) {
    const season = this.getSeason(seasonId);
    if (!season) return null;
    return season.participants[participantId] || null;
  },

  // Player Database
  getAllPlayers() {
    const data = loadData();
    return Object.values(data.players);
  },

  getPlayer(playerId) {
    const data = loadData();
    return data.players[playerId] || null;
  },

  // Draft
  getPlayerDraftOrder(seasonId) {
    const season = this.getSeason(seasonId);
    if (!season) return [];
    // Return as array of participant objects (not just IDs)
    return season.playerDraftOrder.map(
      (id) => season.participants[id]
    ).filter(Boolean);
  },

  getDraftPicks(seasonId) {
    const season = this.getSeason(seasonId);
    if (!season) return [];
    return season.playerDraftPicks;
  },

  /**
   * Players not yet drafted this season — the global player database
   * minus every playerId already present in playerDraftPicks. This is
   * how a drafted player becomes structurally undraftable again: it
   * simply stops appearing here. The global player database itself is
   * never modified by drafting.
   */
  getAvailablePlayers(seasonId) {
    const season = this.getSeason(seasonId);
    if (!season) return [];
    const drafted = new Set(season.playerDraftPicks.map((p) => p.playerId));
    return this.getAllPlayers().filter((p) => !drafted.has(p.id));
  },

  /**
   * Full derived state of the live snake draft. Nothing here is stored —
   * round, pick number, and the current participant are all computed
   * from playerDraftOrder and the current length of playerDraftPicks, so
   * this reflects reality even right after a page refresh. Uses the same
   * snake formula as the Draft Orders preview and AdminActions.makeDraftPick.
   */
  getDraftState(seasonId) {
    const season = this.getSeason(seasonId);
    if (!season) return null;

    const order = season.playerDraftOrder; // authoritative, from DuckRace #1
    const n = order.length;
    const picks = season.playerDraftPicks || [];
    const totalPicksMade = picks.length;
    const availablePlayers = this.getAvailablePlayers(seasonId);

    // Revision 1: turn/round/current-participant are now derived via
    // computeDraftSchedule (replays playerDraftPicks + draftSkips) instead
    // of the old raw idx/n arithmetic, so Skip/bonus-double-pick turns are
    // reflected correctly. Still fully derived, still nothing stored.
    const schedule = n > 0 ? computeDraftSchedule(season) : null;
    const currentParticipantId = schedule ? schedule.currentParticipantId : null;

    return {
      n,
      totalPicksMade,
      currentRound: schedule ? schedule.currentRound : null,
      currentPickInRound: schedule ? (schedule.turnIndex % n) + 1 : null,
      // "Overall pick" is the ordinal of the next ACTUAL pick about to be
      // made (skips don't consume one) — same meaning as before this
      // revision for a draft with no skips.
      currentPickOverall: currentParticipantId ? totalPicksMade + 1 : null,
      currentParticipantId,
      currentParticipant: currentParticipantId
        ? season.participants[currentParticipantId]
        : null,
      // New in Revision 1 — see computeDraftSchedule for what these mean.
      isBonusTurn: schedule ? schedule.isBonusTurn : false,
      picksTakenThisTurn: schedule ? schedule.picksTakenThisTurn : 0,
      picksNeededThisTurn: schedule ? schedule.picksNeededThisTurn : 1,
      bonusPicks: schedule ? schedule.bonusPicks : {},
      skipCount: (season.draftSkips || []).length,
      draftComplete: season.draftComplete,
      poolExhausted: availablePlayers.length === 0,
      picks,
      availablePlayers,
    };
  },

  // Get roster for a participant (their drafted players)
  getParticipantRoster(seasonId, participantId) {
    const season = this.getSeason(seasonId);
    if (!season) return [];
    const data = loadData();
    const picks = season.playerDraftPicks.filter(
      (p) => p.participantId === participantId
    );
    return picks.map((p) => ({
      ...p,
      player: data.players[p.playerId] || null,
    }));
  },

  // ── Phase 4A: Current Rosters ─────────────────────────────────────────────

  /**
   * Returns the current roster for one participant as an array of enriched
   * entries: { playerId, source, player }.
   *
   * If rosters have been initialized (rostersInitialized === true), reads from
   * season.currentRosters[participantId] — the mutable post-draft structure.
   * Falls back to a read-only derived view from playerDraftPicks if rosters
   * have not yet been initialized, so the public Teams view keeps working.
   *
   * Never writes to storage. Safe to call from public pages.
   */
  getCurrentRoster(seasonId, participantId) {
    const season = this.getSeason(seasonId);
    if (!season) return [];
    const data = loadData();

    if (season.rostersInitialized && season.currentRosters[participantId]) {
      const ownPicks = season.playerDraftPicks.filter((p) => p.participantId === participantId);
      return season.currentRosters[participantId].map(entry => {
        const player = data.players[entry.playerId] || null;
        // Display-only fallback for legacy rosters saved before the
        // "Preserve Original Draft Pick Slot" revision — not persisted
        // here (see ensureRosterDraftSlots, called by the manual-edit
        // writes, for the persisted version of this same backfill).
        let draftSlot = entry.draftSlot;
        if (draftSlot === undefined) {
          const pickIdx = ownPicks.findIndex((p) => p.playerId === entry.playerId);
          draftSlot = pickIdx === -1 ? null : pickIdx + 1;
        }
        return {
          ...entry,
          player,
          draftSlot,
          // Pool-agnostic — see getEffectivePosition. Added so every roster
          // display (public Rosters page, admin Rosters page) can show a
          // Joker's assigned position instead of always falling back to the
          // player's card-native position, exactly like getRosterForTransactions
          // already did for the Trades page.
          effectivePosition: player ? getEffectivePosition(entry, player) : null,
        };
      });
    }

    // Fallback: derive from draft picks (pre-initialization view) — no
    // Joker exists yet at this stage (rostersInitialized is false), so
    // effectivePosition is always just the player's own position.
    // draftSlot mirrors what initializeRostersFromDraft will assign a
    // moment later, purely for display consistency pre-initialization.
    return season.playerDraftPicks
      .filter(p => p.participantId === participantId)
      .map((p, i) => {
        const player = data.players[p.playerId] || null;
        return {
          playerId: p.playerId,
          source: 'draft',
          player,
          effectivePosition: player ? player.position : null,
          draftSlot: i + 1,
        };
      });
  },

  /**
   * Returns a summary of all participants' current rosters for the season,
   * ordered by season.playerDraftOrder — the authoritative, admin-entered
   * (DuckRace #1) draft/team order (see createSeason's doc comment on that
   * field). This is deliberately NOT participant addition/object order:
   * that order is not guaranteed to survive a Firestore round-trip (map
   * field key order isn't preserved), which is exactly why callers need a
   * real stored order to sort by instead. Any participant not yet present
   * in playerDraftOrder (e.g. added before an order was ever entered)
   * is appended afterward, sorted by participant ID — a deterministic,
   * non-name, non-insertion-order fallback — never left to whatever order
   * Object.values() happened to return.
   *
   * Each entry: {
   *   participant,           // { id, name }
   *   rosterEntries,         // [{ playerId, source, player }]
   *   totalRating,           // sum of player.overall for all entries
   *   ratingCap,             // season.ratingCap (875 default)
   *   remaining,             // ratingCap - totalRating
   *   isOverCap,             // totalRating > ratingCap
   * }
   *
   * Rating is computed from player.overall in the global player database —
   * the single source of truth for a player's rating.
   */
  getRosterSummary(seasonId) {
    const season = this.getSeason(seasonId);
    if (!season) return [];
    const cap = season.ratingCap ?? 875;

    const orderedIds = [...(season.playerDraftOrder || [])];
    const orderedSet = new Set(orderedIds);
    const fallbackIds = Object.keys(season.participants)
      .filter((id) => !orderedSet.has(id))
      .sort();
    const participants = [...orderedIds, ...fallbackIds]
      .map((id) => season.participants[id])
      .filter(Boolean); // guards against a stale ID (e.g. a removed participant) lingering in playerDraftOrder

    return participants.map(participant => {
      const entries = this.getCurrentRoster(seasonId, participant.id);
      const totalRating = entries.reduce((sum, e) => sum + (e.player?.overall ?? 0), 0);
      return {
        participant,
        rosterEntries: entries,
        totalRating,
        ratingCap: cap,
        remaining: cap - totalRating,
        isOverCap: totalRating > cap,
      };
    });
  },

  // ── Phase 4B: Player Draft position rules & pool status ──────────────────

  /**
   * Returns the given participant's core-position fill state:
   * { filled: {PG,SG,SF,PF,C}, missing: [...], allFilled }.
   * Read-only — derives entirely from playerDraftPicks. Never writes.
   */
  getPositionState(seasonId, participantId) {
    const season = this.getSeason(seasonId);
    if (!season) return null;
    const data = loadData();
    return computePositionState(season, data.players, participantId);
  },

  /**
   * Returns EVERY player in the database (nothing is filtered out — see
   * Phase 4B spec: "Do NOT permanently remove players from the pool")
   * annotated with a status for the given participant:
   *
   *   'available'       — legal to draft right now
   *   'drafted'         — this exact player already picked (by anyone)
   *   'variant-locked'  — another variant in the same variantGroup was picked
   *   'position-locked' — mandatory-first-five rule blocks this position
   *   'no-position'     — player has no recognized position (PG/SG/SF/PF/C)
   *                        and the mandatory-first-five phase is still active,
   *                        so it's unclear which slot it would fill
   *
   * Pass participantId = null/undefined to get drafted/variant-locked
   * status only (position rules skipped) — used once the draft is complete
   * and there's no "current" participant.
   */
  getDraftPoolStatus(seasonId, participantId) {
    const season = this.getSeason(seasonId);
    if (!season) return [];
    const data = loadData();
    const allPlayers = Object.values(data.players);

    const draftedIds = new Set(season.playerDraftPicks.map((p) => p.playerId));
    const draftedVariantGroups = new Set(
      season.playerDraftPicks
        .map((p) => data.players[p.playerId]?.variantGroup)
        .filter(Boolean)
    );

    const posState = participantId
      ? computePositionState(season, data.players, participantId)
      : null;

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
  },

  // Team Assignment
  getTeamAssignmentOrder(seasonId) {
    const season = this.getSeason(seasonId);
    if (!season) return [];
    return season.teamAssignmentOrder.map(
      (id) => season.participants[id]
    ).filter(Boolean);
  },

  getNBATeamAssignments(seasonId) {
    const season = this.getSeason(seasonId);
    if (!season) return {};
    return { ...season.nbaTeamAssignments };
  },

  getAssignedNBATeams(seasonId) {
    const assignments = this.getNBATeamAssignments(seasonId);
    return Object.values(assignments);
  },

  getAvailableNBATeams(seasonId) {
    const assigned = new Set(this.getAssignedNBATeams(seasonId));
    return NBA_TEAMS.filter((t) => !assigned.has(t.abbr));
  },

  // ── Phase 7: Regular Season Schedule ──────────────────────────────────────

  /**
   * Returns the full generated schedule (array of { round, matchups }),
   * or [] if none has been generated yet. Never writes.
   */
  getSchedule(seasonId) {
    const season = this.getSeason(seasonId);
    if (!season) return [];
    return season.schedule;
  },

  /**
   * Finds a single matchup by ID anywhere in the schedule, along with
   * the round it belongs to. Returns null if not found.
   */
  getMatchup(seasonId, matchupId) {
    const season = this.getSeason(seasonId);
    if (!season) return null;
    for (const round of season.schedule) {
      const matchup = round.matchups.find((m) => m.id === matchupId);
      if (matchup) return { matchup, round: round.round };
    }
    return null;
  },

  /**
   * Derived summary of the schedule's current state — nothing here is
   * stored beyond scheduleGeneratedAt; counts are computed fresh each call
   * so they can never drift from the underlying schedule/matchup data.
   *
   * realMatchupCount/completedCount exclude BYEs, since a BYE is a
   * scheduling artifact only (see generateRoundRobinRounds) and is never
   * a game to complete.
   */
  getScheduleState(seasonId) {
    const season = this.getSeason(seasonId);
    if (!season) return null;

    const rounds = season.schedule;
    const allMatchups = rounds.flatMap((r) => r.matchups);
    const realMatchups = allMatchups.filter((m) => m.teamB !== null);
    const completed = realMatchups.filter((m) => m.status === "completed");

    return {
      generated: rounds.length > 0,
      generatedAt: season.scheduleGeneratedAt,
      totalRounds: rounds.length,
      realMatchupCount: realMatchups.length,
      completedCount: completed.length,
      hasCompletedGames: completed.length > 0,
      teamsCount: new Set(
        allMatchups.flatMap((m) => [m.teamA, m.teamB]).filter(Boolean)
      ).size,
    };
  },

  // ── Phase 8: Standings & Statistics ────────────────────────────────────────
  // Everything below is fully derived from season.schedule on every call —
  // nothing is stored. This guarantees standings can never drift from the
  // underlying match results, and an edited result (Phase 7's
  // recordMatchResult) is reflected automatically on the very next read,
  // with no separate "update standings" step anywhere.

  /**
   * Per-participant team statistics for the season, derived entirely from
   * completed REAL matchups (BYEs and not-yet-played games are excluded
   * by construction — see the filters below).
   *
   * Format-agnostic: this simply looks at ALL of season.schedule, so for a
   * Group Stage season, once both stages exist, this is exactly the
   * correct combined final ranking across all 6 games/team — no special
   * casing needed here for Group Stage at all.
   *
   * Returns [] if the season has no schedule or no assigned teams.
   */
  getTeamStatistics(seasonId) {
    const season = this.getSeason(seasonId);
    if (!season) return [];

    const teamIds = season.teamAssignmentOrder.filter(
      (pid) => !!season.nbaTeamAssignments[pid]
    );
    const allMatchups = season.schedule.flatMap((r) => r.matchups);
    return computeTeamStandings(teamIds, allMatchups, season.participants, season.nbaTeamAssignments);
  },

  /**
   * Group Stage-only: per-group standings for one stage, using the exact
   * same computeTeamStandings ranking rule as getTeamStatistics above —
   * this is NOT a second standings engine, just the same pure function
   * scoped to one group's teams and one stage's matchups.
   *
   * Returns null if this season isn't a Group Stage season. Returns
   * { A: [...], B: [...], C: [...], D: [...] }, each an array of 4 ranked
   * stat rows (same shape getTeamStatistics rows have) for the requested
   * stage (defaults to season.groupStageState.stage, i.e. whichever stage
   * is current).
   */
  getGroupStageStandings(seasonId, stage) {
    const season = this.getSeason(seasonId);
    if (!season || !season.groupStageState) return null;
    const targetStage = stage || season.groupStageState.stage;
    const groups = targetStage === 1 ? season.groupStageState.groups : season.groupStageState.round2Groups;
    if (!groups) return null;

    const allMatchups = season.schedule.flatMap((r) => r.matchups);
    const result = {};
    for (const g of GROUP_NAMES) {
      const stageMatchups = allMatchups.filter((m) => m.stage === targetStage && m.group === g);
      result[g] = computeTeamStandings(groups[g], stageMatchups, season.participants, season.nbaTeamAssignments);
    }
    return result;
  },

  /**
   * Streamer leaderboard for the season: how many completed REAL games
   * each streamer has been credited with, derived from the same
   * completed-matchup scan as getTeamStatistics. Sorted descending by
   * count. BYEs and not-yet-played games are never counted (a BYE has no
   * streamer field to begin with; a scheduled game has streamer: null).
   */
  getStreamerStatistics(seasonId) {
    const season = this.getSeason(seasonId);
    if (!season) return [];

    const completedReal = season.schedule
      .flatMap((r) => r.matchups)
      .filter((m) => m.teamB !== null && m.status === "completed");

    const counts = new Map();
    for (const m of completedReal) {
      counts.set(m.streamer, (counts.get(m.streamer) || 0) + 1);
    }

    return [...counts.entries()]
      .map(([streamer, gamesStreamed]) => ({ streamer, gamesStreamed }))
      .sort((a, b) => b.gamesStreamed - a.gamesStreamed);
  },

  /**
   * F6 — live preview of a streamer-salary payout, computed fresh from
   * the CURRENT season.pot and CURRENT getStreamerStatistics() every time
   * this is called; nothing here is stored. Eligibility/counting is
   * exactly getStreamerStatistics() as it already exists (regular-season
   * games only — playoff streamer counting is out of scope for F6, see
   * the F6 architecture review). If AdminActions.payStreamerSalaries()
   * is actually called, it independently snapshots pot/pool/individual
   * salary at that moment — this preview does not guarantee the numbers
   * a later payout run will use if the pot or eligibility changes first.
   *
   * alreadyPaid lists any `streamerSalary` transactions recorded in past
   * runs (informational only — F6 does not block paying a streamer/
   * participant again in a later run).
   */
  getStreamerSalaryPlan(seasonId) {
    const season = this.getSeason(seasonId);
    if (!season) return null;

    const pot = season.pot ?? 0;
    const salaryPool = pot * STREAMER_SALARY_POOL_PCT;
    const eligibleStreamers = this.getStreamerStatistics(seasonId)
      .filter((s) => s.gamesStreamed >= STREAMER_SALARY_MIN_GAMES);
    const individualSalary = eligibleStreamers.length
      ? Math.round(salaryPool / eligibleStreamers.length)
      : null;

    const transactions = season.transactions || [];
    const alreadyPaid = transactions
      .filter((t) => t.type === "streamerSalary")
      .map((t) => ({
        participantId: t.teamA,
        participantName: season.participants[t.teamA]?.name || "—",
        amount: t.amount,
        description: t.description,
        seasonDay: t.seasonDay,
        timestamp: t.timestamp,
      }));

    return {
      pot,
      salaryPool,
      eligibleStreamers,
      individualSalary,
      alreadyPaid,
    };
  },

  // ── Phase 9: Playoffs ────────────────────────────────────────────────────

  /** Returns the full playoffs object, or null if not yet generated. */
  getPlayoffs(seasonId) {
    const season = this.getSeason(seasonId);
    if (!season) return null;
    return season.playoffs;
  },

  /**
   * Finds a single Round 1 match, Round 2 series, Finals semifinal, or the
   * Championship series by id anywhere in the bracket. Returns
   * { item, kind } (kind: 'round1'|'round2'|'semifinal'|'championship'),
   * or null if not found / playoffs not generated yet.
   */
  getPlayoffItem(seasonId, itemId) {
    const season = this.getSeason(seasonId);
    if (!season || !season.playoffs) return null;
    return findPlayoffItem(season.playoffs, itemId);
  },

  // ── Phase 5: Trading / Swap System (read-only) ──────────────────────────

  /** Current pot total and season day — for the Pot/Fee summary panel. */
  getTransactionState(seasonId) {
    const season = this.getSeason(seasonId);
    if (!season) return null;
    return {
      pot: season.pot ?? 0,
      currentSeasonDay: season.currentSeasonDay ?? 1,
      transactionsLocked: isTransactionsLockedDay(season.currentSeasonDay ?? 1),
      feeDoubled: isFeeDoubleDay(season.currentSeasonDay ?? 1),
    };
  },

  /** Full transaction history, most recent first. */
  getTransactionHistory(seasonId) {
    const season = this.getSeason(seasonId);
    if (!season) return [];
    return [...(season.transactions || [])].reverse();
  },

  // ── Financial Management (F4 — Financial Calculations, read-only) ───────
  // Everything below derives entirely from season.transactions[] (the same
  // ledger written by recordEntryFeePayment/commitTrade/commitSwap) plus
  // season.financialSettings — never a stored participant balance, never a
  // new collection. Nothing here calls saveData() or mutates `season`; a
  // missing season.financialSettings is handled the same inline-fallback
  // way getTransactionState() already handles a missing season.pot above
  // (`season.pot ?? 0`) — read-only methods don't call ensureFinancialFields
  // (that's a write-path backfill helper, per F1/F2/F3), they just fall
  // back to the F1 defaults for display purposes without persisting them.

  /**
   * One participant's derived financial account for a season.
   * Returns null if the season or participant doesn't exist (same
   * not-found convention as getParticipant()).
   *
   * Trade-fee attribution rule (see F3): tradeFeesPaid sums `tradeFeeSplit`
   * transactions only — never the original `trade` transaction's `fee`,
   * which represents the trade EVENT's total, not this participant's
   * share, and would double the real amount if added on top of the splits.
   *
   * Swap-fee rule: sums the `fee` field of this participant's own `swap`/
   * `jokerSwap` transactions (both single-participant, teamA-only, per
   * commitSwap — no split needed). `jokerDesignation` (fee is always 0)
   * and `tenthPickBlueFee` (a draft-time charge, not a swap) are
   * intentionally excluded — see getFinancialSummary's doc comment for
   * why tenthPickBlueFee sits outside all three F4 categories.
   *
   * outstandingBalance: under the current system every entryFee/
   * tradeFeeSplit/swap transaction is written already `status: "paid"` at
   * the moment it's created — there is no "charged but unpaid" state
   * anywhere in the existing ledger. The only real outstanding obligation
   * this data can represent is therefore an entry fee that hasn't been
   * recorded yet (see F4 spec section 6) — not a manufactured debt system.
   *
   * freeTradesRemaining/freeSwapsRemaining: delegated to
   * getFreeAllowanceRemaining() below — see that method's doc comment for
   * why these come back null rather than a fabricated number.
   *
   * F6 Revision 2 (charge vs. payment — see f6ParticipantBreakdown's doc
   * comment for the full model): entryFeePaid/tradeFeesPaid/swapFeesPaid/
   * totalPaid/outstandingBalance below are now driven by that breakdown
   * instead of assuming a charge transaction's mere existence means it
   * was paid. New fields entryFeeCharged/entryFeeUnpaid,
   * tradeFeesCharged/tradeFeesUnpaid, swapFeesCharged/swapFeesUnpaid,
   * totalCharges/totalUnpaid are added for the Charged|Paid|Unpaid
   * dashboard (F6 Revision 2 spec section 16). Existing field NAMES are
   * all kept for backward compatibility — tradeFeesPaid/swapFeesPaid/
   * totalPaid now mean actual money paid (not charged), which is what
   * their names always implied; outstandingBalance is generalized from
   * "unpaid entry fee only" to "total unpaid across all three
   * categories, net of credit/debit" (credits/debits remain a season-
   * wide ledger adjustment only, unchanged from before — see
   * AdminActions.recordFinancialCredit/Debit).
   */
  getParticipantFinancialAccount(seasonId, participantId) {
    const season = this.getSeason(seasonId);
    if (!season) return null;
    const participant = season.participants[participantId];
    if (!participant) return null;

    const transactions = season.transactions || [];
    const breakdown = f6ParticipantBreakdown(season, participantId);

    const totalCredits = transactions
      .filter((t) => t.type === "credit" && t.teamA === participantId)
      .reduce((sum, t) => sum + (t.amount || 0), 0);
    const totalDebits = transactions
      .filter((t) => t.type === "debit" && t.teamA === participantId)
      .reduce((sum, t) => sum + (t.amount || 0), 0);
    const streamerSalaryReceived = transactions
      .filter((t) => t.type === "streamerSalary" && t.teamA === participantId)
      .reduce((sum, t) => sum + (t.amount || 0), 0);

    const entryFeePaid = breakdown.entryFee.unpaid <= 0;
    const outstandingBalance = breakdown.totalUnpaid - totalCredits + totalDebits;

    const allowance = this.getFreeAllowanceRemaining(seasonId, participantId);

    return {
      participantId,
      entryFee: breakdown.entryFee.charged,
      entryFeePaid,
      entryFeeCharged: breakdown.entryFee.charged,
      entryFeeUnpaid: breakdown.entryFee.unpaid,
      tradeFeesPaid: breakdown.tradeFee.paid,
      tradeFeesCharged: breakdown.tradeFee.charged,
      tradeFeesUnpaid: breakdown.tradeFee.unpaid,
      swapFeesPaid: breakdown.swapFee.paid,
      swapFeesCharged: breakdown.swapFee.charged,
      swapFeesUnpaid: breakdown.swapFee.unpaid,
      totalCharges: breakdown.totalCharged,
      totalPaid: breakdown.totalPaid,
      totalUnpaid: breakdown.totalUnpaid,
      outstandingBalance,
      freeTradesRemaining: allowance?.freeTradesRemaining ?? null,
      freeSwapsRemaining: allowance?.freeSwapsRemaining ?? null,
      tradeCount: breakdown.tradeFeeTransactions.length,
      swapCount: breakdown.swapFeeTransactions.length,
      entryFeeTransaction: breakdown.entryFeeTransaction,
      tradeFeeTransactions: breakdown.tradeFeeTransactions,
      swapFeeTransactions: breakdown.swapFeeTransactions,
      paymentTransactions: breakdown.paymentTransactions,
      // F6 additions:
      totalRefunded: breakdown.totalRefunded,
      totalCredits,
      totalDebits,
      streamerSalaryReceived,
    };
  },

  /**
   * League-wide derived financial summary for a season.
   * Returns null if the season doesn't exist.
   *
   * Avoiding double-counting (F4 spec section 9-11): tradeFeesCollected
   * sums `tradeFeeSplit` records only — the original `trade` transaction's
   * `fee` is NOT added again; a ₱200 trade contributes ₱200 once (as
   * ₱100+₱100 across its two splits), never ₱400. entryFeesCollected and
   * swapFeesCollected each read only their own transaction type, so no
   * transaction is ever counted toward more than one category.
   *
   * tenthPickBlueFee is real pot revenue but fits none of the three named
   * categories (entry/trade/swap) — it's a draft-time charge, not
   * requested as a category by F4. It's deliberately left out of
   * totalCollected/ledgerCalculatedTotal rather than silently folded into
   * one of the three, which is why potDifference below will legitimately
   * be non-zero whenever any 10th-pick-Blue fees exist this season — that
   * is expected, not a bug, and nothing here "fixes" it. Refunds and
   * streamer-salary payouts are the other pre-existing, documented source
   * of legitimate potDifference drift — see expectedPot/potDifferenceV2
   * below, which account for those; potDifference itself intentionally
   * does not.
   *
   * F6 Revision 2 naming note: despite the name, entryFeesCollected/
   * tradeFeesCollected/swapFeesCollected/totalCollected now include
   * `"pending"` (charged-but-unpaid) transactions too, not only ones
   * that have actually been paid — because season.pot itself is
   * increased at CHARGE time now, not payment time (see
   * addParticipant()/commitTrade()/commitSwap()), and these three sums
   * exist specifically to let potDifference cross-check pot, so they
   * have to track the same "charged" event pot does, not "paid". The
   * name predates that change and reads as though it means "actually
   * collected"; renaming it would touch every call site across F4/F5/F6
   * for a purely cosmetic reason, which is out of scope here — the
   * accurate "was this actually paid" figures are getParticipantFinancialAccount's
   * entryFeeCharged/Paid/Unpaid (per participant) and this same method's
   * own entryFeeChargedTotal/entryFeePaidTotal/entryFeeUnpaidTotal (and
   * the tradeFee/swapFee equivalents) below — those are what the F6
   * Revision 2 dashboard actually displays as Charged/Paid/Unpaid; this
   * field is kept only for the pot reconciliation diagnostic and any
   * existing code/tests already reading it.
   *
   * A voided charge is excluded from these three sums if — and only if —
   * it was still `"pending"` (never collected) at the moment it was
   * voided, via f6StillCountsAsCollected: voidFinancialTransaction() only
   * reverses season.pot for that exact case (see its doc comment), so
   * excluding it here too is what keeps potDifference/expectedPot
   * meaningful after a pending-charge void instead of drifting stale. A
   * voided charge that was already collected (paid) when voided still
   * counts here, matching pot, which void never touched for that case.
   *
   * pot/ledgerCalculatedTotal/potDifference are diagnostic only
   * (F4 spec section 13) — season.pot itself is never read from here for
   * any of the three main categories, and is never written to.
   */
  getFinancialSummary(seasonId) {
    const season = this.getSeason(seasonId);
    if (!season) return null;

    const participants = Object.values(season.participants || {});
    const transactions = season.transactions || [];
    const entryFee = Number.isFinite(season.financialSettings?.entryFee)
      ? season.financialSettings.entryFee
      : 300;

    const entryFeeTxns = transactions.filter((t) => t.type === "entryFee");
    // entryFeesPaidCount/entryFeesUnpaidCount are a separate, pre-existing
    // legacy diagnostic (transaction-exists count, not a money total) —
    // left exactly as before; only the money sum below needs the voided-
    // while-pending exclusion (see f6StillCountsAsCollected's doc comment).
    const entryFeesCollected = entryFeeTxns
      .filter((t) => f6StillCountsAsCollected(transactions, t))
      .reduce((sum, t) => sum + (t.amount || 0), 0);
    const entryFeesPaidCount = entryFeeTxns.length;
    const entryFeesUnpaidCount = Math.max(0, participants.length - entryFeesPaidCount);

    const tradeFeeSplitTxns = transactions.filter((t) => t.type === "tradeFeeSplit");
    const tradeFeesCollected = tradeFeeSplitTxns
      .filter((t) => f6StillCountsAsCollected(transactions, t))
      .reduce((sum, t) => sum + (t.amount || 0), 0);
    const tradeFeeTransactionCount = transactions.filter((t) => t.type === "trade").length;

    const swapTxns = transactions.filter((t) => t.type === "swap" || t.type === "jokerSwap");
    const swapFeesCollected = swapTxns
      .filter((t) => f6StillCountsAsCollected(transactions, t))
      .reduce((sum, t) => sum + (t.fee || 0), 0);
    const swapTransactionCount = swapTxns.length;

    const totalCollected = entryFeesCollected + tradeFeesCollected + swapFeesCollected;
    const outstandingBalance = entryFeesUnpaidCount * entryFee;

    const pot = season.pot ?? 0;
    const ledgerCalculatedTotal = totalCollected;
    const potDifference = pot - ledgerCalculatedTotal;

    // ── F6 additions (read-only, additive) ─────────────────────────────
    // totalCollected/ledgerCalculatedTotal/potDifference above are left
    // completely untouched, per F6 instruction — they keep meaning exactly
    // what they meant before F6 existed. These new fields answer the
    // F6-aware question instead: given every known pot-affecting event
    // (entry/trade/swap/10th-pick-Blue fees in, refunds and streamer
    // salary payouts out — credits/debits are ledger-only and never
    // touch pot), does season.pot reconcile? expectedPot should equal
    // season.pot barring a bug; potDifferenceV2 is that cross-check.
    const tenthPickBlueFeesCollected = transactions
      .filter((t) => t.type === "tenthPickBlueFee")
      .reduce((sum, t) => sum + (t.fee || 0), 0);
    const totalRefunded = transactions
      .filter((t) => t.type === "refund")
      .reduce((sum, t) => sum + (t.amount || 0), 0);
    const totalCredits = transactions
      .filter((t) => t.type === "credit")
      .reduce((sum, t) => sum + (t.amount || 0), 0);
    const totalDebits = transactions
      .filter((t) => t.type === "debit")
      .reduce((sum, t) => sum + (t.amount || 0), 0);
    const totalStreamerSalaryPaid = transactions
      .filter((t) => t.type === "streamerSalary")
      .reduce((sum, t) => sum + (t.amount || 0), 0);
    const voidedCount = transactions.filter((t) => t.type === "void").length;

    const expectedPot = totalCollected + tenthPickBlueFeesCollected - totalRefunded - totalStreamerSalaryPaid;
    const potDifferenceV2 = pot - expectedPot;

    // ── F6 Revision 2 — Charged / Paid / Unpaid (season-wide) ───────────
    // This is the primary new dashboard requirement: "how much is in the
    // pot" (pot, above) answered separately from "how much of that has
    // not been paid yet" (totalUnpaidAll, below). Computed by summing
    // every participant's f6ParticipantBreakdown — the exact same
    // per-participant function the Financial Management participant table
    // and getParticipantFinancialAccount both use, so the season-wide
    // totals always agree with what each participant's row shows.
    const participantIds = Object.keys(season.participants || {});
    const breakdowns = participantIds.map((pid) => f6ParticipantBreakdown(season, pid));
    const sumField = (cat, key) => breakdowns.reduce((sum, b) => sum + b[cat][key], 0);
    const totalChargesAll = breakdowns.reduce((sum, b) => sum + b.totalCharged, 0);
    const totalPaidAll = breakdowns.reduce((sum, b) => sum + b.totalPaid, 0);
    const totalUnpaidAll = breakdowns.reduce((sum, b) => sum + b.totalUnpaid, 0);

    return {
      seasonId,
      entryFeesCollected,
      tradeFeesCollected,
      swapFeesCollected,
      totalCollected,
      outstandingBalance,
      participants: participants.length,
      entryFeesPaidCount,
      entryFeesUnpaidCount,
      tradeFeeTransactionCount,
      swapTransactionCount,
      // Diagnostic cross-check only — see doc comment above. Never
      // written back to season.pot.
      pot,
      ledgerCalculatedTotal,
      potDifference,
      // F6 Revision 2 — Charged/Paid/Unpaid, season-wide:
      totalChargesAll,
      totalPaidAll,
      totalUnpaidAll,
      entryFeeChargedTotal: sumField("entryFee", "charged"),
      entryFeePaidTotal: sumField("entryFee", "paid"),
      entryFeeUnpaidTotal: sumField("entryFee", "unpaid"),
      tradeFeeChargedTotal: sumField("tradeFee", "charged"),
      tradeFeePaidTotal: sumField("tradeFee", "paid"),
      tradeFeeUnpaidTotal: sumField("tradeFee", "unpaid"),
      swapFeeChargedTotal: sumField("swapFee", "charged"),
      swapFeePaidTotal: sumField("swapFee", "paid"),
      swapFeeUnpaidTotal: sumField("swapFee", "unpaid"),
      // F6 additions:
      tenthPickBlueFeesCollected,
      totalRefunded,
      totalCredits,
      totalDebits,
      totalStreamerSalaryPaid,
      voidedCount,
      expectedPot,
      potDifferenceV2,
    };
  },

  /**
   * Configured free-trade/free-swap allowance for a participant.
   * Returns null if the season or participant doesn't exist.
   *
   * IMPORTANT LIMITATION (F4 spec sections 15-16): commitTrade()/
   * commitSwap() charge every trade/swap its full computed fee
   * unconditionally — there is no branch anywhere in either function that
   * charges ₱0 for a "free" use, and no field on any trade/swap
   * transaction that records whether it consumed a free allowance. Every
   * `trade`/`swap`/`jokerSwap` transaction in the ledger is therefore
   * indistinguishable from any other on this question — there is nothing
   * in season.transactions[] that reliably answers "was this particular
   * trade free or paid?", so freeTradesRemaining/freeSwapsRemaining
   * cannot be derived here without inventing a rule the actual charging
   * system never applied (e.g. "assume the first N trades were free" —
   * which would be fiction, since those trades were, in fact, fully
   * charged in the ledger).
   *
   * Per that instruction, this returns the configured limits plus null
   * for the "remaining" fields rather than a fabricated number. Making
   * this derivable for real would need a future phase to change
   * commitTrade()/commitSwap() to record whether each specific use was
   * free (e.g. a `wasFree: true` field, or genuinely charging ₱0) — not
   * something F4 does, since that would mean modifying those two write
   * functions, which F4 is explicitly scoped not to touch.
   */
  getFreeAllowanceRemaining(seasonId, participantId) {
    const season = this.getSeason(seasonId);
    if (!season) return null;
    if (!season.participants[participantId]) return null;

    const freeTrades = Number.isFinite(season.financialSettings?.freeTrades)
      ? season.financialSettings.freeTrades
      : 2;
    const freeSwaps = Number.isFinite(season.financialSettings?.freeSwaps)
      ? season.financialSettings.freeSwaps
      : 2;

    return {
      participantId,
      freeTrades,
      freeSwaps,
      freeTradesRemaining: null,
      freeSwapsRemaining: null,
      limitation:
        "The existing trade/swap system charges every trade/swap its full fee unconditionally — season.transactions[] has no record of which uses (if any) were meant to be free, so remaining free-trade/free-swap counts cannot be reliably derived from the current ledger. This is not a bug in this read method; it reflects what commitTrade()/commitSwap() actually record today.",
    };
  },

  /**
   * Classification info for one player: { classification, ownPickNumber,
   * originalOwnerId, currentOwnerId, isJoker }. See
   * getPlayerClassificationInfo above for the full contract.
   */
  getPlayerClassification(seasonId, playerId) {
    const season = this.getSeason(seasonId);
    if (!season) return null;
    return getPlayerClassificationInfo(season, playerId);
  },

  /**
   * Every player currently on a participant's roster, enriched with pool,
   * effective position, and classification — the read the Trade/Swap
   * builder UI uses to populate pickers.
   */
  getRosterForTransactions(seasonId, participantId) {
    const season = this.getSeason(seasonId);
    if (!season) return [];
    const data = loadData();
    const entries = (season.currentRosters && season.currentRosters[participantId]) || [];
    return entries.map((entry) => {
      const player = data.players[entry.playerId] || null;
      const classification = getPlayerClassificationInfo(season, entry.playerId);
      return {
        ...entry,
        player,
        effectivePosition: player ? getEffectivePosition(entry, player) : null,
        classification: classification.classification,
      };
    });
  },

  /**
   * Free-agent players eligible as a swap replacement: currently unowned
   * by any participant's currentRosters (i.e. never drafted, or previously
   * swapped back to the pool), matching the requested pool.
   */
  getSwapEligibleReplacements(seasonId, pool) {
    const season = this.getSeason(seasonId);
    if (!season) return [];
    const data = loadData();
    const ownedIds = new Set();
    Object.values(season.currentRosters || {}).forEach((entries) => {
      entries.forEach((e) => ownedIds.add(e.playerId));
    });
    return Object.values(data.players).filter(
      (p) => !ownedIds.has(p.id) && (!pool || p.pool === pool)
    );
  },

  /**
   * A participant's current Joker entry, if any (there can be at most one
   * per participant at a time — see AdminActions.designateJoker).
   */
  getJoker(seasonId, participantId) {
    const season = this.getSeason(seasonId);
    if (!season) return null;
    const entries = (season.currentRosters && season.currentRosters[participantId]) || [];
    const entry = entries.find((e) => e.isJoker);
    if (!entry) return null;
    const data = loadData();
    return { ...entry, player: data.players[entry.playerId] || null };
  },

  /**
   * Players on a participant's roster eligible to become their Joker:
   * whoever currently occupies one of their own draft picks #1-10 (Rule C,
   * revised — Joker eligibility is no longer restricted to picks #6-10;
   * any of a participant's own first 10 picks may be designated Joker),
   * not already the Joker. Returns [] once a participant's own picks run
   * out (fewer than 1, i.e. none yet).
   *
   * Eligibility is read from each entry's CURRENT `draftSlot` on
   * season.currentRosters — the same "own pick #1-10" slot Manual Roster
   * Edit already preserves across Add/Fill-Slot/Replace (Revision —
   * Preserve Original Draft Pick Slot) — rather than from the immutable
   * playerDraftPicks history. playerDraftPicks only records who was
   * originally drafted into a slot, so a manually-added player filling a
   * vacated own-pick slot would never appear there and could never be
   * offered as Joker-eligible even though they now legitimately hold that
   * pick. (Bugfix — Missing Joker Icon on Manually Added Players.) This
   * does not affect Red/Yellow classification, which intentionally still
   * traces back to the original draftee via getOriginalPickInfo.
   */
  getJokerEligiblePlayers(seasonId, participantId) {
    const season = this.getSeason(seasonId);
    if (!season) return [];
    const data = loadData();
    const roster = (season.currentRosters && season.currentRosters[participantId]) || [];
    // Legacy fallback for rosters saved before the "Preserve Original
    // Draft Pick Slot" revision (mirrors getCurrentRoster/
    // ensureRosterDraftSlots) — not persisted here since this is a
    // read-only method.
    const ownPicks = (season.playerDraftPicks || []).filter((p) => p.participantId === participantId);
    return roster
      .filter((e) => e.playerId)
      .map((e) => {
        let ownPickNumber = e.draftSlot;
        if (ownPickNumber === undefined) {
          const pickIdx = ownPicks.findIndex((p) => p.playerId === e.playerId);
          ownPickNumber = pickIdx === -1 ? null : pickIdx + 1;
        }
        return { playerId: e.playerId, player: data.players[e.playerId] || null, ownPickNumber };
      })
      .filter((e) => e.player && e.ownPickNumber != null && e.ownPickNumber >= 1 && e.ownPickNumber <= 10);
  },

  /**
   * Revision 3 — Validate Rosters: a pure, read-only diagnostic over EVERY
   * participant's currentRosters for a season. Never mutates season data —
   * no saveData() call anywhere in this function or anything it calls.
   *
   * Reuses the exact same rule functions the normal (non-manual) write
   * paths already enforce — validateRatingCap, countPositionsForRoster/
   * CORE_POSITIONS, validateBlueComposition, validateMinimumRating,
   * MAX_PLAYERS_PER_POSITION, MAX_ROSTER_SIZE, getOriginalPickInfo — so
   * this never invents a second copy of any roster rule. "Available" is
   * still derived from currentRosters membership only (see
   * getSwapEligibleReplacements) — there is no second available-player
   * list for this to conflict with, so no separate "pool integrity" check
   * is needed beyond the duplicate-ownership check below.
   *
   * Returns:
   *   {
   *     valid,          // true iff errors.length === 0
   *     teamsChecked,   // actual participant count this season (never hard-coded)
   *     errors:   [{ teamId, teamName, type, message }],  // teamId is null for a league-wide (cross-team) finding
   *     warnings: [{ teamId, teamName, type, message }],
   *   }
   */
  validateAllRosters(seasonId) {
    const season = this.getSeason(seasonId);
    if (!season) {
      return {
        valid: false,
        teamsChecked: 0,
        errors: [{ teamId: null, teamName: null, type: "SEASON_NOT_FOUND", message: "Season not found." }],
        warnings: [],
      };
    }
    const data = loadData();
    const playersById = data.players;
    const cap = season.ratingCap ?? 875;
    const currentRosters = season.currentRosters || {};

    // Same ordering/fallback logic as getRosterSummary, so "teams checked"
    // matches what the admin roster grid itself shows.
    const orderedIds = [...(season.playerDraftOrder || [])];
    const orderedSet = new Set(orderedIds);
    const fallbackIds = Object.keys(season.participants)
      .filter((id) => !orderedSet.has(id))
      .sort();
    const participantIds = [...orderedIds, ...fallbackIds].filter((id) => season.participants[id]);

    const errors = [];
    const warnings = [];
    const teamName = (teamId) => (teamId ? season.participants[teamId]?.name || teamId : null);
    const addError = (teamId, type, message) => errors.push({ teamId, teamName: teamName(teamId), type, message });
    const addWarning = (teamId, type, message) => warnings.push({ teamId, teamName: teamName(teamId), type, message });

    const ownerTeamsByPlayerId = {}; // playerId -> [participantId, ...] across the whole league

    for (const participantId of participantIds) {
      const roster = currentRosters[participantId] || [];
      const filledEntries = roster.filter((e) => e.source !== "empty" && e.playerId);

      // 7/8: duplicate roster entries + invalid/missing player records
      const seenOnThisRoster = new Set();
      for (const entry of filledEntries) {
        if (seenOnThisRoster.has(entry.playerId)) {
          addError(participantId, "DUPLICATE_ROSTER_ENTRY",
            `${playersById[entry.playerId]?.name || entry.playerId} appears more than once on this roster.`);
        }
        seenOnThisRoster.add(entry.playerId);

        if (!playersById[entry.playerId]) {
          addError(participantId, "INVALID_PLAYER",
            `Roster entry references an unknown/invalid player ID (${entry.playerId}).`);
        }

        (ownerTeamsByPlayerId[entry.playerId] ||= []).push(participantId);
      }

      // Only players that actually resolve can be safely fed into the
      // rating/position/pool rule functions below (they all key off
      // playersById internally too, but skipping here keeps totals from
      // being silently computed against a missing player as 0 OVR).
      const resolvableEntries = filledEntries.filter((e) => playersById[e.playerId]);

      // 1. Rating cap
      const capCheck = validateRatingCap(resolvableEntries, playersById, cap);
      if (!capCheck.valid) {
        const total = resolvableEntries.reduce((sum, e) => sum + (playersById[e.playerId]?.overall ?? 0), 0);
        addError(participantId, "RATING_CAP",
          `Rating cap exceeded — total ${total} OVR, limit ${cap}, over by ${total - cap}.`);
      }

      // 2. Position requirements — missing core positions and any position
      // over the max-per-position rule, both using each entry's EFFECTIVE
      // position (Joker-aware) exactly like the normal write paths do.
      const posCounts = countPositionsForRoster(resolvableEntries, playersById);
      for (const pos of CORE_POSITIONS) {
        if (!posCounts[pos]) addError(participantId, "MISSING_POSITION", `Missing ${pos}.`);
      }
      for (const pos of Object.keys(posCounts)) {
        if (posCounts[pos] > MAX_PLAYERS_PER_POSITION) {
          addError(participantId, "POSITION_OVER_MAX",
            `${posCounts[pos]} players at ${pos} (max ${MAX_PLAYERS_PER_POSITION}).`);
        }
      }

      // 3. Blue/Green composition
      const blueCheck = validateBlueComposition(resolvableEntries, playersById);
      if (!blueCheck.valid) addError(participantId, "BLUE_COMPOSITION", blueCheck.reason);

      // 4. Minimum rating
      for (const entry of resolvableEntries) {
        const minCheck = validateMinimumRating(playersById[entry.playerId]);
        if (!minCheck.valid) addError(participantId, "MINIMUM_RATING", minCheck.reason);
      }

      // 5. Roster size — the existing configured maximum (never hard-coded).
      if (resolvableEntries.length > MAX_ROSTER_SIZE) {
        addError(participantId, "ROSTER_SIZE",
          `Roster has ${resolvableEntries.length} players (max ${MAX_ROSTER_SIZE}).`);
      }

      // 9. Draft slot integrity — report only, never repair.
      for (const entry of roster) {
        if (entry.draftSlot != null && (!Number.isInteger(entry.draftSlot) || entry.draftSlot < 1)) {
          addError(participantId, "DRAFT_SLOT",
            `Invalid draft slot value (${JSON.stringify(entry.draftSlot)}) on a roster entry.`);
        }
      }

      // 11. Joker integrity
      const jokerEntries = roster.filter((e) => e.isJoker);
      if (jokerEntries.length > 1) {
        addError(participantId, "JOKER_MULTIPLE",
          `${jokerEntries.length} players are marked as Joker on this roster — only one is allowed at a time.`);
      }
      for (const entry of jokerEntries) {
        const p = entry.playerId ? playersById[entry.playerId] : null;
        if (!entry.playerId || !p) {
          addError(participantId, "JOKER_STATE", "A Joker-marked roster entry has no valid player.");
          continue;
        }
        if (!entry.jokerPosition) {
          addError(participantId, "JOKER_STATE", `${p.name} is marked Joker but has no jokerPosition set.`);
        }
        if (entry.draftSlot == null || entry.draftSlot < 1 || entry.draftSlot > 10) {
          addError(participantId, "JOKER_ELIGIBILITY",
            `${p.name} is marked Joker but is not on one of this participant's own picks #1-10 ` +
            `(draftSlot: ${entry.draftSlot ?? "none"}).`);
        }
      }

      // 12. Classification integrity — can classificationSourcePlayerId
      // still resolve to an original draft pick? Report-only, per spec.
      for (const entry of roster) {
        if (entry.classificationSourcePlayerId
          && !getOriginalPickInfo(season, entry.classificationSourcePlayerId)) {
          addWarning(participantId, "CLASSIFICATION_SOURCE",
            `Invalid classification source — the Red/Yellow tag for pick #${entry.draftSlot ?? "?"} ` +
            `can no longer be traced back to an original draft pick.`);
        }
      }
    }

    // 6. Duplicate ownership — league-wide, across ALL teams.
    for (const [playerId, teamIds] of Object.entries(ownerTeamsByPlayerId)) {
      const uniqueTeamIds = [...new Set(teamIds)];
      if (uniqueTeamIds.length > 1) {
        addError(null, "DUPLICATE_PLAYER",
          `${playersById[playerId]?.name || playerId} is assigned to multiple rosters: ` +
          `${uniqueTeamIds.map((id) => teamName(id)).join(", ")}.`);
      }
    }

    return {
      valid: errors.length === 0,
      teamsChecked: participantIds.length,
      errors,
      warnings,
    };
  },
};

// ─── Admin Write API ──────────────────────────────────────────────────────────
// IMPORTANT: These functions MUST only be called from admin context,
// after the auth boundary has been cleared (see auth-boundary.js).
//
// In Phase 1, the auth boundary is a UI gate that will enforce a real
// backend session in production. Do NOT call AdminActions from public JS.

const AdminActions = {
  // Seasons
  /**
   * @param financialSettings — optional { entryFee, freeTrades, freeSwaps }
   *   overrides for the F1 defaults baked into createSeason() (300/2/2).
   *   Only used at creation time (per F1 scope — no separate "edit an
   *   existing season's settings" action exists yet). Any field omitted
   *   keeps the factory default; any field provided must be a finite
   *   number >= 0, or this throws — same validation style as
   *   setRatingCap/setSeasonDay below.
   */
  createSeason(name, financialSettings) {
    const data = loadData();
    const id = generateId("s");
    const season = createSeason(id, name);

    if (financialSettings && typeof financialSettings === "object") {
      for (const key of ["entryFee", "freeTrades", "freeSwaps"]) {
        if (financialSettings[key] === undefined) continue;
        const n = Number(financialSettings[key]);
        if (!Number.isFinite(n) || n < 0) {
          throw new Error(`${key} must be a non-negative number.`);
        }
        season.financialSettings[key] = n;
      }
    }

    data.seasons[id] = season;
    if (!data.settings.currentSeasonId) {
      data.settings.currentSeasonId = id;
    }
    saveData(data);
    return season;
  },

  setCurrentSeason(seasonId) {
    const data = loadData();
    if (!data.seasons[seasonId]) throw new Error("Season not found");
    data.settings.currentSeasonId = seasonId;
    saveData(data);
  },

  updateSeasonStatus(seasonId, status) {
    const validStatuses = [
      "setup", "draft", "team_assignment",
      "regular_season", "playoffs", "complete",
    ];
    if (!validStatuses.includes(status)) throw new Error("Invalid status");
    const data = loadData();
    if (!data.seasons[seasonId]) throw new Error("Season not found");
    data.seasons[seasonId].status = status;
    saveData(data);
  },

  deleteSeason(seasonId) {
    const data = loadData();
    if (!data.seasons[seasonId]) throw new Error("Season not found");
    delete data.seasons[seasonId];
    if (data.settings.currentSeasonId === seasonId) {
      const remaining = Object.keys(data.seasons);
      data.settings.currentSeasonId = remaining.length ? remaining[0] : null;
    }
    saveData(data);
  },

  // Participants
  /**
   * F6 Revision 2: a participant becomes liable for this season's entry
   * fee the moment they join — the charge is recorded immediately as a
   * `status: "pending"` entryFee transaction, and season.pot is increased
   * by the full configured amount right now (the "pot = total charged"
   * model — see f6ParticipantBreakdown's doc comment). Whether/when they
   * actually pay it is tracked completely separately via `payment`
   * transactions (recordFinancialPayment / the adapted
   * recordEntryFeePayment below) and never touches pot again. Skipped
   * entirely if entryFee is configured as 0 — consistent with the
   * existing no-unnecessary-₱0-records rule commitTrade's tradeFeeSplit
   * already follows (`if (evaluation.fee > 0)`).
   *
   * A participant added under the OLD code (before this revision
   * shipped) has no such transaction — recordEntryFeePayment() below
   * detects that and falls back to its original one-shot behavior for
   * them, so no historical data is migrated or rewritten.
   */
  addParticipant(seasonId, name) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    ensureFinancialFields(season);
    ensureTransactionFields(season);

    const id = generateId("p");
    season.participants[id] = createParticipant(id, name.trim());

    const entryFee = season.financialSettings.entryFee;
    if (Number.isFinite(entryFee) && entryFee > 0) {
      season.transactions.push({
        id: generateId("txn"),
        seasonId,
        seasonDay: season.currentSeasonDay,
        timestamp: new Date().toISOString(),
        type: "entryFee",
        teamA: id,
        teamB: null,
        playersOut: [],
        playersIn: [],
        amount: entryFee,
        status: "pending",
        relatedTransactionId: null,
        description: "Entry fee",
        approvedBy: "commissioner",
      });
      season.pot = (season.pot || 0) + entryFee;
    }

    saveData(data);
    return season.participants[id];
  },

  updateParticipant(seasonId, participantId, name) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season || !season.participants[participantId])
      throw new Error("Participant not found");
    season.participants[participantId].name = name.trim();
    saveData(data);
  },

  removeParticipant(seasonId, participantId) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    delete season.participants[participantId];
    // Also remove from draft/assignment orders if present
    season.playerDraftOrder = season.playerDraftOrder.filter(
      (id) => id !== participantId
    );
    season.teamAssignmentOrder = season.teamAssignmentOrder.filter(
      (id) => id !== participantId
    );
    delete season.nbaTeamAssignments[participantId];
    saveData(data);
  },

  // ── Process 1: Player Draft Order (entered from DuckRace result) ──────────
  // participantIds must be an ordered array of participant IDs.
  setPlayerDraftOrder(seasonId, participantIds) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    // Validate all IDs exist as participants
    for (const id of participantIds) {
      if (!season.participants[id])
        throw new Error(`Participant ID not found: ${id}`);
    }
    season.playerDraftOrder = [...participantIds];
    saveData(data);
  },

  /**
   * Records the next pick in the live snake draft.
   *
   * Round, pick number, and the drafting participant are all COMPUTED
   * from season.playerDraftOrder and the current length of
   * season.playerDraftPicks — never passed in — so a pick can never be
   * recorded out of step with the snake order. This replaces the old
   * Phase 1 placeholder (manual round/pick entry), which was unused and
   * could have let a pick be saved with an inconsistent round/pick.
   *
   * Uses the same snake formula as the Draft Orders preview: odd rounds
   * go in playerDraftOrder's stored order, even rounds reverse it.
   */
  makeDraftPick(seasonId, playerId) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    ensureTransactionFields(season); // backfill for seasons created before Phase 5
    ensureDraftSkipFields(season); // backfill for seasons created before Revision 1
    if (!season.playerDraftOrder.length)
      throw new Error("Set the player draft order before drafting.");
    const player = data.players[playerId];
    if (!player) throw new Error("Player not found");

    const alreadyDrafted = season.playerDraftPicks.some(
      (p) => p.playerId === playerId
    );
    if (alreadyDrafted) throw new Error("Player already drafted");

    // ── Phase 4B: variant-group lock ────────────────────────────────────
    // If this player belongs to a variant group (e.g. multiple LeBron
    // James cards sharing variantGroup "lebron-james") and any other
    // member of that group has already been drafted by anyone, this pick
    // is rejected. Undrafted, ungrouped players are unaffected.
    if (player.variantGroup) {
      const groupAlreadyDrafted = season.playerDraftPicks.some((p) => {
        const pickedPlayer = data.players[p.playerId];
        return pickedPlayer && pickedPlayer.variantGroup === player.variantGroup;
      });
      if (groupAlreadyDrafted) {
        throw new Error(
          `Another variant of "${player.name}" has already been drafted.`
        );
      }
    }

    // Revision 1: who's on the clock (and which round) is now derived via
    // computeDraftSchedule, which accounts for Skip/bonus-double-pick
    // turns — see its doc comment. `pick` remains a simple incrementing
    // counter of actual picks made, same meaning as before.
    const schedule = computeDraftSchedule(season);
    if (!schedule.currentParticipantId) {
      throw new Error("No active turn — set the draft order first.");
    }
    const participantId = schedule.currentParticipantId;
    const round = schedule.currentRound;
    const pick = season.playerDraftPicks.length + 1;

    // ── Phase 4B: mandatory first-five-positions rule ───────────────────
    // Enforced here at the data layer (not just in the UI) so the rule
    // cannot be bypassed. While this participant hasn't yet filled all of
    // PG/SG/SF/PF/C, they may only draft a player at a position they
    // still need. A player with no recognized position is rejected during
    // this phase too, since it's unclear which slot it would fill.
    const posState = computePositionState(season, data.players, participantId);
    if (!posState.allFilled) {
      if (!CORE_POSITIONS.includes(player.position)) {
        throw new Error(
          `"${player.name}" has no recognized position (PG/SG/SF/PF/C). ` +
          `Complete PG, SG, SF, PF, and C first: still need ${posState.missing.join(", ")}.`
        );
      }
      if (posState.filled[player.position]) {
        throw new Error(
          `This participant already has a ${player.position}. ` +
          `Complete their remaining positions (${posState.missing.join(", ")}) ` +
          `before drafting another ${player.position}.`
        );
      }
    }

    // ── Position cap: max 2 players per position, across ALL 10 picks ───
    // Not just the mandatory-first-five phase (picks 1-5, above) — the cap
    // applies for the whole draft. Picks 1-5 already can't exceed 1 per
    // position (the rule above enforces that), so this only starts to
    // matter from pick 6 onward: a "sub" pick can only go to one of the
    // 5 positions already started in the first five, and each position
    // tops out at MAX_PLAYERS_PER_POSITION (2) — the same cap Phase 5
    // already enforces on trade/swap results. This does NOT touch
    // computePositionState/getPositionState (used by the Position Need UI
    // and the mandatory-first-five rule above) — it's a separate count.
    if (CORE_POSITIONS.includes(player.position)) {
      const positionCountSoFar = season.playerDraftPicks.filter(
        (p) =>
          p.participantId === participantId &&
          data.players[p.playerId]?.position === player.position
      ).length;
      if (positionCountSoFar >= MAX_PLAYERS_PER_POSITION) {
        throw new Error(
          `This participant already has ${MAX_PLAYERS_PER_POSITION} players at ` +
          `${player.position} (max ${MAX_PLAYERS_PER_POSITION}).`
        );
      }
    }

    // ── Roster cap: 10 players max per participant ──────────────────────
    // Enforced here at the data layer, same as every other draft rule, so
    // it can't be bypassed. ownPickNumber is this participant's OWN pick
    // count (1st, 2nd, ... 10th player drafted) — not the global
    // round/pick number — computed once here and reused below by the
    // Phase 5 10th-pick-Blue rule.
    const ownPickNumber =
      season.playerDraftPicks.filter((p) => p.participantId === participantId).length + 1;
    if (ownPickNumber > MAX_ROSTER_SIZE) {
      throw new Error(
        `This participant already has ${MAX_ROSTER_SIZE} players — the roster is full.`
      );
    }

    // ── Total roster rating cap (season.ratingCap, 875 default) ─────────
    // Previously only surfaced as an informational isOverCap flag in the
    // Roster view (Phase 4A) — never actually enforced at draft time, so a
    // team's total OVR could exceed the cap. Enforced here the same way as
    // every other draft rule now: this participant's already-drafted total
    // plus this player's OVR must not exceed the cap.
    const priorTotalRating = season.playerDraftPicks
      .filter((p) => p.participantId === participantId)
      .reduce((sum, p) => sum + (data.players[p.playerId]?.overall ?? 0), 0);
    const ratingCap = season.ratingCap ?? 875;
    const projectedTotal = priorTotalRating + player.overall;
    if (projectedTotal > ratingCap) {
      throw new Error(
        `Drafting "${player.name}" (${player.overall} OVR) would put this participant's ` +
        `total at ${projectedTotal} OVR, over the ${ratingCap} rating cap ` +
        `(currently ${priorTotalRating}).`
      );
    }

    // ── Phase 5 / Rule D: 10th-pick Blue fee ─────────────────────────────
    // Enforced here (not as after-the-fact bookkeeping) so it can never be
    // forgotten: if this is the participant's OWN 10th pick (their 10th
    // player drafted, not the global round/pick number) and it's a Blue
    // player, the pick itself requires OVR <= 94 and must still satisfy
    // every other Blue restriction (max 4 Blue, min 84, first-3-combined
    // <=280, 4th-Blue<=94) against their draft-so-far. If it doesn't
    // qualify, the pick is rejected outright — same as any other draft
    // rule violation. If it does qualify, the additional ₱100 goes to the
    // season pot and is recorded in transaction history in the same
    // atomic write as the pick — there is no separate step to forget.
    // The Draft page UI is unchanged: this is invisible plumbing inside
    // the existing confirm-pick call.
    let tenthPickBlueFeeCharged = false;
    if (ownPickNumber === 10 && player.pool === "blue") {
      if (player.overall > MAX_TENTH_PICK_BLUE_RATING) {
        throw new Error(
          `"${player.name}" is ${player.overall} OVR — a Blue player selected for the ` +
          `10th pick must be ${MAX_TENTH_PICK_BLUE_RATING} OVR or lower.`
        );
      }
      const priorEntries = season.playerDraftPicks
        .filter((p) => p.participantId === participantId)
        .map((p) => ({ playerId: p.playerId }));
      const blueCheck = validateBlueComposition([...priorEntries, { playerId }], data.players);
      if (!blueCheck.valid) {
        throw new Error(`10th-pick Blue selection rejected: ${blueCheck.reason}`);
      }
      tenthPickBlueFeeCharged = true;
    }

    season.playerDraftPicks.push({ round, pick, participantId, playerId });

    // Refresh the bonusPicks mirror (see season.bonusPicks doc comment) now
    // that this pick has been recorded — computeDraftSchedule replays the
    // updated history and returns the authoritative, up-to-date entitlement
    // map, whether this pick just consumed a bonus turn or not.
    season.bonusPicks = computeDraftSchedule(season).bonusPicks;

    if (tenthPickBlueFeeCharged) {
      season.pot = (season.pot || 0) + TENTH_PICK_BLUE_FEE;
      season.transactions.push({
        id: generateId("txn"),
        seasonId,
        seasonDay: season.currentSeasonDay,
        timestamp: new Date().toISOString(),
        type: "tenthPickBlueFee",
        teamA: participantId,
        teamB: null,
        playersOut: [],
        playersIn: [{
          playerId,
          name: player.name,
          overall: player.overall,
          pool: player.pool,
          pickClassification: null,
          isJoker: false,
        }],
        fee: TENTH_PICK_BLUE_FEE,
        feeDoubled: false,
        approvedBy: "commissioner",
      });
    }

    saveData(data);
    return {
      round,
      pick,
      participantId,
      playerId,
      tenthPickBlueFeeCharged,
      tenthPickBlueFee: tenthPickBlueFeeCharged ? TENTH_PICK_BLUE_FEE : 0,
    };
  },

  /**
   * Undoes the single most recent draft pick — removing it returns the
   * player to the available pool and restores the previous current pick,
   * since round/pick/current-participant are derived from array state
   * rather than stored separately. Only the most recent pick can be
   * undone; arbitrary editing of earlier picks is not supported.
   *
   * If the draft had been marked complete, undoing a pick reopens it —
   * a "complete" draft can't have fewer picks than it did when completed.
   */
  undoLastDraftPick(seasonId) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    if (!season.playerDraftPicks.length)
      throw new Error("No picks to undo.");

    season.playerDraftPicks.pop();
    if (season.draftComplete) {
      season.draftComplete = false;
    }
    // Keep the bonusPicks mirror correct — e.g. undoing a bonus turn's
    // 2nd pick should show that participant as still owed the bonus.
    ensureDraftSkipFields(season);
    if (season.playerDraftOrder.length) {
      season.bonusPicks = computeDraftSchedule(season).bonusPicks;
    }
    saveData(data);
  },

  markDraftComplete(seasonId) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    season.draftComplete = true;
    saveData(data);
  },

  /**
   * Revision 1 — Phase 2 Draft Skip. Records that the current drafter is
   * skipping their turn this round: no player is drafted, the pick is
   * NOT added to playerDraftPicks (that array's meaning — the players a
   * participant has actually drafted — must stay exactly as it always
   * has been, since ownPickNumber/roster-cap/position-state/Joker-window
   * logic all depend on it unchanged). Instead this is recorded in
   * draftSkips (its own append-only audit trail, mirroring
   * playerDraftPicks), the draft immediately moves to the next
   * participant (computeDraftSchedule advances past a skip
   * automatically), and the skipping participant is credited a bonus
   * pick — see season.bonusPicks and computeDraftSchedule's doc comment
   * for exactly when and how that bonus turn is redeemed.
   */
  skipDraftPick(seasonId) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    ensureTransactionFields(season);
    ensureDraftSkipFields(season);
    if (!season.playerDraftOrder.length) {
      throw new Error("Set the player draft order before drafting.");
    }
    if (season.draftComplete) {
      throw new Error("The draft is already complete — there is no active turn to skip.");
    }

    const schedule = computeDraftSchedule(season);
    if (!schedule.currentParticipantId) {
      throw new Error("No active turn — there is nothing to skip.");
    }
    if (schedule.isBonusTurn) {
      // A bonus (double-pick) turn is the redemption of an earlier skip —
      // it must be filled with its two picks, not skipped again, or the
      // entitlement could compound indefinitely.
      throw new Error(
        "This is a bonus double-pick turn from an earlier skip — it must be filled with two picks, not skipped."
      );
    }

    season.draftSkips.push({
      participantId: schedule.currentParticipantId,
      round: schedule.currentRound,
      afterPickCount: season.playerDraftPicks.length,
      timestamp: new Date().toISOString(),
    });

    // Refresh the bonusPicks mirror the same way makeDraftPick does —
    // computeDraftSchedule replays the now-updated history to produce the
    // authoritative entitlement map.
    season.bonusPicks = computeDraftSchedule(season).bonusPicks;

    saveData(data);
    return {
      skippedParticipantId: schedule.currentParticipantId,
      round: schedule.currentRound,
    };
  },

  // ── Process 2: NBA Team Assignment Order (second DuckRace — independent) ──
  setTeamAssignmentOrder(seasonId, participantIds) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    for (const id of participantIds) {
      if (!season.participants[id])
        throw new Error(`Participant ID not found: ${id}`);
    }
    // Stored separately — never merged with playerDraftOrder
    season.teamAssignmentOrder = [...participantIds];
    saveData(data);
  },

  assignNBATeam(seasonId, participantId, nbaTeamAbbr) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    if (!season.participants[participantId])
      throw new Error("Participant not found");
    const teamExists = NBA_TEAMS.find((t) => t.abbr === nbaTeamAbbr);
    if (!teamExists) throw new Error("Invalid NBA team abbreviation");
    // Check not already taken
    const takenBy = Object.entries(season.nbaTeamAssignments).find(
      ([, abbr]) => abbr === nbaTeamAbbr
    );
    if (takenBy && takenBy[0] !== participantId)
      throw new Error(`${nbaTeamAbbr} already assigned to another participant`);

    // nbaTeamAssignments is the single source of truth — no mirrored
    // field is written onto the participant record.
    season.nbaTeamAssignments[participantId] = nbaTeamAbbr;
    saveData(data);
  },

  /**
   * Clears a participant's NBA team assignment, freeing the team back up.
   * This is the only supported way to undo an assignment — it goes
   * through the normal data-layer read/save cycle, same as every other
   * write in this module.
   */
  unassignNBATeam(seasonId, participantId) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    if (!season.participants[participantId])
      throw new Error("Participant not found");

    delete season.nbaTeamAssignments[participantId];
    saveData(data);
  },

  markTeamAssignmentComplete(seasonId) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    season.teamAssignmentComplete = true;
    saveData(data);
  },

  // ── Phase 7: Regular Season Schedule ──────────────────────────────────────

  /**
   * Force-clears a season's entire schedule (both Round Robin and Group
   * Stage), REGARDLESS of whether any games have been completed —
   * deliberately bypasses the safety guard generateSchedule/
   * generateGroupStageSchedule enforce. This exists purely for a
   * commissioner clearing out test/scratch data before the real season
   * starts; it is destructive (every recorded score, streamer credit, and
   * derived standing for this season's games is gone the moment this
   * runs — there is no undo) and is NOT wired to any button that fires
   * without an explicit confirmation in the UI.
   *
   * Clears schedule, scheduleGeneratedAt, scheduleFormat, and
   * groupStageState back to their fresh-season defaults, so the season
   * lands exactly back at "no schedule generated yet" — generateSchedule/
   * generateGroupStageSchedule can be called again immediately afterward
   * with a clean slate. Does not touch anything else (draft, rosters,
   * financials, playoffs) — if playoffs were already generated from this
   * schedule's standings, season.playoffs is left as-is (stale) since
   * this is a schedule-only reset; clear playoffs separately if needed.
   */
  resetSchedule(seasonId) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");

    season.schedule = [];
    season.scheduleGeneratedAt = null;
    season.scheduleFormat = null;
    season.groupStageState = null;
    saveData(data);
  },

  /**
   * Generates (or regenerates) a single round-robin schedule from the
   * season's ACTUAL NBA team assignments — never a hardcoded team count.
   *
   * Team list is derived from teamAssignmentOrder, filtered down to
   * participants who actually have an assigned team (nbaTeamAssignments is
   * the single source of truth for that — see Process 2). This keeps the
   * scheduler a pure consumer of the existing assignment data rather than
   * a second, competing source of truth.
   *
   * Regeneration safety: if a schedule already exists and ANY matchup in
   * it has been completed, this throws rather than silently discarding
   * results — call getScheduleState(seasonId).hasCompletedGames first to
   * decide whether to offer regeneration in the UI at all. To force-clear
   * anyway (e.g. test data), use resetSchedule() above first.
   */
  generateSchedule(seasonId) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");

    if (season.schedule.length > 0) {
      const hasCompleted = season.schedule.some((round) =>
        round.matchups.some((m) => m.status === "completed")
      );
      if (hasCompleted) {
        throw new Error(
          "Cannot regenerate: this season already has completed games. " +
          "Regeneration is disabled to protect existing results."
        );
      }
    }

    const teamIds = season.teamAssignmentOrder.filter(
      (pid) => !!season.nbaTeamAssignments[pid]
    );
    if (teamIds.length < 2) {
      throw new Error(
        "At least 2 participants with an assigned NBA team are required to generate a schedule."
      );
    }

    season.schedule = generateRoundRobinRounds(teamIds);
    season.scheduleGeneratedAt = new Date().toISOString();
    season.scheduleFormat = "roundRobin";
    season.groupStageState = null;
    saveData(data);
    return season.schedule;
  },

  /**
   * Group Stage (legacy 16-team / 4-group format), Round 1. Reuses
   * generateRoundRobinRounds unmodified for each group's mini round-robin
   * (see generateGroupStageRounds) — this is a second entry point into
   * the same scheduling infrastructure generateSchedule uses, not a
   * parallel implementation.
   *
   * groups: { A: [id,id,id,id], B: [...], C: [...], D: [...] } — the
   * commissioner's chosen (or auto-generated from teamAssignmentOrder)
   * Round 1 group assignment. Validated here before anything is written:
   * exactly 16 distinct, currently-assigned teams, split into exactly 4
   * groups of exactly 4.
   *
   * Same regeneration-safety guard as generateSchedule: refuses to
   * overwrite a schedule that already has a completed game.
   */
  generateGroupStageSchedule(seasonId, groups) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");

    if (season.schedule.length > 0) {
      const hasCompleted = season.schedule.some((round) =>
        round.matchups.some((m) => m.status === "completed")
      );
      if (hasCompleted) {
        throw new Error(
          "Cannot regenerate: this season already has completed games. " +
          "Regeneration is disabled to protect existing results."
        );
      }
    }

    const assignedTeamIds = season.teamAssignmentOrder.filter(
      (pid) => !!season.nbaTeamAssignments[pid]
    );
    if (assignedTeamIds.length !== 16) {
      throw new Error(
        `The legacy Group Stage format requires exactly 16 teams with an assigned NBA team ` +
        `(this season has ${assignedTeamIds.length}). Use Round Robin instead, or adjust team assignments.`
      );
    }

    if (!groups || GROUP_NAMES.some((g) => !Array.isArray(groups[g]))) {
      throw new Error("All four groups (A-D) are required.");
    }
    for (const g of GROUP_NAMES) {
      if (groups[g].length !== 4) {
        throw new Error(`Group ${g} must contain exactly 4 teams (has ${groups[g].length}).`);
      }
    }
    const allGroupedIds = GROUP_NAMES.flatMap((g) => groups[g]);
    const uniqueGroupedIds = new Set(allGroupedIds);
    if (uniqueGroupedIds.size !== 16) {
      throw new Error("Each team must appear in exactly one group — a team is duplicated across groups.");
    }
    const assignedSet = new Set(assignedTeamIds);
    for (const pid of allGroupedIds) {
      if (!assignedSet.has(pid)) {
        throw new Error("A team in the group assignment does not have an assigned NBA team on this roster.");
      }
    }
    for (const pid of assignedTeamIds) {
      if (!uniqueGroupedIds.has(pid)) {
        throw new Error("Every assigned team must appear in a group — one or more teams are missing.");
      }
    }

    const round1Rounds = generateGroupStageRounds(groups, 1, 0);
    const round1Matchups = round1Rounds.flatMap((r) => r.matchups);

    // Home Court Rule — Round 1: higher original team-assignment pick
    // number (season.teamAssignmentOrder position) gets home court. Mutates
    // round1Matchups (the same objects referenced inside round1Rounds) in
    // place before anything is written.
    const pickNumberOf = (pid) => season.teamAssignmentOrder.indexOf(pid) + 1;
    assignRound1HomeCourt(round1Matchups, pickNumberOf);

    // Sanity-check the generator's own output before writing anything —
    // belt-and-suspenders against a future edit to generateGroupStageRounds
    // silently breaking these invariants.
    if (round1Matchups.length !== 24) {
      throw new Error(`Internal error: expected 24 Round 1 games, generated ${round1Matchups.length}.`);
    }
    for (const g of GROUP_NAMES) {
      const gameCount = round1Matchups.filter((m) => m.group === g).length;
      if (gameCount !== 6) {
        throw new Error(`Internal error: Group ${g} has ${gameCount} Round 1 games, expected 6.`);
      }
    }
    for (const pid of assignedTeamIds) {
      const played = round1Matchups.filter((m) => m.teamA === pid || m.teamB === pid).length;
      if (played !== 3) {
        throw new Error(`Internal error: a team has ${played} Round 1 games, expected 3.`);
      }
    }

    season.schedule = round1Rounds;
    season.scheduleGeneratedAt = new Date().toISOString();
    season.scheduleFormat = "groupStage";
    season.groupStageState = {
      groups,
      stage: 1,
      round1Standings: null,
      round2Groups: null,
    };
    saveData(data);
    return season.schedule;
  },

  /**
   * Group Stage, Round 2 (Manual Online-Roulette Assignment): generates
   * Round 2's 24 games from a commissioner-supplied group assignment,
   * APPENDING them to the existing season.schedule (Round 1's
   * rounds/results are never touched or replaced) — reuses
   * generateGroupStageRounds exactly like Round 1 did.
   *
   * round2Groups: { A: [id,id,id,id], B: [...], C: [...], D: [...] } — the
   * commissioner's manual assignment, entered after running the actual
   * draw on an external online roulette. This function does NOT compute
   * or suggest group membership itself — the roulette result, as entered
   * by the commissioner, is the sole source of truth for Round 2 groups.
   *
   * Guards, in order: this must be a Group Stage season currently on
   * stage 1; Round 1 must be fully complete (all 24 games); Round 2 must
   * not already have been generated; round2Groups must be exactly 16
   * distinct, currently-assigned teams split into 4 groups of 4. The
   * rematch check validates the commissioner's actual entered groups
   * against Round 1's real matchups (findGroupStageRematches) and BLOCKS
   * generation on a rematch — it never rearranges the commissioner's
   * selections to avoid one; the commissioner corrects the dropdowns
   * (per the roulette process) and re-submits.
   *
   * Once this succeeds, season.groupStageState.round1Standings is frozen
   * (Round 1's final standings at the moment Round 2 was generated —
   * informational/audit only now, since it no longer drives group
   * membership) and recordMatchResult refuses further edits to any
   * Round 1 game — see that function's stage-lock guard.
   */
  generateGroupStageRound2(seasonId, round2Groups) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    if (season.scheduleFormat !== "groupStage" || !season.groupStageState) {
      throw new Error("This season is not using the Group Stage format.");
    }
    if (season.groupStageState.stage !== 1) {
      throw new Error("Round 2 has already been generated for this season.");
    }

    const round1Matchups = season.schedule.flatMap((r) => r.matchups).filter((m) => m.stage === 1);
    const completedCount = round1Matchups.filter((m) => m.status === "completed").length;
    if (completedCount < round1Matchups.length) {
      throw new Error(
        `Cannot generate Round 2: Round 1 is not yet complete ` +
        `(${completedCount} of ${round1Matchups.length} games played).`
      );
    }

    // Validate the commissioner's manually-entered Round 2 assignment —
    // same shape/rigor as generateGroupStageSchedule's Round 1 validation.
    const assignedTeamIds = season.teamAssignmentOrder.filter(
      (pid) => !!season.nbaTeamAssignments[pid]
    );
    if (!round2Groups || GROUP_NAMES.some((g) => !Array.isArray(round2Groups[g]))) {
      throw new Error("Round 2 cannot be generated: all four groups (A-D) are required.");
    }
    for (const g of GROUP_NAMES) {
      const count = round2Groups[g].filter((pid) => pid != null).length;
      if (round2Groups[g].some((pid) => pid == null)) {
        throw new Error(
          `Round 2 cannot be generated: Group ${g} has an empty slot — every slot needs a team assigned.`
        );
      }
      if (count !== 4) {
        throw new Error(`Round 2 cannot be generated: Group ${g} only contains ${count} team${count === 1 ? '' : 's'}, expected 4.`);
      }
    }
    const allRound2Ids = GROUP_NAMES.flatMap((g) => round2Groups[g]);
    const seen = new Set();
    for (const pid of allRound2Ids) {
      if (seen.has(pid)) {
        const name = season.participants[pid]?.name || pid;
        throw new Error(`Round 2 cannot be generated: Team "${name}" is assigned twice.`);
      }
      seen.add(pid);
    }
    const assignedSet = new Set(assignedTeamIds);
    for (const pid of allRound2Ids) {
      if (!assignedSet.has(pid)) {
        throw new Error("Round 2 cannot be generated: an assigned team does not have a current NBA team assignment.");
      }
    }
    const missing = assignedTeamIds.filter((pid) => !seen.has(pid));
    if (missing.length > 0) {
      const names = missing.map((pid) => season.participants[pid]?.name || pid).join(", ");
      throw new Error(
        `Round 2 cannot be generated: ${missing.length} team${missing.length === 1 ? ' has' : 's have'} not been assigned (${names}).`
      );
    }

    const rematches = findGroupStageRematches(round1Matchups, round2Groups);
    if (rematches.length > 0) {
      const detail = rematches
        .map((r) => `${season.participants[r.teamA]?.name || r.teamA} vs ${season.participants[r.teamB]?.name || r.teamB} — already played in Round 1`)
        .join("; ");
      throw new Error(
        `Round 2 contains ${rematches.length} rematch${rematches.length === 1 ? '' : 'es'} from Round 1: ${detail}. ` +
        `Adjust the group assignment and try again — groups are never automatically rearranged.`
      );
    }

    const round1Standings = LeagueData.getGroupStageStandings(seasonId, 1);
    const round1StandingsIds = {};
    for (const g of GROUP_NAMES) {
      round1StandingsIds[g] = (round1Standings[g] || []).map((row) => row.participantId);
    }

    const maxExistingRound = season.schedule.reduce((max, r) => Math.max(max, r.round), 0);
    const round2Rounds = generateGroupStageRounds(round2Groups, 2, maxExistingRound);

    const round2Matchups = round2Rounds.flatMap((r) => r.matchups);
    if (round2Matchups.length !== 24) {
      throw new Error(`Internal error: expected 24 Round 2 games, generated ${round2Matchups.length}.`);
    }

    // Home Court Rule — Round 2: better (higher) Round 1 point differential
    // gets home court, tied on total Round 1 points scored, then on the
    // same unique pick number Round 1 uses (see assignRound2HomeCourt).
    const round1StatsByParticipant = {};
    for (const g of GROUP_NAMES) {
      for (const row of round1Standings[g] || []) {
        round1StatsByParticipant[row.participantId] = row;
      }
    }
    const statsOf = (pid) => round1StatsByParticipant[pid];
    const pickNumberOf = (pid) => season.teamAssignmentOrder.indexOf(pid) + 1;
    assignRound2HomeCourt(round2Matchups, statsOf, pickNumberOf);

    season.schedule = [...season.schedule, ...round2Rounds];
    season.groupStageState.stage = 2;
    season.groupStageState.round1Standings = round1StandingsIds;
    season.groupStageState.round2Groups = round2Groups;
    saveData(data);
    return round2Rounds;
  },

  /**
   * Saves (or edits) a completed match result for one matchup, found by
   * ID anywhere in the schedule. Used for both first-time score entry and
   * later corrections — it always updates the existing matchup entry in
   * place, so a correction can never create a duplicate game.
   *
   * The winner is always computed here from the scores — never accepted
   * as a caller-supplied value — matching how every other derived value
   * in this module (e.g. getDraftState's currentParticipantId) is never
   * trusted from the caller.
   *
   * Tied scores are invalid by league rule (no overtime/tie-break system
   * exists) and are rejected outright.
   *
   * Throws if the matchup is a BYE — a BYE is a scheduling artifact only
   * and never carries a score, streamer, or winner.
   */
  recordMatchResult(seasonId, matchupId, { scoreA, scoreB, streamer }) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");

    let found = null;
    for (const round of season.schedule) {
      const m = round.matchups.find((mu) => mu.id === matchupId);
      if (m) { found = m; break; }
    }
    if (!found) throw new Error("Matchup not found");
    if (found.teamB === null) throw new Error("Cannot record a result for a BYE.");

    // Group Stage Round 1-lock: once Round 2 has been generated, Round 1's
    // results are what Round 2's re-seeding was actually built from —
    // editing them afterward would silently invalidate seeding nobody
    // would notice happened. Round 2 results, and every Round Robin game,
    // are unaffected by this check.
    if (found.stage === 1 && season.groupStageState && season.groupStageState.stage === 2) {
      throw new Error(
        "Cannot edit a Round 1 result: Round 2 has already been generated from the Round 1 standings."
      );
    }

    const a = Number(scoreA);
    const b = Number(scoreB);
    if (!Number.isInteger(a) || a < 0 || !Number.isInteger(b) || b < 0) {
      throw new Error("Scores must be non-negative whole numbers.");
    }
    if (a === b) {
      throw new Error("Tied scores are not allowed — enter a final result.");
    }
    const streamerName = String(streamer || "").trim();
    if (!streamerName) {
      throw new Error("Streamer is required.");
    }

    found.scoreA = a;
    found.scoreB = b;
    found.streamer = streamerName;
    found.winner = a > b ? found.teamA : found.teamB;
    found.status = "completed";
    found.playedAt = new Date().toISOString();

    saveData(data);
    return found;
  },

  // ── Phase 9: Playoffs ────────────────────────────────────────────────────

  /**
   * Generates the full playoff bracket skeleton from the current final
   * standings (LeagueData.getTeamStatistics — Phase 8, untouched). Freezes
   * the top 12 into `playoffs.seeds`; later edits to regular-season
   * results never reshuffle an existing bracket.
   *
   * Blocked from regenerating once any playoff game has been completed,
   * mirroring Phase 7's generateSchedule guard.
   */
  generatePlayoffs(seasonId) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");

    if (playoffsHaveAnyCompletedGame(season.playoffs)) {
      throw new Error(
        "Cannot regenerate: this playoff bracket already has completed games. " +
        "Regeneration is disabled to protect existing results."
      );
    }

    const scheduleState = LeagueData.getScheduleState(seasonId);
    if (!scheduleState.generated) {
      throw new Error("Cannot generate playoffs: no regular-season schedule has been created.");
    }
    if (scheduleState.realMatchupCount === 0) {
      throw new Error("Cannot generate playoffs: the regular-season schedule contains no games.");
    }
    if (scheduleState.completedCount < scheduleState.realMatchupCount) {
      throw new Error("Cannot generate playoffs: the regular season is not yet complete.");
    }

    const stats = LeagueData.getTeamStatistics(seasonId);
    if (stats.length < 12) {
      throw new Error(
        "At least 12 ranked teams (with an assigned NBA team) are required to generate the playoff bracket."
      );
    }

    const seeds = stats.slice(0, 12).map((s, i) => ({ seed: i + 1, participantId: s.participantId }));
    season.playoffs = buildPlayoffsSkeleton(seeds);
    saveData(data);
    return season.playoffs;
  },

  /**
   * Records seed 3's (pool "top") or seed 1's (pool "bottom") opponent
   * choice. Requires both of that pool's Round 1 matches to be complete.
   * The leftover Round 1 winner is assigned to the other seed in the pool
   * automatically — never a separate admin action, so there's no way for
   * the "leftover" to drift from the actual leftover winner.
   *
   * A selection may be changed only while neither resulting series has a
   * recorded game yet — once a game exists, the selection is locked, so a
   * completed result can never be silently invalidated by a change of
   * mind (the same "never silently destroy a result" principle Phase 7
   * established for schedule regeneration, applied here to selections).
   */
  selectPlayoffOpponent(seasonId, poolName, selectedParticipantId) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    const playoffs = season.playoffs;
    if (!playoffs) throw new Error("Playoffs have not been generated yet.");

    const pool = playoffs.round2.pools.find((p) => p.name === poolName);
    if (!pool) throw new Error("Unknown playoff pool: " + poolName);

    const sourceMatches = pool.sourceMatchIds.map(
      (id) => playoffs.round1.matches.find((m) => m.id === id)
    );
    if (sourceMatches.some((m) => !m.winner)) {
      throw new Error("Both Round 1 matches in this pool must be completed before a selection can be made.");
    }

    const winners = sourceMatches.map((m) => m.winner);
    if (!winners.includes(selectedParticipantId)) {
      throw new Error("The selected team did not win either Round 1 match in this pool.");
    }

    if (pool.selection !== null) {
      const alreadyPlayed = pool.series.some((s) => s.games.length > 0);
      if (alreadyPlayed) {
        throw new Error("This selection is locked — a game has already been recorded for one of the resulting series.");
      }
    }

    const leftover = winners.find((w) => w !== selectedParticipantId);
    pool.selection = selectedParticipantId;
    pool.series[0].opponent = selectedParticipantId; // the chooser's own series (seed 3 or seed 1)
    pool.series[1].opponent = leftover;               // the automatic leftover (seed 4 or seed 2)

    cascadePlayoffAdvancement(playoffs);
    saveData(data);
    return pool;
  },

  /**
   * Records (or edits) one game's result for any playoff match/series —
   * a Round 1 BO1 match, a Round 2 BO3 series, a Finals semifinal, or the
   * Championship — found by id anywhere in the bracket. Reuses Phase 7's
   * validation rules exactly: non-negative integer scores, ties rejected,
   * streamer required, winner always derived (never accepted from the
   * caller).
   *
   * gameNumber must be 1 for BO1. For BO3 it may be 1, 2, or 3, and a NEW
   * game (not an edit) can only be appended in order — game 2 requires
   * game 1 to exist, game 3 requires games 1 and 2 to exist AND be split
   * 1-1 — and never once the series already has a winner.
   *
   * Editing an EXISTING game is allowed (matching Phase 7's edit-in-place
   * philosophy) unless this item's result has already been consumed
   * downstream (its winner used for a selection, a semifinal, the
   * championship, or the champion) — at that point the edit is rejected
   * outright rather than silently leaving stale data downstream.
   */
  recordPlayoffGameResult(seasonId, itemId, gameNumber, { scoreA, scoreB, streamer }) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    const playoffs = season.playoffs;
    if (!playoffs) throw new Error("Playoffs have not been generated yet.");

    const found = findPlayoffItem(playoffs, itemId);
    if (!found) throw new Error("Playoff match/series not found.");
    const { item, kind } = found;
    const format = kind === "round1" ? "bo1" : "bo3";

    // Resolve the two sides' participantIds for this item.
    let sideA, sideB;
    if (kind === "round1") {
      sideA = item.teamA;
      sideB = item.teamB;
    } else if (kind === "round2") {
      const bySeed = Object.fromEntries(playoffs.seeds.map((s) => [s.seed, s.participantId]));
      sideA = bySeed[item.seed];
      sideB = item.opponent;
      if (!sideB) throw new Error("This series' opponent has not been determined yet.");
    } else {
      // semifinal or championship
      sideA = item.teamA;
      sideB = item.teamB;
      if (!sideA || !sideB) throw new Error("Both participants for this series have not been determined yet.");
    }

    // Validate gameNumber range for the format.
    const maxGames = format === "bo1" ? 1 : 3;
    if (!Number.isInteger(gameNumber) || gameNumber < 1 || gameNumber > maxGames) {
      throw new Error(`Invalid game number for a ${format === "bo1" ? "Best-of-1" : "Best-of-3"} matchup.`);
    }

    const isEdit = gameNumber <= item.games.length;

    if (!isEdit) {
      // Appending a new game — must be the next one in sequence.
      if (gameNumber !== item.games.length + 1) {
        throw new Error(`Game ${gameNumber - 1} must be recorded before game ${gameNumber}.`);
      }
      if (item.status === "completed") {
        throw new Error("This series has already been decided — no additional games may be recorded.");
      }
      if (format === "bo3" && gameNumber === 3) {
        const winsA = item.games.filter((g) => g.winner === sideA).length;
        const winsB = item.games.filter((g) => g.winner === sideB).length;
        if (winsA !== 1 || winsB !== 1) {
          throw new Error("Game 3 is only played if the series is tied 1-1 after two games.");
        }
      }
    } else {
      // Editing an existing game — blocked if this item's result has
      // already been consumed downstream.
      if (isPlayoffItemDownstreamLocked(playoffs, itemId, kind)) {
        throw new Error(
          "This result has already advanced to the next round and cannot be edited here."
        );
      }
    }

    const a = Number(scoreA);
    const b = Number(scoreB);
    if (!Number.isInteger(a) || a < 0 || !Number.isInteger(b) || b < 0) {
      throw new Error("Scores must be non-negative whole numbers.");
    }
    if (a === b) {
      throw new Error("Tied scores are not allowed — enter a final result.");
    }
    const streamerName = String(streamer || "").trim();
    if (!streamerName) {
      throw new Error("Streamer is required.");
    }

    item.games[gameNumber - 1] = {
      gameNumber,
      scoreA: a,
      scoreB: b,
      winner: a > b ? sideA : sideB,
      streamer: streamerName,
      playedAt: new Date().toISOString(),
      status: "completed",
    };

    if (kind === "round1") {
      recomputeRound1Match(item);
    } else {
      recomputeBo3Result(item, sideA, sideB);
    }

    cascadePlayoffAdvancement(playoffs);
    saveData(data);
    return item;
  },

  // ── Phase 4A: Roster Initialization & Cap ─────────────────────────────────

  /**
   * One-time operation: copies the completed playerDraftPicks into
   * season.currentRosters, keyed by participantId.
   *
   * playerDraftPicks is NEVER modified — it remains the immutable draft log.
   * currentRosters is the mutable structure that trades/swaps will update
   * in future phases.
   *
   * Safe to call multiple times (re-initialization): each call replaces the
   * currentRosters entries cleanly from the current draft picks, which is
   * useful if picks were undone and re-made before rosters were finalized.
   *
   * Throws if:
   * - Season not found
   * - Draft not marked complete (guard against partial-draft initialization)
   */
  /**
   * One-time roster seed from the completed draft. Every entry gets a
   * `draftSlot` — the participant's own 1-based pick number (1..N) that
   * this roster row represents (Revision — Preserve Original Draft Pick
   * Slot). This is a roster-entry-level concept. Red/Yellow classification
   * still looks up ownPickNumber straight from the immutable
   * playerDraftPicks, keyed by whichever player was ORIGINALLY drafted
   * into a slot (see getOriginalPickInfo) — that never changes, no matter
   * who currently occupies the slot. Joker eligibility, however, DOES read
   * this draftSlot field (see getJokerEligiblePlayers/designateJoker,
   * Bugfix — Missing Joker Icon on Manually Added Players): a Joker is a
   * designation of whoever currently and legitimately holds one of this
   * participant's own pick slots #1-10, so draftSlot — which already
   * survives manual Replace/Remove/Fill-Slot below even when the occupant
   * changes to a player who was never personally drafted — is the correct
   * current source of truth for it, not the historical draft record.
   */
  initializeRostersFromDraft(seasonId) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    if (!season.draftComplete)
      throw new Error("Mark the draft complete before initializing rosters.");

    // Group draft picks by participant, preserving pick order within each,
    // and number each entry with that participant's own running pick count.
    const rosters = {};
    const ownPickCounters = {};
    for (const participant of Object.values(season.participants)) {
      rosters[participant.id] = [];
      ownPickCounters[participant.id] = 0;
    }
    for (const pick of season.playerDraftPicks) {
      if (!rosters[pick.participantId]) {
        rosters[pick.participantId] = [];
        ownPickCounters[pick.participantId] = 0;
      }
      ownPickCounters[pick.participantId] += 1;
      rosters[pick.participantId].push({
        playerId: pick.playerId,
        source: 'draft',
        draftSlot: ownPickCounters[pick.participantId],
      });
    }

    season.currentRosters = rosters;
    season.rostersInitialized = true;
    saveData(data);
  },

  /**
   * Updates the rating cap for the season.
   * Does not retroactively remove players — the cap is a UI enforcement
   * boundary only; no roster entries are deleted by this call.
   */
  setRatingCap(seasonId, cap) {
    const cap_n = Number(cap);
    if (!Number.isFinite(cap_n) || cap_n < 1)
      throw new Error("Rating cap must be a positive number.");
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    season.ratingCap = cap_n;
    saveData(data);
  },

  // ── Phase 5: Trading / Swap System ───────────────────────────────────────
  // Every write below requires season.rostersInitialized (currentRosters is
  // the single source of truth these actions mutate — playerDraftPicks, the
  // permanent draft history, is never touched by anything in this section).

  /** Rule B: Season Day is manual/commissioner-set — never derived from a date. */
  setSeasonDay(seasonId, day) {
    const dayN = parseInt(day, 10);
    if (!Number.isFinite(dayN) || dayN < 1) {
      throw new Error("Season Day must be a positive whole number.");
    }
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    season.currentSeasonDay = dayN;
    saveData(data);
    return { currentSeasonDay: dayN };
  },

  // ── Financial Management (F2 — Entry Fee Recording) ─────────────────────
  // Uses the existing season.transactions[] ledger as the sole source of
  // truth (same array Phase 5 trade/swap/Joker/10th-pick-Blue entries live
  // in) — no separate financial collection, and no stored
  // participant.entryFeePaid flag; "paid" is always derived by checking
  // for an existing type:"entryFee" transaction for that participant (see
  // the duplicate check below, which doubles as the paid-status read).

  /**
   * Records a participant's season entry-fee payment as a new ledger
   * transaction and adds the amount to season.pot — the same one
   * load→mutate→push→saveData atomic pattern already used by
   * commitTrade/commitSwap (single read, single write; nothing is
   * persisted if a validation check throws first).
   *
   * The amount always comes from season.financialSettings.entryFee
   * (never hard-coded) — ensureFinancialFields(season) is called first so
   * a season created before F1 safely receives the 300/2/2 defaults at
   * the moment this is actually used, without touching any other season.
   *
   * Throws if:
   * - Season not found
   * - Participant not found in this season
   * - financialSettings.entryFee is somehow not a valid non-negative
   *   number even after ensureFinancialFields (defensive — shouldn't
   *   happen, since ensureFinancialFields guarantees this)
   * - Entry fee has already been fully recorded for this participant
   *
   * F6 Revision 2: this now branches on whether the participant has a
   * real entryFee transaction (see addParticipant()):
   *   - none at all → legacy participant from before this revision —
   *     falls back to the exact original one-shot behavior (one `entryFee`
   *     transaction, full amount, pot += amount) so old seasons behave
   *     identically to before; no migration, no rewritten history.
   *   - status "pending" (the new model) → "Mark Paid" now means "record
   *     a payment for whatever is still outstanding" — writes a `payment`
   *     transaction, category "entryFee", and does NOT touch season.pot
   *     (the charge already did, back when they joined).
   *   - status "paid" already → duplicate-payment guard, same as before.
   */
  recordEntryFeePayment(seasonId, participantId) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    if (!season.participants[participantId]) throw new Error("Participant not found in this season");

    ensureFinancialFields(season); // backfill for seasons created before F1
    ensureTransactionFields(season);

    const entryFee = season.financialSettings.entryFee;
    if (!Number.isFinite(entryFee) || entryFee < 0) {
      throw new Error("This season's entry fee is not configured correctly.");
    }

    const notVoided = (t) => !isF6Voided(season.transactions, t.id);
    const entryFeeTxn = season.transactions.find(
      (t) => t.type === "entryFee" && t.teamA === participantId && notVoided(t)
    ) || null;

    if (entryFeeTxn && entryFeeTxn.status === "paid") {
      throw new Error("Entry fee has already been recorded for this participant.");
    }

    if (!entryFeeTxn) {
      // Legacy participant — added before this revision, so they never
      // received the automatic charge addParticipant() now creates.
      // Exactly the original F2 behavior: one-shot charge + collection.
      season.transactions.push({
        id: generateId("txn"),
        seasonId,
        seasonDay: season.currentSeasonDay,
        timestamp: new Date().toISOString(),
        type: "entryFee",
        teamA: participantId,
        teamB: null,
        playersOut: [],
        playersIn: [],
        amount: entryFee,
        status: "paid",
        relatedTransactionId: null,
        description: "Entry fee",
        approvedBy: "commissioner",
      });
      season.pot = (season.pot || 0) + entryFee;
      saveData(data);
      return { amount: entryFee, pot: season.pot };
    }

    // entryFeeTxn.status === "pending" — a real F6-Revision-2 charge.
    const breakdown = f6ParticipantBreakdown(season, participantId);
    const unpaid = breakdown.entryFee.unpaid;
    if (unpaid <= 0) {
      throw new Error("Entry fee has already been recorded for this participant.");
    }
    season.transactions.push({
      id: generateId("txn"),
      seasonId,
      seasonDay: season.currentSeasonDay,
      timestamp: new Date().toISOString(),
      type: "payment",
      teamA: participantId,
      teamB: null,
      playersOut: [],
      playersIn: [],
      amount: unpaid,
      status: "paid",
      paymentCategory: "entryFee",
      relatedTransactionId: null,
      description: "Entry fee marked paid (remaining balance)",
      approvedBy: "commissioner",
    });
    // Intentionally no season.pot change — the charge already added this
    // money to the pot when the participant joined.

    saveData(data);
    return { amount: unpaid, pot: season.pot };
  },

  // ── Financial Management (F6 — Adjustments, Refunds, and Corrections) ───
  // Never deletes or modifies an existing transaction — every action here
  // only ever pushes a brand-new transaction onto season.transactions[],
  // referencing the original (where applicable) via relatedTransactionId.
  // Each function follows the same load → validate → mutate → save-once
  // pattern as every other AdminActions write; if any validation throws,
  // nothing has been pushed and season.pot is untouched.

  /**
   * Records ACTUAL money received from a participant. Never touches
   * season.pot — the underlying charge (entryFee/tradeFeeSplit/swap/
   * jokerSwap) already added its amount to pot the moment it was created
   * (see addParticipant()/commitTrade()/commitSwap()); a payment only
   * settles how much of that charge has actually come in.
   *
   * category is one of "entryFee" | "tradeFee" | "swapFee" | "general".
   * "general" is never itself written to a transaction — it's a UI-only
   * convenience that walks the Entry Fee → Trade Fees → Swap Fees
   * waterfall and writes one `payment` record per category actually
   * touched (mirroring the existing trade→tradeFeeSplit and
   * streamerSalaryRun→streamerSalary parent/child patterns), so a later
   * refund can always point at one specific, single-category payment —
   * never an ambiguous multi-category lump sum.
   *
   * Rejects (writes nothing, pot unchanged) if the requested amount
   * exceeds what's actually outstanding for the requested category (or,
   * for "general", the participant's total outstanding across all three
   * categories) — no partial application, no silently creating a credit
   * balance from an overpayment.
   */
  recordFinancialPayment(seasonId, { participantId, amount, category, reason }) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    ensureFinancialFields(season);
    ensureTransactionFields(season);

    if (!season.participants[participantId]) throw new Error("Participant not found in this season");

    const amountN = Number(amount);
    if (!Number.isFinite(amountN) || amountN <= 0) {
      throw new Error("Payment amount must be a positive number.");
    }
    if (!reason || !String(reason).trim()) {
      throw new Error("A reason is required for a payment.");
    }
    const validCategories = ["entryFee", "tradeFee", "swapFee", "general"];
    if (!validCategories.includes(category)) {
      throw new Error("Invalid payment category.");
    }

    const CATEGORY_LABELS = { entryFee: "entry fee", tradeFee: "trade fee", swapFee: "swap fee" };
    const breakdown = f6ParticipantBreakdown(season, participantId);
    const allocations = []; // [{ category, amount }]

    if (category !== "general") {
      const unpaid = breakdown[category].unpaid;
      if (amountN > unpaid) {
        throw new Error(`Payment cannot exceed the participant's outstanding ${CATEGORY_LABELS[category]} balance of ₱${unpaid}.`);
      }
      allocations.push({ category, amount: amountN });
    } else {
      const order = ["entryFee", "tradeFee", "swapFee"];
      const totalUnpaid = order.reduce((sum, c) => sum + breakdown[c].unpaid, 0);
      if (amountN > totalUnpaid) {
        throw new Error(`Payment cannot exceed the participant's total outstanding balance of ₱${totalUnpaid}.`);
      }
      let remaining = amountN;
      for (const c of order) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, breakdown[c].unpaid);
        if (take > 0) {
          allocations.push({ category: c, amount: take });
          remaining -= take;
        }
      }
    }

    const trimmedReason = String(reason).trim();
    const createdIds = [];
    for (const { category: cat, amount: amt } of allocations) {
      const id = generateId("txn");
      season.transactions.push({
        id,
        seasonId,
        seasonDay: season.currentSeasonDay,
        timestamp: new Date().toISOString(),
        type: "payment",
        teamA: participantId,
        teamB: null,
        playersOut: [],
        playersIn: [],
        amount: amt,
        status: "paid",
        paymentCategory: cat,
        relatedTransactionId: null,
        description: trimmedReason,
        approvedBy: "commissioner",
      });
      createdIds.push(id);
    }
    // Intentionally no season.pot change — see doc comment above.

    saveData(data);
    return { amount: amountN, allocations, transactionIds: createdIds, pot: season.pot };
  },

  // ── Financial Management (F6 — Corrections: Refund / Credit / Debit / Void / Streamer Salary) ───
  // Never deletes or modifies an existing transaction — every action here
  // only ever pushes a brand-new transaction onto season.transactions[],
  // referencing the original (where applicable) via relatedTransactionId.
  // Each function follows the same load → validate → mutate → save-once
  // pattern as every other AdminActions write; if any validation throws,
  // nothing has been pushed and season.pot is untouched.

  /**
   * Refunds part or all of one existing fee-collecting transaction back to
   * the participant who paid it. Creates a new `refund` transaction; never
   * touches the original. Rejects zero/negative amounts and rejects any
   * amount exceeding what's still refundable on that transaction (original
   * amount minus refunds already recorded against it) — the same
   * transaction can never be refunded twice beyond its original amount.
   * Decreases season.pot by the refunded amount (real cash leaving).
   */
  recordFinancialRefund(seasonId, { relatedTransactionId, amount, reason }) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    ensureFinancialFields(season);
    ensureTransactionFields(season);

    const amountN = Number(amount);
    if (!Number.isFinite(amountN) || amountN <= 0) {
      throw new Error("Refund amount must be a positive number.");
    }
    if (!reason || !String(reason).trim()) {
      throw new Error("A reason is required for a refund.");
    }

    const original = season.transactions.find((t) => t.id === relatedTransactionId);
    if (!original) throw new Error("Original transaction not found.");
    if (!F6_REFUNDABLE_TYPES.includes(original.type)) {
      throw new Error(`A "${original.type}" transaction cannot be refunded directly.`);
    }
    if (!f6IsCollected(original)) {
      throw new Error("This charge hasn't been paid yet, so there's nothing to refund. Refund the payment(s) made against it instead.");
    }
    if (!season.participants[original.teamA]) {
      throw new Error("The participant on the original transaction no longer exists.");
    }

    const originalAmount = f6TransactionAmount(original);
    const alreadyRefunded = f6TotalRefundedAgainst(season.transactions, original.id);
    const remainingRefundable = originalAmount - alreadyRefunded;
    if (amountN > remainingRefundable) {
      throw new Error(
        `Refund amount ₱${amountN} exceeds the remaining refundable amount of ₱${remainingRefundable} on this transaction.`
      );
    }

    season.transactions.push({
      id: generateId("txn"),
      seasonId,
      seasonDay: season.currentSeasonDay,
      timestamp: new Date().toISOString(),
      type: "refund",
      teamA: original.teamA,
      teamB: null,
      playersOut: [],
      playersIn: [],
      amount: amountN,
      status: "completed",
      relatedTransactionId: original.id,
      description: String(reason).trim(),
      approvedBy: "commissioner",
    });
    season.pot = (season.pot || 0) - amountN;

    saveData(data);
    return { amount: amountN, pot: season.pot, remainingRefundable: remainingRefundable - amountN };
  },

  /**
   * Applies a credit to a participant's account — a ledger adjustment
   * reducing what they owe, NOT a cash movement. season.pot is
   * intentionally never touched here (see F6 architecture review: credits
   * represent an owed-amount adjustment, not money physically entering or
   * leaving the pot).
   */
  recordFinancialCredit(seasonId, { participantId, amount, reason }) {
    return this._recordFinancialLedgerAdjustment(seasonId, { participantId, amount, reason, type: "credit" });
  },

  /**
   * Applies a debit to a participant's account — a ledger adjustment
   * increasing what they owe. season.pot is intentionally never touched
   * here (same reasoning as recordFinancialCredit).
   */
  recordFinancialDebit(seasonId, { participantId, amount, reason }) {
    return this._recordFinancialLedgerAdjustment(seasonId, { participantId, amount, reason, type: "debit" });
  },

  /** Shared implementation for recordFinancialCredit/recordFinancialDebit — identical validation/shape, only `type` differs. */
  _recordFinancialLedgerAdjustment(seasonId, { participantId, amount, reason, type }) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    ensureFinancialFields(season);
    ensureTransactionFields(season);

    if (!season.participants[participantId]) throw new Error("Participant not found in this season");

    const amountN = Number(amount);
    if (!Number.isFinite(amountN) || amountN <= 0) {
      throw new Error(`${type === "credit" ? "Credit" : "Debit"} amount must be a positive number.`);
    }
    if (!reason || !String(reason).trim()) {
      throw new Error(`A reason is required for a ${type}.`);
    }

    season.transactions.push({
      id: generateId("txn"),
      seasonId,
      seasonDay: season.currentSeasonDay,
      timestamp: new Date().toISOString(),
      type,
      teamA: participantId,
      teamB: null,
      playersOut: [],
      playersIn: [],
      amount: amountN,
      status: "applied",
      relatedTransactionId: null,
      description: String(reason).trim(),
      approvedBy: "commissioner",
    });
    // Intentionally no season.pot change — see doc comment above.

    saveData(data);
    return { amount: amountN, pot: season.pot };
  },

  /**
   * Voids an existing transaction: preserves it in place, and pushes a new
   * `void` transaction referencing it via relatedTransactionId. From that
   * point on, getParticipantFinancialAccount/getFinancialSummary exclude
   * the original from their totals (see isF6Voided). Rejects voiding the
   * same transaction twice.
   *
   * Pot effect (F6 Revision 2 — charge vs. payment): a void's effect on
   * season.pot now depends on whether the original transaction was ever
   * actually collected (f6IsCollected):
   *   - A still-`"pending"` charge (entryFee/tradeFeeSplit/swap/jokerSwap
   *     created under the new model, never paid) added its amount to pot
   *     the moment it was created — see addParticipant()/commitTrade()/
   *     commitSwap(). Voiding it means the participant never owed this in
   *     the first place, so pot must give that amount back: pot -= amount.
   *     f6ParticipantBreakdown already excludes a voided charge from
   *     Charged entirely, so Paid (nothing was ever paid against an
   *     unpaid charge) stays 0 and Unpaid correctly returns to 0 — the
   *     pot correction here is what keeps pot and Total Charges in sync
   *     with that.
   *   - Anything already collected (a legacy `"paid"` record, a legacy
   *     swap/jokerSwap/tenthPickBlueFee with no status field, a `payment`
   *     transaction, or a `credit`/`debit`/`streamerSalary` adjustment)
   *     is UNCHANGED — void still never touches pot for these, exactly as
   *     before. Refunding (not voiding) remains the only way to reverse
   *     money that's actually been collected.
   * Known limitation, unchanged by this fix: if a pending charge already
   * has partial `payment`s recorded against its category (payments are
   * tracked per-category, not per-charge — see f6ParticipantBreakdown),
   * voiding it removes the charge but not those payments; this is the
   * same pre-existing category-aggregate tradeoff noted when payments
   * were introduced, not something this fix changes.
   */
  voidFinancialTransaction(seasonId, { transactionId, reason }) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    ensureFinancialFields(season);
    ensureTransactionFields(season);

    if (!reason || !String(reason).trim()) {
      throw new Error("A reason is required to void a transaction.");
    }

    const original = season.transactions.find((t) => t.id === transactionId);
    if (!original) throw new Error("Transaction not found.");
    if (!F6_VOIDABLE_TYPES.includes(original.type)) {
      throw new Error(`A "${original.type}" transaction cannot be voided.`);
    }
    if (isF6Voided(season.transactions, original.id)) {
      throw new Error("This transaction has already been voided.");
    }

    const isPendingCharge = ["entryFee", "tradeFeeSplit", "swap", "jokerSwap"].includes(original.type)
      && !f6IsCollected(original);

    season.transactions.push({
      id: generateId("txn"),
      seasonId,
      seasonDay: season.currentSeasonDay,
      timestamp: new Date().toISOString(),
      type: "void",
      teamA: original.teamA ?? null,
      teamB: null,
      playersOut: [],
      playersIn: [],
      amount: f6TransactionAmount(original),
      status: "voided",
      relatedTransactionId: original.id,
      description: String(reason).trim(),
      approvedBy: "commissioner",
    });
    if (isPendingCharge) {
      season.pot = (season.pot || 0) - f6TransactionAmount(original);
    }
    // Anything already collected: intentionally no season.pot change —
    // see doc comment above.

    saveData(data);
    return { voidedTransactionId: original.id, pot: season.pot };
  },

  /**
   * Pays the current season's streamer salary pool: 30% of season.pot,
   * split equally among every streamer with >=14 completed regular-season
   * games (per the existing, unmodified LeagueData.getStreamerStatistics).
   * The pool is snapshotted ONCE against season.pot at the moment this
   * runs — every eligible streamer's individualSalary is computed from
   * that single snapshot, not recalculated after each payout, so paying
   * streamer #1 never changes what streamer #2 or #3 receive in the same
   * run.
   *
   * streamerParticipantMap maps each eligible streamer's free-text name to
   * the participantId who should actually receive that payout (the
   * streamer name recorded on a game is free text, not a participantId —
   * see F6 architecture review). Every eligible streamer must have an
   * entry; every mapped participantId must exist in this season; the same
   * participant cannot be mapped twice in one run.
   *
   * Writes one parent `streamerSalaryRun` record (snapshot only, no
   * participant, no pot effect) plus one `streamerSalary` child record per
   * eligible streamer (each decreases season.pot by individualSalary),
   * all in a single load → validate → mutate → save — the whole run
   * succeeds or fails together. If there are no eligible streamers, throws
   * and nothing is written (no salary is ever paid automatically).
   */
  payStreamerSalaries(seasonId, { streamerParticipantMap, reason }) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    ensureFinancialFields(season);
    ensureTransactionFields(season);

    if (!reason || !String(reason).trim()) {
      throw new Error("A reason is required to pay streamer salaries.");
    }

    const eligible = LeagueData.getStreamerStatistics(seasonId)
      .filter((s) => s.gamesStreamed >= STREAMER_SALARY_MIN_GAMES);
    if (!eligible.length) {
      throw new Error(`No eligible streamers (must have streamed at least ${STREAMER_SALARY_MIN_GAMES} games).`);
    }

    const map = streamerParticipantMap || {};
    const seenParticipants = new Set();
    for (const { streamer } of eligible) {
      const participantId = map[streamer];
      if (!participantId) {
        throw new Error(`No participant selected for eligible streamer "${streamer}".`);
      }
      if (!season.participants[participantId]) {
        throw new Error(`Selected participant for "${streamer}" was not found in this season.`);
      }
      if (seenParticipants.has(participantId)) {
        throw new Error("The same participant is mapped to more than one eligible streamer in this run.");
      }
      seenParticipants.add(participantId);
    }

    // Snapshot — computed once, used for every child payout in this run.
    const totalPotAtPayout = season.pot || 0;
    const salaryPool = totalPotAtPayout * STREAMER_SALARY_POOL_PCT;
    const individualSalary = Math.round(salaryPool / eligible.length);

    const runId = generateId("txn");
    season.transactions.push({
      id: runId,
      seasonId,
      seasonDay: season.currentSeasonDay,
      timestamp: new Date().toISOString(),
      type: "streamerSalaryRun",
      teamA: null,
      teamB: null,
      playersOut: [],
      playersIn: [],
      amount: individualSalary * eligible.length,
      status: "completed",
      relatedTransactionId: null,
      description: String(reason).trim(),
      approvedBy: "commissioner",
      totalPotAtPayout,
      salaryPool,
      eligibleStreamerCount: eligible.length,
      individualSalary,
    });

    for (const { streamer, gamesStreamed } of eligible) {
      const participantId = map[streamer];
      season.transactions.push({
        id: generateId("txn"),
        seasonId,
        seasonDay: season.currentSeasonDay,
        timestamp: new Date().toISOString(),
        type: "streamerSalary",
        teamA: participantId,
        teamB: null,
        playersOut: [],
        playersIn: [],
        amount: individualSalary,
        status: "paid",
        relatedTransactionId: runId,
        description: `Streamer salary — ${streamer} (${gamesStreamed} games)`,
        approvedBy: "commissioner",
      });
      season.pot = (season.pot || 0) - individualSalary;
    }

    saveData(data);
    return { runId, totalPotAtPayout, salaryPool, individualSalary, eligibleCount: eligible.length, pot: season.pot };
  },

  /**
   * Runs every Trade validation check (rule set §16 / trade workflow) and
   * returns an itemized result WITHOUT mutating anything. Used both for the
   * live preview in the UI and, re-run, as the gate inside commitTrade.
   */
  evaluateTrade(seasonId, { teamA, playersOutA, teamB, playersOutB }) {
    const data = loadData();
    const season = data.seasons[seasonId];
    const checks = [];
    const fail = (label, reason) => checks.push({ label, valid: false, reason });
    const pass = (label) => checks.push({ label, valid: true, reason: null });

    if (!season) {
      fail("Season", "Season not found.");
      return { valid: false, checks, fee: 0, feeDoubled: false };
    }
    if (!season.rostersInitialized) {
      fail("Rosters", "Rosters must be initialized (post-draft) before trading.");
      return { valid: false, checks, fee: 0, feeDoubled: false };
    }
    if (!teamA || !teamB) {
      fail("Teams", "Select two different teams.");
      return { valid: false, checks, fee: 0, feeDoubled: false };
    }
    if (teamA === teamB) {
      // Same participant selected on both sides (e.g. Team A = Maka, Team
      // B = Maka) — a participant can never trade with themselves. Named
      // explicitly here (rather than a generic "select two different
      // teams") so the preview/commit failure is unambiguous about why.
      const name = season.participants?.[teamA]?.name || "This participant";
      fail("Teams", `${name} cannot trade with themselves — Team A and Team B must be different participants.`);
      return { valid: false, checks, fee: 0, feeDoubled: false };
    }
    if (!playersOutA?.length || !playersOutB?.length) {
      fail("Players", "Select at least one player from each team.");
      return { valid: false, checks, fee: 0, feeDoubled: false };
    }

    const rosterA = season.currentRosters[teamA] || [];
    const rosterB = season.currentRosters[teamB] || [];

    const missingA = playersOutA.filter((pid) => !rosterA.some((e) => e.playerId === pid));
    const missingB = playersOutB.filter((pid) => !rosterB.some((e) => e.playerId === pid));
    if (missingA.length || missingB.length) {
      fail("Ownership", "One or more selected players are not currently owned by the selected team.");
      return { valid: false, checks, fee: 0, feeDoubled: false };
    }
    pass("Ownership");

    const day = season.currentSeasonDay ?? 1;
    if (isTransactionsLockedDay(day)) {
      fail("Season Day", `Day ${day} — trading is closed.`);
    } else {
      pass("Season Day");
    }

    const playersA = playersOutA.map((pid) => data.players[pid]).filter(Boolean);
    const playersB = playersOutB.map((pid) => data.players[pid]).filter(Boolean);
    const totalA = playersA.reduce((s, p) => s + p.overall, 0);
    const totalB = playersB.reduce((s, p) => s + p.overall, 0);
    const diff = Math.abs(totalA - totalB);
    if (diff > 4) {
      fail("Rating balance", `Trade difference is ${diff} OVR (max ±4). Team A sends ${totalA}, Team B sends ${totalB}.`);
    } else {
      pass(`Rating balance: difference ${diff}`);
    }

    const redYellow = validateRedYellowCompatibility(season, playersOutA, playersOutB);
    if (!redYellow.valid) fail("Red/Yellow compatibility", redYellow.reason);
    else pass("Red/Yellow compatibility");

    const afterA = [
      ...rosterA.filter((e) => !playersOutA.includes(e.playerId)),
      ...playersOutB.map((pid) => ({ playerId: pid, source: "trade" })),
    ];
    const afterB = [
      ...rosterB.filter((e) => !playersOutB.includes(e.playerId)),
      ...playersOutA.map((pid) => ({ playerId: pid, source: "trade" })),
    ];

    const posA = validateResultingPositions(rosterA, afterA, data.players);
    const posB = validateResultingPositions(rosterB, afterB, data.players);
    if (!posA.valid) fail("Position limit (Team A)", posA.reason);
    else pass("Position limit (Team A)");
    if (!posB.valid) fail("Position limit (Team B)", posB.reason);
    else pass("Position limit (Team B)");

    const blueA = validateBlueComposition(afterA, data.players);
    const blueB = validateBlueComposition(afterB, data.players);
    if (!blueA.valid) fail("Blue restrictions (Team A)", blueA.reason);
    else pass("Blue restrictions (Team A)");
    if (!blueB.valid) fail("Blue restrictions (Team B)", blueB.reason);
    else pass("Blue restrictions (Team B)");

    for (const p of playersB) {
      const minCheck = validateMinimumRating(p);
      if (!minCheck.valid) fail("Minimum rating (Team A incoming)", minCheck.reason);
    }
    for (const p of playersA) {
      const minCheck = validateMinimumRating(p);
      if (!minCheck.valid) fail("Minimum rating (Team B incoming)", minCheck.reason);
    }

    const cap = season.ratingCap ?? 875;
    const capA = validateRatingCap(afterA, data.players, cap);
    const capB = validateRatingCap(afterB, data.players, cap);
    if (!capA.valid) fail(`Rating cap (Team A, ${cap})`, capA.reason);
    else pass(`Rating cap (Team A, ${cap})`);
    if (!capB.valid) fail(`Rating cap (Team B, ${cap})`, capB.reason);
    else pass(`Rating cap (Team B, ${cap})`);

    // Rule E: normal trade fee is POOL-based only, summed per player moved,
    // doubled on Days 9-11 (never on swaps).
    const feeDoubled = isFeeDoubleDay(day);
    const allMoved = [...playersA, ...playersB];
    let fee = allMoved.reduce((sum, p) => sum + getPoolTradeFee(p), 0);
    if (feeDoubled) fee *= 2;

    const valid = checks.every((c) => c.valid);
    return { valid, checks, fee, feeDoubled, totalA, totalB, diff };
  },

  /** Re-validates (never trusts a stale preview) then atomically commits a trade. */
  commitTrade(seasonId, { teamA, playersOutA, teamB, playersOutB }) {
    const evaluation = this.evaluateTrade(seasonId, { teamA, playersOutA, teamB, playersOutB });
    if (!evaluation.valid) {
      const reasons = evaluation.checks.filter((c) => !c.valid).map((c) => c.reason).join(" ");
      throw new Error(reasons || "Trade failed validation.");
    }

    const data = loadData();
    const season = data.seasons[seasonId];
    ensureTransactionFields(season); // backfill for seasons created before Phase 5
    const rosterA = season.currentRosters[teamA];
    const rosterB = season.currentRosters[teamB];

    season.currentRosters[teamA] = [
      ...rosterA.filter((e) => !playersOutA.includes(e.playerId)),
      ...rosterB.filter((e) => playersOutB.includes(e.playerId)).map((e) => ({ ...e, source: "trade" })),
    ];
    season.currentRosters[teamB] = [
      ...rosterB.filter((e) => !playersOutB.includes(e.playerId)),
      ...rosterA.filter((e) => playersOutA.includes(e.playerId)).map((e) => ({ ...e, source: "trade" })),
    ];

    season.pot = (season.pot || 0) + evaluation.fee;

    const describe = (pid) => {
      const p = data.players[pid];
      const info = getPlayerClassificationInfo(season, pid);
      return {
        playerId: pid,
        name: p?.name,
        overall: p?.overall,
        pool: p?.pool,
        pickClassification: info.classification === "PINK" ? "PINK" : info.classification,
        isJoker: info.isJoker,
      };
    };
    const tradeTransactionId = generateId("txn");
    season.transactions.push({
      id: tradeTransactionId,
      seasonId,
      seasonDay: season.currentSeasonDay,
      timestamp: new Date().toISOString(),
      type: "trade",
      teamA,
      teamB,
      playersOut: playersOutA.map(describe),
      playersIn: playersOutB.map(describe),
      fee: evaluation.fee,
      feeDoubled: evaluation.feeDoubled,
      approvedBy: "commissioner",
    });

    // ── Financial Management (F3 — Trade Fee Splitting) ─────────────────────
    // Attribution only — season.pot was already increased by the FULL
    // evaluation.fee above, exactly as before F3; the two records below
    // never touch season.pot themselves, so a ₱200 trade still adds
    // exactly ₱200 to the pot, not ₱400. They exist so a later phase can
    // derive each participant's trade-fee total from the ledger without
    // re-splitting the shared `trade` transaction's fee itself.
    // evaluation.fee is always a sum of POOL_TRADE_FEE (100/200) across at
    // least one player per side, optionally doubled — always an even
    // number under every existing fee rule, so `/ 2` is always a whole
    // peso amount; no rounding policy is needed or invented here. Skipped
    // entirely if fee is ever 0 (not currently reachable — a valid trade
    // always has fee >= 200 — but guarded per the no-unnecessary-₱0-
    // records rule rather than assumed away).
    //
    // F6 Revision 2: status is "pending", not "paid" — the fee is CHARGED
    // now (pot already reflects it, above) but not yet necessarily PAID.
    // Whether/how much has actually been paid is tracked separately via
    // `payment` transactions (AdminActions.recordFinancialPayment) — see
    // f6ParticipantBreakdown's doc comment for the full model. A
    // tradeFeeSplit written by code that predates this revision always has
    // status "paid" explicitly, so old records are unambiguous and need no
    // migration — see f6IsCollected().
    if (evaluation.fee > 0) {
      ensureFinancialFields(season); // backfill for seasons created before F1
      const half = evaluation.fee / 2;
      const makeSplit = (participantId, label) => ({
        id: generateId("txn"),
        seasonId,
        seasonDay: season.currentSeasonDay,
        timestamp: new Date().toISOString(),
        type: "tradeFeeSplit",
        teamA: participantId,
        teamB: null,
        playersOut: [],
        playersIn: [],
        amount: half,
        status: "pending",
        relatedTransactionId: tradeTransactionId,
        description: `Trade fee — ${label} share`,
        approvedBy: "commissioner",
      });
      season.transactions.push(makeSplit(teamA, "Team A"));
      season.transactions.push(makeSplit(teamB, "Team B"));
    }

    saveData(data);
    return evaluation;
  },

  /**
   * Runs every Swap validation check (rule set §17 / swap workflow).
   * isJokerSwap=true uses the ₱300 Joker fee and, on commit, makes
   * incomingPlayerId the participant's new Joker at jokerPosition.
   */
  evaluateSwap(seasonId, { participantId, outgoingPlayerId, incomingPlayerId, isJokerSwap, jokerPosition }) {
    const data = loadData();
    const season = data.seasons[seasonId];
    const checks = [];
    const fail = (label, reason) => checks.push({ label, valid: false, reason });
    const pass = (label) => checks.push({ label, valid: true, reason: null });

    if (!season) {
      fail("Season", "Season not found.");
      return { valid: false, checks, fee: 0 };
    }
    if (!season.rostersInitialized) {
      fail("Rosters", "Rosters must be initialized (post-draft) before swapping.");
      return { valid: false, checks, fee: 0 };
    }
    const roster = season.currentRosters[participantId] || [];
    const outgoingEntry = roster.find((e) => e.playerId === outgoingPlayerId);
    if (!outgoingEntry) {
      fail("Ownership", "That player is not currently on this roster.");
      return { valid: false, checks, fee: 0 };
    }
    pass("Ownership");

    if (isJokerSwap && !outgoingEntry.isJoker) {
      fail("Joker", "A Joker swap must select the participant's current Joker as the outgoing player.");
    }

    const day = season.currentSeasonDay ?? 1;
    if (isTransactionsLockedDay(day)) {
      fail("Season Day", `Day ${day} — swaps are closed.`);
    } else {
      pass("Season Day");
    }

    const outgoingPlayer = data.players[outgoingPlayerId];
    const incomingPlayer = data.players[incomingPlayerId];
    if (!incomingPlayer) {
      fail("Replacement", "Replacement player not found.");
      return { valid: checks.every((c) => c.valid), checks, fee: 0 };
    }

    // Rule 10: a swap returns the outgoing player to the pool and draws an
    // eligible replacement — the incoming player must not already be owned
    // by any roster. The Discord rules don't require the replacement to
    // come from the SAME pool as the outgoing player (Blue restrictions are
    // explicitly meant to be checked "after every transaction," implying a
    // swap can turn a Green slot into a Blue one); pool/rating/position/cap
    // eligibility is enforced below via the standard resulting-roster checks
    // instead of a same-pool requirement.
    const ownedElsewhere = Object.entries(season.currentRosters).some(
      ([pid, entries]) => pid !== participantId && entries.some((e) => e.playerId === incomingPlayerId)
    );
    const ownedHere = roster.some((e) => e.playerId === incomingPlayerId);
    if (ownedElsewhere || ownedHere) {
      fail("Replacement eligibility", `${incomingPlayer.name} is already owned by a roster.`);
    } else {
      pass("Replacement eligibility");
    }

    const minCheck = validateMinimumRating(incomingPlayer);
    if (!minCheck.valid) fail("Minimum rating", minCheck.reason);
    else pass("Minimum rating");

    if (isJokerSwap && !jokerPosition) {
      fail("Joker position", "A Joker swap must specify the assigned roster position.");
    }

    const afterEntries = [
      ...roster.filter((e) => e.playerId !== outgoingPlayerId),
      isJokerSwap
        ? { playerId: incomingPlayerId, source: "swap", isJoker: true, jokerPosition }
        : { playerId: incomingPlayerId, source: "swap" },
    ];

    const posCheck = validateResultingPositions(roster, afterEntries, data.players);
    if (!posCheck.valid) fail("Position limit", posCheck.reason);
    else pass("Position limit");

    const blueCheck = validateBlueComposition(afterEntries, data.players);
    if (!blueCheck.valid) fail("Blue restrictions", blueCheck.reason);
    else pass("Blue restrictions");

    const cap = season.ratingCap ?? 875;
    const capCheck = validateRatingCap(afterEntries, data.players, cap);
    if (!capCheck.valid) fail(`Rating cap (${cap})`, capCheck.reason);
    else pass(`Rating cap (${cap})`);

    const fee = isJokerSwap ? JOKER_SWAP_FEE : REGULAR_SWAP_FEE;
    const valid = checks.every((c) => c.valid);
    return { valid, checks, fee, isJokerSwap: !!isJokerSwap };
  },

  /** Re-validates then atomically commits a swap. */
  commitSwap(seasonId, { participantId, outgoingPlayerId, incomingPlayerId, isJokerSwap, jokerPosition }) {
    const evaluation = this.evaluateSwap(seasonId, {
      participantId, outgoingPlayerId, incomingPlayerId, isJokerSwap, jokerPosition,
    });
    if (!evaluation.valid) {
      const reasons = evaluation.checks.filter((c) => !c.valid).map((c) => c.reason).join(" ");
      throw new Error(reasons || "Swap failed validation.");
    }

    const data = loadData();
    const season = data.seasons[seasonId];
    ensureTransactionFields(season); // backfill for seasons created before Phase 5
    const roster = season.currentRosters[participantId];
    const newEntry = isJokerSwap
      ? { playerId: incomingPlayerId, source: "swap", isJoker: true, jokerPosition }
      : { playerId: incomingPlayerId, source: "swap" };

    season.currentRosters[participantId] = [
      ...roster.filter((e) => e.playerId !== outgoingPlayerId),
      newEntry,
    ];
    season.pot = (season.pot || 0) + evaluation.fee;

    const outPlayer = data.players[outgoingPlayerId];
    const inPlayer = data.players[incomingPlayerId];
    season.transactions.push({
      id: generateId("txn"),
      seasonId,
      seasonDay: season.currentSeasonDay,
      timestamp: new Date().toISOString(),
      type: isJokerSwap ? "jokerSwap" : "swap",
      teamA: participantId,
      teamB: null,
      playersOut: [{
        playerId: outgoingPlayerId, name: outPlayer?.name, overall: outPlayer?.overall,
        pool: outPlayer?.pool, isJoker: !!isJokerSwap,
      }],
      playersIn: [{
        playerId: incomingPlayerId, name: inPlayer?.name, overall: inPlayer?.overall,
        pool: inPlayer?.pool, isJoker: !!isJokerSwap,
      }],
      fee: evaluation.fee,
      feeDoubled: false,
      // F6 Revision 2: charged now (pot already reflects it, above via
      // season.pot += evaluation.fee), not yet necessarily paid — see
      // f6ParticipantBreakdown's doc comment. A swap/jokerSwap record from
      // before this revision has no status field at all; f6IsCollected()
      // treats that specific absence as "collected" (the old commitSwap()
      // unconditionally paid it at creation), so no migration is needed.
      status: "pending",
      approvedBy: "commissioner",
    });

    saveData(data);
    return evaluation;
  },

  /**
   * Rule C (revised): designates one of a participant's own picks #1-10 as
   * their Joker (PINK). Joker eligibility is no longer restricted to picks
   * #6-10 — any of a participant's first 10 own picks qualifies. Only one
   * Joker per participant at a time — designating a new one first clears
   * any existing Joker flag for that participant (does not remove the
   * player, only the isJoker/jokerPosition tag). The player's original
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
   * still the same single Joker mechanism — own-pick #1-10 eligibility
   * below is unconditional either way; only the resulting-position check
   * is ever bypassed.
   */
  designateJoker(seasonId, participantId, playerId, jokerPosition, options = {}) {
    if (!jokerPosition) throw new Error("A Joker requires an assigned roster position.");
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    ensureTransactionFields(season); // backfill for seasons created before Phase 5
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
    const ownPickNumber = entry.draftSlot;
    if (ownPickNumber == null || ownPickNumber < 1 || ownPickNumber > 10) {
      throw new Error(
        "Joker must be one of this participant's own picks #1-10."
      );
    }

    const afterEntries = roster.map((e) =>
      e.playerId === playerId
        ? { ...e, isJoker: true, jokerPosition }
        : { ...e, isJoker: false, jokerPosition: undefined }
    );
    if (!options.bypassRosterRules) {
      const posCheck = validateResultingPositions(roster, afterEntries, data.players);
      if (!posCheck.valid) throw new Error(posCheck.reason);
    }

    season.currentRosters[participantId] = afterEntries;

    season.transactions.push({
      id: generateId("txn"),
      seasonId,
      seasonDay: season.currentSeasonDay,
      timestamp: new Date().toISOString(),
      type: "jokerDesignation",
      teamA: participantId,
      teamB: null,
      playersOut: [],
      playersIn: [{
        playerId,
        name: data.players[playerId]?.name,
        overall: data.players[playerId]?.overall,
        pool: data.players[playerId]?.pool,
        pickClassification: "PINK",
        isJoker: true,
      }],
      fee: 0,
      feeDoubled: false,
      approvedBy: "commissioner",
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
  // getSwapEligibleReplacements already does for Phase 5, a player is
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
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    ensureTransactionFields(season);
    if (!season.rostersInitialized) {
      throw new Error("Rosters must be initialized (post-draft) before manual roster editing.");
    }
    ensureRosterDraftSlots(season);
    if (!season.participants[participantId]) throw new Error("Participant not found.");
    const player = data.players[playerId];
    if (!player) throw new Error("Player not found.");

    const owner = findCurrentRosterEntry(season, playerId);
    if (owner) {
      const ownerName = season.participants[owner.participantId]?.name || "another team";
      throw new Error(`${player.name} is already on ${ownerName}'s roster — cannot be assigned twice.`);
    }

    const roster = season.currentRosters[participantId] || [];
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
        playerId, source: "manual", draftSlot: targetDraftSlot,
        ...(inheritedClassificationSource ? { classificationSourcePlayerId: inheritedClassificationSource } : {}),
      };
    } else {
      afterEntries = [...roster, { playerId, source: "manual", draftSlot: null }];
    }

    // Revision 3 — Manual Override: normal roster/game rules (position
    // requirements, Blue/Green composition, minimum rating, rating cap)
    // are intentionally NOT enforced here — see the Revision 2/3 header
    // comment above. Duplicate-ownership was already rejected above via
    // findCurrentRosterEntry, and `player` above already confirms the
    // playerId resolves to a real record — both are data integrity, not a
    // game rule, and remain enforced unconditionally.

    season.currentRosters[participantId] = afterEntries;

    season.transactions.push({
      id: generateId("txn"),
      seasonId,
      seasonDay: season.currentSeasonDay,
      timestamp: new Date().toISOString(),
      type: "manualRosterAdd",
      teamA: participantId,
      teamB: null,
      playersOut: [],
      playersIn: [{
        playerId, name: player.name, overall: player.overall, pool: player.pool, isJoker: false,
        draftSlot: targetDraftSlot,
      }],
      fee: 0,
      feeDoubled: false,
      approvedBy: "commissioner",
    });

    saveData(data);
  },

  /**
   * Manually removes a player from a participant's roster. This ONLY
   * removes their season.currentRosters entry — it never deletes the
   * player from the global database (js/admin/players.js's Delete
   * Player/Delete All Players is the only thing that does that) — so the
   * player is immediately draftable/assignable again everywhere
   * "available" is derived from currentRosters (getSwapEligibleReplacements,
   * getRosterForTransactions, and this same manual editor).
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
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    ensureTransactionFields(season);
    if (!season.rostersInitialized) {
      throw new Error("Rosters must be initialized (post-draft) before manual roster editing.");
    }
    ensureRosterDraftSlots(season);
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
    season.transactions.push({
      id: generateId("txn"),
      seasonId,
      seasonDay: season.currentSeasonDay,
      timestamp: new Date().toISOString(),
      type: "manualRosterRemove",
      teamA: participantId,
      teamB: null,
      playersOut: [{
        playerId, name: player?.name, overall: player?.overall, pool: player?.pool,
        isJoker: !!entry.isJoker, returnedToPool: true, draftSlot: entry.draftSlot ?? null,
      }],
      playersIn: [],
      fee: 0,
      feeDoubled: false,
      approvedBy: "commissioner",
    });

    saveData(data);
  },

  /**
   * Manually swaps one roster player out for a currently-unowned one, in
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
  manualReplacePlayerOnRoster(seasonId, participantId, outgoingPlayerId, incomingPlayerId) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    ensureTransactionFields(season);
    if (!season.rostersInitialized) {
      throw new Error("Rosters must be initialized (post-draft) before manual roster editing.");
    }
    ensureRosterDraftSlots(season);
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
    if (owner) {
      const ownerName = season.participants[owner.participantId]?.name || "another team";
      throw new Error(`${incomingPlayer.name} is already on ${ownerName}'s roster — cannot be assigned twice.`);
    }

    const preservedDraftSlot = outEntry.draftSlot ?? null;
    const classificationSourcePlayerId = outEntry.classificationSourcePlayerId ?? outgoingPlayerId;
    const afterEntries = roster.slice();
    afterEntries[idx] = {
      playerId: incomingPlayerId, source: "manual", draftSlot: preservedDraftSlot, classificationSourcePlayerId,
    };

    // Revision 3 — Manual Override: normal roster/game rules (position
    // requirements, Blue/Green composition, minimum rating, rating cap)
    // are intentionally NOT enforced here — see the Revision 2/3 header
    // comment above. Duplicate-ownership was already rejected above via
    // findCurrentRosterEntry, and `incomingPlayer` above already confirms
    // the playerId resolves to a real record — both are data integrity,
    // not a game rule, and remain enforced unconditionally.

    season.currentRosters[participantId] = afterEntries;

    const outgoingPlayer = data.players[outgoingPlayerId];
    season.transactions.push({
      id: generateId("txn"),
      seasonId,
      seasonDay: season.currentSeasonDay,
      timestamp: new Date().toISOString(),
      type: "manualRosterReplace",
      teamA: participantId,
      teamB: null,
      playersOut: [{
        playerId: outgoingPlayerId, name: outgoingPlayer?.name, overall: outgoingPlayer?.overall,
        pool: outgoingPlayer?.pool, isJoker: !!outEntry.isJoker, returnedToPool: true,
        draftSlot: preservedDraftSlot,
      }],
      playersIn: [{
        playerId: incomingPlayerId, name: incomingPlayer.name, overall: incomingPlayer.overall,
        pool: incomingPlayer.pool, isJoker: false, draftSlot: preservedDraftSlot,
      }],
      fee: 0,
      feeDoubled: false,
      approvedBy: "commissioner",
    });

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
