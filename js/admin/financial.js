/**
 * admin/financial.js — Financial Management (F5 + F6)
 *
 * Presentation layer over the F4 derived financial APIs
 * (LeagueData.getFinancialSummary / getParticipantFinancialAccount /
 * getFreeAllowanceRemaining / getStreamerSalaryPlan), which themselves
 * derive everything from season.transactions[] — the same ledger Phase 5
 * (trades/swaps/Joker/10th-pick-Blue) and F2/F3 (entryFee/tradeFeeSplit)
 * already write to.
 *
 * F5 was originally read-only. F6 adds exactly two write paths, both
 * gated behind AuthBoundary.requireAuth() and a confirmation modal, same
 * convention as every other admin write in this app:
 *   - "Adjust Account" → AdminActions.recordFinancialRefund /
 *     recordFinancialCredit / recordFinancialDebit / voidFinancialTransaction
 *   - "Pay Streamer Salaries" → AdminActions.payStreamerSalaries
 * No other write path exists here — Mark Paid (recordEntryFeePayment)
 * still lives on the Participants page exactly where F2 put it.
 *
 * One addition intentionally lives here rather than in F4: "Draft / Other
 * Fees" (the existing tenthPickBlueFee transactions). F4's
 * getFinancialSummary() deliberately excludes this from totalCollected
 * (it doesn't fit the entry/trade/swap categories — see that method's doc
 * comment in data.js), so this view sums those transactions itself,
 * read-only, purely for display, and combines it with F4's three
 * category totals into the dashboard's own "Total Collected" figure. F4's
 * own totalCollected field is never altered or reinterpreted — this file
 * just also shows the fuller picture alongside it.
 */
const AdminFinancialView = {
  _statusFilter: 'all', // 'all' | 'paid' | 'unpaid' — read-only display filter, not stored anywhere
  _streamerMap: {}, // { [streamerName]: participantId } — in-progress mapping for the salary payout form, cleared after a successful/failed pay

  render(container) {
    const season = LeagueData.getCurrentSeason();
    if (!season) {
      container.innerHTML = `<div class="empty-state"><p>No current season.</p></div>`;
      return;
    }

    let summary, participants, accounts, draftOtherFeesCollected;
    try {
      summary = LeagueData.getFinancialSummary(season.id);
      participants = LeagueData.getParticipants(season.id);
      // One getParticipantFinancialAccount call per participant, cached
      // here and reused for the unpaid count, the table rows, and the
      // detail modal — never re-queried for the same participant (F5
      // spec section 25).
      accounts = participants.map((p) => ({
        participant: p,
        account: LeagueData.getParticipantFinancialAccount(season.id, p.id),
      }));
      // Draft / Other Fees — derived here, not in F4 (see file header).
      draftOtherFeesCollected = (season.transactions || [])
        .filter((t) => t.type === 'tenthPickBlueFee')
        .reduce((sum, t) => sum + (t.fee ?? t.amount ?? 0), 0);
    } catch (e) {
      container.innerHTML = `<div class="empty-state"><p>Unable to load financial information.</p></div>`;
      return;
    }

    if (!summary) {
      container.innerHTML = `<div class="empty-state"><p>Unable to load financial information.</p></div>`;
      return;
    }

    const totalCollected = summary.entryFeesCollected + summary.tradeFeesCollected
      + summary.swapFeesCollected + draftOtherFeesCollected;
    const pot = season.pot ?? 0;
    const potDifference = pot - totalCollected;

    const unpaidCount = accounts.filter((a) => a.account && !a.account.entryFeePaid).length;

    container.innerHTML = `
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>Financial Management — ${escapeHtml(season.name)}</h2>
        </div>

        ${this._renderSummary({ pot, summary, draftOtherFeesCollected, totalCollected, potDifference, unpaidCount, participantCount: participants.length })}

        <div class="admin-section-header" style="margin-top:1.5rem;">
          <h3>Participants</h3>
          <div class="header-actions">
            <button class="btn btn-sm ${this._statusFilter === 'all' ? 'btn-primary' : 'btn-ghost'}" data-filter="all">All</button>
            <button class="btn btn-sm ${this._statusFilter === 'paid' ? 'btn-primary' : 'btn-ghost'}" data-filter="paid">Paid</button>
            <button class="btn btn-sm ${this._statusFilter === 'unpaid' ? 'btn-primary' : 'btn-ghost'}" data-filter="unpaid">Unpaid</button>
            <button class="btn btn-sm btn-primary" data-action="adjustAccount">Adjust Account</button>
          </div>
        </div>
        ${this._renderParticipantTable(accounts)}

        <div class="admin-section-header" style="margin-top:1.5rem;">
          <h3>Streamer Salary</h3>
        </div>
        ${this._renderStreamerSalarySection(season, participants)}

        <div class="admin-section-header" style="margin-top:1.5rem;">
          <h3>Financial Transaction History</h3>
        </div>
        ${this._renderTransactionHistory(season, participants)}
      </div>`;

    container.querySelectorAll('[data-filter]').forEach((btn) => {
      btn.onclick = () => {
        this._statusFilter = btn.dataset.filter;
        this.render(container);
      };
    });

    container.querySelectorAll('[data-action="viewDetails"]').forEach((btn) => {
      btn.onclick = () => {
        const entry = accounts.find((a) => a.participant.id === btn.dataset.id);
        if (entry) this._openDetailModal(season, entry, participants, container);
      };
    });

    const adjustBtn = container.querySelector('[data-action="adjustAccount"]');
    if (adjustBtn) {
      adjustBtn.onclick = () => this._openAdjustModal(season, participants, container);
    }

    container.querySelectorAll('[data-action="adjustParticipant"]').forEach((btn) => {
      btn.onclick = () => this._openAdjustModal(season, participants, container, btn.dataset.id);
    });

    const streamerMapSelects = container.querySelectorAll('[data-streamer-select]');
    streamerMapSelects.forEach((sel) => {
      sel.onchange = () => {
        this._streamerMap[sel.dataset.streamerSelect] = sel.value || null;
      };
    });
    const payStreamersBtn = container.querySelector('[data-action="payStreamerSalaries"]');
    if (payStreamersBtn) {
      payStreamersBtn.onclick = () => this._openStreamerSalaryConfirm(season, participants, container);
    }
  },

  _renderSummary({ pot, summary, draftOtherFeesCollected, totalCollected, potDifference, unpaidCount, participantCount }) {
    const diffLabel = potDifference === 0 ? '₱0' : (potDifference > 0 ? `+₱${potDifference}` : `-₱${Math.abs(potDifference)}`);
    return `
      <div class="financial-summary-strip">
        <div><span class="pot-summary-label">Current Pot</span><span class="pot-summary-value">₱${pot}</span></div>
        <div><span class="pot-summary-label">Entry Fees</span><span class="pot-summary-value">₱${summary.entryFeesCollected}</span></div>
        <div><span class="pot-summary-label">Trade Fees</span><span class="pot-summary-value">₱${summary.tradeFeesCollected}</span></div>
        <div><span class="pot-summary-label">Swap Fees</span><span class="pot-summary-value">₱${summary.swapFeesCollected}</span></div>
        <div><span class="pot-summary-label">Draft / Other Fees</span><span class="pot-summary-value">₱${draftOtherFeesCollected}</span></div>
        <div><span class="pot-summary-label">Total Collected</span><span class="pot-summary-value">₱${totalCollected}</span></div>
      </div>
      <div class="recon-strip">
        <span>Total Collected <strong>₱${totalCollected}</strong></span>
        <span>Current Pot <strong>₱${pot}</strong></span>
        <span class="${potDifference === 0 ? 'recon-ok' : 'recon-off'}">Difference <strong>${diffLabel}</strong></span>
        <span>${unpaidCount} of ${participantCount} participant${participantCount !== 1 ? 's' : ''} unpaid</span>
      </div>`;
  },

  _renderParticipantTable(accounts) {
    if (!accounts.length) {
      return `<div class="empty-state"><p>No participants in this season.</p></div>`;
    }
    const visible = accounts.filter(({ account }) => {
      if (!account) return this._statusFilter === 'all';
      if (this._statusFilter === 'paid') return account.entryFeePaid;
      if (this._statusFilter === 'unpaid') return !account.entryFeePaid;
      return true;
    });
    if (!visible.length) {
      return `<div class="empty-state"><p>No participants match this filter.</p></div>`;
    }
    return `
      <div class="table-scroll">
        <table class="admin-table">
          <thead>
            <tr><th>Participant</th><th>Entry</th><th>Trade</th><th>Swap</th><th>Total Paid</th><th>Outstanding</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            ${visible.map(({ participant, account }) => {
              if (!account) {
                return `<tr><td>${escapeHtml(participant.name)}</td><td colspan="6">Unable to load account.</td></tr>`;
              }
              return `
                <tr>
                  <td>${escapeHtml(participant.name)}</td>
                  <td>₱${account.entryFee}</td>
                  <td>₱${account.tradeFeesPaid}</td>
                  <td>₱${account.swapFeesPaid}</td>
                  <td>₱${account.totalPaid}</td>
                  <td>₱${account.outstandingBalance}</td>
                  <td><span class="status-chip ${account.entryFeePaid ? 'status-paid' : 'status-unpaid'}">${account.entryFeePaid ? 'Paid' : 'Unpaid'}</span></td>
                  <td>
                    <button class="btn btn-sm btn-ghost" data-action="viewDetails" data-id="${participant.id}">View Details</button>
                    <button class="btn btn-sm btn-ghost" data-action="adjustParticipant" data-id="${participant.id}">Adjust</button>
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  },

  _openDetailModal(season, { participant, account }, participants, container) {
    document.getElementById('financialDetailOverlay')?.remove();
    const allowance = LeagueData.getFreeAllowanceRemaining(season.id, participant.id);

    const overlay = document.createElement('div');
    overlay.id = 'financialDetailOverlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="financialDetailTitle">
        <div class="modal-eyebrow">Financial Account</div>
        <div class="modal-player-name" id="financialDetailTitle">${escapeHtml(participant.name)}</div>

        <div class="financial-detail-grid">
          <div><span class="pot-summary-label">Entry Fee</span><span class="pot-summary-value">₱${account.entryFee} — ${account.entryFeePaid ? 'Paid' : 'Unpaid'}</span></div>
          <div><span class="pot-summary-label">Trade Fees</span><span class="pot-summary-value">₱${account.tradeFeesPaid}</span></div>
          <div><span class="pot-summary-label">Swap Fees</span><span class="pot-summary-value">₱${account.swapFeesPaid}</span></div>
          <div><span class="pot-summary-label">Total Paid</span><span class="pot-summary-value">₱${account.totalPaid}</span></div>
          <div><span class="pot-summary-label">Outstanding</span><span class="pot-summary-value">₱${account.outstandingBalance}${account.outstandingBalance < 0 ? ' (credit balance)' : ''}</span></div>
        </div>

        ${(account.totalRefunded || account.totalCredits || account.totalDebits || account.streamerSalaryReceived) ? `
        <div class="financial-detail-grid" style="margin-top:0.5rem;">
          <div><span class="pot-summary-label">Refunded</span><span class="pot-summary-value">₱${account.totalRefunded}</span></div>
          <div><span class="pot-summary-label">Credits</span><span class="pot-summary-value">₱${account.totalCredits}</span></div>
          <div><span class="pot-summary-label">Debits</span><span class="pot-summary-value">₱${account.totalDebits}</span></div>
          <div><span class="pot-summary-label">Streamer Salary Received</span><span class="pot-summary-value">₱${account.streamerSalaryReceived}</span></div>
        </div>` : ''}

        <p class="helper-text" style="margin-top:1rem;">
          Free Trades: ${allowance ? allowance.freeTrades : '—'} configured — usage tracking unavailable<br>
          Free Swaps: ${allowance ? allowance.freeSwaps : '—'} configured — usage tracking unavailable
        </p>

        ${account.tradeFeeTransactions.length || account.swapFeeTransactions.length ? `
        <p class="helper-text" style="margin-top:0.75rem;"><strong>Transactions</strong></p>
        <ul class="import-summary-list">
          ${account.tradeFeeTransactions.map((t) => `<li>Trade fee share — ₱${t.amount} (Day ${t.seasonDay})</li>`).join('')}
          ${account.swapFeeTransactions.map((t) => `<li>${t.type === 'jokerSwap' ? 'Joker swap' : 'Swap'} — ₱${t.fee} (Day ${t.seasonDay})</li>`).join('')}
        </ul>` : ''}

        <div class="modal-actions">
          <button class="btn btn-ghost" id="financialDetailCloseBtn">Close</button>
          <button class="btn btn-primary" id="financialDetailAdjustBtn">Adjust Account</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('financialDetailCloseBtn').onclick = close;
    document.getElementById('financialDetailAdjustBtn').onclick = () => {
      close();
      this._openAdjustModal(season, participants, container, participant.id);
    };
  },

  /**
   * Displays entryFee / tradeFeeSplit / swap / jokerSwap / tenthPickBlueFee
   * (F5 spec section 12) plus, since F6, refund / credit / debit / void /
   * streamerSalary. The plain "trade" transaction is intentionally NOT
   * listed on its own here (it would duplicate the same ₱ figure already
   * shown via its two tradeFeeSplit children — see the file header and F5
   * spec section 13); likewise "streamerSalaryRun" is never listed on its
   * own, only via its grouped streamerSalary children (same reasoning).
   * Each trade's two tradeFeeSplit records, and each payout run's
   * streamerSalary records, are grouped by relatedTransactionId into one
   * row so no total is ever implied to be collected/paid twice over.
   */
  _renderTransactionHistory(season, participants) {
    const nameOf = (id) => participants.find((p) => p.id === id)?.name || '—';
    const TYPE_LABELS = { entryFee: 'Entry Fee', swap: 'Swap', jokerSwap: 'Joker Swap', tenthPickBlueFee: '10th Pick Blue Fee' };
    const relevant = new Set(['entryFee', 'tradeFeeSplit', 'swap', 'jokerSwap', 'tenthPickBlueFee', 'refund', 'credit', 'debit', 'void', 'streamerSalary']);
    const history = LeagueData.getTransactionHistory(season.id).filter((t) => relevant.has(t.type));

    if (!history.length) {
      return `<div class="empty-state"><p>No financial transactions yet.</p></div>`;
    }

    const allHistory = LeagueData.getTransactionHistory(season.id); // unfiltered — needed to describe what a refund/void points at
    const describeOriginal = (id) => {
      const t = allHistory.find((x) => x.id === id);
      if (!t) return 'an unknown transaction';
      return `${TYPE_LABELS[t.type] || t.type} — ₱${t.amount ?? t.fee ?? 0} (${escapeHtml(nameOf(t.teamA))})`;
    };

    const seenGroups = new Set();
    const rows = [];
    for (const t of history) {
      if (t.type === 'tradeFeeSplit') {
        if (seenGroups.has(t.relatedTransactionId)) continue;
        seenGroups.add(t.relatedTransactionId);
        const group = history.filter((x) => x.type === 'tradeFeeSplit' && x.relatedTransactionId === t.relatedTransactionId);
        const total = group.reduce((sum, x) => sum + (x.amount || 0), 0);
        rows.push({
          day: t.seasonDay,
          timestamp: t.timestamp,
          label: `Trade fee — ${group.map((g) => escapeHtml(nameOf(g.teamA))).join(' ↔ ')}`,
          detail: `Total ₱${total} (${group.map((g) => `${escapeHtml(nameOf(g.teamA))} ₱${g.amount}`).join(', ')})`,
        });
      } else if (t.type === 'streamerSalary') {
        if (seenGroups.has(t.relatedTransactionId)) continue;
        seenGroups.add(t.relatedTransactionId);
        const group = history.filter((x) => x.type === 'streamerSalary' && x.relatedTransactionId === t.relatedTransactionId);
        const runTxn = allHistory.find((x) => x.id === t.relatedTransactionId);
        const total = group.reduce((sum, x) => sum + (x.amount || 0), 0);
        rows.push({
          day: t.seasonDay,
          timestamp: t.timestamp,
          label: 'Streamer Salary Payout',
          detail: `Pool ₱${runTxn ? runTxn.salaryPool : total} from pot ₱${runTxn ? runTxn.totalPotAtPayout : '—'} — ${group.map((g) => `${escapeHtml(nameOf(g.teamA))} ₱${g.amount}`).join(', ')}`,
        });
      } else if (t.type === 'refund') {
        rows.push({
          day: t.seasonDay,
          timestamp: t.timestamp,
          label: 'Refund',
          detail: `${escapeHtml(nameOf(t.teamA))} — ₱${t.amount} (refunding ${describeOriginal(t.relatedTransactionId)}) — "${escapeHtml(t.description || '')}"`,
        });
      } else if (t.type === 'credit') {
        rows.push({
          day: t.seasonDay,
          timestamp: t.timestamp,
          label: 'Credit',
          detail: `${escapeHtml(nameOf(t.teamA))} — ₱${t.amount} — "${escapeHtml(t.description || '')}"`,
        });
      } else if (t.type === 'debit') {
        rows.push({
          day: t.seasonDay,
          timestamp: t.timestamp,
          label: 'Debit',
          detail: `${escapeHtml(nameOf(t.teamA))} — ₱${t.amount} — "${escapeHtml(t.description || '')}"`,
        });
      } else if (t.type === 'void') {
        rows.push({
          day: t.seasonDay,
          timestamp: t.timestamp,
          label: 'Void',
          detail: `Voided ${describeOriginal(t.relatedTransactionId)} — "${escapeHtml(t.description || '')}"`,
        });
      } else {
        rows.push({
          day: t.seasonDay,
          timestamp: t.timestamp,
          label: TYPE_LABELS[t.type] || escapeHtml(t.type),
          detail: `${escapeHtml(nameOf(t.teamA))} — ₱${t.fee ?? t.amount ?? 0}`,
        });
      }
    }

    return `
      <div class="table-scroll">
        <table class="admin-table">
          <thead><tr><th>Day</th><th>Type</th><th>Detail</th><th>Timestamp</th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td>${r.day}</td>
                <td>${r.label}</td>
                <td>${r.detail}</td>
                <td>${new Date(r.timestamp).toLocaleString()}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  },

  // ── F6 — Adjust Account (Refund / Credit / Debit / Void) ────────────────

  /**
   * Single modal covering all four F6 correction types. `presetParticipantId`
   * pre-selects a participant when opened from a row's "Adjust" button or
   * the detail modal; opened from the section-header button it starts
   * unselected. The related-transaction dropdown (required for
   * Refund/Void) is populated from that participant's own refundable/
   * voidable transactions and is rebuilt whenever the participant or
   * adjustment type changes.
   */
  _openAdjustModal(season, participants, container, presetParticipantId) {
    document.getElementById('financialAdjustOverlay')?.remove();

    const REFUNDABLE_TYPES = new Set(['entryFee', 'tradeFeeSplit', 'swap', 'jokerSwap', 'tenthPickBlueFee']);
    const VOIDABLE_TYPES = new Set(['entryFee', 'tradeFeeSplit', 'swap', 'jokerSwap', 'tenthPickBlueFee', 'credit', 'debit', 'streamerSalary']);
    const TYPE_LABELS = { entryFee: 'Entry Fee', tradeFeeSplit: 'Trade Fee Share', swap: 'Swap', jokerSwap: 'Joker Swap', tenthPickBlueFee: '10th Pick Blue Fee', credit: 'Credit', debit: 'Debit', streamerSalary: 'Streamer Salary' };

    let state = { participantId: presetParticipantId || '', adjustType: 'refund', relatedTransactionId: '', amount: '', reason: '' };

    const allTxns = LeagueData.getTransactionHistory(season.id);
    const voidedIds = new Set(allTxns.filter((t) => t.type === 'void').map((t) => t.relatedTransactionId));
    const refundedTotals = new Map();
    allTxns.filter((t) => t.type === 'refund').forEach((t) => {
      refundedTotals.set(t.relatedTransactionId, (refundedTotals.get(t.relatedTransactionId) || 0) + (t.amount || 0));
    });

    const candidateTxns = () => {
      if (!state.participantId) return [];
      const eligibleTypes = state.adjustType === 'refund' ? REFUNDABLE_TYPES : state.adjustType === 'void' ? VOIDABLE_TYPES : null;
      if (!eligibleTypes) return [];
      return allTxns.filter((t) => eligibleTypes.has(t.type) && t.teamA === state.participantId && !voidedIds.has(t.id))
        .filter((t) => state.adjustType !== 'refund' || ((t.amount ?? t.fee ?? 0) - (refundedTotals.get(t.id) || 0)) > 0);
    };

    const overlay = document.createElement('div');
    overlay.id = 'financialAdjustOverlay';
    overlay.className = 'modal-overlay';

    const renderBody = () => {
      const account = state.participantId ? LeagueData.getParticipantFinancialAccount(season.id, state.participantId) : null;
      const needsAmount = state.adjustType !== 'void';
      const needsRelated = state.adjustType === 'refund' || state.adjustType === 'void';
      const options = candidateTxns();
      let previewLine = '';
      if (account) {
        if (state.adjustType === 'credit') previewLine = `New outstanding balance would be ₱${account.outstandingBalance - (Number(state.amount) || 0)}.`;
        else if (state.adjustType === 'debit') previewLine = `New outstanding balance would be ₱${account.outstandingBalance + (Number(state.amount) || 0)}.`;
        else if (state.adjustType === 'refund') previewLine = `Pot will decrease by ₱${Number(state.amount) || 0}.`;
        else if (state.adjustType === 'void') previewLine = `This transaction will no longer count toward financial totals. Pot is not affected.`;
      }

      overlay.innerHTML = `
        <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="financialAdjustTitle">
          <div class="modal-eyebrow">Adjust Account</div>
          <div class="modal-player-name" id="financialAdjustTitle">Financial Correction</div>

          <label class="helper-text" style="display:block;margin-top:0.75rem;">Participant</label>
          <select class="input" id="adjParticipant">
            <option value="">Select participant…</option>
            ${participants.map((p) => `<option value="${p.id}" ${p.id === state.participantId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
          </select>

          <label class="helper-text" style="display:block;margin-top:0.75rem;">Adjustment Type</label>
          <select class="input" id="adjType">
            <option value="refund" ${state.adjustType === 'refund' ? 'selected' : ''}>Refund</option>
            <option value="credit" ${state.adjustType === 'credit' ? 'selected' : ''}>Credit</option>
            <option value="debit" ${state.adjustType === 'debit' ? 'selected' : ''}>Debit</option>
            <option value="void" ${state.adjustType === 'void' ? 'selected' : ''}>Void</option>
          </select>

          ${needsRelated ? `
          <label class="helper-text" style="display:block;margin-top:0.75rem;">Related Transaction</label>
          <select class="input" id="adjRelated">
            <option value="">Select transaction…</option>
            ${options.map((t) => {
              const amt = t.amount ?? t.fee ?? 0;
              const remaining = state.adjustType === 'refund' ? amt - (refundedTotals.get(t.id) || 0) : amt;
              return `<option value="${t.id}" ${t.id === state.relatedTransactionId ? 'selected' : ''}>${TYPE_LABELS[t.type] || t.type} — ₱${amt}${state.adjustType === 'refund' ? ` (₱${remaining} refundable)` : ''} — Day ${t.seasonDay}</option>`;
            }).join('')}
          </select>
          ${state.participantId && !options.length ? `<p class="helper-text">No eligible transactions for this participant.</p>` : ''}
          ` : ''}

          ${needsAmount ? `
          <label class="helper-text" style="display:block;margin-top:0.75rem;">Amount (₱)</label>
          <input type="number" class="input" id="adjAmount" min="1" step="1" value="${escapeHtml(state.amount)}">
          ` : ''}

          <label class="helper-text" style="display:block;margin-top:0.75rem;">Reason (required)</label>
          <textarea class="input" id="adjReason" rows="2">${escapeHtml(state.reason)}</textarea>

          ${previewLine ? `<p class="helper-text" style="margin-top:0.75rem;"><strong>${previewLine}</strong></p>` : ''}

          <div class="modal-actions">
            <button class="btn btn-ghost" id="adjCancelBtn">Cancel</button>
            <button class="btn btn-primary" id="adjConfirmBtn">Confirm Adjustment</button>
          </div>
        </div>`;

      overlay.querySelector('#adjParticipant').onchange = (e) => { state.participantId = e.target.value; state.relatedTransactionId = ''; renderBody(); };
      overlay.querySelector('#adjType').onchange = (e) => { state.adjustType = e.target.value; state.relatedTransactionId = ''; renderBody(); };
      const relatedSel = overlay.querySelector('#adjRelated');
      if (relatedSel) relatedSel.onchange = (e) => { state.relatedTransactionId = e.target.value; renderBody(); };
      const amountInput = overlay.querySelector('#adjAmount');
      if (amountInput) amountInput.oninput = (e) => { state.amount = e.target.value; };
      overlay.querySelector('#adjReason').oninput = (e) => { state.reason = e.target.value; };

      overlay.querySelector('#adjCancelBtn').onclick = close;
      overlay.querySelector('#adjConfirmBtn').onclick = () => {
        AuthBoundary.requireAuth();
        try {
          if (!state.participantId) throw new Error('Select a participant.');
          if (needsRelated && !state.relatedTransactionId) throw new Error('Select the related transaction.');
          if (state.adjustType === 'refund') {
            AdminActions.recordFinancialRefund(season.id, { relatedTransactionId: state.relatedTransactionId, amount: Number(state.amount), reason: state.reason });
          } else if (state.adjustType === 'credit') {
            AdminActions.recordFinancialCredit(season.id, { participantId: state.participantId, amount: Number(state.amount), reason: state.reason });
          } else if (state.adjustType === 'debit') {
            AdminActions.recordFinancialDebit(season.id, { participantId: state.participantId, amount: Number(state.amount), reason: state.reason });
          } else if (state.adjustType === 'void') {
            AdminActions.voidFinancialTransaction(season.id, { transactionId: state.relatedTransactionId, reason: state.reason });
          }
          showToast('Adjustment recorded.', 'success');
          close();
          this.render(container);
        } catch (e) {
          showToast(e.message, 'error');
        }
      };
    };

    renderBody();
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  },

  // ── F6 — Streamer Salary ─────────────────────────────────────────────────

  /**
   * Live preview (LeagueData.getStreamerSalaryPlan — nothing here is
   * stored) plus, for each currently-eligible streamer, a participant
   * mapping <select> (the streamer name is free text — see the F6
   * architecture review — so the commissioner must map it to a real
   * participant before a payout can be recorded). The pool/individual
   * salary shown is a live preview only; the actual payout snapshots its
   * own numbers independently the moment it's confirmed (F6 spec: "do not
   * recalculate the pool after every individual payout").
   */
  _renderStreamerSalarySection(season, participants) {
    const plan = LeagueData.getStreamerSalaryPlan(season.id);
    if (!plan) return `<div class="empty-state"><p>Unable to load streamer salary information.</p></div>`;

    const participantOptions = (selected) => `
      <option value="">Select participant…</option>
      ${participants.map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}`;

    // Best-effort pre-fill: case-insensitive/trimmed exact name match only
    // — never assumed automatically for the actual payout, just a
    // convenience default the commissioner can change or clear.
    if (!plan.eligibleStreamers.length) {
      return `<div class="empty-state"><p>No streamer has reached ${14} completed games yet. Pool would be ₱${plan.salaryPool} (30% of the current ₱${plan.pot} pot).</p></div>`;
    }

    plan.eligibleStreamers.forEach(({ streamer }) => {
      if (this._streamerMap[streamer] === undefined) {
        const match = participants.find((p) => p.name.trim().toLowerCase() === streamer.trim().toLowerCase());
        this._streamerMap[streamer] = match ? match.id : '';
      }
    });

    return `
      <div class="financial-summary-strip">
        <div><span class="pot-summary-label">Current Pot</span><span class="pot-summary-value">₱${plan.pot}</span></div>
        <div><span class="pot-summary-label">Salary Pool (30%)</span><span class="pot-summary-value">₱${plan.salaryPool}</span></div>
        <div><span class="pot-summary-label">Eligible Streamers</span><span class="pot-summary-value">${plan.eligibleStreamers.length}</span></div>
        <div><span class="pot-summary-label">Each Would Receive</span><span class="pot-summary-value">₱${plan.individualSalary}</span></div>
      </div>
      <div class="table-scroll">
        <table class="admin-table">
          <thead><tr><th>Streamer</th><th>Games Streamed</th><th>Pay To Participant</th></tr></thead>
          <tbody>
            ${plan.eligibleStreamers.map(({ streamer, gamesStreamed }) => `
              <tr>
                <td>${escapeHtml(streamer)}</td>
                <td>${gamesStreamed}</td>
                <td><select class="input" data-streamer-select="${escapeHtml(streamer)}">${participantOptions(this._streamerMap[streamer])}</select></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="header-actions" style="margin-top:0.75rem;">
        <button class="btn btn-primary" data-action="payStreamerSalaries">Pay Streamer Salaries</button>
      </div>
      ${plan.alreadyPaid.length ? `
      <p class="helper-text" style="margin-top:0.75rem;"><strong>Already paid this season</strong></p>
      <ul class="import-summary-list">
        ${plan.alreadyPaid.map((p) => `<li>${escapeHtml(p.participantName)} — ₱${p.amount} (Day ${p.seasonDay})</li>`).join('')}
      </ul>` : ''}`;
  },

  _openStreamerSalaryConfirm(season, participants, container) {
    const plan = LeagueData.getStreamerSalaryPlan(season.id);
    if (!plan || !plan.eligibleStreamers.length) {
      showToast('No eligible streamers to pay.', 'error');
      return;
    }
    const missing = plan.eligibleStreamers.filter(({ streamer }) => !this._streamerMap[streamer]);
    if (missing.length) {
      showToast(`Select a participant for: ${missing.map((m) => m.streamer).join(', ')}.`, 'error');
      return;
    }
    const chosenIds = plan.eligibleStreamers.map(({ streamer }) => this._streamerMap[streamer]);
    if (new Set(chosenIds).size !== chosenIds.length) {
      showToast('The same participant is mapped to more than one streamer — each must be unique for this run.', 'error');
      return;
    }

    document.getElementById('streamerSalaryConfirmOverlay')?.remove();
    const nameOf = (id) => participants.find((p) => p.id === id)?.name || '—';

    const overlay = document.createElement('div');
    overlay.id = 'streamerSalaryConfirmOverlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="streamerSalaryConfirmTitle">
        <div class="modal-eyebrow">Pay Streamer Salaries</div>
        <div class="modal-player-name" id="streamerSalaryConfirmTitle">Confirm Payout Run</div>
        <p class="modal-prompt">
          Pool snapshot: ₱${plan.salaryPool} (30% of the current ₱${plan.pot} pot), split ${plan.eligibleStreamers.length} ways
          — ₱${plan.individualSalary} each. This snapshot is fixed for the whole run; paying one streamer will not
          change what the others receive.
        </p>
        <ul class="import-summary-list">
          ${plan.eligibleStreamers.map(({ streamer, gamesStreamed }) => `<li>${escapeHtml(streamer)} (${gamesStreamed} games) → ${escapeHtml(nameOf(this._streamerMap[streamer]))} — ₱${plan.individualSalary}</li>`).join('')}
        </ul>
        <label class="helper-text" style="display:block;margin-top:0.75rem;">Reason (required)</label>
        <textarea class="input" id="streamerSalaryReason" rows="2"></textarea>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="streamerSalaryCancelBtn">Cancel</button>
          <button class="btn btn-primary" id="streamerSalaryConfirmBtn">Confirm &amp; Pay</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('streamerSalaryCancelBtn').onclick = close;
    document.getElementById('streamerSalaryConfirmBtn').onclick = () => {
      AuthBoundary.requireAuth();
      const reason = document.getElementById('streamerSalaryReason').value;
      try {
        const map = {};
        plan.eligibleStreamers.forEach(({ streamer }) => { map[streamer] = this._streamerMap[streamer]; });
        AdminActions.payStreamerSalaries(season.id, { streamerParticipantMap: map, reason });
        showToast('Streamer salaries paid.', 'success');
        this._streamerMap = {};
        close();
        this.render(container);
      } catch (e) {
        showToast(e.message, 'error');
      }
    };
  },
};
