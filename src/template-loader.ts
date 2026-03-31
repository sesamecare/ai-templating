import handlebars from 'handlebars';
import type { LangfuseClient } from '@langfuse/client';

import { registerHandlebarsHelpers } from './handlebars-helpers.js';
import {
  loadFilesystemPartials,
  loadFilesystemSkills,
  loadFilesystemTemplates,
} from './sources/filesystem.js';
import { loadLangfuseInventory, loadProductionTemplates } from './sources/langfuse.js';
import type {
  TemplateApp,
  TemplateDirectories,
  TemplatePartialSource,
  TemplateStore,
} from './types.js';

const TEMPLATE_LOAD_MAX_ATTEMPTS = 3;
const TEMPLATE_LOAD_BASE_DELAY_MS = 500;

export async function loadTemplateStore(
  app: TemplateApp,
  langfuse: LangfuseClient,
  store: TemplateStore,
  directories: TemplateDirectories,
) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= TEMPLATE_LOAD_MAX_ATTEMPTS; attempt++) {
    try {
      registerHandlebarsHelpers();

      const partials = await loadFilesystemPartials(directories.promptsDir);
      const productionLabelsByName = await loadLangfuseInventory(app, langfuse, store, partials);

      registerPartials(app, partials);
      await loadFilesystemTemplates(app, store, directories.promptsDir);
      await loadFilesystemSkills(app, store, directories.skillsDir);
      await loadProductionTemplates(app, langfuse, store, productionLabelsByName);
      return;
    } catch (error) {
      lastError = error;

      if (!isRetryableTemplateLoadError(error) || attempt === TEMPLATE_LOAD_MAX_ATTEMPTS) {
        throw error;
      }

      const retryDelayMs = TEMPLATE_LOAD_BASE_DELAY_MS * attempt;
      app.locals.logger.warn(
        {
          attempt,
          maxAttempts: TEMPLATE_LOAD_MAX_ATTEMPTS,
          retryDelayMs,
          errorMessage: getErrorMessage(error),
          errorName: getErrorName(error),
        },
        'Template load failed; retrying',
      );
      await delay(retryDelayMs);
    }
  }

  throw lastError;
}

function registerPartials(app: TemplateApp, partials: Map<string, TemplatePartialSource>) {
  for (const [name, source] of partials.entries()) {
    handlebars.registerPartial(name, source.code);
    if (process.env.DEBUG_TEMPLATES) {
      app.locals.logger.debug(
        { partial: name, name: source.name, version: source.version },
        'Registered partial',
      );
    }
  }
}

function isRetryableTemplateLoadError(error: unknown) {
  return flattenErrorMessages(error).some((message) => {
    const normalized = message.toLowerCase();
    return (
      normalized.includes('fetch failed') ||
      normalized.includes('networkerror') ||
      normalized.includes('econnreset') ||
      normalized.includes('etimedout') ||
      normalized.includes('timeout')
    );
  });
}

function flattenErrorMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;

  while (current) {
    const message = getErrorMessage(current);
    if (message) {
      messages.push(message);
    }

    current =
      typeof current === 'object' &&
      current !== null &&
      'cause' in current &&
      (current as { cause?: unknown }).cause
        ? (current as { cause?: unknown }).cause
        : undefined;
  }

  return messages;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
  }

  return String(error);
}

function getErrorName(error: unknown) {
  if (error instanceof Error) {
    return error.name;
  }

  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string') {
      return name;
    }
  }

  return undefined;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
