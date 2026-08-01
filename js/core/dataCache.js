// ════════════════════════════════════════════
//  DATA CACHE
//  A short-lived, key-addressed cache in front of the full-table loads that
//  several modules share. Bank Entry, Party Ledger and Final Account all read
//  the same ledger tables: opening those three tabs in a row used to download
//  bank_transactions in full three times, because each module's init refetched
//  unconditionally (tabs.js calls MODULE_INITS[tab]() on every open).
//
//  Two deliberate choices:
//
//  - It caches the PROMISE, not the resolved rows. Two modules opening in
//    quick succession then share one round-trip instead of racing two.
//  - A rejected load is evicted immediately, so a network blip can't be
//    served from cache for the rest of the TTL.
//
//  The TTL is the safety net, not the mechanism: local writes must call
//  invalidate() so a save is visible instantly. The TTL only bounds how long
//  ANOTHER staff member's write can stay invisible on this screen.
// ════════════════════════════════════════════
window.DataCache = (function () {
  const store = new Map();          // key -> { at, promise }
  const TTL_MS = 60 * 1000;

  // loader must return a Promise (typically an sbFetchAll call — the row-cap
  // rule in CLAUDE.md §6 still applies, this only decides whether it runs).
  function get(key, loader) {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;

    const promise = loader();
    store.set(key, { at: Date.now(), promise });
    promise.catch(() => {
      // Only evict if this is still the entry we put in — a later successful
      // load for the same key must not be thrown away by an older failure.
      if (store.get(key) && store.get(key).promise === promise) store.delete(key);
    });
    return promise;
  }

  function invalidate(...keys) { keys.forEach(k => store.delete(k)); }
  function invalidateAll() { store.clear(); }

  return { get, invalidate, invalidateAll };
})();
