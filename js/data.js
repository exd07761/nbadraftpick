/**
 * data.js — Single source of truth for all league data.
 *
 * All reads and writes go through this module.
 * Public (read-only) functions are exported at the bottom.
 * Write functions are clearly marked and called only from admin context,
 * behind the auth boundary in auth-boundary.js.
 *
 * Storage: localStorage key "nba2k_league"
 * Future: replace loadData/saveData with API calls to backend.
 */

const STORAGE_KEY = "nba2k_league";

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
    // currentRosters[participantId] = [{ playerId, source, isJoker?, jokerPosition? }]
    //   source: 'draft' | 'trade' | 'swap'
    //   isJoker/jokerPosition: set only for the participant's designated Joker
    //   (Phase 5) — see AdminActions.designateJoker. Absent on every other entry.
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

    // ── Phase 7: Regular Season Schedule ──────────────────────────────────────
    // schedule[i] = { round: Number, matchups: [Matchup] }
    // Matchup = {
    //   id, teamA, teamB,        // teamA/teamB are participantIds (or teamB
    //                             // is null for a BYE — see generateSchedule)
    //   status,                  // 'scheduled' | 'completed'
    //   scoreA, scoreB, winner,  // winner is participantId, always derived
    //   streamer,                // free-text string, set at score-entry time
    //   playedAt,                // ISO string, set when the result is saved
    // }
    // NBA team abbreviation is intentionally NOT stored here — look it up via
    // season.nbaTeamAssignments[participantId] (single source of truth,
    // see Process 2 above) rather than duplicating it onto the matchup.
    schedule: [],
    scheduleGeneratedAt: null, // ISO string, set each time generateSchedule() runs

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
const MAX_BLUE_PLAYERS = 4;
const MAX_FIRST_THREE_BLUE_TOTAL = 280;
const MAX_FOURTH_BLUE_RATING = 94;
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
  const originalPick = getOriginalPickInfo(season, playerId);
  const current = findCurrentRosterEntry(season, playerId);
  const isJoker = !!(current && current.entry.isJoker);
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
function createPlayer(id, { name, position, overall, pool, variantGroup }) {
  return {
    id,
    name,        // e.g. "M. JORDAN" or "LEBRON JAMES (PRIME)"
    position,    // e.g. "SG"
    overall,     // e.g. 99
    pool: pool || undefined,               // 'green' | 'blue' | undefined
    variantGroup: variantGroup || undefined, // string | undefined
    createdAt: new Date().toISOString(),
  };
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

// ─── Storage (localStorage — replace with API calls in backend phase) ─────────

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getDefaultData();
    return JSON.parse(raw);
  } catch (e) {
    console.error("Failed to load league data:", e);
    return getDefaultData();
  }
}

function saveData(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.error("Failed to save league data:", e);
    throw new Error("Storage write failed. Data not saved.");
  }
}

// ─── ID Generation ────────────────────────────────────────────────────────────

function generateId(prefix = "id") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Public Read API ──────────────────────────────────────────────────────────
// These functions are safe to call from public-facing pages.
// They never write to storage.

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

    let currentRound = null;
    let currentPickInRound = null;
    let currentPickOverall = null;
    let currentParticipantId = null;

    if (n > 0) {
      const idx = totalPicksMade; // 0-based index of the NEXT pick to make
      currentRound = Math.floor(idx / n) + 1;
      const posInRound = idx % n;
      currentPickInRound = posInRound + 1;
      currentPickOverall = idx + 1;
      const isEvenRound = currentRound % 2 === 0;
      const orderIndex = isEvenRound ? n - 1 - posInRound : posInRound;
      currentParticipantId = order[orderIndex];
    }

    return {
      n,
      totalPicksMade,
      currentRound,
      currentPickInRound,
      currentPickOverall,
      currentParticipantId,
      currentParticipant: currentParticipantId
        ? season.participants[currentParticipantId]
        : null,
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
      return season.currentRosters[participantId].map(entry => ({
        ...entry,
        player: data.players[entry.playerId] || null,
      }));
    }

    // Fallback: derive from draft picks (pre-initialization view)
    return season.playerDraftPicks
      .filter(p => p.participantId === participantId)
      .map(p => ({
        playerId: p.playerId,
        source: 'draft',
        player: data.players[p.playerId] || null,
      }));
  },

  /**
   * Returns a summary of all participants' current rosters for the season,
   * sorted by participant addition order.
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
    const participants = this.getParticipants(seasonId);
    const cap = season.ratingCap ?? 875;

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
   * Ranking rule (the only one this league defines): sort by winPct
   * descending; if winPct is equal, sort by pointDifferential descending.
   * No other tie-breaker exists — equal winPct AND equal pointDifferential
   * rows are left in their relative order (stable sort), never
   * arbitrarily separated.
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
    const completedReal = allMatchups.filter(
      (m) => m.teamB !== null && m.status === "completed"
    );
    const scheduledReal = allMatchups.filter(
      (m) => m.teamB !== null && m.status !== "completed"
    );

    const stats = teamIds.map((pid) => {
      const participant = season.participants[pid];
      const nbaTeam = season.nbaTeamAssignments[pid] || null;

      const played = completedReal.filter(
        (m) => m.teamA === pid || m.teamB === pid
      );
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

      const gamesRemaining = scheduledReal.filter(
        (m) => m.teamA === pid || m.teamB === pid
      ).length;

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

    // Sort by the one established ranking rule: winPct desc, then PD desc.
    // Array.prototype.sort is stable, so ties on BOTH remain in their
    // existing (teamAssignmentOrder) relative order rather than being
    // reshuffled — no additional tie-breaker is invented here.
    stats.sort((a, b) => {
      if (b.winPct !== a.winPct) return b.winPct - a.winPct;
      return b.pointDifferential - a.pointDifferential;
    });

    return stats;
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
   * their own draft picks #6-10 (rule 7), not already the Joker, and only
   * once they've completed their first 5 picks. Returns [] (with a reason)
   * if that participant hasn't reached pick 6 yet.
   */
  getJokerEligiblePlayers(seasonId, participantId) {
    const season = this.getSeason(seasonId);
    if (!season) return [];
    const data = loadData();
    const ownPicks = season.playerDraftPicks.filter((p) => p.participantId === participantId);
    return ownPicks
      .map((p, i) => ({ pick: p, ownPickNumber: i + 1 }))
      .filter(({ ownPickNumber }) => ownPickNumber >= 6 && ownPickNumber <= 10)
      .map(({ pick, ownPickNumber }) => ({
        playerId: pick.playerId,
        player: data.players[pick.playerId] || null,
        ownPickNumber,
      }))
      .filter((e) => e.player);
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
  createSeason(name) {
    const data = loadData();
    const id = generateId("s");
    const season = createSeason(id, name);
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
  addParticipant(seasonId, name) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    const id = generateId("p");
    season.participants[id] = createParticipant(id, name.trim());
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

    const n = season.playerDraftOrder.length;
    const idx = season.playerDraftPicks.length; // 0-based index of this pick
    const round = Math.floor(idx / n) + 1;
    const posInRound = idx % n;
    const isEvenRound = round % 2 === 0;
    const orderIndex = isEvenRound ? n - 1 - posInRound : posInRound;
    const participantId = season.playerDraftOrder[orderIndex];
    const pick = idx + 1;

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
    saveData(data);
  },

  markDraftComplete(seasonId) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    season.draftComplete = true;
    saveData(data);
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
   * decide whether to offer regeneration in the UI at all.
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
    saveData(data);
    return season.schedule;
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
  initializeRostersFromDraft(seasonId) {
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    if (!season.draftComplete)
      throw new Error("Mark the draft complete before initializing rosters.");

    // Group draft picks by participant, preserving pick order within each.
    const rosters = {};
    for (const participant of Object.values(season.participants)) {
      rosters[participant.id] = [];
    }
    for (const pick of season.playerDraftPicks) {
      if (!rosters[pick.participantId]) rosters[pick.participantId] = [];
      rosters[pick.participantId].push({
        playerId: pick.playerId,
        source: 'draft',
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
    if (!teamA || !teamB || teamA === teamB) {
      fail("Teams", "Select two different teams.");
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
    season.transactions.push({
      id: generateId("txn"),
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
      approvedBy: "commissioner",
    });

    saveData(data);
    return evaluation;
  },

  /**
   * Rule C: designates one of a participant's own picks #6-10 as their
   * Joker (PINK). Only one Joker per participant at a time — designating a
   * new one first clears any existing Joker flag for that participant
   * (does not remove the player, only the isJoker/jokerPosition tag).
   * The player's original draft history (playerDraftPicks) is untouched.
   */
  designateJoker(seasonId, participantId, playerId, jokerPosition) {
    if (!jokerPosition) throw new Error("A Joker requires an assigned roster position.");
    const data = loadData();
    const season = data.seasons[seasonId];
    if (!season) throw new Error("Season not found");
    ensureTransactionFields(season); // backfill for seasons created before Phase 5
    if (!season.rostersInitialized) throw new Error("Rosters must be initialized before designating a Joker.");

    const ownPicks = season.playerDraftPicks.filter((p) => p.participantId === participantId);
    const pickIndex = ownPicks.findIndex((p) => p.playerId === playerId);
    const ownPickNumber = pickIndex + 1;
    if (pickIndex === -1 || ownPickNumber < 6 || ownPickNumber > 10) {
      throw new Error(
        "Joker must be one of this participant's own picks #6-10, declared after their first 5 picks."
      );
    }

    const roster = season.currentRosters[participantId];
    const entry = roster && roster.find((e) => e.playerId === playerId);
    if (!entry) throw new Error("Player is not currently on this participant's roster.");

    const afterEntries = roster.map((e) =>
      e.playerId === playerId
        ? { ...e, isJoker: true, jokerPosition }
        : { ...e, isJoker: false, jokerPosition: undefined }
    );
    const posCheck = validateResultingPositions(roster, afterEntries, data.players);
    if (!posCheck.valid) throw new Error(posCheck.reason);

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

  // ── Player Database ────────────────────────────────────────────────────────

  addPlayer({ name, position, overall, pool, variantGroup }) {
    const data = loadData();
    const id = generateId("pl");
    const player = createPlayer(id, { name, position, overall, pool, variantGroup });
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
   * Import players from parsed CSV rows.
   *
   * Column headers are matched case-insensitively and with surrounding
   * whitespace trimmed, so "Name", "name", "NAME", and " Name " all
   * match. A small alias list also covers common variants like
   * "Player Name" for the name column. See FIELD_ALIASES below for the
   * exact list of recognized header text per field.
   *
   * Duplicate names are allowed — each import gets a unique ID.
   * Returns { imported, skipped, errors }
   */
  importPlayersFromCSV(rows) {
    const data = loadData();
    let imported = 0;
    let skipped = 0;
    const errors = [];

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
          errors.push(`Note on "${name || "row"}": pool value "${rawPool}" not recognized (expected green/blue) — left unassigned.`);
        }

        // variantGroup: free-text identifier, used as-is (trimmed). Never
        // inferred from name/position/overall — blank stays undefined.
        const variantGroup = String(getField(normalizedRow, "variantGroup") || "").trim() || undefined;

        if (!name) { skipped++; continue; }
        if (isNaN(overall)) { errors.push(`Skipped "${name}": invalid overall`); skipped++; continue; }

        const id = generateId("pl");
        data.players[id] = createPlayer(id, { name, position, overall, pool, variantGroup });
        imported++;
      } catch (e) {
        errors.push(`Row error: ${e.message}`);
        skipped++;
      }
    }

    saveData(data);
    return { imported, skipped, errors };
  },

  // Dev/debug only — wipe all data
  _resetAllData() {
    localStorage.removeItem(STORAGE_KEY);
  },
};

// Freeze public API to prevent accidental mutation
Object.freeze(LeagueData);
