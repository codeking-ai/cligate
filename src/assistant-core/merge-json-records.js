export function mergeJsonRecords({
  currentRecords = [],
  diskRecords = [],
  keyOf
} = {}) {
  const getKey = typeof keyOf === 'function' ? keyOf : ((entry) => entry?.id);
  const merged = new Map();

  for (const entry of Array.isArray(diskRecords) ? diskRecords : []) {
    const key = getKey(entry);
    if (!key) continue;
    merged.set(String(key), entry);
  }

  for (const entry of Array.isArray(currentRecords) ? currentRecords : []) {
    const key = getKey(entry);
    if (!key) continue;
    merged.set(String(key), entry);
  }

  return [...merged.values()];
}

export default {
  mergeJsonRecords
};
