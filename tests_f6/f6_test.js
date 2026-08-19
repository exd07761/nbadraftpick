'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dataJsPath = path.join(__dirname, '..', 'nbadraftpick-main', 'js', 'data.js');
const src = fs.readFileSync(dataJsPath, 'utf8');

function makeSandbox() {
  const sandbox = {
    console,
    firebase: {
      firestore: () => ({
        collection: () => ({
          doc: () => ({
            onSnapshot: () => {},
            set: () => Promise.resolve(),
          }),
        }),
      }),
    },
    showToast: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'data.js' });
  // Top-level `const`/`let` bindings from a vm script don't attach to the
  // sandbox object automatically (only `var`/functions do) — pull the
  // names we need onto the sandbox explicitly via a follow-up script that
  // shares the same lexical scope.
  vm.runInContext(
    'this.LeagueData = LeagueData; this.AdminActions = AdminActions; ' +
    'this.FirebaseSync = FirebaseSync; this.getDefaultData = getDefaultData;',
    sandbox,
    { filename: 'export.js' }
  );

  // Swap the Firestore-backed storage for a simple in-memory object so we
  // can test without a browser/network. loadData()/saveData() only ever
  // go through FirebaseSync.getCache()/save(), so overriding those two
  // methods is enough — everything else in the file is untouched.
  let cache = sandbox.getDefaultData();
  sandbox.FirebaseSync.getCache = () => cache;
  sandbox.FirebaseSync.save = (data) => { cache = data; };

  return sandbox;
}

let pass = 0, fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL - ${name}`);
    console.log(`         ${e.message}`);
  }
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertThrows(fn, msg) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error(msg || 'expected a throw, but none occurred');
}
function assertClose(actual, expected, msg) {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`${msg || 'assertion failed'}: expected ${expected}, got ${actual}`);
  }
}

// ─── Scenario builder ────────────────────────────────────────────────────
// Builds a season with 2 participants, entry fees paid, a trade committed
// (so a tradeFeeSplit exists to refund/void), and enough regular-season
// streamed games to make one streamer eligible.
function buildScenario(sandbox) {
  const { AdminActions, LeagueData } = sandbox;
  const season = AdminActions.createSeason('Test Season');
  const seasonId = season.id;

  const pA = AdminActions.addParticipant(seasonId, 'Alice');
  const pB = AdminActions.addParticipant(seasonId, 'Bob');

  AdminActions.recordEntryFeePayment(seasonId, pA.id);
  AdminActions.recordEntryFeePayment(seasonId, pB.id);

  // Fabricate a completed trade transaction + its tradeFeeSplit pair
  // directly (bypassing full roster/draft setup, which isn't needed to
  // exercise F6 refund/void logic against a tradeFeeSplit).
  const data = sandbox.loadData ? null : null; // no-op, loadData is internal
  return { seasonId, pA, pB };
}

// Directly inject a trade + tradeFeeSplit pair using AdminActions internals
// isn't exposed, so we reach into the season via a raw read/write of the
// same storage the sandbox exposes, mimicking what commitTrade() writes.
function injectTradeFeeSplit(sandbox, seasonId, participantId, amount, otherParticipantId) {
  const cache = sandbox.FirebaseSync.getCache();
  const data = JSON.parse(JSON.stringify(cache));
  const season = data.seasons[seasonId];
  const tradeId = 'txn_fake_trade';
  season.transactions.push({
    id: tradeId, seasonId, seasonDay: season.currentSeasonDay, timestamp: new Date().toISOString(),
    type: 'trade', teamA: participantId, teamB: otherParticipantId || 'other', playersOut: [], playersIn: [], fee: amount * 2,
    feeDoubled: false, approvedBy: 'commissioner',
  });
  // Mirror the real commitTrade(): the fee is split into TWO tradeFeeSplit
  // records (one per side) that together equal the full fee added to pot —
  // otherwise pot vs tradeFeesCollected won't reconcile in tests that check it.
  season.transactions.push({
    id: 'txn_fake_split', seasonId, seasonDay: season.currentSeasonDay, timestamp: new Date().toISOString(),
    type: 'tradeFeeSplit', teamA: participantId, teamB: null, playersOut: [], playersIn: [], amount, status: 'paid',
    relatedTransactionId: tradeId, description: 'Trade fee — Team A share', approvedBy: 'commissioner',
  });
  season.transactions.push({
    id: 'txn_fake_split_b', seasonId, seasonDay: season.currentSeasonDay, timestamp: new Date().toISOString(),
    type: 'tradeFeeSplit', teamA: otherParticipantId || 'other', teamB: null, playersOut: [], playersIn: [], amount, status: 'paid',
    relatedTransactionId: tradeId, description: 'Trade fee — Team B share', approvedBy: 'commissioner',
  });
  season.pot = (season.pot || 0) + amount * 2;
  sandbox.FirebaseSync.save(data);
  return 'txn_fake_split';
}

function injectStreamedGames(sandbox, seasonId, streamerName, count) {
  const cache = sandbox.FirebaseSync.getCache();
  const data = JSON.parse(JSON.stringify(cache));
  const season = data.seasons[seasonId];
  season.schedule = season.schedule || [];
  const matchups = [];
  for (let i = 0; i < count; i++) {
    matchups.push({
      id: `m_${streamerName}_${i}`, teamA: 'x', teamB: 'y', scoreA: 10, scoreB: 5,
      winner: 'x', streamer: streamerName, status: 'completed', playedAt: new Date().toISOString(),
    });
  }
  season.schedule.push({ round: 1, matchups });
  sandbox.FirebaseSync.save(data);
}

console.log('F6 tests');

// ── Refund ──────────────────────────────────────────────────────────────
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const { seasonId, pA } = buildScenario(sandbox);
  const splitId = injectTradeFeeSplit(sandbox, seasonId, pA.id, 100);

  check('refund of a trade-fee split decreases pot and creates a refund txn', () => {
    const potBefore = LeagueData.getTransactionState(seasonId).pot;
    const result = AdminActions.recordFinancialRefund(seasonId, { relatedTransactionId: splitId, amount: 60, reason: 'Overcharged' });
    assertEqual(result.pot, potBefore - 60, 'pot should drop by refund amount');
    const history = LeagueData.getTransactionHistory(seasonId);
    const refundTxn = history.find((t) => t.type === 'refund');
    assertEqual(refundTxn.amount, 60, 'refund amount');
    assertEqual(refundTxn.relatedTransactionId, splitId, 'refund points at original');
    assertEqual(refundTxn.teamA, pA.id, 'refund attributed to original participant');
  });

  check('partial refund leaves remaining refundable correctly, second valid refund succeeds', () => {
    const result = AdminActions.recordFinancialRefund(seasonId, { relatedTransactionId: splitId, amount: 40, reason: 'Remainder' });
    assertEqual(result.remainingRefundable, 0, 'fully refunded now');
  });

  check('attempted over-refund is rejected', () => {
    assertThrows(() => AdminActions.recordFinancialRefund(seasonId, { relatedTransactionId: splitId, amount: 1, reason: 'oops' }),
      'should reject refund beyond remaining amount');
  });

  check('original transaction remains unchanged after refunds', () => {
    const history = LeagueData.getTransactionHistory(seasonId);
    const original = history.find((t) => t.id === splitId);
    assertEqual(original.amount, 100, 'original amount untouched');
    assertEqual(original.status, 'paid', 'original status untouched');
  });

  check('invalid amount rejected (zero/negative)', () => {
    assertThrows(() => AdminActions.recordFinancialRefund(seasonId, { relatedTransactionId: splitId, amount: 0, reason: 'x' }));
    assertThrows(() => AdminActions.recordFinancialRefund(seasonId, { relatedTransactionId: splitId, amount: -5, reason: 'x' }));
  });

  check('missing refund reason rejected', () => {
    assertThrows(() => AdminActions.recordFinancialRefund(seasonId, { relatedTransactionId: splitId, amount: 1, reason: '' }));
  });

  check('refund of non-refundable type (trade) rejected', () => {
    assertThrows(() => AdminActions.recordFinancialRefund(seasonId, { relatedTransactionId: 'txn_fake_trade', amount: 1, reason: 'x' }));
  });
})();

// ── Duplicate/full refund guard on a fresh split ─────────────────────────
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const { seasonId, pA } = buildScenario(sandbox);
  const splitId = injectTradeFeeSplit(sandbox, seasonId, pA.id, 100);

  check('full refund then duplicate refund rejected', () => {
    AdminActions.recordFinancialRefund(seasonId, { relatedTransactionId: splitId, amount: 100, reason: 'Full refund' });
    assertThrows(() => AdminActions.recordFinancialRefund(seasonId, { relatedTransactionId: splitId, amount: 1, reason: 'more' }));
  });
})();

// ── Credit / Debit ────────────────────────────────────────────────────────
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const { seasonId, pA } = buildScenario(sandbox);

  check('credit does not change pot, reduces outstanding balance (goes negative, unclamped)', () => {
    const potBefore = LeagueData.getTransactionState(seasonId).pot;
    AdminActions.recordFinancialCredit(seasonId, { participantId: pA.id, amount: 500, reason: 'Commissioner credit' });
    const potAfter = LeagueData.getTransactionState(seasonId).pot;
    assertEqual(potAfter, potBefore, 'pot unchanged by credit');
    const account = LeagueData.getParticipantFinancialAccount(seasonId, pA.id);
    // pA already paid entry fee, so outstandingBalance starts at 0; credit pushes it negative.
    assertEqual(account.outstandingBalance, -500, 'credit pushes outstanding balance negative, unclamped');
    assertEqual(account.totalCredits, 500, 'totalCredits recorded');
  });

  check('debit does not change pot, increases outstanding balance', () => {
    AdminActions.recordFinancialDebit(seasonId, { participantId: pA.id, amount: 200, reason: 'Additional league charge' });
    const account = LeagueData.getParticipantFinancialAccount(seasonId, pA.id);
    assertEqual(account.outstandingBalance, -500 + 200, 'debit offsets the credit');
    assertEqual(account.totalDebits, 200, 'totalDebits recorded');
  });

  check('missing participant rejected for credit', () => {
    assertThrows(() => AdminActions.recordFinancialCredit(seasonId, { participantId: 'nope', amount: 10, reason: 'x' }));
  });

  check('invalid amount rejected for debit', () => {
    assertThrows(() => AdminActions.recordFinancialDebit(seasonId, { participantId: pA.id, amount: -1, reason: 'x' }));
  });
})();

// ── Void ──────────────────────────────────────────────────────────────────
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const { seasonId, pA } = buildScenario(sandbox);
  const splitId = injectTradeFeeSplit(sandbox, seasonId, pA.id, 100);

  check('void excludes the original from participant financial totals, pot unchanged', () => {
    const potBefore = LeagueData.getTransactionState(seasonId).pot;
    const before = LeagueData.getParticipantFinancialAccount(seasonId, pA.id);
    assertEqual(before.tradeFeesPaid, 100, 'sanity: trade fee counted before void');

    AdminActions.voidFinancialTransaction(seasonId, { transactionId: splitId, reason: 'Recorded in error' });

    const potAfter = LeagueData.getTransactionState(seasonId).pot;
    assertEqual(potAfter, potBefore, 'void does not change pot');
    const after = LeagueData.getParticipantFinancialAccount(seasonId, pA.id);
    assertEqual(after.tradeFeesPaid, 0, 'voided trade fee no longer counted');
  });

  check('attempted double void rejected', () => {
    assertThrows(() => AdminActions.voidFinancialTransaction(seasonId, { transactionId: splitId, reason: 'again' }));
  });

  check('void requires a reason', () => {
    const split2 = injectTradeFeeSplit(sandbox, seasonId, pA.id, 50);
    assertThrows(() => AdminActions.voidFinancialTransaction(seasonId, { transactionId: 'txn_fake_split', reason: '' }));
  });

  check('voiding the entryFee charge zeroes its charged amount (F6 Revision 2: charge and payment are separate — see f6_revision2_test.js)', () => {
    const account = LeagueData.getParticipantFinancialAccount(seasonId, pA.id);
    const entryFeeTxnId = account.entryFeeTransaction.id;
    AdminActions.voidFinancialTransaction(seasonId, { transactionId: entryFeeTxnId, reason: 'Duplicate payment recorded' });
    const after = LeagueData.getParticipantFinancialAccount(seasonId, pA.id);
    assertEqual(after.entryFeeCharged, 0, 'voided charge no longer counts as an obligation');
    assertEqual(after.entryFeeTransaction, null, 'voided charge excluded from entryFeeTransaction');
  });
})();

// ── Streamer salary ─────────────────────────────────────────────────────
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const { seasonId, pA, pB } = buildScenario(sandbox);
  injectTradeFeeSplit(sandbox, seasonId, pA.id, 4000); // pot = 8000 (fee*2) + entryfees(600) = well, entry fees already added 300*2=600. total pot after split injection: 600 + 8000=8600
  injectStreamedGames(sandbox, seasonId, 'Alice', 14);
  injectStreamedGames(sandbox, seasonId, 'Bob', 20);
  injectStreamedGames(sandbox, seasonId, 'Carl', 5); // not eligible

  check('salary pool snapshot is fixed for the whole run — later payouts do not shrink from a recalculated pot', () => {
    const potBefore = LeagueData.getTransactionState(seasonId).pot;
    const plan = LeagueData.getStreamerSalaryPlan(seasonId);
    assertEqual(plan.eligibleStreamers.length, 2, 'Alice and Bob eligible, Carl not');

    const expectedPool = potBefore * 0.30;
    const expectedIndividual = Math.round(expectedPool / 2);

    const result = AdminActions.payStreamerSalaries(seasonId, {
      streamerParticipantMap: { Alice: pA.id, Bob: pB.id },
      reason: 'Mid-season payout',
    });

    assertEqual(result.individualSalary, expectedIndividual, 'individual salary matches snapshot calc');
    assertClose(result.totalPotAtPayout, potBefore, 1e-9, 'snapshot pot matches pre-payout pot');

    const history = LeagueData.getTransactionHistory(seasonId);
    const runTxn = history.find((t) => t.type === 'streamerSalaryRun');
    const childTxns = history.filter((t) => t.type === 'streamerSalary');
    assertEqual(childTxns.length, 2, 'one child per eligible streamer');
    // Both children must use the SAME individualSalary (snapshot), not a
    // recalculated-after-each-payout figure.
    assertEqual(childTxns[0].amount, expectedIndividual, 'first payout uses snapshot amount');
    assertEqual(childTxns[1].amount, expectedIndividual, 'second payout uses snapshot amount (not recalculated after first)');
    assertEqual(runTxn.individualSalary, expectedIndividual, 'parent record stores the snapshot');
    assertEqual(runTxn.totalPotAtPayout, potBefore, 'parent record stores pot snapshot');

    const potAfter = LeagueData.getTransactionState(seasonId).pot;
    assertClose(potAfter, potBefore - expectedIndividual * 2, 1e-9, 'pot decreased by both payouts');
  });

  check('no eligible streamers throws, nothing written', () => {
    const sandbox2 = makeSandbox();
    const { AdminActions: AA2, LeagueData: LD2 } = sandbox2;
    const scenario2 = buildScenario(sandbox2);
    injectStreamedGames(sandbox2, scenario2.seasonId, 'Nobody', 3);
    const potBefore = LD2.getTransactionState(scenario2.seasonId).pot;
    assertThrows(() => AA2.payStreamerSalaries(scenario2.seasonId, { streamerParticipantMap: {}, reason: 'x' }));
    const potAfter = LD2.getTransactionState(scenario2.seasonId).pot;
    assertEqual(potAfter, potBefore, 'pot unchanged when no eligible streamers');
  });

  check('missing participant mapping for an eligible streamer rejected', () => {
    const sandbox3 = makeSandbox();
    const { AdminActions: AA3 } = sandbox3;
    const scenario3 = buildScenario(sandbox3);
    injectStreamedGames(sandbox3, scenario3.seasonId, 'Solo', 14);
    assertThrows(() => AA3.payStreamerSalaries(scenario3.seasonId, { streamerParticipantMap: {}, reason: 'x' }));
  });

  check('duplicate participant mapped to two streamers in one run rejected', () => {
    const sandbox4 = makeSandbox();
    const { AdminActions: AA4 } = sandbox4;
    const scenario4 = buildScenario(sandbox4);
    injectStreamedGames(sandbox4, scenario4.seasonId, 'S1', 14);
    injectStreamedGames(sandbox4, scenario4.seasonId, 'S2', 14);
    assertThrows(() => AA4.payStreamerSalaries(scenario4.seasonId, {
      streamerParticipantMap: { S1: scenario4.pA.id, S2: scenario4.pA.id },
      reason: 'x',
    }));
  });
})();

// ── Season isolation ────────────────────────────────────────────────────
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const s1 = buildScenario(sandbox);
  const season2 = AdminActions.createSeason('Season 2');
  const p2 = AdminActions.addParticipant(season2.id, 'Zed');
  AdminActions.recordEntryFeePayment(season2.id, p2.id);

  check('F6 write on season 1 does not affect season 2 pot/transactions', () => {
    const split = injectTradeFeeSplit(sandbox, s1.seasonId, s1.pA.id, 100);
    const s2PotBefore = LeagueData.getTransactionState(season2.id).pot;
    AdminActions.recordFinancialRefund(s1.seasonId, { relatedTransactionId: split, amount: 50, reason: 'Season isolation check' });
    const s2PotAfter = LeagueData.getTransactionState(season2.id).pot;
    assertEqual(s2PotAfter, s2PotBefore, 'season 2 pot untouched by season 1 refund');
    assertEqual(LeagueData.getTransactionHistory(season2.id).some((t) => t.type === 'refund'), false, 'no refund leaked into season 2');
  });
})();

// ── Mixed F1-F5 + F6 history / reconciliation ───────────────────────────
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const { seasonId, pA, pB } = buildScenario(sandbox);
  const splitId = injectTradeFeeSplit(sandbox, seasonId, pA.id, 100);

  check('getFinancialSummary reconciles pot against expectedPot after refund + credit/debit (credit/debit excluded from pot math)', () => {
    AdminActions.recordFinancialRefund(seasonId, { relatedTransactionId: splitId, amount: 30, reason: 'partial' });
    AdminActions.recordFinancialCredit(seasonId, { participantId: pA.id, amount: 999, reason: 'should not affect pot' });
    AdminActions.recordFinancialDebit(seasonId, { participantId: pB.id, amount: 111, reason: 'should not affect pot' });

    const summary = LeagueData.getFinancialSummary(seasonId);
    assertEqual(summary.totalRefunded, 30, 'summary totalRefunded');
    assertEqual(summary.totalCredits, 999, 'summary totalCredits');
    assertEqual(summary.totalDebits, 111, 'summary totalDebits');
    assertClose(summary.pot, summary.expectedPot, 1e-9, 'pot reconciles with expectedPot (credit/debit excluded)');
  });
})();

// ── Existing F1-F5 flows continue to work unchanged ─────────────────────
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;

  check('recordEntryFeePayment, participant/account calc still work exactly as before with no F6 transactions present', () => {
    const season = AdminActions.createSeason('Plain Season');
    const p = AdminActions.addParticipant(season.id, 'Plain');
    const before = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    assertEqual(before.entryFeePaid, false);
    assertEqual(before.outstandingBalance, 300, 'default entry fee, no F6 activity');
    AdminActions.recordEntryFeePayment(season.id, p.id);
    const after = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    assertEqual(after.entryFeePaid, true);
    assertEqual(after.outstandingBalance, 0);
    assertEqual(after.totalRefunded, 0);
    assertEqual(after.totalCredits, 0);
    assertEqual(after.totalDebits, 0);
    const summary = LeagueData.getFinancialSummary(season.id);
    assertEqual(summary.potDifference, summary.pot - summary.ledgerCalculatedTotal, 'original potDifference formula unchanged');
  });
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
