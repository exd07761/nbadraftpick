'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dataJsPath = path.join(__dirname, '..', 'nbadraftpick-main', 'js', 'data.js');
const src = fs.readFileSync(dataJsPath, 'utf8');

function makeSandbox() {
  const sandbox = {
    console,
    firebase: { firestore: () => ({ collection: () => ({ doc: () => ({ onSnapshot: () => {}, set: () => Promise.resolve() }) }) }) },
    showToast: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'data.js' });
  vm.runInContext(
    'this.LeagueData = LeagueData; this.AdminActions = AdminActions; this.FirebaseSync = FirebaseSync; this.getDefaultData = getDefaultData;',
    sandbox, { filename: 'export.js' }
  );
  let cache = sandbox.getDefaultData();
  sandbox.FirebaseSync.getCache = () => cache;
  sandbox.FirebaseSync.save = (data) => { cache = data; };
  return sandbox;
}

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}\n         ${e.stack || e.message}`); }
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function throws(fn, msg) {
  try { fn(); } catch (e) { return e; }
  throw new Error(msg || 'expected a throw, but none occurred');
}

function injectTrade(sandbox, seasonId, pA, pB, feeEach) {
  const cache = sandbox.FirebaseSync.getCache();
  const data = JSON.parse(JSON.stringify(cache));
  const season = data.seasons[seasonId];
  const tradeId = 'txn_trade_' + Math.random().toString(36).slice(2);
  season.transactions.push({
    id: tradeId, seasonId, seasonDay: season.currentSeasonDay, timestamp: new Date().toISOString(),
    type: 'trade', teamA: pA, teamB: pB, playersOut: [], playersIn: [], fee: feeEach * 2, feeDoubled: false, approvedBy: 'commissioner',
  });
  const splitA = 'txn_split_a_' + Math.random().toString(36).slice(2);
  const splitB = 'txn_split_b_' + Math.random().toString(36).slice(2);
  season.transactions.push({ id: splitA, seasonId, seasonDay: season.currentSeasonDay, timestamp: new Date().toISOString(), type: 'tradeFeeSplit', teamA: pA, teamB: null, playersOut: [], playersIn: [], amount: feeEach, status: 'pending', relatedTransactionId: tradeId, description: 'Trade fee — Team A share', approvedBy: 'commissioner' });
  season.transactions.push({ id: splitB, seasonId, seasonDay: season.currentSeasonDay, timestamp: new Date().toISOString(), type: 'tradeFeeSplit', teamA: pB, teamB: null, playersOut: [], playersIn: [], amount: feeEach, status: 'pending', relatedTransactionId: tradeId, description: 'Trade fee — Team B share', approvedBy: 'commissioner' });
  season.pot = (season.pot || 0) + feeEach * 2;
  sandbox.FirebaseSync.save(data);
  return { tradeId, splitA, splitB };
}

function injectSwap(sandbox, seasonId, participantId, fee, isJoker) {
  const cache = sandbox.FirebaseSync.getCache();
  const data = JSON.parse(JSON.stringify(cache));
  const season = data.seasons[seasonId];
  const id = 'txn_swap_' + Math.random().toString(36).slice(2);
  season.transactions.push({ id, seasonId, seasonDay: season.currentSeasonDay, timestamp: new Date().toISOString(), type: isJoker ? 'jokerSwap' : 'swap', teamA: participantId, teamB: null, playersOut: [{}], playersIn: [{}], fee, feeDoubled: false, status: 'pending', approvedBy: 'commissioner' });
  season.pot = (season.pot || 0) + fee;
  sandbox.FirebaseSync.save(data);
  return id;
}

function injectLegacySwap(sandbox, seasonId, participantId, fee) {
  const cache = sandbox.FirebaseSync.getCache();
  const data = JSON.parse(JSON.stringify(cache));
  const season = data.seasons[seasonId];
  const id = 'txn_legacyswap_' + Math.random().toString(36).slice(2);
  season.transactions.push({ id, seasonId, seasonDay: season.currentSeasonDay, timestamp: new Date().toISOString(), type: 'swap', teamA: participantId, teamB: null, playersOut: [{}], playersIn: [{}], fee, feeDoubled: false, approvedBy: 'commissioner' });
  season.pot = (season.pot || 0) + fee;
  sandbox.FirebaseSync.save(data);
  return id;
}

function makeLegacyParticipant(sandbox, seasonId, name) {
  const { AdminActions } = sandbox;
  const p = AdminActions.addParticipant(seasonId, name);
  const cache = sandbox.FirebaseSync.getCache();
  const data = JSON.parse(JSON.stringify(cache));
  const season = data.seasons[seasonId];
  const chargeTxn = season.transactions.find((t) => t.type === 'entryFee' && t.teamA === p.id);
  if (chargeTxn) {
    season.transactions = season.transactions.filter((t) => t.id !== chargeTxn.id);
    season.pot -= chargeTxn.amount;
  }
  sandbox.FirebaseSync.save(data);
  return p;
}

console.log('F6 Revision 2 tests (charge vs. payment)');

// ── Section 20: acceptance scenario (Entry 2000 / Trade 1500 / Swap 300) ──
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const season = AdminActions.createSeason('Acceptance2');
  {
    const cache = sandbox.FirebaseSync.getCache();
    const data = JSON.parse(JSON.stringify(cache));
    data.seasons[season.id].financialSettings = { entryFee: 2000, freeTrades: 2, freeSwaps: 2 };
    sandbox.FirebaseSync.save(data);
  }
  const p = AdminActions.addParticipant(season.id, 'Gigs');
  const other = AdminActions.addParticipant(season.id, 'Opponent');

  injectTrade(sandbox, season.id, p.id, other.id, 1000); // Trade Fee A: p's share ₱1,000
  injectTrade(sandbox, season.id, p.id, other.id, 500);  // Trade Fee B: p's share ₱500
  injectSwap(sandbox, season.id, p.id, 300);             // Swap Fee: ₱300

  check('20a: per-participant breakdown matches the doc for Gigs', () => {
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    eq(acc.entryFeeCharged, 2000);
    eq(acc.entryFeeUnpaid, 2000);
    eq(acc.tradeFeesCharged, 1500);
    eq(acc.tradeFeesUnpaid, 1500);
    eq(acc.swapFeesCharged, 300);
    eq(acc.swapFeesUnpaid, 300);
    eq(acc.totalCharges, 3800);
    eq(acc.totalPaid, 0);
    eq(acc.totalUnpaid, 3800);
  });

  check('20a: TOTAL POT reflects all charges', () => {
    eq(LeagueData.getTransactionState(season.id).pot, 2000 + 2000 + 2000 + 1000 + 300);
  });

  check('20b: General payment ₱1,000 -> Entry Fee first, pot unchanged', () => {
    const potBefore = LeagueData.getTransactionState(season.id).pot;
    const result = AdminActions.recordFinancialPayment(season.id, { participantId: p.id, amount: 1000, category: 'general', reason: 'partial' });
    eq(result.pot, potBefore);
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    eq(acc.entryFeeUnpaid, 1000);
    eq(acc.tradeFeesUnpaid, 1500);
    eq(acc.swapFeesUnpaid, 300);
  });

  check('20c: General payment ₱1,200 -> finishes Entry Fee, starts Trade Fees', () => {
    AdminActions.recordFinancialPayment(season.id, { participantId: p.id, amount: 1200, category: 'general', reason: 'partial 2' });
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    eq(acc.entryFeeUnpaid, 0);
    eq(acc.tradeFeesUnpaid, 1300);
    eq(acc.swapFeesUnpaid, 300);
  });

  check('20d: General payment ₱1,500 -> finishes Trade Fees, partially pays Swap', () => {
    AdminActions.recordFinancialPayment(season.id, { participantId: p.id, amount: 1500, category: 'general', reason: 'partial 3' });
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    eq(acc.tradeFeesUnpaid, 0);
    eq(acc.swapFeesUnpaid, 100);
    eq(acc.totalUnpaid, 100);
  });

  check('20 (critical rule): pot never changed across any of the three payments', () => {
    eq(LeagueData.getTransactionState(season.id).pot, 2000 + 2000 + 2000 + 1000 + 300);
  });
})();

// ── A: New trade ──────────────────────────────────────────────────────────
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const season = AdminActions.createSeason('A');
  const p = AdminActions.addParticipant(season.id, 'P');
  const potAfterEntry = LeagueData.getTransactionState(season.id).pot;
  injectTrade(sandbox, season.id, p.id, 'x', 100);
  check('A: new trade — charged 100, paid 0, unpaid 100, pot increases by 200 (both sides)', () => {
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    eq(acc.tradeFeesCharged, 100);
    eq(acc.tradeFeesPaid, 0);
    eq(acc.tradeFeesUnpaid, 100);
    eq(LeagueData.getTransactionState(season.id).pot, potAfterEntry + 200);
  });
})();

// ── B: New swap ────────────────────────────────────────────────────────────
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const season = AdminActions.createSeason('B');
  const p = AdminActions.addParticipant(season.id, 'P');
  const potAfterEntry = LeagueData.getTransactionState(season.id).pot;
  injectSwap(sandbox, season.id, p.id, 100);
  check('B: new swap — charged 100, paid 0, unpaid 100, pot increases by 100', () => {
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    eq(acc.swapFeesCharged, 100);
    eq(acc.swapFeesPaid, 0);
    eq(acc.swapFeesUnpaid, 100);
    eq(LeagueData.getTransactionState(season.id).pot, potAfterEntry + 100);
  });
})();

// ── C/D/E: partial payments to 0, pot fixed throughout ──────────────────
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const season = AdminActions.createSeason('CDE');
  {
    const cache = sandbox.FirebaseSync.getCache();
    const data = JSON.parse(JSON.stringify(cache));
    data.seasons[season.id].financialSettings = { entryFee: 2000, freeTrades: 2, freeSwaps: 2 };
    sandbox.FirebaseSync.save(data);
  }
  const p = AdminActions.addParticipant(season.id, 'P');
  const potFixed = LeagueData.getTransactionState(season.id).pot;

  check('C: pay 500 of 2000 — unpaid 1500, pot unchanged', () => {
    const r = AdminActions.recordFinancialPayment(season.id, { participantId: p.id, amount: 500, category: 'entryFee', reason: 'partial 1' });
    eq(r.pot, potFixed);
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    eq(acc.entryFeeCharged - acc.entryFeeUnpaid, 500);
    eq(acc.entryFeeUnpaid, 1500);
  });

  check('D: pay another 800 — unpaid 700', () => {
    AdminActions.recordFinancialPayment(season.id, { participantId: p.id, amount: 800, category: 'entryFee', reason: 'partial 2' });
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    eq(acc.entryFeeCharged - acc.entryFeeUnpaid, 1300);
    eq(acc.entryFeeUnpaid, 700);
    eq(LeagueData.getTransactionState(season.id).pot, potFixed);
  });

  check('E: pay final 700 — unpaid 0, pot unchanged throughout', () => {
    AdminActions.recordFinancialPayment(season.id, { participantId: p.id, amount: 700, category: 'entryFee', reason: 'final' });
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    eq(acc.entryFeeUnpaid, 0);
    eq(acc.entryFeePaid, true);
    eq(LeagueData.getTransactionState(season.id).pot, potFixed);
  });
})();

// ── F: Overpayment rejected ──────────────────────────────────────────────
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const season = AdminActions.createSeason('F');
  const p = AdminActions.addParticipant(season.id, 'P');
  const potBefore = LeagueData.getTransactionState(season.id).pot;
  check('F: payment exceeding outstanding rejected, pot/outstanding unchanged', () => {
    throws(() => AdminActions.recordFinancialPayment(season.id, { participantId: p.id, amount: 700, category: 'entryFee', reason: 'too much' }));
    eq(LeagueData.getTransactionState(season.id).pot, potBefore);
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    eq(acc.entryFeeUnpaid, 300);
  });
  check('F2: general overpayment beyond total outstanding rejected entirely', () => {
    throws(() => AdminActions.recordFinancialPayment(season.id, { participantId: p.id, amount: 100000, category: 'general', reason: 'way too much' }));
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    eq(acc.entryFeeUnpaid, 300, 'nothing was applied');
  });
  check('F3: category-specific payment into a zero-outstanding category rejected', () => {
    throws(() => AdminActions.recordFinancialPayment(season.id, { participantId: p.id, amount: 1, category: 'tradeFee', reason: 'no trade charge exists' }));
  });
})();

// ── G: Multiple participants isolated ────────────────────────────────────
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const season = AdminActions.createSeason('G');
  const gigs = AdminActions.addParticipant(season.id, 'Gigs');
  const jordan = AdminActions.addParticipant(season.id, 'Jordan');
  const maka = AdminActions.addParticipant(season.id, 'Maka');
  AdminActions.recordFinancialPayment(season.id, { participantId: gigs.id, amount: 100, category: 'entryFee', reason: 'gigs pays' });
  check('G: payment for Gigs does not affect Jordan or Maka', () => {
    eq(LeagueData.getParticipantFinancialAccount(season.id, gigs.id).entryFeeUnpaid, 200);
    eq(LeagueData.getParticipantFinancialAccount(season.id, jordan.id).entryFeeUnpaid, 300);
    eq(LeagueData.getParticipantFinancialAccount(season.id, maka.id).entryFeeUnpaid, 300);
  });
})();

// ── H: Season isolation ──────────────────────────────────────────────────
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const s1 = AdminActions.createSeason('H1');
  const s2 = AdminActions.createSeason('H2');
  const p1 = AdminActions.addParticipant(s1.id, 'P1');
  const p2 = AdminActions.addParticipant(s2.id, 'P2');
  const s2PotBefore = LeagueData.getTransactionState(s2.id).pot;
  AdminActions.recordFinancialPayment(s1.id, { participantId: p1.id, amount: 100, category: 'entryFee', reason: 'x' });
  check('H: season 1 payment does not affect season 2 pot/transactions', () => {
    eq(LeagueData.getTransactionState(s2.id).pot, s2PotBefore);
    eq(LeagueData.getTransactionHistory(s2.id).some((t) => t.type === 'payment'), false);
  });
})();

// ── I: Existing F6 (refund/credit/debit/void/streamer salary) still work ──
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const season = AdminActions.createSeason('I');
  const p = AdminActions.addParticipant(season.id, 'P');

  check('I1: refund rejected against a pending (unpaid) charge', () => {
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    throws(() => AdminActions.recordFinancialRefund(season.id, { relatedTransactionId: acc.entryFeeTransaction.id, amount: 1, reason: 'x' }));
  });

  check('I2: refund allowed against a payment transaction, decreases pot, increases unpaid back up', () => {
    const potBeforePayment = LeagueData.getTransactionState(season.id).pot;
    const payResult = AdminActions.recordFinancialPayment(season.id, { participantId: p.id, amount: 300, category: 'entryFee', reason: 'full' });
    eq(payResult.pot, potBeforePayment);
    const paymentTxnId = payResult.transactionIds[0];
    const potBeforeRefund = LeagueData.getTransactionState(season.id).pot;
    const refundResult = AdminActions.recordFinancialRefund(season.id, { relatedTransactionId: paymentTxnId, amount: 100, reason: 'partial refund of payment' });
    eq(refundResult.pot, potBeforeRefund - 100);
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    eq(acc.entryFeeUnpaid, 100);
  });

  check('I3: credit/debit still have zero pot effect', () => {
    const potBefore = LeagueData.getTransactionState(season.id).pot;
    AdminActions.recordFinancialCredit(season.id, { participantId: p.id, amount: 50, reason: 'goodwill' });
    AdminActions.recordFinancialDebit(season.id, { participantId: p.id, amount: 20, reason: 'extra charge' });
    eq(LeagueData.getTransactionState(season.id).pot, potBefore);
  });

  check('I4: legacy swap (no status field) treated as already-collected — refundable, counts as paid', () => {
    const legacyId = injectLegacySwap(sandbox, season.id, p.id, 200);
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    eq(acc.swapFeesCharged, 200);
    eq(acc.swapFeesPaid, 200);
    eq(acc.swapFeesUnpaid, 0);
    const potBefore = LeagueData.getTransactionState(season.id).pot;
    const r = AdminActions.recordFinancialRefund(season.id, { relatedTransactionId: legacyId, amount: 50, reason: 'legacy refund still works' });
    eq(r.pot, potBefore - 50);
  });

  check('I5: void still works, no pot effect, excludes from totals', () => {
    const legacyId2 = injectLegacySwap(sandbox, season.id, p.id, 150);
    const potBefore = LeagueData.getTransactionState(season.id).pot;
    const before = LeagueData.getParticipantFinancialAccount(season.id, p.id).swapFeesCharged;
    AdminActions.voidFinancialTransaction(season.id, { transactionId: legacyId2, reason: 'error' });
    const after = LeagueData.getParticipantFinancialAccount(season.id, p.id).swapFeesCharged;
    eq(LeagueData.getTransactionState(season.id).pot, potBefore);
    eq(after, before - 150);
  });

  check('I6: streamer salary unaffected — still snapshot-based, still decreases pot', () => {
    const cache = sandbox.FirebaseSync.getCache();
    const data = JSON.parse(JSON.stringify(cache));
    const s = data.seasons[season.id];
    s.schedule = [{ round: 1, matchups: Array.from({ length: 14 }, (_, i) => ({ id: 'm' + i, teamA: 'x', teamB: 'y', scoreA: 1, scoreB: 0, winner: 'x', streamer: 'Streamy', status: 'completed', playedAt: new Date().toISOString() })) }];
    sandbox.FirebaseSync.save(data);
    const potBefore = LeagueData.getTransactionState(season.id).pot;
    const result = AdminActions.payStreamerSalaries(season.id, { streamerParticipantMap: { Streamy: p.id }, reason: 'payout' });
    eq(result.pot, potBefore - result.individualSalary);
  });
})();

// ── J: Roster/draft regression (unaffected by this revision) ─────────────
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const season = AdminActions.createSeason('J');
  const gigs = AdminActions.addParticipant(season.id, 'Gigs');
  const jordan = AdminActions.addParticipant(season.id, 'Jordan');
  const maka = AdminActions.addParticipant(season.id, 'Maka');
  AdminActions.setPlayerDraftOrder(season.id, [gigs.id, jordan.id, maka.id]);
  check('J: playerDraftOrder / roster summary order unaffected by financial changes', () => {
    const summary = LeagueData.getRosterSummary(season.id);
    eq(JSON.stringify(summary.map((s) => s.participant.name)), JSON.stringify(['Gigs', 'Jordan', 'Maka']));
  });
})();

// ── Legacy participant fallback (no entryFee txn at all) ──────────────────
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const season = AdminActions.createSeason('Legacy');
  const legacy = makeLegacyParticipant(sandbox, season.id, 'OldTimer');

  check('Legacy participant has no entryFee transaction and virtual-fallback charged amount', () => {
    const acc = LeagueData.getParticipantFinancialAccount(season.id, legacy.id);
    eq(acc.entryFeeTransaction, null);
    eq(acc.entryFeeCharged, 300);
    eq(acc.entryFeeUnpaid, 300);
  });

  check('Legacy participant Mark Paid falls back to original one-shot behavior (charge+pay+pot in one step)', () => {
    const potBefore = LeagueData.getTransactionState(season.id).pot;
    const result = AdminActions.recordEntryFeePayment(season.id, legacy.id);
    eq(result.pot, potBefore + 300);
    const acc = LeagueData.getParticipantFinancialAccount(season.id, legacy.id);
    eq(acc.entryFeePaid, true);
    eq(acc.entryFeeUnpaid, 0);
  });

  check('Legacy participant duplicate Mark Paid rejected', () => {
    throws(() => AdminActions.recordEntryFeePayment(season.id, legacy.id));
  });
})();

// ── New-model participant: Mark Paid records remaining as a payment, no pot change ──
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const season = AdminActions.createSeason('NewModelMarkPaid');
  const p = AdminActions.addParticipant(season.id, 'P');
  AdminActions.recordFinancialPayment(season.id, { participantId: p.id, amount: 100, category: 'entryFee', reason: 'partial before mark paid' });

  check('§4 example: partial payment then Mark Paid records only the remainder, pot unchanged', () => {
    const potBefore = LeagueData.getTransactionState(season.id).pot;
    const result = AdminActions.recordEntryFeePayment(season.id, p.id);
    eq(result.amount, 200);
    eq(result.pot, potBefore);
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    eq(acc.entryFeeUnpaid, 0);
    eq(acc.entryFeePaid, true);
  });

  check('Duplicate Mark Paid after full payment rejected', () => {
    throws(() => AdminActions.recordEntryFeePayment(season.id, p.id));
  });
})();

// ── Sanity: no-F6-activity season still reconciles ────────────────────────
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const season = AdminActions.createSeason('SanityF4F5');
  const p = AdminActions.addParticipant(season.id, 'Plain');
  check('Sanity: getFinancialSummary/account return sane numbers with only auto-charge', () => {
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    eq(acc.entryFeeCharged, 300);
    eq(acc.entryFeeUnpaid, 300);
    eq(acc.entryFeePaid, false);
    const summary = LeagueData.getFinancialSummary(season.id);
    eq(summary.pot, 300);
    eq(summary.potDifference, summary.pot - summary.ledgerCalculatedTotal);
  });
})();

// ── Void of a PENDING charge reverses the pot increase (this fix) ────────
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const season = AdminActions.createSeason('VoidPendingEntryFee');
  const p = AdminActions.addParticipant(season.id, 'P'); // entryFee 300 charged, pot += 300

  check('Void-pending A: entry fee charge created pot+300, unpaid 300', () => {
    eq(LeagueData.getTransactionState(season.id).pot, 300);
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    eq(acc.entryFeeCharged, 300);
    eq(acc.entryFeeUnpaid, 300);
  });

  check('Void-pending A: voiding the pending entry fee charge reverses pot (pot-300), unpaid back to 0, paid unchanged (0)', () => {
    const potBefore = LeagueData.getTransactionState(season.id).pot;
    const acc0 = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    const result = AdminActions.voidFinancialTransaction(season.id, { transactionId: acc0.entryFeeTransaction.id, reason: 'charged in error' });
    eq(result.pot, potBefore - 300, 'pot decreased by exactly the charge amount');
    eq(LeagueData.getTransactionState(season.id).pot, 0, 'pot back to 0');
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    eq(acc.entryFeeCharged, 0, 'voided charge no longer counted');
    eq(acc.entryFeeCharged - acc.entryFeeUnpaid, 0, 'paid remains 0 — nothing was ever paid');
    eq(acc.entryFeeUnpaid, 0, 'unpaid correctly returns to 0, not negative');
  });
})();

(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const season = AdminActions.createSeason('VoidPendingTrade');
  const p = AdminActions.addParticipant(season.id, 'P');
  const other = AdminActions.addParticipant(season.id, 'Other');
  const potAfterEntries = LeagueData.getTransactionState(season.id).pot;
  const { splitA } = injectTrade(sandbox, season.id, p.id, other.id, 100); // pot += 200 (100 each side)

  check('Void-pending B: trade charge created pot+200, p unpaid 100', () => {
    eq(LeagueData.getTransactionState(season.id).pot, potAfterEntries + 200);
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    eq(acc.tradeFeesCharged, 100);
    eq(acc.tradeFeesUnpaid, 100);
  });

  check('Void-pending B: voiding p\'s pending tradeFeeSplit reverses pot by exactly that share (pot-100), unpaid back to 0, paid unchanged (0)', () => {
    const potBefore = LeagueData.getTransactionState(season.id).pot;
    const result = AdminActions.voidFinancialTransaction(season.id, { transactionId: splitA, reason: 'wrong split recorded' });
    eq(result.pot, potBefore - 100, 'pot decreased by exactly this participant\'s pending share, not the whole trade');
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    eq(acc.tradeFeesCharged, 0);
    eq(acc.tradeFeesPaid, 0, 'paid remains unchanged at 0');
    eq(acc.tradeFeesUnpaid, 0, 'unpaid correctly returns to 0');
    // The other side's still-pending split is untouched.
    const otherAcc = LeagueData.getParticipantFinancialAccount(season.id, other.id);
    eq(otherAcc.tradeFeesCharged, 100, 'the other participant\'s own pending charge is unaffected');
  });
})();

(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const season = AdminActions.createSeason('VoidPendingSwap');
  const p = AdminActions.addParticipant(season.id, 'P');
  const potAfterEntry = LeagueData.getTransactionState(season.id).pot;
  const swapId = injectSwap(sandbox, season.id, p.id, 150);

  check('Void-pending C: swap charge created pot+150, unpaid 150', () => {
    eq(LeagueData.getTransactionState(season.id).pot, potAfterEntry + 150);
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    eq(acc.swapFeesCharged, 150);
    eq(acc.swapFeesUnpaid, 150);
  });

  check('Void-pending C: voiding the pending swap charge reverses pot (pot-150), unpaid back to 0, paid unchanged (0)', () => {
    const potBefore = LeagueData.getTransactionState(season.id).pot;
    const result = AdminActions.voidFinancialTransaction(season.id, { transactionId: swapId, reason: 'wrong swap fee recorded' });
    eq(result.pot, potBefore - 150);
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    eq(acc.swapFeesCharged, 0);
    eq(acc.swapFeesPaid, 0);
    eq(acc.swapFeesUnpaid, 0);
  });
})();

// ── Void of an ALREADY-PAID/legacy transaction still does NOT touch pot ──
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const season = AdminActions.createSeason('VoidPaidUnchanged');
  const p = AdminActions.addParticipant(season.id, 'P');

  check('Void of legacy (no-status) swap: pot unchanged (existing behavior preserved)', () => {
    const legacyId = injectLegacySwap(sandbox, season.id, p.id, 200);
    const potBefore = LeagueData.getTransactionState(season.id).pot;
    const result = AdminActions.voidFinancialTransaction(season.id, { transactionId: legacyId, reason: 'legacy, already collected' });
    eq(result.pot, potBefore, 'pot untouched for an already-collected legacy record');
  });

  check('Void of a legacy fully-paid entryFee transaction: pot unchanged (existing behavior preserved)', () => {
    const legacy = makeLegacyParticipant(sandbox, season.id, 'OldTimer');
    AdminActions.recordEntryFeePayment(season.id, legacy.id); // one-shot legacy charge+pay, status "paid"
    const acc = LeagueData.getParticipantFinancialAccount(season.id, legacy.id);
    const potBefore = LeagueData.getTransactionState(season.id).pot;
    const result = AdminActions.voidFinancialTransaction(season.id, { transactionId: acc.entryFeeTransaction.id, reason: 'recorded twice by mistake' });
    eq(result.pot, potBefore, 'pot untouched when voiding an already-collected (paid) entry fee');
  });
})();

// ── Refund behavior is unaffected by this fix ─────────────────────────────
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const season = AdminActions.createSeason('RefundUnaffected');
  const p = AdminActions.addParticipant(season.id, 'P');

  check('Refund against a legacy (already-collected) swap still decreases pot exactly as before', () => {
    const legacyId = injectLegacySwap(sandbox, season.id, p.id, 200);
    const potBefore = LeagueData.getTransactionState(season.id).pot;
    const result = AdminActions.recordFinancialRefund(season.id, { relatedTransactionId: legacyId, amount: 80, reason: 'refund still works' });
    eq(result.pot, potBefore - 80);
  });

  check('Refund still rejected against a still-pending charge (unaffected by the void fix)', () => {
    const acc = LeagueData.getParticipantFinancialAccount(season.id, p.id);
    throws(() => AdminActions.recordFinancialRefund(season.id, { relatedTransactionId: acc.entryFeeTransaction.id, amount: 1, reason: 'x' }));
  });
})();

// ── potDifference/totalCollected/expectedPot stay reconciled after a pending-charge void ──
(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const season = AdminActions.createSeason('ReconcileAfterVoid');
  const p = AdminActions.addParticipant(season.id, 'P'); // pot += 300, pending
  const acc0 = LeagueData.getParticipantFinancialAccount(season.id, p.id);
  AdminActions.voidFinancialTransaction(season.id, { transactionId: acc0.entryFeeTransaction.id, reason: 'test' });

  check('totalCollected/expectedPot exclude a voided pending charge, matching pot (potDifference/potDifferenceV2 both 0)', () => {
    const summary = LeagueData.getFinancialSummary(season.id);
    eq(summary.pot, 0);
    eq(summary.totalCollected, 0, 'voided pending charge excluded from totalCollected');
    eq(summary.potDifference, 0);
    eq(summary.expectedPot, 0);
    eq(summary.potDifferenceV2, 0);
  });
})();

(() => {
  const sandbox = makeSandbox();
  const { AdminActions, LeagueData } = sandbox;
  const season = AdminActions.createSeason('ReconcileVoidedPaidStillCounts');
  const p = AdminActions.addParticipant(season.id, 'P');
  const legacy = makeLegacyParticipant(sandbox, season.id, 'OldTimer');
  AdminActions.recordEntryFeePayment(season.id, legacy.id); // legacy one-shot: status "paid"
  const accLegacy = LeagueData.getParticipantFinancialAccount(season.id, legacy.id);
  AdminActions.voidFinancialTransaction(season.id, { transactionId: accLegacy.entryFeeTransaction.id, reason: 'void a paid one' });

  check('a voided ALREADY-PAID charge still counts toward totalCollected (matches pot, which void never reversed for it)', () => {
    const summary = LeagueData.getFinancialSummary(season.id);
    // pot = p's pending charge (300) + legacy's paid charge (300, untouched by its void)
    eq(summary.pot, 600);
    eq(summary.totalCollected, 600, 'voided-but-already-paid charge still included');
    eq(summary.potDifference, 0);
    eq(summary.expectedPot, 600);
    eq(summary.potDifferenceV2, 0);
  });
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
