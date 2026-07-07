import { describe, expect, test } from 'vitest';

import {
  normalizeSkillName,
  normalizeSkillNames,
  resolveSkillTools,
  validateSkillTools,
} from '../skill-tools.js';

describe('resolveSkillTools', () => {
  test('returns an empty list when tools are undefined', () => {
    expect(resolveSkillTools(undefined, { flow: 'patient-generic' })).toEqual([]);
  });

  test('returns plain arrays unconditionally', () => {
    expect(resolveSkillTools(['a', 'b'], { flow: 'patient-generic' })).toEqual(['a', 'b']);
  });

  test('includes unconditional entries and rule matches', () => {
    const tools = {
      include: [
        'request_location',
        { name: 'suggest_providers_for_service', when: 'flow == "patient-generic"' },
        { name: 'create_support_ticket', when: 'flow == "support-agent"' },
      ],
    };

    expect(resolveSkillTools(tools, { flow: 'patient-generic' })).toEqual([
      'request_location',
      'suggest_providers_for_service',
    ]);
    expect(resolveSkillTools(tools, { flow: 'support-agent' })).toEqual([
      'request_location',
      'create_support_ticket',
    ]);
  });

  test('exclusion wins over inclusion', () => {
    const tools = {
      include: ['alert', 'request_location'],
      exclude: [{ name: 'alert', when: 'flow == "customer-support"' }],
    };

    expect(resolveSkillTools(tools, { flow: 'customer-support' })).toEqual(['request_location']);
    expect(resolveSkillTools(tools, { flow: 'patient-generic' })).toEqual([
      'alert',
      'request_location',
    ]);
  });

  test('unconditional exclude always removes the tool', () => {
    const tools = {
      include: ['alert'],
      exclude: ['alert'],
    };
    expect(resolveSkillTools(tools, {})).toEqual([]);
  });

  test('rules can reach nested context values', () => {
    const tools = {
      include: [{ name: 'suggest_subscription', when: 'options.patient_id and flow != "voice"' }],
    };
    expect(
      resolveSkillTools(tools, { flow: 'patient-generic', options: { patient_id: 'pt_1' } }),
    ).toEqual(['suggest_subscription']);
    expect(resolveSkillTools(tools, { flow: 'patient-generic', options: {} })).toEqual([]);
  });

  test('deduplicates repeated include entries', () => {
    expect(resolveSkillTools({ include: ['a', 'a', { name: 'a' }] }, {})).toEqual(['a']);
  });
});

describe('validateSkillTools', () => {
  test('accepts undefined, plain arrays, and rule objects', () => {
    expect(validateSkillTools(undefined)).toBeUndefined();
    expect(validateSkillTools(['a'])).toBeUndefined();
    expect(
      validateSkillTools({
        include: ['a', { name: 'b', when: 'flow == "x"' }],
        exclude: [{ name: 'c' }],
      }),
    ).toBeUndefined();
  });

  test('rejects malformed shapes', () => {
    expect(validateSkillTools([1])).toMatch(/must be strings/);
    expect(validateSkillTools('nope')).toMatch(/must be an array/);
    expect(validateSkillTools({ includes: [] })).toMatch(/unknown keys/);
    expect(validateSkillTools({ include: 'a' })).toMatch(/must be an array/);
    expect(validateSkillTools({ include: [{ when: 'x == 1' }] })).toMatch(/missing a name/);
    expect(validateSkillTools({ include: [{ name: 'a', when: 5 }] })).toMatch(/non-string when/);
  });

  test('rejects rules that fail to compile', () => {
    expect(validateSkillTools({ include: [{ name: 'a', when: 'flow ==' }] })).toMatch(
      /invalid when rule/,
    );
  });
});

describe('normalizeSkillName', () => {
  test('normalizes path and langfuse prompt forms to store names', () => {
    expect(normalizeSkillName('patient/handle_refill')).toBe('patient_handle_refill');
    expect(normalizeSkillName('skill/patient/handle_refill')).toBe('patient_handle_refill');
    expect(normalizeSkillName('skill:patient/handle_refill')).toBe('patient_handle_refill');
    expect(normalizeSkillName('patient_handle_refill')).toBe('patient_handle_refill');
  });

  test('normalizeSkillNames filters non-strings and returns undefined for non-arrays', () => {
    expect(normalizeSkillNames(['patient/a', 7, ''])).toEqual(['patient_a']);
    expect(normalizeSkillNames(undefined)).toBeUndefined();
    expect(normalizeSkillNames('patient/a')).toBeUndefined();
  });
});
