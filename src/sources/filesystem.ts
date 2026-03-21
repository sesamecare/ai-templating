import { existsSync, readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';

import type {
  DevPrompt,
  SkillSpec,
  TemplateApp,
  TemplatePartialSource,
  TemplateStore,
} from '../types.js';
import {
  derefTemplateFile,
  getPartialNameFromFile,
  getPromptNameFromFile,
  getSkillNameFromFile,
} from '../template-files.js';
import { createDevTemplate } from '../template-store.js';

export async function loadFilesystemPartials(promptsDir: string) {
  const partials = new Map<string, TemplatePartialSource>();
  const files = glob(path.join(promptsDir, '**/*.partial.hbs'));

  for await (const file of files) {
    const partialName = getPartialNameFromFile(promptsDir, file);
    partials.set(partialName, {
      source: 'filesystem',
      code: readFileSync(file, 'utf-8'),
      name: file,
      version: 'dev',
    });
  }

  return partials;
}

export function loadFilesystemPartialByName(promptsDir: string, partialName: string) {
  const file = path.join(promptsDir, `${partialName}.partial.hbs`);
  if (!existsSync(file)) {
    return undefined;
  }

  return {
    source: 'filesystem' as const,
    code: readFileSync(file, 'utf-8'),
    name: file,
    version: 'dev',
  };
}

export async function loadFilesystemTemplates(
  app: TemplateApp,
  store: TemplateStore,
  promptsDir: string,
) {
  const files = glob(path.join(promptsDir, '**/*.{yml,yaml}'));

  for await (const file of files) {
    const prompt = await derefTemplateFile<DevPrompt>(file);
    const templateName = getPromptNameFromFile(promptsDir, file);
    store.templates[templateName] = createDevTemplate(templateName, prompt);

    if (process.env.DEBUG_TEMPLATES) {
      app.locals.logger.debug({ promptName: templateName, file }, 'Loaded filesystem prompt');
    }
  }
}

export async function loadFilesystemTemplateByName(
  app: TemplateApp,
  store: TemplateStore,
  promptsDir: string,
  templateName: string,
) {
  const file = resolveYamlFile(promptsDir, templateName);
  if (!file) {
    return false;
  }

  const prompt = await derefTemplateFile<DevPrompt>(file);
  store.templates[templateName] = createDevTemplate(templateName, prompt);

  if (process.env.DEBUG_TEMPLATES) {
    app.locals.logger.debug({ promptName: templateName, file }, 'Loaded filesystem prompt');
  }

  return true;
}

export async function loadFilesystemSkills(
  app: TemplateApp,
  store: TemplateStore,
  skillsDir: string,
) {
  const files = glob(path.join(skillsDir, '**/*.{yml,yaml}'));

  for await (const file of files) {
    const skill = await derefTemplateFile<Omit<SkillSpec, 'name'>>(file);
    const skillName = getSkillNameFromFile(skillsDir, file);
    store.skills[skillName] = { ...skill, name: skillName };

    if (process.env.DEBUG_TEMPLATES) {
      app.locals.logger.debug({ skillName, file }, 'Loaded filesystem skill');
    }
  }
}

export async function loadFilesystemSkillByName(
  app: TemplateApp,
  store: TemplateStore,
  skillsDir: string,
  skillPath: string,
) {
  const file = resolveYamlFile(skillsDir, skillPath);
  if (!file) {
    return false;
  }

  const skill = await derefTemplateFile<Omit<SkillSpec, 'name'>>(file);
  const skillName = getSkillNameFromFile(skillsDir, file);
  store.skills[skillName] = { ...skill, name: skillName };

  if (process.env.DEBUG_TEMPLATES) {
    app.locals.logger.debug({ skillName, file }, 'Loaded filesystem skill');
  }

  return true;
}

function resolveYamlFile(rootDir: string, relativeName: string) {
  for (const extension of ['.yaml', '.yml']) {
    const file = path.join(rootDir, `${relativeName}${extension}`);
    if (existsSync(file)) {
      return file;
    }
  }

  return undefined;
}
