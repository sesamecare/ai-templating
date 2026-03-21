import { describe, expect, test } from 'vitest';

import { createLangfuseTemplate, mergeProductionTemplateIntoStore } from '../template-store.js';
import type { TemplateConfig, TemplateStore } from '../types.js';

interface TestPromptDetail {
  type: 'text';
  prompt: string;
  labels: string[];
  version: number;
  config: TemplateConfig;
  toJSON(): string;
}

describe('createLangfuseTemplate', () => {
  test('derives the variant from production labels when no explicit label is passed', () => {
    const template = createLangfuseTemplate(
      'patient/base-prompt',
      makePromptDetail({
        labels: ['production-canary'],
      }),
    );

    expect(template.name).toBe('patient/base-prompt#canary');
    expect(template.variant).toBe('canary');
  });
});

describe('mergeProductionTemplateIntoStore', () => {
  test('upgrades a single production template into a weighted group', () => {
    const current = createLangfuseTemplate(
      'patient/base-prompt',
      makePromptDetail({
        labels: ['production'],
        version: 1,
        config: createConfig(1),
      }),
      'production',
    );
    const canary = createLangfuseTemplate(
      'patient/base-prompt',
      makePromptDetail({
        labels: ['production-canary'],
        version: 2,
        config: createConfig(3),
      }),
      'production-canary',
    );
    const store: TemplateStore = {
      templates: {
        'patient/base-prompt': current,
      },
      promptGroups: {},
      skills: {},
    };

    mergeProductionTemplateIntoStore(store, 'patient/base-prompt', canary, ['production-canary']);

    expect(store.templates['patient/base-prompt']).toBeUndefined();
    expect(
      store.promptGroups['patient/base-prompt']?.variants.map((entry) => entry.template.name),
    ).toEqual(['patient/base-prompt', 'patient/base-prompt#canary']);
  });
});

function makePromptDetail(overrides: Partial<TestPromptDetail> = {}) {
  const promptDetail: TestPromptDetail = {
    type: 'text',
    prompt: 'Hello {{name}}',
    version: 7,
    labels: [],
    config: createConfig(),
    toJSON: () => '{"name":"patient/base-prompt","version":7}',
    ...overrides,
  };

  return promptDetail;
}

function createConfig(promptWeight?: number) {
  const config: TemplateConfig = {
    model: 'test-model',
    temperature: 0,
    topK: 0,
    topP: 1,
    ...(promptWeight === undefined ? {} : { promptWeight }),
  };

  return config;
}
