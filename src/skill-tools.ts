import { toFunction } from '@sesamecare-oss/rule-evaluator';

import type { RuleContext, RuleGatedEntry, RuleGatedName, SkillSpec, SkillTools } from './types.js';

type CompiledRule = ReturnType<typeof toFunction>;

// Rule expressions are shared across skills and re-evaluated on every turn,
// so cache the compiled functions by source expression.
const compiledRules = new Map<string, CompiledRule>();

function compileRule(expression: string): CompiledRule {
  let compiled = compiledRules.get(expression);
  if (!compiled) {
    compiled = toFunction(expression);
    compiledRules.set(expression, compiled);
  }
  return compiled;
}

function normalizeEntry(entry: RuleGatedName): RuleGatedEntry {
  return typeof entry === 'string' ? { name: entry } : entry;
}

function evaluateRule(expression: string, context: RuleContext): boolean {
  return Boolean(compileRule(expression)(context));
}

/** True when any entry in the list carries an include/exclude rule. */
export function hasRuleGatedEntries(entries: readonly RuleGatedName[] | undefined): boolean {
  return Boolean(
    entries?.some((entry) => typeof entry !== 'string' && (entry.include || entry.exclude)),
  );
}

/**
 * Resolve a list of rule-gated name entries against a context.
 *
 * Each entry is included when it has no `include` rule or its `include` rule
 * evaluates truthy. Any entry whose `exclude` rule evaluates truthy then
 * removes that name from the result, even if another entry included it —
 * exclusion wins. Rules are @sesamecare-oss/rule-evaluator expressions
 * evaluated against `context`, which always carries the top-level `flow`.
 *
 * Used for both skill→tool bindings and prompt→skill bindings.
 */
export function resolveRuleGatedNames(
  entries: readonly RuleGatedName[] | undefined,
  context: RuleContext,
): string[] {
  if (!entries) {
    return [];
  }

  const normalized = entries.map(normalizeEntry);

  const included: string[] = [];
  for (const entry of normalized) {
    if (included.includes(entry.name)) {
      continue;
    }
    if (!entry.include || evaluateRule(entry.include, context)) {
      included.push(entry.name);
    }
  }

  const excluded = new Set(
    normalized
      .filter((entry) => entry.exclude && evaluateRule(entry.exclude, context))
      .map((entry) => entry.name),
  );

  return included.filter((name) => !excluded.has(name));
}

/**
 * Resolve a skill's tool binding against the rendering context. See
 * {@link resolveRuleGatedNames} for the semantics.
 */
export function resolveSkillTools(tools: SkillTools | undefined, context: RuleContext): string[] {
  return resolveRuleGatedNames(tools, context);
}

/**
 * Convenience wrapper over {@link resolveSkillTools} for a full spec.
 */
export function resolveSkillToolsForSpec(
  spec: Pick<SkillSpec, 'tools'>,
  context: RuleContext,
): string[] {
  return resolveSkillTools(spec.tools, context);
}

/**
 * Validate a list of rule-gated name entries: checks the structural shape
 * and eagerly compiles every `include`/`exclude` expression so malformed
 * rules fail at load time rather than mid-conversation. Returns an error
 * message, or undefined when valid.
 */
export function validateRuleGatedNames(entries: unknown, label = 'entries'): string | undefined {
  if (entries === undefined) {
    return undefined;
  }

  if (!Array.isArray(entries)) {
    return `${label} must be an array of names or { name, include?, exclude? } entries`;
  }

  for (const entry of entries) {
    if (typeof entry === 'string') {
      continue;
    }
    if (typeof entry !== 'object' || entry === null) {
      return `${label} entries must be strings or { name, include?, exclude? } objects`;
    }

    const record = entry as Record<string, unknown>;
    const unknownKeys = Object.keys(record).filter(
      (key) => key !== 'name' && key !== 'include' && key !== 'exclude',
    );
    if (unknownKeys.length > 0) {
      return `${label} entry has unknown keys: ${unknownKeys.join(', ')}`;
    }

    const { name } = record;
    if (typeof name !== 'string' || !name) {
      return `${label} entry is missing a name`;
    }

    for (const key of ['include', 'exclude'] as const) {
      const rule = record[key];
      if (rule === undefined) {
        continue;
      }
      if (typeof rule !== 'string') {
        return `${label} entry '${name}' has a non-string ${key} rule`;
      }
      try {
        compileRule(rule);
      } catch (error) {
        return `${label} entry '${name}' has an invalid ${key} rule: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
  }

  return undefined;
}

/** Validate a skill's tool binding. See {@link validateRuleGatedNames}. */
export function validateSkillTools(tools: unknown): string | undefined {
  return validateRuleGatedNames(tools, 'tools');
}

/**
 * Normalize a skill name to skill-store form: strips a `skill:`/`skill/`
 * prefix and sanitizes the rest the same way as `getSkillNameFromFile`
 * (`\W+` collapses to a single underscore), so prompt configs can reference
 * skills by their file path (`patient/handle_refill`,
 * `support-agent/tickets`) or their store name (`patient_handle_refill`,
 * `support_agent_tickets`) interchangeably.
 */
export function normalizeSkillName(name: string): string {
  return name.replace(/^skill[:/]/, '').replace(/\W+/g, '_');
}

/**
 * Normalize a prompt's skills binding: keeps plain-name and rule-gated
 * entries, normalizing each name to skill-store form. Returns undefined for
 * non-arrays (no binding declared).
 */
export function normalizeSkillNames(entries: unknown): RuleGatedName[] | undefined {
  if (!Array.isArray(entries)) {
    return undefined;
  }

  const normalized: RuleGatedName[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string' && entry.length > 0) {
      normalized.push(normalizeSkillName(entry));
    } else if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { name?: unknown }).name === 'string' &&
      (entry as { name: string }).name.length > 0
    ) {
      const gated = entry as RuleGatedEntry;
      normalized.push({ ...gated, name: normalizeSkillName(gated.name) });
    }
  }
  return normalized;
}
