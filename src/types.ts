import type { ModelMessage } from 'ai';
import type { RuntimeOptions } from 'handlebars';
import type { ChatPromptClient, LangfuseClient, TextPromptClient } from '@langfuse/client';
import type { ChatMessageWithPlaceholders } from '@langfuse/core';
import type { AnyServiceLocals, ServiceLike } from '@openapi-typescript-infra/service';

export interface TemplateConfig {
  topK: number;
  temperature: number;
  topP: number;
  model: string;
  promptWeight?: number;
  providerOptions?: unknown;
}

export interface LangfuseHandlebarsTemplate<T = unknown> {
  name: string;
  version: number;
  variant: string;
  tag: string;
  config?: TemplateConfig;
  /**
   * Skills bound to this prompt. Populated from the top-level `skills` list
   * in a filesystem prompt yaml, or from `config.skills` on a Langfuse
   * prompt. Entries may be plain names or rule-gated
   * (`{ name, include?, exclude? }`); names are normalized to skill-store
   * form (`patient/handle_refill` → `patient_handle_refill`).
   */
  skills?: RuleGatedName[];
  delegate: LangfuseTemplateDelegate<T>;
}

export interface PromptVariant<T = unknown> {
  template: LangfuseHandlebarsTemplate<T>;
  weight: number;
}

export interface WeightedPromptGroup<T = unknown> {
  baseName: string;
  variants: PromptVariant<T>[];
}

type RefinedPromptDetail<T, TType extends 'text' | 'chat', TPrompt> = Omit<
  Pick<T, Extract<keyof T, 'type' | 'prompt' | 'labels' | 'version' | 'config' | 'toJSON'>>,
  'type' | 'prompt'
> & {
  type: TType;
  prompt: TPrompt;
};

export type LangfusePromptDetail =
  | RefinedPromptDetail<TextPromptClient, 'text', string>
  | RefinedPromptDetail<ChatPromptClient, 'chat', ChatMessageWithPlaceholders[]>;

/**
 * The context that include/exclude rules evaluate against and that skill
 * detail templates render with. `flow` (the active prompt/flow, e.g. a
 * conversation type) is the required discriminator shared skills key off;
 * everything else is caller-defined.
 */
export type RuleContext = { flow: string } & Record<string, unknown>;

/**
 * A conditional name entry, used by both skill→tool bindings and
 * prompt→skill bindings. `include` and `exclude` are
 * @sesamecare-oss/rule-evaluator expressions evaluated against the
 * {@link RuleContext} (the same context used to render the skill detail):
 *
 * - `include`: the entry is bound only when the rule evaluates truthy
 * - `exclude`: the entry is dropped when the rule evaluates truthy, even if
 *   another entry included it — exclusion wins
 *
 * An entry with neither rule always applies. A bare string is shorthand for
 * `{ name }`.
 */
export interface RuleGatedEntry {
  name: string;
  include?: string;
  exclude?: string;
}

export type RuleGatedName = string | RuleGatedEntry;

/** A skill's tool binding: a list of unconditional and/or rule-based entries. */
export type SkillTools = RuleGatedName[];

export interface SkillSpec {
  name: string;
  description: string;
  detail: string;
  tools?: SkillTools;
  /** When true, this skill can be activated alongside other skills in the same turn. */
  composable?: boolean;
}

export interface DevPrompt {
  messages: ChatMessageWithPlaceholders[];
  config?: TemplateConfig;
  /** Skills bound to this prompt (see LangfuseHandlebarsTemplate.skills). */
  skills?: RuleGatedName[];
}

export interface TemplateStore {
  templates: Record<string, LangfuseHandlebarsTemplate<unknown>>;
  promptGroups: Record<string, WeightedPromptGroup<unknown>>;
  skills: Record<string, SkillSpec>;
}

export interface TemplatePartialSource {
  source: 'filesystem' | 'langfuse';
  code: string;
  name: string;
  version: string;
}

export interface TemplateDirectories {
  promptsDir: string;
  skillsDir: string;
}

export interface TemplateManagerOptions {
  langfuse: LangfuseClient;
  rootDir?: string;
}

export interface LangfuseReloadRequest {
  promptName?: string;
  version?: number;
  label?: string;
  labels?: string[];
}

export type TemplateApp<TLocals extends AnyServiceLocals = AnyServiceLocals> = ServiceLike<TLocals>;

export type LangfuseTemplateDelegate<T = unknown> = (
  context: T,
  placeholders: Record<string, ModelMessage[]> | undefined,
  options?: RuntimeOptions,
) => ModelMessage[];
