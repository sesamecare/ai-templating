import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
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
