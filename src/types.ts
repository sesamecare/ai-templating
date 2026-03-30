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

export interface SkillSpec {
  name: string;
  description: string;
  detail: string;
  tools?: string[];
  /** When true, this skill can be activated alongside other skills in the same turn. */
  composable?: boolean;
}

export interface DevPrompt {
  messages: ChatMessageWithPlaceholders[];
  config?: TemplateConfig;
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
