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
   * Names of the skills bound to this prompt. Populated from the top-level
   * `skills` list in a filesystem prompt yaml, or from `config.skills` on a
   * Langfuse prompt. Names are normalized to skill-store form
   * (`patient/handle_refill` → `patient_handle_refill`).
   */
  skills?: string[];
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
 * A conditional tool entry. `when` is a @sesamecare-oss/rule-evaluator
 * expression evaluated against the same context used to render the skill
 * detail (which always includes the top-level `flow`). An entry with no
 * `when` always applies. A bare string is shorthand for `{ name }`.
 */
export interface SkillToolRule {
  name: string;
  when?: string;
}

export type SkillToolRuleEntry = string | SkillToolRule;

/**
 * Rule-based tool binding: `include` selects tools (subject to their `when`
 * rules), then `exclude` removes matching ones. Exclusion wins over
 * inclusion.
 */
export interface SkillToolRules {
  include?: SkillToolRuleEntry[];
  exclude?: SkillToolRuleEntry[];
}

/** Either a plain (unconditional) tool list or rule-based include/exclude. */
export type SkillTools = string[] | SkillToolRules;

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
  skills?: string[];
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
