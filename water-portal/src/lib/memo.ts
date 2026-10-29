/**
 * `cache`'s entry for `key`, made by `make` if there's none yet. One that fails is
 * forgotten, so it's tried again the next time it's asked for (a network error isn't
 * taken for a missing file for the rest of the session).
 */
export function memoized<K, V>(cache: Map<K, Promise<V>>, key: K, make: () => Promise<V>): Promise<V> {
  let value = cache.get(key);
  if (!value) {
    const made = (value = make());
    cache.set(key, made);
    made.catch(() => cache.get(key) === made && cache.delete(key));
  }
  return value;
}

/** Only the last `max` entries of a map are kept: the oldest go (in the order they were added). */
export function keepLast<K, V>(map: Map<K, V>, max: number) {
  for (const key of map.keys()) {
    if (map.size <= max) break;
    map.delete(key);
  }
}
