import { toFunction } from '@sesamecare-oss/rule-evaluator';

import type { SkillSpec, SkillToolRule, SkillToolRuleEntry, SkillTools } from './types.js';

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

function normalizeEntry(entry: SkillToolRuleEntry): SkillToolRule {
  return typeof entry === 'string' ? { name: entry } : entry;
}

function ruleApplies(entry: SkillToolRule, context: Record<string, unknown>): boolean {
  if (!entry.when) {
    return true;
  }
  return Boolean(compileRule(entry.when)(context));
}

/**
 * Resolve a skill's tool binding against a rendering context.
 *
 * A plain string array is returned as-is (unconditional binding). For the
 * rule form, `include` entries whose `when` rule passes (or that have no
 * rule) are selected, then matching `exclude` entries are removed —
 * exclusion always wins. Rules are @sesamecare-oss/rule-evaluator
 * expressions evaluated against `context`, which should be the same context
 * used to render the skill detail (and always carries the top-level `flow`).
 */
export function resolveSkillTools(
  tools: SkillTools | undefined,
  context: Record<string, unknown>,
): string[] {
  if (!tools) {
    return [];
  }
  if (Array.isArray(tools)) {
    return [...tools];
  }

  const included: string[] = [];
  for (const entry of (tools.include ?? []).map(normalizeEntry)) {
    if (!included.includes(entry.name) && ruleApplies(entry, context)) {
      included.push(entry.name);
    }
  }

  const excluded = new Set(
    (tools.exclude ?? [])
      .map(normalizeEntry)
      .filter((entry) => ruleApplies(entry, context))
      .map((entry) => entry.name),
  );

  return included.filter((name) => !excluded.has(name));
}

/**
 * Convenience wrapper over {@link resolveSkillTools} for a full spec.
 */
export function resolveSkillToolsForSpec(
  spec: Pick<SkillSpec, 'tools'>,
  context: Record<string, unknown>,
): string[] {
  return resolveSkillTools(spec.tools, context);
}

/**
 * Validate a tools binding: checks the structural shape and eagerly compiles
 * every `when` expression so malformed rules fail at load time rather than
 * mid-conversation. Returns an error message, or undefined when valid.
 */
export function validateSkillTools(tools: unknown): string | undefined {
  if (tools === undefined) {
    return undefined;
  }

  if (Array.isArray(tools)) {
    return tools.every((tool) => typeof tool === 'string')
      ? undefined
      : 'tools array entries must be strings';
  }

  if (typeof tools !== 'object' || tools === null) {
    return 'tools must be an array or an include/exclude object';
  }

  const record = tools as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => key !== 'include' && key !== 'exclude');
  if (unknownKeys.length > 0) {
    return `tools has unknown keys: ${unknownKeys.join(', ')}`;
  }

  for (const key of ['include', 'exclude'] as const) {
    const entries = record[key];
    if (entries === undefined) {
      continue;
    }
    if (!Array.isArray(entries)) {
      return `tools.${key} must be an array`;
    }
    for (const entry of entries) {
      if (typeof entry === 'string') {
        continue;
      }
      if (typeof entry !== 'object' || entry === null) {
        return `tools.${key} entries must be strings or { name, when } objects`;
      }
      const { name, when } = entry as Record<string, unknown>;
      if (typeof name !== 'string' || !name) {
        return `tools.${key} entry is missing a name`;
      }
      if (when !== undefined) {
        if (typeof when !== 'string') {
          return `tools.${key} entry '${name}' has a non-string when rule`;
        }
        try {
          compileRule(when);
        } catch (error) {
          return `tools.${key} entry '${name}' has an invalid when rule: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }
    }
  }

  return undefined;
}

/**
 * Normalize a skill name to skill-store form: strips a `skill:`/`skill/`
 * prefix and converts path separators to underscores, so prompt configs can
 * reference skills by their file path (`patient/handle_refill`) or their
 * store name (`patient_handle_refill`) interchangeably.
 */
export function normalizeSkillName(name: string): string {
  return name.replace(/^skill[:/]/, '').replace(/\//g, '_');
}

export function normalizeSkillNames(names: unknown): string[] | undefined {
  if (!Array.isArray(names)) {
    return undefined;
  }
  const normalized = names
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
    .map(normalizeSkillName);
  return normalized;
}
