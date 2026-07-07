import { toFunction } from '@sesamecare-oss/rule-evaluator';

import type { SkillSpec, SkillToolEntry, SkillToolRule, SkillTools } from './types.js';

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

function normalizeEntry(entry: SkillToolEntry): SkillToolRule {
  return typeof entry === 'string' ? { name: entry } : entry;
}

function evaluateRule(expression: string, context: Record<string, unknown>): boolean {
  return Boolean(compileRule(expression)(context));
}

/**
 * Resolve a skill's tool binding against a rendering context.
 *
 * Each entry is included when it has no `include` rule or its `include` rule
 * evaluates truthy. Any entry whose `exclude` rule evaluates truthy then
 * removes that tool from the result, even if another entry included it —
 * exclusion wins. Rules are @sesamecare-oss/rule-evaluator expressions
 * evaluated against `context`, which should be the same context used to
 * render the skill detail (and always carries the top-level `flow`).
 */
export function resolveSkillTools(
  tools: SkillTools | undefined,
  context: Record<string, unknown>,
): string[] {
  if (!tools) {
    return [];
  }

  const entries = tools.map(normalizeEntry);

  const included: string[] = [];
  for (const entry of entries) {
    if (included.includes(entry.name)) {
      continue;
    }
    if (!entry.include || evaluateRule(entry.include, context)) {
      included.push(entry.name);
    }
  }

  const excluded = new Set(
    entries
      .filter((entry) => entry.exclude && evaluateRule(entry.exclude, context))
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
 * every `include`/`exclude` expression so malformed rules fail at load time
 * rather than mid-conversation. Returns an error message, or undefined when
 * valid.
 */
export function validateSkillTools(tools: unknown): string | undefined {
  if (tools === undefined) {
    return undefined;
  }

  if (!Array.isArray(tools)) {
    return 'tools must be an array of tool names or { name, include?, exclude? } entries';
  }

  for (const entry of tools) {
    if (typeof entry === 'string') {
      continue;
    }
    if (typeof entry !== 'object' || entry === null) {
      return 'tools entries must be strings or { name, include?, exclude? } objects';
    }

    const record = entry as Record<string, unknown>;
    const unknownKeys = Object.keys(record).filter(
      (key) => key !== 'name' && key !== 'include' && key !== 'exclude',
    );
    if (unknownKeys.length > 0) {
      return `tools entry has unknown keys: ${unknownKeys.join(', ')}`;
    }

    const { name } = record;
    if (typeof name !== 'string' || !name) {
      return 'tools entry is missing a name';
    }

    for (const key of ['include', 'exclude'] as const) {
      const rule = record[key];
      if (rule === undefined) {
        continue;
      }
      if (typeof rule !== 'string') {
        return `tools entry '${name}' has a non-string ${key} rule`;
      }
      try {
        compileRule(rule);
      } catch (error) {
        return `tools entry '${name}' has an invalid ${key} rule: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
  }

  return undefined;
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

export function normalizeSkillNames(names: unknown): string[] | undefined {
  if (!Array.isArray(names)) {
    return undefined;
  }
  const normalized = names
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
    .map(normalizeSkillName);
  return normalized;
}
