import { describe, expect, test } from 'vitest';

import {
  hasRuleGatedEntries,
  normalizeSkillName,
  normalizeSkillNames,
  resolveRuleGatedNames,
  resolveSkillTools,
  validateSkillTools,
} from '../skill-tools.js';

describe('resolveSkillTools', () => {
  test('returns an empty list when tools are undefined', () => {
    expect(resolveSkillTools(undefined, { flow: 'patient-generic' })).toEqual([]);
  });

  test('returns plain string lists unconditionally', () => {
    expect(resolveSkillTools(['a', 'b'], { flow: 'patient-generic' })).toEqual(['a', 'b']);
  });

  test('includes unconditional entries and include-rule matches', () => {
    const tools = [
      'request_location',
      { name: 'suggest_providers_for_service', include: 'flow == "patient-generic"' },
      { name: 'create_support_ticket', include: 'flow == "support-agent"' },
    ];

    expect(resolveSkillTools(tools, { flow: 'patient-generic' })).toEqual([
      'request_location',
      'suggest_providers_for_service',
    ]);
    expect(resolveSkillTools(tools, { flow: 'support-agent' })).toEqual([
      'request_location',
      'create_support_ticket',
    ]);
  });

  test('an exclude rule drops the tool only when it fires', () => {
    const tools = ['request_location', { name: 'alert', exclude: 'flow == "customer-support"' }];

    expect(resolveSkillTools(tools, { flow: 'customer-support' })).toEqual(['request_location']);
    expect(resolveSkillTools(tools, { flow: 'patient-generic' })).toEqual([
      'request_location',
      'alert',
    ]);
  });

  test('exclusion wins over inclusion from another entry', () => {
    const tools = ['alert', { name: 'alert', exclude: 'flow == "customer-support"' }];

    expect(resolveSkillTools(tools, { flow: 'customer-support' })).toEqual([]);
    expect(resolveSkillTools(tools, { flow: 'patient-generic' })).toEqual(['alert']);
  });

  test('an entry can carry both include and exclude rules', () => {
    const tools = [
      {
        name: 'suggest_subscription',
        include: 'flow == "patient-generic"',
        exclude: 'options.subscribed == 1',
      },
    ];

    expect(resolveSkillTools(tools, { flow: 'patient-generic', options: {} })).toEqual([
      'suggest_subscription',
    ]);
    expect(
      resolveSkillTools(tools, { flow: 'patient-generic', options: { subscribed: 1 } }),
    ).toEqual([]);
    expect(resolveSkillTools(tools, { flow: 'support-agent', options: {} })).toEqual([]);
  });

  test('rules can reach nested context values', () => {
    const tools = [
      { name: 'suggest_subscription', include: 'options.patient_id and flow != "voice"' },
    ];
    expect(
      resolveSkillTools(tools, { flow: 'patient-generic', options: { patient_id: 'pt_1' } }),
    ).toEqual(['suggest_subscription']);
    expect(resolveSkillTools(tools, { flow: 'patient-generic', options: {} })).toEqual([]);
  });

  test('deduplicates repeated entries', () => {
    expect(resolveSkillTools(['a', 'a', { name: 'a' }], { flow: 'patient-generic' })).toEqual([
      'a',
    ]);
  });
});

describe('resolveRuleGatedNames / hasRuleGatedEntries', () => {
  test('resolves prompt skill bindings with the same semantics as tools', () => {
    const entries = [
      'patient_handle_symptoms',
      { name: 'patient_handle_glp1', include: 'flow == "patient-generic"' },
      { name: 'patient_handle_labs', exclude: 'options.labs_disabled == 1' },
    ];

    expect(resolveRuleGatedNames(entries, { flow: 'patient-generic', options: {} })).toEqual([
      'patient_handle_symptoms',
      'patient_handle_glp1',
      'patient_handle_labs',
    ]);
    expect(
      resolveRuleGatedNames(entries, { flow: 'support-agent', options: { labs_disabled: 1 } }),
    ).toEqual(['patient_handle_symptoms']);
  });

  test('hasRuleGatedEntries detects rules', () => {
    expect(hasRuleGatedEntries(undefined)).toBe(false);
    expect(hasRuleGatedEntries(['a', { name: 'b' }])).toBe(false);
    expect(hasRuleGatedEntries(['a', { name: 'b', include: 'flow == "x"' }])).toBe(true);
    expect(hasRuleGatedEntries([{ name: 'b', exclude: 'flow == "x"' }])).toBe(true);
  });
});

describe('validateSkillTools', () => {
  test('accepts undefined, plain string lists, and rule entries', () => {
    expect(validateSkillTools(undefined)).toBeUndefined();
    expect(validateSkillTools(['a'])).toBeUndefined();
    expect(
      validateSkillTools([
        'a',
        { name: 'b', include: 'flow == "x"' },
        { name: 'c', exclude: 'flow == "y"' },
        { name: 'd', include: 'flow == "x"', exclude: 'options.hidden == 1' },
      ]),
    ).toBeUndefined();
  });

  test('rejects malformed shapes', () => {
    expect(validateSkillTools([1])).toMatch(/entries must be strings/);
    expect(validateSkillTools('nope')).toMatch(/must be an array/);
    expect(validateSkillTools({ include: ['a'] })).toMatch(/must be an array/);
    expect(validateSkillTools([{ name: 'a', when: 'x == 1' }])).toMatch(/unknown keys/);
    expect(validateSkillTools([{ include: 'x == 1' }])).toMatch(/missing a name/);
    expect(validateSkillTools([{ name: 'a', include: 5 }])).toMatch(/non-string include/);
  });

  test('rejects rules that fail to compile', () => {
    expect(validateSkillTools([{ name: 'a', include: 'flow ==' }])).toMatch(/invalid include rule/);
    expect(validateSkillTools([{ name: 'a', exclude: 'and and' }])).toMatch(/invalid exclude rule/);
  });
});

describe('normalizeSkillName', () => {
  test('normalizes path and langfuse prompt forms to store names', () => {
    expect(normalizeSkillName('patient/handle_refill')).toBe('patient_handle_refill');
    expect(normalizeSkillName('skill/patient/handle_refill')).toBe('patient_handle_refill');
    expect(normalizeSkillName('skill:patient/handle_refill')).toBe('patient_handle_refill');
    expect(normalizeSkillName('patient_handle_refill')).toBe('patient_handle_refill');
    // Matches getSkillNameFromFile's sanitization: \W+ collapses to one _.
    expect(normalizeSkillName('support-agent/tickets')).toBe('support_agent_tickets');
    expect(normalizeSkillName('skill/support-agent/tickets')).toBe('support_agent_tickets');
  });

  test('normalizeSkillNames filters non-strings and returns undefined for non-arrays', () => {
    expect(normalizeSkillNames(['patient/a', 7, ''])).toEqual(['patient_a']);
    expect(normalizeSkillNames(undefined)).toBeUndefined();
    expect(normalizeSkillNames('patient/a')).toBeUndefined();
  });
});
