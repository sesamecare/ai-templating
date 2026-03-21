import handlebars from 'handlebars';

import { registerHandlebarsHelpers } from './handlebars-helpers.js';
import {
  loadFilesystemPartials,
  loadFilesystemSkills,
  loadFilesystemTemplates,
} from './sources/filesystem.js';
import { loadLangfuseInventory, loadProductionTemplates } from './sources/langfuse.js';
import type { LangfuseClient } from '@langfuse/client';
import type {
  TemplateApp,
  TemplateDirectories,
  TemplatePartialSource,
  TemplateStore,
} from './types.js';

export async function loadTemplateStore(
  app: TemplateApp,
  langfuse: LangfuseClient,
  store: TemplateStore,
  directories: TemplateDirectories,
) {
  registerHandlebarsHelpers();

  const partials = await loadFilesystemPartials(directories.promptsDir);
  const productionLabelsByName = await loadLangfuseInventory(app, langfuse, store, partials);

  registerPartials(app, partials);
  await loadFilesystemTemplates(app, store, directories.promptsDir);
  await loadFilesystemSkills(app, store, directories.skillsDir);
  await loadProductionTemplates(app, langfuse, store, productionLabelsByName);
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
