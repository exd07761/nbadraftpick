/**
 * admin/hall-of-fame.js — Hall of Fame (historical champions archive)
 * admin CRUD, Phase 6.14.
 *
 * SCOPE — this file is the entire Admin UI for Hall of Fame. It:
 *   - reads public.hall_of_fame with a plain SupabaseQuery.select() call
 *     (the same read pattern js/supabase-reads-*.js already uses
 *     elsewhere) — table-level SELECT is already open to anon/
 *     authenticated (Phase 6.11), so no read RPC is needed.
 *   - writes ONLY through the three Phase 6.13 SECURITY DEFINER RPCs:
 *     create_hall_of_fame_champion, update_hall_of_fame_champion,
 *     delete_hall_of_fame_champion, via the new SupabaseQuery.callWriteRpc
 *     helper (js/supabase-query.js) — there is no direct .insert()/
 *     .update()/.delete() against hall_of_fame anywhere in this file,
 *     and there must never be one (anon/authenticated only ever hold
 *     table-level SELECT on this table — see Phase 6.11/6.13).
 *   - never references participant_id, player_id, LeagueData,
 *     AdminActions, or any current-roster/draft/player data. A Hall of
 *     Fame roster entry is exactly {slot, player, position, ovr} —
 *     free-text historical values, never a foreign key — matching
 *     js/hall-of-fame-data.js's (public, still-static) placeholder shape
 *     and the `roster` column comment set in the Phase 6.11 migration.
 *
 * IMPORTANT — KNOWN GAP, NOT FIXED HERE (flagging, not solving, same as
 * this project's existing documented gaps, e.g. supabase-reads-roster.js's
 * Phase 6.4 classification-grant note): every Phase 6.13 RPC opens with
 * require_commissioner(), which raises UNAUTHENTICATED unless
 * Supabase Auth's auth.uid() is set — i.e. the browser needs an actual
 * signed-in Supabase Auth session. js/supabase-config.js's SupabaseClient
 * is currently initialized with the anon key only, and nothing anywhere
 * in this repo ever calls supabase.auth.signInWithPassword() or any other
 * Supabase Auth sign-in — the admin login screen (auth-boundary.js) signs
 * in to Firebase Auth only, a completely separate system from Supabase
 * Auth. This view still calls AuthBoundary.requireAuth() first in every
 * write handler, for the same fast client-side UI guard every other
 * admin write path here already uses, and it still calls the three RPCs
 * exactly as specified — but until a future phase explicitly bridges a
 * Supabase Auth session for the signed-in commissioner (out of scope for
 * this UI-only phase — the brief for this phase says not to build a new
 * authentication mechanism), Create/Update/Delete here will fail at the
 * RPC with "UNAUTHENTICATED: sign-in required" even for an
 * already-Firebase-signed-in commissioner. Reads are unaffected (SELECT
 * is already open to anon per Phase 6.11).
 *
 * PATTERNS FOLLOWED (inspected before writing, not invented fresh):
 *   - View shape: a `{ render(container) }` object registered in
 *     AdminApp.routes (js/admin.js) — identical to every other admin
 *     view (AdminSeasonsView, AdminParticipantsView, ...).
 *   - List: .admin-section/.admin-section-header + .table-scroll >
 *     table.admin-table, matching AdminSeasonsView's plain-table CRUD
 *     list exactly (Season/Status/Participants/Actions there ->
 *     Season/Champion/Roster/Actions here).
 *   - Add/Edit form: a .modal-overlay/.modal-card modal with a ×, a
 *     click-outside-to-close, an Escape handler, and Cancel — the same
 *     shape as admin/nba2k-database.js's _openManualEdit modal — rather
 *     than an inline form, since a 10-row roster editor is too tall for
 *     one. A small .hof-admin-modal width/height override sits on top
 *     of the shared .modal-card (css/admin.css), the same layering
 *     .manual-edit-modal already uses for the same reason.
 *   - Delete: native confirm() naming the season/champion, then the
 *     RPC — same shape as AdminSeasonsView's deleteSeason and
 *     AdminParticipantsView's removeP.
 *   - Notifications: showToast(message, 'success' | 'error')
 *     (js/shared-utils.js) — same as every other admin write path.
 *   - Async write handlers disable + relabel their button ("Saving…" /
 *     "Deleting…") and wrap the RPC call in try/catch, matching
 *     AdminSeasonsView's async seedPool handler.
 */
const AdminHallOfFameView = {
  _entries: [],
  _escHandler: null,

  render(container) {
    container.innerHTML = `
      <div class="admin-section">
        <div class="admin-section-header">
          <h2>Hall of Fame</h2>
          <button class="btn btn-primary" id="btnAddHof">+ Add Champion</button>
        </div>
        <p class="helper-text">
          Manually curated historical archive of past champions. Static snapshot data —
          not connected to current players, participants, or rosters.
        </p>
        <div id="hofListMount"><p class="helper-text">Loading…</p></div>
        <div id="hofModalMount"></div>
      </div>`;

    container.querySelector('#btnAddHof').onclick = () => {
      AuthBoundary.requireAuth();
      this._openForm(container, null);
    };

    this._loadAndRenderList(container);
  },

  async _loadAndRenderList(container) {
    const mount = container.querySelector('#hofListMount');
    if (!mount) return; // view navigated away before the read resolved

    try {
      this._entries = await SupabaseQuery.select('hall_of_fame', (qb) =>
        qb.order('created_at', { ascending: true })
      );
    } catch (e) {
      mount.innerHTML = `<div class="empty-state"><p>Failed to load Hall of Fame entries: ${escapeHtml(e.message)}</p></div>`;
      return;
    }

    if (!this._entries.length) {
      mount.innerHTML = `<div class="empty-state"><p>No Hall of Fame champions yet.</p></div>`;
      return;
    }

    mount.innerHTML = `
      <div class="table-scroll">
      <table class="admin-table">
        <thead>
          <tr><th>Season</th><th>Champion</th><th>Roster</th><th>Actions</th></tr>
        </thead>
        <tbody>
          ${this._entries.map((row) => {
            const count = Array.isArray(row.roster) ? row.roster.length : 0;
            return `
              <tr>
                <td>${escapeHtml(row.season_name)}</td>
                <td>${escapeHtml(row.champion_name)}</td>
                <td>${count} player${count !== 1 ? 's' : ''}</td>
                <td class="action-cell">
                  <button class="btn btn-sm btn-ghost" data-action="editHof" data-id="${row.id}">Edit</button>
                  <button class="btn btn-sm btn-danger" data-action="deleteHof" data-id="${row.id}">Delete</button>
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
      </div>`;

    mount.querySelectorAll('[data-action]').forEach((btn) => {
      btn.onclick = () => {
        AuthBoundary.requireAuth();
        const { action, id } = btn.dataset;
        const entry = this._entries.find((e) => e.id === id);
        if (!entry) return;
        if (action === 'editHof') {
          this._openForm(container, entry);
        } else if (action === 'deleteHof') {
          this._confirmDelete(container, entry);
        }
      };
    });
  },

  // ── Delete ────────────────────────────────────────────────────────────
  _confirmDelete(container, entry) {
    const ok = confirm(
      `Delete the Hall of Fame entry for "${entry.champion_name}" (${entry.season_name})? This cannot be undone.`
    );
    if (!ok) return;

    const btn = container.querySelector(`[data-action="deleteHof"][data-id="${entry.id}"]`);
    if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }

    SupabaseQuery.callWriteRpc('delete_hall_of_fame_champion', { p_id: entry.id })
      .then(() => {
        showToast(`Deleted "${entry.champion_name}" (${entry.season_name}).`, 'success');
        this._loadAndRenderList(container);
      })
      .catch((e) => {
        showToast(e.message, 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
      });
  },

  // ── Add / Edit modal ─────────────────────────────────────────────────
  // entry === null means "Add Champion"; otherwise editing that row.
  _openForm(container, entry) {
    const mount = container.querySelector('#hofModalMount');
    if (!mount) return;

    // Tear down a previous modal's Escape listener before opening another,
    // same guard _openManualEdit (admin/nba2k-database.js) uses.
    if (this._escHandler) {
      document.removeEventListener('keydown', this._escHandler);
      this._escHandler = null;
    }

    const isEdit = !!entry;
    const existingRoster = isEdit && Array.isArray(entry.roster) ? entry.roster : [];
    // Always exactly 10 slots, in order, regardless of what shape the
    // existing data happens to be in — a missing slot just renders blank.
    const slots = Array.from({ length: 10 }, (_, i) => {
      const slotNum = i + 1;
      const existing = existingRoster.find((r) => Number(r.slot) === slotNum) || {};
      return {
        slot: slotNum,
        player: existing.player || '',
        position: existing.position || '',
        ovr: existing.ovr != null ? existing.ovr : '',
      };
    });

    mount.innerHTML = `
      <div class="modal-overlay" id="hofFormOverlay">
        <div class="modal-card hof-admin-modal" role="dialog" aria-modal="true" aria-labelledby="hofFormTitle">
          <button type="button" class="nba2k-detail-close" id="hofFormCloseBtn" aria-label="Close">×</button>
          <div class="modal-eyebrow" id="hofFormTitle">${isEdit ? 'Edit Champion' : 'Add Champion'}</div>

          <div class="form-group">
            <label for="hofSeasonName">Season Name</label>
            <input type="text" id="hofSeasonName" class="input" maxlength="60"
                   placeholder="e.g. NBA 2K26" value="${escapeHtml(isEdit ? entry.season_name : '')}">
          </div>
          <div class="form-group">
            <label for="hofChampionName">Champion Name</label>
            <input type="text" id="hofChampionName" class="input" maxlength="60"
                   placeholder="e.g. Gigs" value="${escapeHtml(isEdit ? entry.champion_name : '')}">
          </div>

          <label class="helper-text" style="display:block;margin-top:0.5rem;">
            Historical Roster — exactly 10 slots, snapshot values only (not linked to current players)
          </label>
          <div class="table-scroll" style="margin-top:0.4rem;">
            <table class="admin-table">
              <thead><tr><th style="width:3rem;">Slot</th><th>Player</th><th style="width:6rem;">Pos</th><th style="width:5rem;">OVR</th></tr></thead>
              <tbody id="hofRosterRows">
                ${slots.map((s) => `
                  <tr>
                    <td>${s.slot}</td>
                    <td><input type="text" class="input" data-hof-slot="${s.slot}" data-hof-field="player" maxlength="60" value="${escapeHtml(s.player)}"></td>
                    <td>
                      <select class="input" data-hof-slot="${s.slot}" data-hof-field="position">
                        <option value="">--</option>
                        ${CORE_POSITIONS.map((p) => `<option value="${p}" ${s.position === p ? 'selected' : ''}>${p}</option>`).join('')}
                      </select>
                    </td>
                    <td><input type="number" class="input input-sm" data-hof-slot="${s.slot}" data-hof-field="ovr" min="0" max="99" value="${s.ovr}"></td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>

          <div id="hofFormError"></div>
          <div class="form-actions">
            <button type="button" class="btn btn-primary" id="hofFormSaveBtn">${isEdit ? 'Save Changes' : 'Create'}</button>
            <button type="button" class="btn btn-ghost" id="hofFormCancelBtn">Cancel</button>
          </div>
        </div>
      </div>`;

    const close = () => {
      mount.innerHTML = '';
      if (this._escHandler) {
        document.removeEventListener('keydown', this._escHandler);
        this._escHandler = null;
      }
    };

    mount.querySelector('#hofFormOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'hofFormOverlay') close();
    });
    mount.querySelector('#hofFormCloseBtn').onclick = close;
    mount.querySelector('#hofFormCancelBtn').onclick = close;
    this._escHandler = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', this._escHandler);

    mount.querySelector('#hofFormSaveBtn').onclick = async () => {
      AuthBoundary.requireAuth();
      const errEl = mount.querySelector('#hofFormError');
      errEl.innerHTML = '';

      const seasonName = mount.querySelector('#hofSeasonName').value.trim();
      const championName = mount.querySelector('#hofChampionName').value.trim();

      const roster = [];
      for (let slotNum = 1; slotNum <= 10; slotNum++) {
        const playerEl = mount.querySelector(`[data-hof-slot="${slotNum}"][data-hof-field="player"]`);
        const positionEl = mount.querySelector(`[data-hof-slot="${slotNum}"][data-hof-field="position"]`);
        const ovrEl = mount.querySelector(`[data-hof-slot="${slotNum}"][data-hof-field="ovr"]`);
        roster.push({
          slot: slotNum,
          player: playerEl.value.trim(),
          position: positionEl.value,
          ovrRaw: ovrEl.value.trim(),
        });
      }

      // Client-side validation. The RPC (Phase 6.13) remains the final
      // authority — this is only a fast UI check so a commissioner sees a
      // clear message before a round trip, exactly like every other admin
      // form's pre-flight validation (e.g. AdminParticipantsView's
      // duplicate/length checks before calling AdminActions.addParticipant).
      if (!seasonName) {
        errEl.innerHTML = `<div class="backup-result backup-result-error">Season name is required.</div>`;
        return;
      }
      if (!championName) {
        errEl.innerHTML = `<div class="backup-result backup-result-error">Champion name is required.</div>`;
        return;
      }
      const incomplete = roster.filter((r) => !r.player || !r.position || r.ovrRaw === '');
      if (incomplete.length) {
        errEl.innerHTML = `<div class="backup-result backup-result-error">Every slot needs a player name, position, and OVR — missing slot ${incomplete.map((r) => r.slot).join(', ')}.</div>`;
        return;
      }
      const invalidOvr = roster.filter((r) => {
        const n = Number(r.ovrRaw);
        return !Number.isFinite(n) || n < 0 || n > 99;
      });
      if (invalidOvr.length) {
        errEl.innerHTML = `<div class="backup-result backup-result-error">OVR must be a number from 0–99 — check slot ${invalidOvr.map((r) => r.slot).join(', ')}.</div>`;
        return;
      }

      const rosterPayload = roster.map((r) => ({
        slot: r.slot,
        player: r.player,
        position: r.position,
        ovr: Number(r.ovrRaw),
      }));

      const saveBtn = mount.querySelector('#hofFormSaveBtn');
      saveBtn.disabled = true;
      saveBtn.textContent = isEdit ? 'Saving…' : 'Creating…';

      try {
        if (isEdit) {
          await SupabaseQuery.callWriteRpc('update_hall_of_fame_champion', {
            p_id: entry.id,
            p_season_name: seasonName,
            p_champion_name: championName,
            p_roster: rosterPayload,
          });
          showToast(`"${championName}" (${seasonName}) updated.`, 'success');
        } else {
          await SupabaseQuery.callWriteRpc('create_hall_of_fame_champion', {
            p_season_name: seasonName,
            p_champion_name: championName,
            p_roster: rosterPayload,
          });
          showToast(`"${championName}" (${seasonName}) added to the Hall of Fame.`, 'success');
        }
        close();
        this._loadAndRenderList(container);
      } catch (e) {
        errEl.innerHTML = `<div class="backup-result backup-result-error">${escapeHtml(e.message)}</div>`;
        saveBtn.disabled = false;
        saveBtn.textContent = isEdit ? 'Save Changes' : 'Create';
      }
    };
  },
};
