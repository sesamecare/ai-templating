import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { LangfuseClient } from '@langfuse/client';

import { TemplateManager } from '../TemplateManager.js';

describe('TemplateManager.reloadFromLangfuse', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }

    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  test('refreshes one prompt without refetching unrelated prompt details', async () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'ai-templating-'));
    roots.push(rootDir);
    mkdirSync(path.join(rootDir, 'prompts'), { recursive: true });
    mkdirSync(path.join(rootDir, 'skills'), { recursive: true });

    const versions = new Map<string, number>([
      ['patient/base-prompt', 1],
      ['patient/other-prompt', 5],
    ]);
    const promptGetCalls: string[] = [];

    const langfuse = {
      api: {
        prompts: {
          list: vi.fn(async ({ page }: { page: number }) => ({
            data:
              page === 1
                ? [
                    { name: 'patient/base-prompt', labels: ['production'] },
                    { name: 'patient/other-prompt', labels: ['production'] },
                  ]
                : [],
          })),
        },
      },
      prompt: {
        get: vi.fn(async (name: string) => {
          promptGetCalls.push(name);
          return createPromptDetail(name, versions.get(name) ?? 0, ['production']);
        }),
      },
    } as unknown as LangfuseClient;

    const manager = new TemplateManager(createApp(), {
      langfuse,
      rootDir,
    });

    await manager.loadTemplates();
    expect(manager.templates['patient/base-prompt']?.version).toBe(1);
    expect(manager.templates['patient/other-prompt']?.version).toBe(5);

    promptGetCalls.length = 0;
    versions.set('patient/base-prompt', 2);

    await manager.reloadFromLangfuse({ promptName: 'patient/base-prompt' });

    expect(manager.templates['patient/base-prompt']?.version).toBe(2);
    expect(manager.templates['patient/other-prompt']?.version).toBe(5);
    expect(promptGetCalls).toContain('patient/base-prompt');
    expect(promptGetCalls).not.toContain('patient/other-prompt');
  });

  test('retries transient Langfuse fetch failures during initial template load', async () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'ai-templating-'));
    roots.push(rootDir);
    mkdirSync(path.join(rootDir, 'prompts'), { recursive: true });
    mkdirSync(path.join(rootDir, 'skills'), { recursive: true });

    const app = createApp();
    const langfuse = {
      api: {
        prompts: {
          list: vi
            .fn()
            .mockRejectedValueOnce(new Error('fetch failed'))
            .mockResolvedValue({ data: [] }),
        },
      },
      prompt: {
        get: vi.fn(),
      },
    } as unknown as LangfuseClient;

    const manager = new TemplateManager(app, {
      langfuse,
      rootDir,
    });

    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(immediateSetTimeout);

    await expect(manager.loadTemplates()).resolves.toBeUndefined();

    expect(langfuse.api.prompts.list).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(app.locals.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        maxAttempts: 3,
        retryDelayMs: 500,
        errorMessage: 'fetch failed',
      }),
      'Template load failed; retrying',
    );
  });

  test('fails hard after exhausting retries for transient Langfuse fetch failures', async () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'ai-templating-'));
    roots.push(rootDir);
    mkdirSync(path.join(rootDir, 'prompts'), { recursive: true });
    mkdirSync(path.join(rootDir, 'skills'), { recursive: true });

    const app = createApp();
    const langfuse = {
      api: {
        prompts: {
          list: vi.fn().mockRejectedValue(new Error('fetch failed')),
        },
      },
      prompt: {
        get: vi.fn(),
      },
    } as unknown as LangfuseClient;

    const manager = new TemplateManager(app, {
      langfuse,
      rootDir,
    });

    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(immediateSetTimeout);

    await expect(manager.loadTemplates()).rejects.toThrow('fetch failed');

    expect(langfuse.api.prompts.list).toHaveBeenCalledTimes(3);
    expect(app.locals.logger.warn).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
  });
});

describe('TemplateManager.getPromptSkills', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }

    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function createFixtureRoot() {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), 'ai-templating-'));
    roots.push(rootDir);
    mkdirSync(path.join(rootDir, 'prompts', 'patient'), { recursive: true });
    mkdirSync(path.join(rootDir, 'skills', 'patient'), { recursive: true });

    writeFileSync(
      path.join(rootDir, 'skills', 'patient', 'triage.yaml'),
      [
        'description: Triage the patient request.',
        'detail: Triage instructions for {{flow}}.',
        'tools:',
        '  - request_location',
        '  - name: create_support_ticket',
        '    include: flow == "support-agent"',
        '',
      ].join('\n'),
    );
    writeFileSync(
      path.join(rootDir, 'prompts', 'patient', 'base-prompt.yaml'),
      [
        'skills:',
        '  - patient/triage',
        'messages:',
        '  - role: system',
        '    content: You are a test prompt.',
        '',
      ].join('\n'),
    );

    return rootDir;
  }

  function createLangfuse(promptDetails: Record<string, ReturnType<typeof createPromptDetail>>) {
    return {
      api: {
        prompts: {
          list: vi.fn(async ({ page }: { page: number }) => ({
            data:
              page === 1
                ? Object.keys(promptDetails).map((name) => ({
                    name,
                    labels: promptDetails[name].labels,
                  }))
                : [],
          })),
        },
      },
      prompt: {
        get: vi.fn(async (name: string) => promptDetails[name]),
      },
    } as unknown as LangfuseClient;
  }

  test('reads the skills binding from the filesystem prompt yaml', async () => {
    const rootDir = createFixtureRoot();
    const manager = new TemplateManager(createApp(), {
      langfuse: createLangfuse({}),
      rootDir,
    });
    await manager.loadTemplates();

    const skills = await manager.getPromptSkills('patient/base-prompt');
    expect(skills.map((skill) => skill.name)).toEqual(['patient_triage']);
    // The detail stays a raw template so consumers can render it with the
    // live conversation context.
    expect(skills[0].detail).toContain('{{flow}}');
  });

  test('falls back to the filesystem binding when a production prompt lacks config.skills', async () => {
    const rootDir = createFixtureRoot();
    const manager = new TemplateManager(createApp(), {
      langfuse: createLangfuse({
        'patient/base-prompt': createPromptDetail('patient/base-prompt', 3, ['production']),
      }),
      rootDir,
    });
    await manager.loadTemplates();

    // The langfuse production prompt replaced the dev template...
    expect(manager.templates['patient/base-prompt']?.version).toBe(3);
    // ...but the skills binding still comes from the local yaml.
    const skills = await manager.getPromptSkills('patient/base-prompt');
    expect(skills.map((skill) => skill.name)).toEqual(['patient_triage']);
  });

  test('config.skills on a langfuse prompt overrides the filesystem binding', async () => {
    const rootDir = createFixtureRoot();
    const detail = createPromptDetail('patient/base-prompt', 3, ['production']);
    (detail.config as Record<string, unknown>).skills = [];
    const manager = new TemplateManager(createApp(), {
      langfuse: createLangfuse({ 'patient/base-prompt': detail }),
      rootDir,
    });
    await manager.loadTemplates();

    await expect(manager.getPromptSkills('patient/base-prompt')).resolves.toEqual([]);
  });

  test('resolves rule-gated skills bindings against the provided context', async () => {
    const rootDir = createFixtureRoot();
    writeFileSync(
      path.join(rootDir, 'skills', 'patient', 'refill.yaml'),
      ['description: Handle refills.', 'detail: Refill instructions.', ''].join('\n'),
    );
    writeFileSync(
      path.join(rootDir, 'prompts', 'patient', 'base-prompt.yaml'),
      [
        'skills:',
        '  - patient/triage',
        '  - name: patient/refill',
        '    include: flow == "patient-generic"',
        'messages:',
        '  - role: system',
        '    content: Test',
        '',
      ].join('\n'),
    );
    const manager = new TemplateManager(createApp(), {
      langfuse: createLangfuse({}),
      rootDir,
    });
    await manager.loadTemplates();

    const patientSkills = await manager.getPromptSkills('patient/base-prompt', {
      context: { flow: 'patient-generic' },
    });
    expect(patientSkills.map((skill) => skill.name)).toEqual(['patient_triage', 'patient_refill']);

    const supportSkills = await manager.getPromptSkills('patient/base-prompt', {
      context: { flow: 'support-agent' },
    });
    expect(supportSkills.map((skill) => skill.name)).toEqual(['patient_triage']);

    // Rule-gated bindings must never silently no-op: no context is an error.
    await expect(manager.getPromptSkills('patient/base-prompt')).rejects.toThrow(
      'requires options.context',
    );
  });

  test('rejects prompts with malformed skills bindings at load time', async () => {
    const rootDir = createFixtureRoot();
    writeFileSync(
      path.join(rootDir, 'prompts', 'patient', 'base-prompt.yaml'),
      [
        'skills:',
        '  - name: patient/triage',
        '    include: flow ==',
        'messages:',
        '  - role: system',
        '    content: Test',
        '',
      ].join('\n'),
    );
    const manager = new TemplateManager(createApp(), {
      langfuse: createLangfuse({}),
      rootDir,
    });

    await expect(manager.loadTemplates()).rejects.toThrow(/invalid skills binding/);
  });

  test('throws when a bound skill does not exist', async () => {
    const rootDir = createFixtureRoot();
    writeFileSync(
      path.join(rootDir, 'prompts', 'patient', 'base-prompt.yaml'),
      [
        'skills:',
        '  - patient/missing',
        'messages:',
        '  - role: system',
        '    content: Test',
        '',
      ].join('\n'),
    );
    const manager = new TemplateManager(createApp(), {
      langfuse: createLangfuse({}),
      rootDir,
    });
    await manager.loadTemplates();

    await expect(manager.getPromptSkills('patient/base-prompt')).rejects.toThrow(
      'Skill patient_missing not found',
    );
  });
});

function createPromptDetail(name: string, version: number, labels: string[]) {
  return {
    type: 'text' as const,
    prompt: `Prompt ${name} v${version}`,
    labels,
    version,
    config: {
      model: 'test-model',
      temperature: 0,
      topK: 0,
      topP: 1,
    },
    toJSON: () => JSON.stringify({ name, version }),
  };
}

const immediateSetTimeout: typeof setTimeout = ((callback: TimerHandler) => {
  if (typeof callback === 'function') {
    callback();
  }
  return 0 as never;
}) as typeof setTimeout;

function createApp() {
  return {
    locals: {
      name: 'test-service',
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    },
  };
}
