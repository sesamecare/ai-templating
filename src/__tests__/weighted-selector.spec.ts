import { describe, expect, test } from 'vitest';

import type { WeightedItem } from '../weighted-selector.js';
import {
  fnv1a32,
  normalize,
  parseWeights,
  seededUnitFloat,
  weightedPick,
} from '../weighted-selector.js';

describe('fnv1a32', () => {
  test('is deterministic', () => {
    expect(fnv1a32('hello')).toBe(fnv1a32('hello'));
    expect(fnv1a32('abc')).toBe(fnv1a32('abc'));
  });

  test('produces different values for different strings', () => {
    expect(fnv1a32('abc')).not.toBe(fnv1a32('abcd'));
  });
});

describe('seededUnitFloat', () => {
  test('returns a number in [0,1)', () => {
    const value = seededUnitFloat('some-seed');
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  });

  test('is deterministic per seed', () => {
    const a = seededUnitFloat('foo');
    const b = seededUnitFloat('foo');
    const c = seededUnitFloat('bar');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('parseWeights', () => {
  test('parses explicit weights', () => {
    expect(parseWeights('A:10,B:20')).toEqual([
      { key: 'A', weight: 10 },
      { key: 'B', weight: 20 },
    ]);
  });

  test('parses implicit equal weights', () => {
    const output = parseWeights('A,B,C');
    const weight = 100 / 3;
    expect(output).toEqual([
      { key: 'A', weight },
      { key: 'B', weight },
      { key: 'C', weight },
    ]);
  });

  test('parses mixed explicit + implicit', () => {
    expect(parseWeights('A:25,B,C')).toEqual([
      { key: 'A', weight: 25 },
      { key: 'B', weight: 12.5 },
      { key: 'C', weight: 12.5 },
    ]);
  });

  test('treats invalid weights as implicit', () => {
    const weight = 10 / 3;
    expect(parseWeights('A:10,B:foo,C:-3,D')).toEqual([
      { key: 'A', weight: 10 },
      { key: 'B', weight },
      { key: 'C', weight },
      { key: 'D', weight },
    ]);
  });
});

describe('weightedPick', () => {
  test('throws when total weight is 0', () => {
    expect(() => weightedPick('A:0,B:0', 'seed')).toThrow();
  });

  test('is deterministic for a given seed', () => {
    const first = weightedPick('A:10,B:20,C:30', 'abc');
    for (let index = 0; index < 100; index++) {
      expect(weightedPick('A:10,B:20,C:30', 'abc')).toBe(first);
    }
  });

  test('seed influences the choice across many seeds', () => {
    const expression = 'A:10,B:20,C:30';
    const seen = new Set<string>();

    for (let index = 0; index < 500; index++) {
      seen.add(weightedPick(expression, `seed-${index}`));
    }

    expect(seen.size).toBeGreaterThan(1);
    for (const key of seen) {
      expect(['A', 'B', 'C']).toContain(key);
    }
  });

  test('respects weight boundaries', () => {
    const seed = 'zzz';
    const random = seededUnitFloat(seed) * 100;
    const items = [
      { key: 'A', weight: 50 },
      { key: 'B', weight: 30 },
      { key: 'C', weight: 20 },
    ] satisfies WeightedItem[];

    const pick = weightedPick(items, seed);

    if (random < 50) {
      expect(pick).toBe('A');
    } else if (random < 80) {
      expect(pick).toBe('B');
    } else {
      expect(pick).toBe('C');
    }
  });

  test('falls back to the last item if accumulator never surpassed', () => {
    expect(
      weightedPick(
        [
          { key: 'A', weight: 1 },
          { key: 'B', weight: 1 },
        ],
        'test-seed-10',
      ),
    ).toBe('B');
  });

  test('works with implicit-only expressions', () => {
    const result = weightedPick('A,B,C', 'abc');
    expect(['A', 'B', 'C']).toContain(result);
  });

  test('works with weighted item arrays', () => {
    const items: WeightedItem[] = [
      { key: 'A', weight: 1 },
      { key: 'B', weight: 3 },
    ];
    expect(['A', 'B']).toContain(weightedPick(items, '1234'));
  });
});

describe('normalize', () => {
  test('preserves item order when filling missing weights', () => {
    expect(normalize([{ key: 'A', weight: 4 }, { key: 'B' }, { key: 'C', weight: 2 }])).toEqual([
      { key: 'A', weight: 4 },
      { key: 'B', weight: 6 },
      { key: 'C', weight: 2 },
    ]);
  });

  test('assigns equal fallback weights when every item is unweighted', () => {
    expect(
      normalize<{ key: string; weight?: number }>([{ key: 'A' }, { key: 'B' }, { key: 'C' }]),
    ).toEqual([
      { key: 'A', weight: 1 },
      { key: 'B', weight: 1 },
      { key: 'C', weight: 1 },
    ]);
  });

  test('recovers from all-zero weighted inputs', () => {
    expect(
      normalize<{ key: string; weight?: number }>([
        { key: 'A', weight: 0 },
        { key: 'B', weight: 0 },
      ]),
    ).toEqual([
      { key: 'A', weight: 1 },
      { key: 'B', weight: 1 },
    ]);
  });
});
