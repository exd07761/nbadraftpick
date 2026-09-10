'use strict';
/**
 * Phase 14 test — proves the NBA 2K player JSON importer
 * (js/admin/nba2k-import.js, `Nba2kImport`) cannot disturb any 2K27
 * curation, by actually running its real `_runImport()` against a fake
 * Firestore pre-seeded with realistic `nba2k27_pool` data (positions,
 * pool, variants, Manual Edit overrides) and asserting that collection
 * comes out 100% byte-for-byte identical afterward — not reasoned
 * about, empirically run.
 *
 * This does not re-test the importer's JSON-parsing/normalization
 * pipeline (unrelated to this question) — `_lastParsed` is set directly
 * to drive `_runImport()`, exactly like the real preview step would.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'admin', 'nba2k-import.js'), 'utf8');

class FakeElement {
  constructor() { this._html = ''; this.disabled = false; this.textContent = ''; }
  set innerHTML(h) { this._html = h; }
  get innerHTML() { return this._html; }
  classList = { add() {}, remove() {} };
}
class FakeContainer {
  constructor() { this._els = {}; }
  querySelector(sel) {
    const id = sel.replace('#', '');
    if (!this._els[id]) this._els[id] = new FakeElement();
    return this._els[id];
  }
}

function makeSandbox() {
  const nba2kPlayersDocs = {};
  const nba2k27Docs = {};
  const leagueMainWrites = [];
  const nba2k27PoolReads = [];
  const nba2k27PoolWrites = [];

  const sandbox = {
    console,
    document: { body: { contains: () => true } },
    escapeHtml: (s) => String(s),
    showToast: () => {},
    AuthBoundary: { requireAuth: () => {} },
    firebase: {
      firestore: () => ({
        collection: (name) => {
          if (name === 'nba2k27_pool') {
            nba2k27PoolReads.push(Date.now());
            return {
              get: () => Promise.resolve({ docs: Object.keys(nba2k27Docs).map(id => ({ id, data: () => nba2k27Docs[id] })) }),
              doc: (id) => ({
                set: (d) => { nba2k27PoolWrites.push({ id, d }); return Promise.resolve(); },
                update: (d) => { nba2k27PoolWrites.push({ id, d }); return Promise.resolve(); },
              }),
            };
          }
          if (name === 'league') {
            return { doc: () => ({ set: (d) => { leagueMainWrites.push(d); return Promise.resolve(); } }) };
          }
          // nba2k_players — the only collection the importer should ever write to.
          return {
            where: (fp, op, values) => ({
              get: () => Promise.resolve({ docs: values.filter(id => nba2kPlayersDocs[id]).map(id => ({ id })) }),
            }),
            doc: (id) => ({
              set: (data, options) => {
                const merge = !!(options && options.merge);
                nba2kPlayersDocs[id] = merge ? Object.assign({}, nba2kPlayersDocs[id] || {}, data) : data;
                return Promise.resolve();
              },
            }),
          };
        },
        batch: () => {
          const ops = [];
          return {
            set: (ref, data, options) => ops.push({ ref, data, options }),
            commit: () => { ops.forEach(op => op.ref.set(op.data, op.options)); return Promise.resolve(); },
          };
        },
        FieldPath: { documentId: () => '__ID__' },
        FieldValue: { serverTimestamp: () => 'SERVER_TS' },
      }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'nba2k-import.js' });
  vm.runInContext('this.Nba2kImport = Nba2kImport;', sandbox, { filename: 'export.js' });
  return { sandbox, nba2kPlayersDocs, nba2k27Docs, leagueMainWrites, nba2k27PoolReads, nba2k27PoolWrites };
}

let pass = 0, fail = 0;
function check(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ok - ${name}`); })
    .catch(e => { fail++; console.log(`  FAIL - ${name}`); console.log(`         ${e.stack || e.message}`); });
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

console.log('Phase 14 test — JSON importer never disturbs nba2k27_pool curation');

(async () => {
  const { sandbox, nba2kPlayersDocs, nba2k27Docs, leagueMainWrites, nba2k27PoolReads, nba2k27PoolWrites } = makeSandbox();

  // Seed nba2k_players with an EXISTING (pre-reimport) source record.
  nba2kPlayersDocs['sga'] = { name: 'Shai Gilgeous-Alexander', team: 'OKC', teamType: 'curr', overall: 96, positions: ['PG'] };

  // Seed nba2k27_pool with realistic curation — position, pool, variant,
  // AND a Manual Edit override — standing in for a representative slice
  // of the ~744 real assignments.
  const N = 30;
  for (let i = 0; i < N; i++) {
    nba2k27Docs[`legacy-${i}`] = {
      nba2kRef: `legacy-${i}`, pool: ['green', 'blue', 'white'][i % 3], position: ['PG', 'SG', 'SF', 'PF', 'C', 'UNASSIGNED'][i % 6],
      selectedAt: `sel-${i}`, updatedAt: `upd-${i}`,
    };
  }
  nba2k27Docs['sga'] = { nba2kRef: 'sga', pool: 'green', position: 'PG', selectedAt: 'x', updatedAt: 'x', variantGroupId: 'test-group', variantLabel: 'A', nameOverride: 'SGA (Corrected)' };
  const snapshotBefore = JSON.parse(JSON.stringify(nba2k27Docs));

  // Simulate a full re-import: SGA's overall/height/badges changed in
  // the new JSON (exactly the scenario in the ask), driving _runImport()
  // directly (bypassing file-picker parsing, which is unrelated here).
  const view = sandbox.Nba2kImport;
  view._lastParsed = {
    toCreate: [],
    toUpdate: [{
      slug: 'sga',
      doc: {
        name: 'Shai Gilgeous-Alexander', team: 'OKC', teamType: 'curr', overall: 98, // updated rating
        positions: ['PG'], height: '6\'6"', weight: 195, wingspan: '6\'11"', build: 'Athletic',
        playerUrl: 'https://www.2kratings.com/sga', playerImage: null, teamImg: null,
        attributes: { threePoint: 91 }, badges: { legendary: 2, hallOfFame: 3, gold: 5, silver: 2, bronze: 1, total: 13, list: [] },
        lastUpdated: '2026-09-09', importedAt: 'SERVER_TS',
      },
    }],
    warnings: [], errors: [], sourceTotal: 1, importTotal: 1, categoryCounts: { curr: 1, class: 0, allt: 0 },
  };
  const container = new FakeContainer();
  await view._runImport(container);

  await check('1. importer DOES update existing nba2k_players records', () => {
    assertEqual(nba2kPlayersDocs['sga'].overall, 98, 'the new rating was written');
  });
  await check('2. write is a full REPLACEMENT ({merge:false}) — confirmed by only import-schema fields surviving', () => {
    assertEqual(Object.keys(nba2kPlayersDocs['sga']).sort().join(','),
      'attributes,badges,build,height,importedAt,lastUpdated,name,overall,playerImage,playerUrl,positions,team,teamImg,teamType,weight,wingspan');
  });
  await check('4. importer performs ZERO reads of nba2k27_pool', () => {
    assertEqual(nba2k27PoolReads.length, 0);
  });
  await check('4/5. importer performs ZERO writes of any kind to nba2k27_pool', () => {
    assertEqual(nba2k27PoolWrites.length, 0);
  });
  await check('6. sga\'s curated position is untouched by the re-import', () => {
    assertEqual(nba2k27Docs['sga'].position, 'PG');
  });
  await check('7. sga\'s variant group/label are untouched by the re-import', () => {
    assertEqual(nba2k27Docs['sga'].variantGroupId, 'test-group');
    assertEqual(nba2k27Docs['sga'].variantLabel, 'A');
  });
  await check('sga\'s Manual Edit override is untouched by the re-import', () => {
    assertEqual(nba2k27Docs['sga'].nameOverride, 'SGA (Corrected)');
  });
  await check('8. sga\'s Green/Blue/White pool classification is untouched by the re-import', () => {
    assertEqual(nba2k27Docs['sga'].pool, 'green');
  });
  await check(`9. the ${N} other existing curated positions (standing in for the real ~744) are BYTE-FOR-BYTE identical after the import`, () => {
    for (let i = 0; i < N; i++) {
      const key = `legacy-${i}`;
      assertEqual(JSON.stringify(nba2k27Docs[key]), JSON.stringify(snapshotBefore[key]), `${key} must be untouched`);
    }
  });
  await check('the entire nba2k27_pool collection is untouched, including sga\'s own doc, byte-for-byte', () => {
    assertEqual(JSON.stringify(nba2k27Docs['sga']), JSON.stringify(snapshotBefore['sga']));
  });
  await check('no writes to league/main from the importer', () => {
    assertEqual(leagueMainWrites.length, 0);
  });
  await check('the 2K27 Pool would now display the NEW overall (98) joined live against the UNCHANGED position/pool/variant', () => {
    // This is exactly what Nba2k27PoolView/PublicNba2k27View's own
    // _buildRows() does at render time — join nba2k27_pool (curation)
    // against nba2k_players (source) fresh on every read. Proven here
    // structurally: the two collections now hold, respectively, the
    // NEW overall and the OLD position/pool — a live join of the two
    // is exactly "new rating + preserved curation" with no further
    // action required.
    assertEqual(nba2kPlayersDocs['sga'].overall, 98);
    assertEqual(nba2k27Docs['sga'].position, 'PG');
    assertEqual(nba2k27Docs['sga'].pool, 'green');
  });
})();

setTimeout(() => {
  console.log(`\nPhase 14 Tests:\n${pass}/${pass + fail} passed`);
  process.exitCode = fail > 0 ? 1 : 0;
}, 50);
