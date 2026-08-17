/**
 * admin/financial.js — Financial Management (F5)
 *
 * Read-only presentation layer over the F4 derived financial APIs
 * (LeagueData.getFinancialSummary / getParticipantFinancialAccount /
 * getFreeAllowanceRemaining), which themselves derive everything from
 * season.transactions[] — the same ledger Phase 5 (trades/swaps/Joker/
 * 10th-pick-Blue) and F2/F3 (entryFee/tradeFeeSplit) already write to.
 *
 * This file performs NO writes of any kind: no saveData, no AdminActions
 * calls, no new transaction types. The only payment-recording action in
 * the app (AdminActions.recordEntryFeePayment, "Mark Paid") stays on the
 * Participants page exactly where F2 put it — this page only reads.
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
          </div>
        </div>
        ${this._renderParticipantTable(accounts)}

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
        if (entry) this._openDetailModal(season, entry);
      };
    });
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
                  <td><button class="btn btn-sm btn-ghost" data-action="viewDetails" data-id="${participant.id}">View Details</button></td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  },

  _openDetailModal(season, { participant, account }) {
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
          <div><span class="pot-summary-label">Outstanding</span><span class="pot-summary-value">₱${account.outstandingBalance}</span></div>
        </div>

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
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('financialDetailCloseBtn').onclick = close;
  },

  /**
   * Displays only entryFee / tradeFeeSplit / swap / jokerSwap /
   * tenthPickBlueFee (F5 spec section 12) — the plain "trade" transaction
   * is intentionally NOT listed on its own here (it would duplicate the
   * same ₱ figure already shown via its two tradeFeeSplit children — see
   * the file header and F5 spec section 13). Instead, each trade's two
   * tradeFeeSplit records are grouped by relatedTransactionId into one
   * row showing the total and each participant's share, so the total is
   * never implied to be collected three times over.
   */
  _renderTransactionHistory(season, participants) {
    const nameOf = (id) => participants.find((p) => p.id === id)?.name || '—';
    const TYPE_LABELS = { entryFee: 'Entry Fee', swap: 'Swap', jokerSwap: 'Joker Swap', tenthPickBlueFee: '10th Pick Blue Fee' };
    const relevant = new Set(['entryFee', 'tradeFeeSplit', 'swap', 'jokerSwap', 'tenthPickBlueFee']);
    const history = LeagueData.getTransactionHistory(season.id).filter((t) => relevant.has(t.type));

    if (!history.length) {
      return `<div class="empty-state"><p>No financial transactions yet.</p></div>`;
    }

    const seenTradeGroups = new Set();
    const rows = [];
    for (const t of history) {
      if (t.type === 'tradeFeeSplit') {
        if (seenTradeGroups.has(t.relatedTransactionId)) continue;
        seenTradeGroups.add(t.relatedTransactionId);
        const group = history.filter((x) => x.type === 'tradeFeeSplit' && x.relatedTransactionId === t.relatedTransactionId);
        const total = group.reduce((sum, x) => sum + (x.amount || 0), 0);
        rows.push({
          day: t.seasonDay,
          timestamp: t.timestamp,
          label: `Trade fee — ${group.map((g) => escapeHtml(nameOf(g.teamA))).join(' ↔ ')}`,
          detail: `Total ₱${total} (${group.map((g) => `${escapeHtml(nameOf(g.teamA))} ₱${g.amount}`).join(', ')})`,
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
};
