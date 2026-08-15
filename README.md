# NBA 2K League Manager

CPU-vs-CPU fantasy league management app.

---

## Project Structure

```
index.html              Public site (read-only, no login required)
admin.html              Admin site (write access, behind auth boundary)

css/
  main.css              Public styles
  admin.css             Admin-specific styles (extends main.css tokens)

assets/
  logos/                30 local NBA team SVGs (atlanta-hawks.svg … washington-wizards.svg —
                         filenames slugified from NBA_TEAMS[].name). No external URLs/CDNs
                         anywhere in the app; see "Team Badges & Logos" below for the fallback.

js/
  data.js               ← SINGLE SOURCE OF TRUTH
                          LeagueData (public read API)
                          AdminActions (write API — admin only)
                          NBA_TEAMS (static reference)

  shared-utils.js        Utilities used by both pages (escapeHtml, showToast, formatStatus,
                          teamBadge/badgeTextColor — Phase 10 local team-identity component)
  public-router.js       Public router — index.html only, never loaded by admin.html

  views/
    home.js             Public dashboard / showcase (rebuilt Phase 10)
    teams.js            Public teams/roster view
    roster.js           Public roster view
    schedule.js         Public regular-season schedule view (Phase 7; card redesign Phase 10)
    standings.js        Public standings + streamer leaderboard (Phase 8; card redesign Phase 10)
    playoffs.js         Public playoff bracket view (Phase 9 logic; connected-bracket redesign Phase 10)
    players.js          Public read-only player database browser (Phase 10, new)
    stubs.js            (no stubs remain — kept as a landing point for future views)

  admin/
    auth-boundary.js    Auth guard — documents backend requirements
    seasons.js          Season create/manage
    participants.js     Participant add/edit/remove
    players.js          Player database + CSV import (Green/Blue pool tabs — Phase 10)
    draft-order.js      DuckRace order entry (both processes)
    draft.js            Live pick-by-pick player draft (Phase 2 engine; 2K-style console redesign Phase 10.3)
    team-assignment.js  NBA team assignment (Phase 3)
    schedule.js         Regular-season scheduler + score entry (Phase 7)
    playoffs.js         Playoff bracket generation + score/selection entry (Phase 9)

  admin.js              Admin router + login gate
```

---

### Team Badges & Logos (Phase 10, logos added Phase 10.2)

Team identity throughout the site (Home, Teams, Rosters, Schedule,
Standings, Playoffs, Team Assignment, and Admin Schedule/Participants) is
rendered by `teamBadge()` in `shared-utils.js`. As of Phase 10.2 this
renders each team's local SVG logo — `assets/logos/<team-slug>.svg`, e.g.
`assets/logos/atlanta-hawks.svg` — supplied by the project owner and
committed to the repo; there are no external URLs, CDNs, or hotlinked
images anywhere in the app. The filename slugs are derived from each
team's `name` in `NBA_TEAMS` (data.js), not guessed from the source
files, so the mapping is exact and traceable back to the app's own data.

`NBA_TEAMS` carries a `logo` path plus the original `color`/`colorAlt`
fields. If a team has no `logo` set, or its image fails to load for any
reason, `teamBadge()` falls back to the original colored-initials badge
via a plain inline `onerror` handler — no broken-image icon is ever
shown, and no extra JS wiring is needed per caller. None of these fields
carry ownership meaning: participant → NBA team ownership is decided
exclusively by `season.nbaTeamAssignments`, exactly as before.

The Draft and Players pages don't display NBA team logos — those pages
are about the Green/Blue player pools, which aren't tied to NBA team
ownership (that assignment happens in a separate step, after the draft).
Admin's playoff score-entry console (`js/admin/playoffs.js`) also still
shows plain team-name text rather than badges: its team-label helper
feeds directly into `prompt()`/`confirm()` dialog text and `<select>`
option lists in several places, where injecting `<img>` markup would
either render as literal garbage text or break the picker — the public
Playoffs bracket (`js/views/playoffs.js`) already has full logo
treatment, and reworking the admin console's label plumbing to safely
carry both a plain-text and an HTML form wasn't part of this targeted
revision.



## Data Model

All data lives under the `nba2k_league` key in localStorage (Phase 1).
Replace `loadData()` / `saveData()` in `data.js` with API calls in Phase 2.

```
{
  seasons: {
    "<seasonId>": {
      id, name, status, createdAt,
      participants: { "<pid>": { id, name } },

      // Process 1 — Player Draft (DuckRace #1)
      playerDraftOrder: ["pid1", "pid2", ...],
      playerDraftPicks: [{ round, pick, participantId, playerId }],
      draftComplete: bool,

      // Process 2 — Team Assignment (DuckRace #2) — SEPARATE from Process 1
      teamAssignmentOrder: ["pid3", "pid1", ...],
      nbaTeamAssignments: { "<pid>": "LAL" },
      teamAssignmentComplete: bool,

      // Process 3 — Regular Season Schedule (Phase 7)
      schedule: [],        // [{ round, matchups: [Matchup] }]
      scheduleGeneratedAt: null,
      results: [],         // reserved for future use — standings (Phase 8) are
                            // NEVER stored here; fully derived from `schedule`

      // Phase 9 — see season.playoffs below for the real shape.
      playoffs: null,
    }
  },
  players: {
    "<playerId>": { id, name, nbaTeam, position, overall }
  },
  settings: {
    currentSeasonId: "<seasonId>"
  }
}
```

### Key invariants
- `playerDraftOrder` and `teamAssignmentOrder` are always stored separately and never merged.
- Players have globally unique IDs — duplicate player names are safe.
- Previous seasons are never mutated when a new season is created.
- `currentSeasonId` only affects admin default context; public views can access any season by ID.
- A `Matchup` (inside `schedule[i].matchups`) stores `teamA`/`teamB` as **participantIds**, never NBA team abbreviations — the team abbreviation is always looked up via `nbaTeamAssignments`, which remains the single source of truth for participant → team ownership.
- `teamB: null` on a matchup means that round's BYE for `teamA` — a scheduling artifact only, never a game (no score/streamer/winner, excluded from standings).
- Tied scores are invalid and rejected at the data layer — there is no overtime or tie-break rule.
- Standings are never stored — `LeagueData.getTeamStatistics`/`getStreamerStatistics` derive everything from `season.schedule` on every call. Ranking is Win % descending, then Point Differential descending; no other tie-breaker exists.
- Playoff seeds (`playoffs.seeds`) are the one deliberate exception to "derive, don't store" — a frozen snapshot taken at generation time, so regular-season edits after a bracket exists never reshuffle it. Everything else in `playoffs` (winners, semifinal/championship construction, `champion`) is still always derived from `games`, never accepted as a caller-supplied value.

---

## Auth Boundary

### Phase 1 (current)
- `admin.html` is a **UX gate**, not a security gate.
- `auth-boundary.js` holds an in-memory session flag, cleared on page reload.
- No password is stored anywhere in the frontend code.
- The login form is a visual stub for the future backend endpoint.

### What the backend must provide (future — Phase 6)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/auth/login` | POST | Authenticate. Body: `{ username, password }`. Set HttpOnly session cookie. |
| `/api/auth/logout` | POST | Clear session cookie. |
| `/api/auth/me` | GET | Return `{ id, username, role }` or 401. |
| `/api/seasons` | GET | Public. All seasons. |
| `/api/seasons` | POST | Admin only. Create season. |
| `/api/seasons/:id` | PUT/DELETE | Admin only. |
| `/api/players` | GET | Public. |
| `/api/players` | POST/PUT/DELETE | Admin only. |
| ... | | All write endpoints require session cookie / JWT. |

Replace `AuthBoundary.login()` in `auth-boundary.js` with a real `fetch('/api/auth/login', ...)` call.
Replace `loadData()`/`saveData()` in `data.js` with REST API calls.

---

## Processes

### Process 1 — Player Draft
1. Run DuckRace externally.
2. Admin enters result in **Draft Orders** → "Process 1". This sets `playerDraftOrder` — the authoritative order, never randomized by the app.
3. Admin runs the live snake draft in the **Draft** view: search the available player pool, click Draft to record a pick.
4. Round, pick number, and the current participant are never stored — they're derived every time from `playerDraftOrder.length` and `playerDraftPicks.length` (odd rounds ascend through the order, even rounds reverse it), so a page refresh always shows the correct current pick.
5. "Undo Last Pick" removes only the most recent entry from `playerDraftPicks`; earlier picks can't be edited yet.
6. Admin marks the draft complete explicitly — this does not auto-start NBA team assignment.

### Process 2 — NBA Team Assignment
1. After the player draft is complete, run DuckRace again externally — a completely separate result from DuckRace #1.
2. Admin enters the result in **Draft Orders** → "Process 2". This sets `teamAssignmentOrder` — independent of `playerDraftOrder`; nothing in this process reads or writes the player draft's data.
3. Admin runs the assignment in the **Team Assignment** view: click any available team to assign it to whoever is currently on the clock.
4. The current pick number and current participant are never stored — they're derived every time from `teamAssignmentOrder.length` and how many entries exist in `nbaTeamAssignments`, so a page refresh always shows the correct current pick. The participant to assign next is always computed, never chosen arbitrarily, so assignment can't happen out of sequence.
5. "Undo Last Assignment" removes only the most recent assignment (always the participant at the end of the completed sequence); earlier assignments can't be edited yet.
6. Once every participant has a team, admin marks assignment complete explicitly — this does not auto-start the regular season.

**Neither order is ever randomized by this application.**

### Process 3 — Regular Season Schedule
1. After team assignment is complete, the admin clicks **Generate Schedule** in the **Schedule** view. This reads `nbaTeamAssignments` directly (the number of teams is never hardcoded) and writes a single round-robin schedule into `season.schedule`.
2. If the team count is odd, one team gets a BYE each round — a scheduling artifact only, with no score, streamer, or winner attached, and excluded from future standings.
3. The admin opens any scheduled matchup, enters both scores and the streamer, and saves. The winner is always computed from the scores — never chosen manually — and tied scores are rejected outright (no overtime/tie-break rule exists in this league).
4. A saved result can be reopened and corrected later; saving again updates the same matchup rather than creating a duplicate game.
5. **Regenerate Schedule** is only available while zero games have been completed — once any game is finished, regeneration is disabled so a completed result can never be silently destroyed.

### Process 4 — Standings
1. The public **Standings** page calls `LeagueData.getTeamStatistics(seasonId)` on every render — there is no stored standings table anywhere to go stale.
2. Only completed real matchups count. BYEs are never real matchups; scheduled-but-unplayed games are excluded from GP/W/L/Win%/PF/PA/PD.
3. Ranking is Win % descending, then Point Differential descending — the only ranking rule this league has defined. Rows tied on both are shown with the same rank number rather than an invented ordering.
4. If an admin edits a completed result on the Schedule page (Process 3, step 4), the standings reflect the correction the next time the page renders — no separate "recalculate standings" action exists or is needed.
5. Streamer totals (`LeagueData.getStreamerStatistics`) count completed real games only, grouped by the free-text `streamer` field already stored on each matchup.

### Process 5 — Playoffs
1. The admin clicks **Generate Playoffs** in the **Playoffs** view once at least 12 ranked teams exist. This freezes the top 12 from `LeagueData.getTeamStatistics` into `playoffs.seeds` — a deliberate snapshot, the one exception to "derive, don't store" in this system, so a later edit to a regular-season result never reshuffles an existing bracket.
2. **Round 1 (Best of 1):** `5v12`, `6v11`, `7v10`, `8v9`. Seeds 1–4 do not appear anywhere in Round 1 — they simply have no match object until Round 2.
3. **Round 2 (Best of 3), two independent pools:** the winners of `5v12`/`6v11` are the top pool — seed 3 picks which one to face, and seed 4 automatically gets the other. The winners of `7v10`/`8v9` are the bottom pool — seed 1 picks, seed 2 automatically gets the leftover. The leftover assignment is never a separate admin action; it's a direct consequence of the pick.
4. A selection can be changed freely until a game has been played in either of that pool's two resulting series — at that point it locks, so a completed result can never be silently invalidated by a change of mind.
5. **Finals (Best of 3):** the seed-3-series winner plays the seed-4-series winner in one semifinal; the seed-1-series winner plays the seed-2-series winner in the other. Both semifinals, the Championship series, and `playoffs.champion` are all constructed automatically the instant their inputs exist — there is no manual "advance winner" button anywhere in the bracket.
6. Every game (Best-of-1 or Best-of-3) reuses Process 3's exact result rules: non-negative integer scores, ties rejected, streamer required, winner always derived and never chosen manually. A Best-of-3's third game is only offered once the series is tied 1-1, and no further game can be recorded once a series is decided.
7. Editing an already-recorded game is allowed (matching Process 3's edit-in-place behavior) **unless** that result has already been consumed by the next stage of the bracket (a pool selection made from it, a semifinal already built from it, or the Championship already built from it) — at that point the edit is rejected outright rather than leaving stale data downstream.
8. **Regenerate Bracket** is only available while zero playoff games have been played, mirroring Process 3's schedule-regeneration guard exactly.
9. `season.playoffs` is entirely separate from `season.schedule`/`results` (Process 3) and from the standings calculation (Process 4) — neither reads from nor writes to the other.

---

## CSV Import

Expected columns (header row required, case-insensitive):

| Column | Alternates accepted |
|---|---|
| `name` | `Name` |
| `nbaTeam` | `NBATeam`, `Team`, `team` |
| `position` | `Position`, `pos` |
| `overall` | `Overall`, `OVR`, `ovr` |

Export your Google Sheet as File → Download → CSV. Import via Admin → Players → Import CSV.

---

## Implemented Phases

- **Phase 1 — Foundation:** seasons, participants, player database + CSV import, DuckRace order entry for both processes.
- **Phase 2 — Player Draft:** live pick-by-pick snake draft, draft history, undo-last-pick, roster view.
- **Phase 3 — NBA Team Assignment:** sequential team assignment using DuckRace #2's order, assignment history, undo-last-assignment, completion state.
- **Phase 4A — Current Rosters & Rating Cap:** `currentRosters` initialized from completed draft picks (immutable `playerDraftPicks` untouched), configurable `ratingCap` (default 875), public roster view with `total / cap` bar and remaining display, admin roster view with per-participant cap usage. New files: `js/admin/roster.js`, `js/views/roster.js`. New `LeagueData` methods: `getCurrentRoster`, `getRosterSummary`. New `AdminActions` methods: `initializeRostersFromDraft`, `setRatingCap`.
- **Phase 4B — Player Draft Experience Refinement:** Player schema drops `nbaTeam`; adds optional `pool` (`'green'` | `'blue'` | unset — never inferred) and `variantGroup` (free-text identifier grouping variants, e.g. multiple LeBron cards; never inferred). Draft screen now shows five position columns (PG/SG/SF/PF/C) across Green Pool / Blue Pool, a live 5-position roster monitor with position-need checklist, and the 875 rating cap bar during drafting. Two new rules enforced **at the data layer** inside `AdminActions.makeDraftPick`: (1) drafting one variant locks the rest of its `variantGroup`; (2) a participant must fill all five core positions before drafting a second player at any position. New `LeagueData` read methods: `getPositionState`, `getDraftPoolStatus` (never removes players from view — locked/drafted players stay visible with a status). Modified files: `js/data.js`, `js/draft.js`, `js/players.js`, `js/admin/roster.js`, `js/views/roster.js`, `js/teams.js`, `css/admin.css`. Phase 4A's `currentRosters`/`playerDraftPicks` architecture is unchanged.
- **Phase 7 — Regular Season Scheduler + Match Results:** Single round-robin scheduler (standard circle method) generated from the season's actual NBA team assignments — no hardcoded team count, odd counts get a synthetic BYE. New `AdminActions` methods: `generateSchedule` (blocked from regenerating once any game is completed, to protect results), `recordMatchResult` (score + streamer entry; also used to edit a completed result in place — never creates a duplicate). New `LeagueData` read methods: `getSchedule`, `getMatchup`, `getScheduleState`. Winner is always derived from scores, never admin-selected; tied scores are rejected (no overtime/tie-break rule exists). A BYE carries no score/streamer/winner. Matchups store participant IDs, not team abbreviations — `nbaTeamAssignments` (Phase 3) remains the single source of truth for team ownership. New files: `js/admin/schedule.js`, `js/views/schedule.js` (replaces the old `ScheduleView` stub in `js/views/stubs.js`). Modified: `js/data.js`, `js/admin.js`, `admin.html`, `index.html`, `css/main.css`, `css/admin.css`.
- **Phase 8 — Standings & Statistics:** Fully derived from `season.schedule` on every read — nothing is stored, so editing a completed result (Phase 7) is reflected the next time standings render, with no separate update step. Ranking rule (the only one this league defines): Win % descending, then Point Differential descending; no other tie-breaker exists, and equal-on-both rows share a display rank rather than being arbitrarily ordered. There is no separate win/loss points system — Win % is the sole primary metric. BYEs and not-yet-completed games are excluded from every column (GP/W/L/Win%/PF/PA/PD). New `LeagueData` read methods: `getTeamStatistics`, `getStreamerStatistics` — no new `AdminActions`, since there is nothing to write. New file: `js/views/standings.js` (replaces the old `StandingsView` stub in `js/views/stubs.js`). Modified: `js/data.js`, `index.html`, `css/main.css`. No admin standings page — corrections happen via the existing Schedule page's score-edit panel. Phase 7's schedule/result architecture is untouched.
- **Phase 9 — Playoffs:** 12-team bracket, seeded and frozen from `LeagueData.getTeamStatistics` at generation time — later edits to regular-season results never reshuffle an existing bracket. Round 1 (BO1): `5v12`, `6v11`, `7v10`, `8v9`, seeds 1–4 bye. Round 2 (BO3): top pool = winners of `5v12`/`6v11` — seed 3 picks one opponent, seed 4 automatically gets the other; bottom pool = winners of `7v10`/`8v9` — seed 1 picks, seed 2 gets the leftover automatically. Finals (BO3): the seed-3-series and seed-4-series winners meet in one semifinal; the seed-1-series and seed-2-series winners meet in the other; those two winners play one Championship BO3. Every winner and downstream pairing (semifinal teams, the championship's own construction, `champion`) is derived automatically the moment its inputs exist — there is no manual "advance" action anywhere in the bracket. New `AdminActions`: `generatePlayoffs` (blocked from regenerating once any playoff game exists), `selectPlayoffOpponent` (seed 3/seed 1's choice; re-selectable only until a game has been played in either resulting series), `recordPlayoffGameResult` (shared by BO1 and BO3, reusing Phase 7's tie-invalid/winner-derived/streamer-required/edit-in-place rules; a new game can only be appended in order, a BO3's 3rd game only when the series is tied 1-1, and no new game once a series/match is decided; editing an *existing* game is blocked once that item's result has already been consumed by the next round, to avoid silently invalidating downstream data). New `LeagueData` reads: `getPlayoffs`, `getPlayoffItem`. New files: `js/admin/playoffs.js`, `js/views/playoffs.js` (replaces the old `PlayoffsView` stub — `js/views/stubs.js` is now empty of stubs). Modified: `js/data.js`, `js/admin.js`, `admin.html`, `index.html`, `css/main.css`. `playoffs` is entirely separate from `season.schedule`/`results` (Phase 7) and from Phase 8's standings calculation — neither reads from nor writes to the other.
- **Phase 10 — NBA 2K-Style UI/UX Polish & Public Player Pool:** Presentation-only phase — no Phase 1–9 business logic, storage schema, or `AdminActions` behavior changed. `NBA_TEAMS` (data.js) gained presentation-only `color`/`colorAlt` fields; ownership is still decided exclusively by `nbaTeamAssignments` (see "Team Badges & Logos" above — no logo image assets exist, so team identity renders as a local colored-initials badge via the new `teamBadge()` helper in `shared-utils.js`, used everywhere a team appears). Draft (`admin/draft.js`) and both Players pages now present Green Pool / Blue Pool as tabs instead of stacked sections; there is no "Unassigned Pool" tab anywhere in the UI (players with no `pool` value still exist in the database — admin Players shows a count of them so nothing silently disappears, it's just not a third tab). New: `js/views/players.js` — a public, read-only, pool-tabbed player database browser, wired into `public-router.js` and the public nav; it reuses `getDraftPoolStatus` so drafted players stay visible but grayed out, exactly like the draft screen. Home (`views/home.js`) rebuilt into a showcase dashboard (hero header, team grid, schedule preview, standings preview, playoff/champion status) sourced entirely from existing `LeagueData` reads — no new stats invented. Schedule (`views/schedule.js`) rebuilt as a matchup-card grid; Standings (`views/standings.js`) gained a genuine mobile layout — a stacked-card view swaps in for the 11-column table below 700px via CSS, not `overflow-x` alone; Playoffs (`views/playoffs.js`) rebuilt as a connected 4-column bracket (Round 1 → Round 2 → Semifinals → Championship) reading the unchanged Phase 9 data shape. Regression-tested headlessly via `jsdom` (seeded season, full draft, schedule results, and a full playoff run through to a derived champion) with zero runtime errors across every public and admin view.
- **Phase 10.1 — Player Database Redesign:** Public and Admin Players pages rebuilt around one shared component, `positionPoolGrid()` in `shared-utils.js` — a 2K-Ratings-style grid of position columns (PG/SG/SF/PF/C, plus an "OTHER" column for any non-standard position) with ranked rows (rank / name / OVR), OVR color-tiered by rating, and drafted players shown struck-through and dimmed rather than removed. Admin's version adds a sort-mode dropdown (OVR high–low / low–high / Name A–Z) and a per-row delete "×", since the reference layout's fixed ordering needed an admin-appropriate way to keep sorting and delete without reverting to a spreadsheet table; Add Player, CSV import, and search are otherwise unchanged. No business logic, storage schema, draft rules, or `AdminActions` behavior touched.
- **Phase 10.2 — Global NBA Logos + Variant Label Removal:** Targeted, presentation-only revision on top of the approved Phase 10/10.1 UI — no redesign. (1) The small variant-group badge next to a player's name on the Public/Admin Players pages (e.g. "Doncic [DONCIC] 97") is removed from `positionPoolGrid()`'s row markup; the underlying `player.variantGroup` data, draft variant-locking logic, and CSV import/export of that field are all untouched — the name still carries it in a hover `title` tooltip, just not as an inline badge. (2) `NBA_TEAMS` (data.js) gained a `logo` field — a local path under `assets/logos/*.svg` (30 team logos, supplied by the project owner, filenames slugified from each team's own `name` field so the mapping is exact) — alongside the existing `color`/`colorAlt`. `teamBadge()` in `shared-utils.js` now renders that SVG via an `<img>`, with an inline `onerror` handler falling back to the original colored-initials badge if a logo is missing or fails to load — no broken-image icon is ever possible, and the fallback needs no per-caller JS. Because `teamBadge()` is the single shared component every view already called, most pages (Home, Teams, Schedule, Standings, Playoffs, Admin Schedule) picked up real logos automatically; `admin/team-assignment.js`, `admin/participants.js`, and the standalone public Rosters page (`views/roster.js` — distinct from the Teams page's roster tab) previously rendered plain abbreviation text and were updated to call `teamBadge()`. `admin/playoffs.js`'s score-entry console was deliberately left as plain text: its team-label helper feeds `prompt()`/`confirm()` dialogs and `<select>` option lists in several places, where HTML badge markup would render as literal text or break the picker — out of scope for a targeted revision. No external logo URLs, CDNs, or hotlinks anywhere; `nbaTeamAssignments` remains the sole ownership source (`NBA_TEAMS.logo` is static reference data only, verified by a regression check that the `NBA_TEAMS` block contains no participant/ownership-shaped fields); storage schema unchanged (`seasons`, `players`, `settings` — no new top-level keys). Regression-tested headlessly via `jsdom`: variant label absence, logo presence with zero external/broken references on every listed page, `teamBadge()` fallback behavior for both an unknown abbreviation and a null/unassigned slot, plus a full re-run of the Phase 7–10.1 functional checklist (search, sort, Add Player, CSV import, delete, drafted-grayout, standings ranking rule, a full playoff simulation through to a derived champion, and `nbaTeamAssignments` left unchanged from what was seeded).
- **Phase 10.3 — Draft Page Redesign:** `admin/draft.js` rebuilt into a 2K-style draft console. Data layer completely unchanged — reuses `getDraftState`, `getDraftPoolStatus`, `getParticipantRoster`, `getPositionState`, and `AdminActions.makeDraftPick`/`undoLastDraftPick`/`markDraftComplete` exactly as before; this phase only changed how the same data is displayed and clicked. New left sidebar: **On the Clock** (current participant, team badge/logo — falls back gracefully since NBA teams normally aren't assigned until after the draft — round/pick/overall-pick/total-picks tiles), **Draft Roster** (that participant's own picks in *chronological* order — reads `getParticipantRoster()`'s array as-is and renders it index-for-index as pick 1, 2, 3…, never re-sorted or re-grouped by position; this was the one hard requirement and is covered by a dedicated regression test that drafts C → PG → SF → PF → SG for a single-participant season and asserts the sidebar shows exactly that order), and **Position Need** (`getPositionState().filled` rendered as ✓/! pills — the mandatory-first-five rule itself is never recomputed here). The five position columns now render through `positionPoolGrid()` (shared-utils.js — the same component the Players pages use), extended with a third `mode: 'draft'` alongside the existing `'view'`/`'manage'`: available rows become clickable (`data-action="selectPlayer"`), and all four non-available statuses (drafted / variant-locked / position-locked / no-position) get a visible tag — drafted/locked players stay in the DOM, dimmed, never removed. Clicking an available row (from a column or the new search-as-you-type dropdown) opens a confirmation modal (name/position/OVR/pool) rather than drafting immediately; only the modal's "Draft Player" button calls `AdminActions.makeDraftPick`. The search box now also shows a live dropdown of up to 6 matches with position/OVR/pool/status, in addition to (not instead of) the existing inline column filtering. The old bottom round-by-round Draft History panel was removed from the UI in favor of the sidebar's per-participant Draft Roster — the underlying pick log (`season.playerDraftPicks`) this was reading from is untouched and still the single source of truth. Regression-tested headlessly via `jsdom`: the chronological-order scenario above, pool tabs, variant-label absence, no Unassigned tab, the search dropdown, click→modal→confirm→drafted-state end to end, Cancel doing nothing, a drafted row being unclickable, Undo Last Pick, the On-the-Clock team-badge fallback, and the board becoming fully non-interactive after Mark Draft Complete — plus a full re-run of the Phase 7–10.2 broad checklist (Players pages, global logos, standings ranking, a complete Phase 9 playoff simulation, and unchanged `nbaTeamAssignments`/storage schema) to confirm the shared-component change didn't regress anything else.

## Future Phases

### Phase 5 — Trades & Pool Swaps *(skipped for now)*
- Player trades between participants (updates `currentRosters`, never `playerDraftPicks`)
- Pool swaps, transaction fees, pot money

### Phase 6 — Backend
- Replace localStorage with real database
- Real auth (see backend requirements above)
- Multi-user support

---

## Variable League Size

The app supports any number of participants with no code changes:
- `participants` is a plain object — add or remove freely
- Draft snake order is derived at runtime from `playerDraftOrder.length`
- Round-robin scheduler (Phase 7) derives team count from `nbaTeamAssignments` at generation time and computes rounds/BYEs using the standard circle rotation algorithm
