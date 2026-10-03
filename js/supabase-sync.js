/**
 * supabase-sync.js
 *
 * Supabase-backed, drop-in replacement for the FirebaseSync abstraction
 * defined in data.js.
 *
 * STATUS (Phase 7.3: Realtime added):
 * - Additive and isolated. NOT wired into data.js yet.
 * - FirebaseSync remains the active application storage layer.
 * - Supabase Realtime is used ONLY as an invalidation signal: the
 *   league_state.data payload is ~1 MB and may be omitted from the event, so
 *   on an UPDATE of the "main" row we re-fetch the full row with the same
 *   SELECT used by init() and then notify onRemoteChange() listeners.
 *
 * Storage contract:
 *   public.league_state, id = "main"
 *   Reads  -> normal SELECT of the single "main" row.
 *   Writes -> protected save_league_state(jsonb) RPC, which receives the
 *             FULL league JSON document as p_data.
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

const SupabaseSync = (() => {
  const STATE_TABLE = "league_state";
  const STATE_ID = "main";
  const SAVE_RPC = "save_league_state";

  let _cache = null; // latest known full data blob (or null before init succeeds)
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

  function getClient() {
    if (typeof SupabaseClient === "undefined" || !SupabaseClient) {
      throw new Error(
        "[SupabaseSync] SupabaseClient is not initialized. " +
        "Check script load order (js/supabase-config.js must load first)."
      );
    }
    return SupabaseClient;
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

  /** Writes the full document through the save_league_state RPC. */
  async function persist(toPersist) {
    const { data: result, error } = await getClient().rpc(SAVE_RPC, {
      p_data: toPersist,
    });

    if (error) {
      throw new Error(
        `[SupabaseSync] Cloud save failed: ${error.message}`
      );
    }

    return result;
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
        _cache = row.data;
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

    // persist() is async, so even a synchronous failure inside it (e.g. the
    // client missing) becomes a rejection handled below rather than a throw.
    _pendingWrites++;
    _writeEpoch++;
    const writePromise = persist(toPersist);
    const writeSettled = () => { _pendingWrites--; };
    writePromise.then(writeSettled, writeSettled);

    writePromise.catch((err) => {
      console.error("[SupabaseSync] Cloud save failed:", err);
      if (typeof showToast === "function") {
        showToast(
          "Saved locally, but the cloud sync failed — check your connection.",
          "error"
        );
      }
    });

    _lastSavePromise = writePromise;
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
    _pendingWrites++;
    _writeEpoch++;
    try {
      await persist(toPersist);
    } finally {
      _pendingWrites--;
    }
    _cache = toPersist;
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
  function notifyRemoteChange(data) {
    _cache = data;

    remoteChangeListeners.slice().forEach((fn) => {
      try {
        fn(_cache);
      } catch (err) {
        console.error("[SupabaseSync] remote-change listener error:", err);
      }
    });
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
      console.log("[SupabaseSync] Realtime refresh discarded: a local save was in progress.");
      return;
    }
    if (jsonEqual(row.data, _cache)) {
      console.log("[SupabaseSync] Realtime refresh matches local cache (own save echo); no notification.");
      return;
    }

    console.log("[SupabaseSync] Realtime refresh applied; notifying listeners.");
    notifyRemoteChange(row.data);
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
      console.log("[SupabaseSync] Realtime event ignored: local save in progress (own echo).");
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

  return {
    ready,
    init,
    getCache,
    save,
    saveAndConfirm,
    waitForPendingSave,
    onRemoteChange,

    // Internal/testing hook.
    notifyRemoteChange,
  };
})();
