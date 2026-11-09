/**
 * supabase-sync.js
 *
 * Supabase-backed, drop-in replacement for the FirebaseSync abstraction
 * defined in data.js.
 *
 * STATUS (Phase 9.3):
 * - Used by the public Supabase-backed data adapter and isolated DEV admin.
 * - Writes require the expected updated_at version through the CAS RPC.
 * - A conflict or uncertain failure stops subsequent full-document writes
 *   until the caller reloads, so an old cache cannot silently overwrite data.
 * - Supabase Realtime is used ONLY as an invalidation signal: the
 *   league_state.data payload is ~1 MB and may be omitted from the event, so
 *   on an UPDATE of the "main" row we re-fetch the full row with the same
 *   SELECT used by init() and then notify onRemoteChange() listeners.
 *
 * Storage contract:
 *   public.league_state, id = "main"
 *   Reads  -> normal SELECT of the single "main" row.
 *   Writes -> protected save_league_state(jsonb, timestamptz) RPC, which
 *             receives the FULL document plus its expected updated_at.
 *
 * Dependencies (all resolved at call time, never at load time, so script
 * load order relative to data.js does not matter and there is no circular
 * dependency):
 *   - SupabaseClient                  global from js/supabase-config.js
 *   - stripLiveNba2k27PoolPlayers()   global function owned by data.js
 *   - showToast()                     optional global UI helper
 *
 * API (identical to FirebaseSync):
 *   ready, init(), getCache(), save(data), saveAndConfirm(data),
 *   waitForPendingSave(), onRemoteChange(fn)
 */

// Everything below runs inside this IIFE so neither createSupabaseSync nor createSupabaseSyncCore
// (the factories that accept an injected client) is ever a browser global. The body is deliberately not re-indented.
const SupabaseSync = (function () {
function createSupabaseSyncCore(clientProvider = () => (typeof SupabaseClient !== "undefined" ? SupabaseClient : null), devDiagnostics = null) {
  const STATE_TABLE = "league_state";
  const STATE_ID = "main";
  const SAVE_RPC = "save_league_state";
  // Keep supporting the pre-migration SQLSTATE during a rolling deployment.
  function isSaveConflictCode(code) {
    return code === "PT409" || code === "40001";
  }

  let _cache = null; // latest known full data blob (or null before init succeeds)
  let _confirmedCache = null;
  let _updatedAt = null; // compare-and-swap version read from league_state/main
  let _writesBlocked = false; // any failed/uncertain full-document write requires a reload
  let _cacheGeneration = 0;
  let _cacheIntentSequence = 0;
  let _remoteGeneration = 0;
  let _syncError = null;
  let _initStarted = false;
  let _readyResolve;
  let _readyReject;

  const ready = new Promise((resolve, reject) => {
    _readyResolve = resolve;
    _readyReject = reject;
  });
  // init() already surfaces a failure to its caller (it returns `ready`).
  // This no-op handler only prevents a spurious "unhandled rejection"
  // warning if nothing happens to be awaiting `ready` at that moment.
  ready.catch(() => {});

  const remoteChangeListeners = [];

  // Tracks the most recently issued fire-and-forget save() write so a caller
  // can sequence a later write after it via waitForPendingSave(). This is
  // the RAW write promise (it rejects if the write fails); save()'s own
  // console/toast reporting is attached to the same promise separately.
  // Starts resolved so waiting before any save() has run is a no-op.
  let _lastSavePromise = Promise.resolve();
  let _saveQueue = Promise.resolve();

  // ── Realtime state ──
  const REALTIME_CHANNEL = "league-state-main";
  let _realtimeChannel = null; // set once; guards against duplicate subscriptions
  let _realtimeNeedsCatchUp = false; // true after any non-SUBSCRIBED status
  // Local-write tracking, used to ignore the echo of our OWN saves (the
  // equivalent of FirebaseSync skipping hasPendingWrites snapshots).
  let _pendingWrites = 0; // save()/saveAndConfirm() writes currently in flight
  let _writeEpoch = 0; // bumped whenever a local write starts
  let _refreshRunning = false;
  let _refreshQueued = false;
  const _refreshWaiters = [];
  let _localWriteResult = null;
  const diagnosticBuffer = [];
  let diagnosticRequestSequence = 0;
  const DIAGNOSTIC_BUFFER_LIMIT = 100;
  const diagnosticsEnabled =
    typeof window !== "undefined" &&
    window.DRAFTP_DEV_ADMIN === true &&
    devDiagnostics?.enabled === true &&
    typeof devDiagnostics.pageInstanceId === "string";

  function newDiagnosticRequestId() {
    diagnosticRequestSequence += 1;
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
    } catch {
      // The per-instance sequence remains unique if browser UUID support is unavailable.
    }
    return `${Date.now().toString(36)}-${diagnosticRequestSequence.toString(36)}`;
  }

  function recordSaveAttempt(expectedUpdatedAt, outcome, requestId, attemptedAt, errorCode = null) {
    if (!diagnosticsEnabled) return null;
    const record = Object.freeze({
      buildRevision: devDiagnostics.buildRevision || "unknown",
      pageInstanceId: devDiagnostics.pageInstanceId,
      requestId,
      expectedUpdatedAt,
      outcome,
      attemptedAt,
      ...(errorCode ? { errorCode } : {}),
    });
    diagnosticBuffer.push(record);
    if (diagnosticBuffer.length > DIAGNOSTIC_BUFFER_LIMIT) diagnosticBuffer.shift();
    return record;
  }

  function getClient() {
    const client = clientProvider();
    if (!client) {
      throw new Error(
        "[SupabaseSync] SupabaseClient is not initialized. " +
        "Check script load order (js/supabase-config.js must load first)."
      );
    }
    return client;
  }

  /**
   * Runs the live NBA2K27 pool strip owned by data.js. Resolved at call
   * time. Fails CLOSED: if the function is unavailable we refuse to write,
   * because persisting without stripping would write the ~2,000 synthetic
   * live-pool players into league_state/main.
   */
  function stripForPersist(data) {
    if (typeof stripLiveNba2k27PoolPlayers !== "function") {
      throw new Error(
        "[SupabaseSync] stripLiveNba2k27PoolPlayers() is not available " +
        "(data.js must be loaded before the first save). Refusing to write."
      );
    }
    return stripLiveNba2k27PoolPlayers(data);
  }

  /** Reads league_state/main. Returns the row, or null if it does not exist. */
  async function fetchState() {
    const { data, error } = await getClient()
      .from(STATE_TABLE)
      .select("id, data, updated_at")
      .eq("id", STATE_ID)
      .maybeSingle();

    if (error) {
      throw new Error(
        `[SupabaseSync] Failed to load league state: ${error.message}`
      );
    }

    return data;
  }

  /** Writes through the compare-and-swap overload of save_league_state. */
  async function persist(toPersist, expectedUpdatedAt) {
    const requestId = diagnosticsEnabled ? newDiagnosticRequestId() : null;
    const attemptedAt = diagnosticsEnabled ? new Date().toISOString() : null;
    let result;
    let error;
    try {
      ({ data: result, error } = await getClient().rpc(SAVE_RPC, {
        p_data: toPersist,
        p_expected_updated_at: expectedUpdatedAt,
      }));
    } catch (requestError) {
      const record = recordSaveAttempt(
        expectedUpdatedAt, "error", requestId, attemptedAt,
        requestError?.code || null,
      );
      if (record) {
        if (requestError && typeof requestError === "object") {
          requestError.diagnostic = record;
        }
        console.error("[DraftP DEV save diagnostic]", record);
      }
      throw requestError;
    }

    if (error) {
      const conflict = isSaveConflictCode(error.code);
      const record = recordSaveAttempt(
        expectedUpdatedAt,
        conflict ? "conflict" : "error",
        requestId,
        attemptedAt,
        error.code || null,
      );
      const saveError = new Error(conflict
        ? "[SupabaseSync] Save conflict: a newer league version exists."
        : `[SupabaseSync] Cloud save failed: ${error.message}`);
      saveError.code = error.code;
      if (record) {
        saveError.diagnostic = record;
        console.error("[DraftP DEV save diagnostic]", record);
      }
      throw saveError;
    }

    if (!result || typeof result.updated_at !== "string") {
      const record = recordSaveAttempt(
        expectedUpdatedAt, "error", requestId, attemptedAt, "INVALID_RESPONSE",
      );
      const responseError = new Error("[SupabaseSync] Save response did not include the new league version.");
      if (record) {
        responseError.diagnostic = record;
        console.error("[DraftP DEV save diagnostic]", record);
      }
      throw responseError;
    }
    recordSaveAttempt(expectedUpdatedAt, "success", requestId, attemptedAt);
    return result;
  }

  /**
   * Serialize writes from this client and use the last confirmed version.
   * Any error makes the outcome/version uncertain, so queued writes are
   * stopped until reload instead of retrying a stale full-document payload.
   */
  function enqueuePersist(toPersist) {
    const queuedWrite = {
      data: toPersist,
      cacheGeneration: _cacheGeneration,
      remoteGeneration: _remoteGeneration,
    };
    const operation = _saveQueue.then(async () => {
      while (_refreshRunning) {
        await new Promise(resolve => _refreshWaiters.push(resolve));
      }
      if (queuedWrite.remoteGeneration !== _remoteGeneration) {
        _writesBlocked = true;
        _syncError = new Error("[SupabaseSync] A remote update arrived while this save was queued. Reload before editing again.");
        throw _syncError;
      }
      if (_writesBlocked) {
        throw new Error("[SupabaseSync] Writes are paused after an unconfirmed save. Reload before editing again.");
      }
      if (!_updatedAt) {
        _writesBlocked = true;
        _syncError = new Error("[SupabaseSync] No league version is available. Reload before editing.");
        throw _syncError;
      }

      _pendingWrites++;
      _writeEpoch++;
      let persistFailed = false;
      // Payloads keep their creation generation. Same-tab writes remain valid
      // in queue order; only a remote generation change makes them stale.
      try {
        const result = await persist(queuedWrite.data, _updatedAt);
        _updatedAt = result.updated_at;
        _confirmedCache = queuedWrite.data;
        _localWriteResult = { updatedAt: result.updated_at, data: queuedWrite.data };
        return result;
      } catch (err) {
        persistFailed = true;
        _writesBlocked = true;
        _syncError = err;
        throw err;
      } finally {
        _pendingWrites--;
        if (_pendingWrites === 0 && _refreshQueued) {
          await refreshFromRemote();
        }
        if (_pendingWrites === 0 && persistFailed) {
          await refreshAfterFailure(_syncError);
        }
        if (_pendingWrites === 0) _localWriteResult = null;
      }
    });
    // Keep the internal queue usable for bookkeeping; the public promise
    // still rejects and is returned by waitForPendingSave()/saveAndConfirm().
    _saveQueue = operation.catch(() => {});
    _lastSavePromise = operation;
    return operation;
  }

  /**
   * Initial read. Populates the in-memory cache and resolves `ready` only
   * after the read succeeds. Unlike FirebaseSync, it NEVER seeds a missing
   * document: the verified league state has already been imported, so a
   * missing row (or a row with no data) is an initialization error.
   * Safe to call more than once; later calls return the same `ready`.
   */
  function init() {
    if (_initStarted) return ready;
    _initStarted = true;

    fetchState()
      .then((row) => {
        if (!row || row.data === null || typeof row.data !== "object") {
          throw new Error(
            `[SupabaseSync] ${STATE_TABLE}/${STATE_ID} does not exist or has no data.`
          );
        }
        if (typeof row.updated_at !== "string" || !row.updated_at) {
          throw new Error(`[SupabaseSync] ${STATE_TABLE}/${STATE_ID} has no version metadata.`);
        }
        _cache = row.data;
        _confirmedCache = row.data;
        _updatedAt = row.updated_at;
        _readyResolve();
        // Realtime is started only AFTER the initial read has succeeded and
        // `ready` has resolved, and it can never reject init (see
        // startRealtime()). A Realtime problem must not affect the read.
        startRealtime();
      })
      .catch((err) => {
        console.error("[SupabaseSync] Initialization failed:", err);
        _readyReject(err);
      });

    return ready;
  }

  function getCache() {
    return _cache;
  }

  /**
   * Fire-and-forget save, matching FirebaseSync.save():
   * - strips live NBA2K27 pool players before anything is stored
   * - updates the local cache immediately (optimistic), to the stripped
   *   version, so it reflects what is actually stored
   * - persists the full document via the RPC without blocking the caller
   * - reports cloud failures via console + toast
   * Returns nothing, like FirebaseSync.save(); use waitForPendingSave() to
   * find out how the write ended.
   */
  function save(data) {
    const toPersist = stripForPersist(data);
    _cache = toPersist; // optimistic local update, synchronous
    _cacheGeneration++;
    _cacheIntentSequence++;
    if (!_writesBlocked) _syncError = null;

    // The queued write uses the latest server-confirmed version and prevents
    // same-tab writes from racing one another.
    const writePromise = enqueuePersist(toPersist);

    writePromise.catch((err) => {
      console.error("[SupabaseSync] Cloud save failed:", err);
      // The queue is blocked after every failed or uncertain write. Fetch the
      // authoritative row before exposing a cache as current; retain the
      // error and blocked state if the refresh also fails.
      if (typeof showToast === "function") {
        showToast(
          isSaveConflictCode(err.code)
            ? "A newer league version was found. The latest data was loaded; reload before editing again."
            : "The cloud save could not be confirmed. Reload before editing again.",
          "error"
        );
      }
    });
  }

  /**
   * Resolves once the most recently issued save() write has landed, or
   * rejects with the underlying error if it failed. Does not track
   * saveAndConfirm() calls (those return their own awaitable promise).
   */
  function waitForPendingSave() {
    return _lastSavePromise;
  }

  /**
   * Awaited, NON-optimistic save, matching FirebaseSync.saveAndConfirm():
   * - strips live NBA2K27 pool players (same as save())
   * - the local cache is updated ONLY after Supabase confirms the RPC; on
   *   any failure the cache is left exactly as it was and the error
   *   propagates to the caller (who owns the user-facing message)
   * - resolves with the ORIGINAL `data` argument, not the stripped copy
   */
  async function saveAndConfirm(data) {
    const toPersist = stripForPersist(data);
    const cacheIntent = ++_cacheIntentSequence;
    await enqueuePersist(toPersist);
    if (_cacheIntentSequence === cacheIntent) {
      _cache = toPersist;
      _cacheGeneration++;
    }
    _confirmedCache = toPersist;
    return data;
  }

  /**
   * Registers a remote-change listener. Returns an unsubscribe function.
   * Listeners are called with the freshly re-fetched league data after a
   * Realtime UPDATE from another client (see refreshFromRemote()).
   */
  function onRemoteChange(fn) {
    if (typeof fn !== "function") {
      throw new TypeError("[SupabaseSync] onRemoteChange requires a function.");
    }

    remoteChangeListeners.push(fn);

    return () => {
      const index = remoteChangeListeners.indexOf(fn);
      if (index !== -1) remoteChangeListeners.splice(index, 1);
    };
  }

  /**
   * Replaces the cache with remotely-sourced data and notifies listeners.
   * Called by the Realtime refresh; also exposed as an internal/testing hook.
   */
  function notifyRemoteChange(data, updatedAt = null) {
    _cache = data;
    _confirmedCache = data;
    _cacheGeneration++;
    _remoteGeneration++;
    _syncError = null;
    if (typeof updatedAt === "string" && updatedAt) _updatedAt = updatedAt;

    remoteChangeListeners.slice().forEach((fn) => {
      try {
        fn(_cache);
      } catch (err) {
        console.error("[SupabaseSync] remote-change listener error:", err);
      }
    });
  }

  async function refreshAfterFailure(cause) {
    try {
      const row = await fetchState();
      if (row && row.data && typeof row.data === "object" && typeof row.updated_at === "string") {
        notifyRemoteChange(row.data, row.updated_at);
        _writesBlocked = true;
        _syncError = cause;
        return;
      }
      throw new Error("[SupabaseSync] Refresh returned no valid league state.");
    } catch (refreshError) {
      _writesBlocked = true;
      _syncError = new Error(`[SupabaseSync] Save failed and server refresh failed. Reload before editing again. (${refreshError.message})`);
      if (_confirmedCache !== null) {
        _cache = _confirmedCache;
        _cacheGeneration++;
      }
      console.error("[SupabaseSync] Save failed and cache reconciliation also failed:", refreshError);
    }
  }

  // ── Realtime (invalidation signal only) ─────────────────────────────────

  /** Order-insensitive JSON equality (jsonb reorders keys); undefined-valued keys count as absent. */
  function jsonEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
      return true;
    }
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k) || !jsonEqual(a[k], b[k])) return false;
    }
    return true;
  }

  /**
   * One re-fetch of the FULL league_state/main row (same SELECT as init()),
   * then replace the cache and notify listeners. The result is dropped when:
   * - a local save started/was in flight while fetching (our full-document
   *   write supersedes it, and applying it could roll the optimistic cache
   *   back), or
   * - it equals the current cache (the echo of our own save).
   */
  async function refreshOnce() {
    const epochAtStart = _writeEpoch;
    const row = await fetchState();

    if (!row || row.data === null || typeof row.data !== "object") {
      console.error("[SupabaseSync] Realtime refresh returned no league data; cache kept.");
      return;
    }
    if (_pendingWrites > 0 || _writeEpoch !== epochAtStart) {
      console.log("[SupabaseSync] Realtime refresh deferred: a local save was in progress.");
      _refreshQueued = true;
      return;
    }
    if (_localWriteResult && row.updated_at === _localWriteResult.updatedAt && jsonEqual(row.data, _localWriteResult.data)) {
      _updatedAt = row.updated_at;
      return;
    }
    if (jsonEqual(row.data, _cache)) {
      _confirmedCache = row.data;
      _updatedAt = row.updated_at;
      console.log("[SupabaseSync] Realtime refresh matches local cache; version synchronized.");
      return;
    }

    console.log("[SupabaseSync] Realtime refresh applied; notifying listeners.");
    notifyRemoteChange(row.data, row.updated_at);
  }

  /** Serialized refresh: an event arriving mid-fetch queues exactly one more fetch. */
  async function refreshFromRemote() {
    if (_refreshRunning) {
      _refreshQueued = true;
      return;
    }
    _refreshRunning = true;
    try {
      do {
        _refreshQueued = false;
        try {
          await refreshOnce();
        } catch (err) {
          console.error("[SupabaseSync] Failed to refresh after Realtime event:", err);
        }
      } while (_refreshQueued);
    } finally {
      _refreshRunning = false;
      _refreshWaiters.splice(0).forEach(resolve => resolve());
    }
  }

  function handleRealtimeChange(payload) {
    // payload.new.data is intentionally never used: it may be omitted.
    console.log("[SupabaseSync] Realtime change detected:", payload && payload.eventType);

    if (payload && payload.new && payload.new.id !== undefined && payload.new.id !== STATE_ID) {
      console.log("[SupabaseSync] Ignored realtime row:", payload.new.id);
      return;
    }
    if (_pendingWrites > 0) {
      console.log("[SupabaseSync] Realtime event deferred until local writes settle.");
      _refreshQueued = true;
      return;
    }
    refreshFromRemote();
  }

  function handleRealtimeStatus(status, err) {
    console.log("[SupabaseSync] Realtime status:", status, err || "");

    if (status === "SUBSCRIBED") {
      // After any gap (error/timeout/close) events may have been missed.
      if (_realtimeNeedsCatchUp) {
        _realtimeNeedsCatchUp = false;
        refreshFromRemote();
      }
    } else {
      _realtimeNeedsCatchUp = true;
    }
  }

  /**
   * Subscribes once to UPDATEs of public.league_state where id = "main".
   * Never throws and never affects init()/ready; failures are only logged.
   * supabase-js handles reconnects on its own; handleRealtimeStatus() adds a
   * catch-up read after one.
   */
  function startRealtime() {
    if (_realtimeChannel) return; // already subscribed — no duplicates

    try {
      _realtimeChannel = getClient()
        .channel(REALTIME_CHANNEL)
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: STATE_TABLE,
            filter: `id=eq.${STATE_ID}`,
          },
          handleRealtimeChange
        )
        .subscribe(handleRealtimeStatus);
    } catch (err) {
      _realtimeChannel = null;
      console.error("[SupabaseSync] Realtime subscription failed (non-fatal):", err);
    }
  }

  // Read-only snapshot of internal state. Only reachable through the DEV factory.
  function getDiagnostics() {
    return {
      updatedAt: _updatedAt,
      initialized: _initStarted && _cache !== null,
      writesBlocked: _writesBlocked,
      pendingWrites: _pendingWrites,
      cacheGeneration: _cacheGeneration,
      remoteGeneration: _remoteGeneration,
      syncError: _syncError?.message || null,
    };
  }

  function getSaveDiagnostics() {
    return diagnosticsEnabled ? diagnosticBuffer.slice() : undefined;
  }

  return {
    api: {
      ready,
      init,
      getCache,
      save,
      saveAndConfirm,
      waitForPendingSave,
      onRemoteChange,

      // Internal/testing hook.
      notifyRemoteChange,
      getSyncError: () => _syncError,
    },
    getDiagnostics,
    getSaveDiagnostics,
  };
}

function createSupabaseSync(clientProvider) {
  return createSupabaseSyncCore(clientProvider).api;
}

// Expose injection only in local DEV builds. A page flag alone is insufficient:
// production hosts cannot enable the factory by setting a mutable global.
const instance = createSupabaseSync();
const devHost = typeof window !== "undefined" &&
  window.location && ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
if (devHost && window.DRAFTP_DEV_ADMIN === true) {
  // Same API as createSupabaseSync plus read-only getDiagnostics().
  window.createDraftPSupabaseSync = function (clientProvider) {
    const { api, getDiagnostics, getSaveDiagnostics } = createSupabaseSyncCore(
      clientProvider,
      window.DRAFTP_DEV_DIAGNOSTICS,
    );
    return { ...api, getDiagnostics, getSaveDiagnostics };
  };
}
return instance;
})();
