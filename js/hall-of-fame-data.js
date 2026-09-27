/**
 * hall-of-fame-data.js — Static, manually curated Hall of Fame archive.
 *
 * IMPORTANT: This data is intentionally NOT connected to the live league
 * database. It does not reference participant_id, player_id, Supabase,
 * Firestore, or any current-season/roster/draft data. It is a plain
 * historical snapshot: once a championship entry is written here, it
 * must stay exactly as entered even if the current NBA2K player
 * database or roster data changes later.
 *
 * Consumed only by js/views/hall-of-fame.js (HallOfFameView), which
 * renders it read-only. No other file should depend on this data.
 *
 * PLACEHOLDER DATA: the six entries below are placeholders so the UI
 * can be built/tested end-to-end. Every placeholder champion/player is
 * marked "(placeholder)" — replace all six with the real historical
 * champions and their real 10-player rosters (roster slots 1–10, each
 * with player name, position, and OVR) before shipping.
 */
const HallOfFameData = [
  {
    season: 'NBA 2K26',
    champion: 'Champion Name (placeholder)',
    roster: [
      { slot: 1, player: 'Player Name (placeholder)', position: 'PG', ovr: 0 },
      { slot: 2, player: 'Player Name (placeholder)', position: 'SG', ovr: 0 },
      { slot: 3, player: 'Player Name (placeholder)', position: 'SF', ovr: 0 },
      { slot: 4, player: 'Player Name (placeholder)', position: 'PF', ovr: 0 },
      { slot: 5, player: 'Player Name (placeholder)', position: 'C', ovr: 0 },
      { slot: 6, player: 'Player Name (placeholder)', position: 'PG', ovr: 0 },
      { slot: 7, player: 'Player Name (placeholder)', position: 'SG', ovr: 0 },
      { slot: 8, player: 'Player Name (placeholder)', position: 'SF', ovr: 0 },
      { slot: 9, player: 'Player Name (placeholder)', position: 'PF', ovr: 0 },
      { slot: 10, player: 'Player Name (placeholder)', position: 'C', ovr: 0 },
    ],
  },
  {
    season: 'NBA 2K25',
    champion: 'Champion Name (placeholder)',
    roster: [
      { slot: 1, player: 'Player Name (placeholder)', position: 'PG', ovr: 0 },
      { slot: 2, player: 'Player Name (placeholder)', position: 'SG', ovr: 0 },
      { slot: 3, player: 'Player Name (placeholder)', position: 'SF', ovr: 0 },
      { slot: 4, player: 'Player Name (placeholder)', position: 'PF', ovr: 0 },
      { slot: 5, player: 'Player Name (placeholder)', position: 'C', ovr: 0 },
      { slot: 6, player: 'Player Name (placeholder)', position: 'PG', ovr: 0 },
      { slot: 7, player: 'Player Name (placeholder)', position: 'SG', ovr: 0 },
      { slot: 8, player: 'Player Name (placeholder)', position: 'SF', ovr: 0 },
      { slot: 9, player: 'Player Name (placeholder)', position: 'PF', ovr: 0 },
      { slot: 10, player: 'Player Name (placeholder)', position: 'C', ovr: 0 },
    ],
  },
  {
    season: 'NBA 2K24',
    champion: 'Champion Name (placeholder)',
    roster: [
      { slot: 1, player: 'Player Name (placeholder)', position: 'PG', ovr: 0 },
      { slot: 2, player: 'Player Name (placeholder)', position: 'SG', ovr: 0 },
      { slot: 3, player: 'Player Name (placeholder)', position: 'SF', ovr: 0 },
      { slot: 4, player: 'Player Name (placeholder)', position: 'PF', ovr: 0 },
      { slot: 5, player: 'Player Name (placeholder)', position: 'C', ovr: 0 },
      { slot: 6, player: 'Player Name (placeholder)', position: 'PG', ovr: 0 },
      { slot: 7, player: 'Player Name (placeholder)', position: 'SG', ovr: 0 },
      { slot: 8, player: 'Player Name (placeholder)', position: 'SF', ovr: 0 },
      { slot: 9, player: 'Player Name (placeholder)', position: 'PF', ovr: 0 },
      { slot: 10, player: 'Player Name (placeholder)', position: 'C', ovr: 0 },
    ],
  },
  {
    season: 'NBA 2K23',
    champion: 'Champion Name (placeholder)',
    roster: [
      { slot: 1, player: 'Player Name (placeholder)', position: 'PG', ovr: 0 },
      { slot: 2, player: 'Player Name (placeholder)', position: 'SG', ovr: 0 },
      { slot: 3, player: 'Player Name (placeholder)', position: 'SF', ovr: 0 },
      { slot: 4, player: 'Player Name (placeholder)', position: 'PF', ovr: 0 },
      { slot: 5, player: 'Player Name (placeholder)', position: 'C', ovr: 0 },
      { slot: 6, player: 'Player Name (placeholder)', position: 'PG', ovr: 0 },
      { slot: 7, player: 'Player Name (placeholder)', position: 'SG', ovr: 0 },
      { slot: 8, player: 'Player Name (placeholder)', position: 'SF', ovr: 0 },
      { slot: 9, player: 'Player Name (placeholder)', position: 'PF', ovr: 0 },
      { slot: 10, player: 'Player Name (placeholder)', position: 'C', ovr: 0 },
    ],
  },
  {
    season: 'NBA 2K22',
    champion: 'Champion Name (placeholder)',
    roster: [
      { slot: 1, player: 'Player Name (placeholder)', position: 'PG', ovr: 0 },
      { slot: 2, player: 'Player Name (placeholder)', position: 'SG', ovr: 0 },
      { slot: 3, player: 'Player Name (placeholder)', position: 'SF', ovr: 0 },
      { slot: 4, player: 'Player Name (placeholder)', position: 'PF', ovr: 0 },
      { slot: 5, player: 'Player Name (placeholder)', position: 'C', ovr: 0 },
      { slot: 6, player: 'Player Name (placeholder)', position: 'PG', ovr: 0 },
      { slot: 7, player: 'Player Name (placeholder)', position: 'SG', ovr: 0 },
      { slot: 8, player: 'Player Name (placeholder)', position: 'SF', ovr: 0 },
      { slot: 9, player: 'Player Name (placeholder)', position: 'PF', ovr: 0 },
      { slot: 10, player: 'Player Name (placeholder)', position: 'C', ovr: 0 },
    ],
  },
  {
    season: 'NBA 2K21',
    champion: 'Champion Name (placeholder)',
    roster: [
      { slot: 1, player: 'Player Name (placeholder)', position: 'PG', ovr: 0 },
      { slot: 2, player: 'Player Name (placeholder)', position: 'SG', ovr: 0 },
      { slot: 3, player: 'Player Name (placeholder)', position: 'SF', ovr: 0 },
      { slot: 4, player: 'Player Name (placeholder)', position: 'PF', ovr: 0 },
      { slot: 5, player: 'Player Name (placeholder)', position: 'C', ovr: 0 },
      { slot: 6, player: 'Player Name (placeholder)', position: 'PG', ovr: 0 },
      { slot: 7, player: 'Player Name (placeholder)', position: 'SG', ovr: 0 },
      { slot: 8, player: 'Player Name (placeholder)', position: 'SF', ovr: 0 },
      { slot: 9, player: 'Player Name (placeholder)', position: 'PF', ovr: 0 },
      { slot: 10, player: 'Player Name (placeholder)', position: 'C', ovr: 0 },
    ],
  },
];
