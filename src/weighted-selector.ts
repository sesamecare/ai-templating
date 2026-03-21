/**
 * A fast non-cryptographic hash function.
 * https://en.wikipedia.org/wiki/Fowler-Noll-Vo_hash_function
 */
export function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function seededUnitFloat(seed: string): number {
  return fnv1a32(seed) / 0xffffffff;
}

export interface WeightedItem {
  key: string;
  weight: number;
}

export function parseWeights(expr: string): WeightedItem[] {
  const parts = expr
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  const explicit: WeightedItem[] = [];
  const implicit: string[] = [];

  for (const part of parts) {
    const [key, rawWeight] = part.split(':');
    if (rawWeight === undefined) {
      implicit.push(key.trim());
      continue;
    }

    const weight = Number(rawWeight);
    if (!key || Number.isNaN(weight) || weight < 0) {
      implicit.push(key.trim());
      continue;
    }

    explicit.push({ key: key.trim(), weight });
  }

  if (implicit.length > 0) {
    const explicitTotal = explicit.reduce((sum, item) => sum + item.weight, 0);
    const remaining = explicit.length > 0 ? explicitTotal : 100;
    const implicitWeight = remaining / implicit.length;

    for (const key of implicit) {
      explicit.push({ key, weight: implicitWeight });
    }
  }

  return explicit;
}

export function weightedPick(expressionOrItems: string | WeightedItem[], seed: string): string {
  const items =
    typeof expressionOrItems === 'string' ? parseWeights(expressionOrItems) : expressionOrItems;
  const total = items.reduce((sum, item) => sum + item.weight, 0);

  if (total <= 0) {
    throw new Error('Total weight must be > 0');
  }

  const random = seededUnitFloat(seed) * total;
  let accumulator = 0;

  for (const { key, weight } of items) {
    accumulator += weight;
    if (random < accumulator) {
      return key;
    }
  }

  return (items.at(-1) as WeightedItem).key;
}

export function normalize<T extends { weight?: number }>(items: T[]): (T & { weight: number })[] {
  const unweightedCount = items.filter((item) => item.weight === undefined).length;
  const total = items.reduce((sum, item) => sum + (item.weight ?? 0), 0);

  if (unweightedCount === 0) {
    if (total > 0) {
      return items as (T & { weight: number })[];
    }

    return items.map((item) => ({ ...item, weight: 1 }));
  }

  const defaultWeight = total > 0 ? total / unweightedCount : 1;
  return items.map((item) => ({
    ...item,
    weight: item.weight === undefined ? defaultWeight : item.weight,
  }));
}
