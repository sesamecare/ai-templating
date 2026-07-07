import { existsSync, readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';

import type {
  DevPrompt,
  RuleGatedName,
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
import { normalizeSkillNames, validateRuleGatedNames, validateSkillTools } from '../skill-tools.js';

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
    assertValidPromptSkills(templateName, file, prompt);
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
  assertValidPromptSkills(templateName, file, prompt);
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
    assertValidSkillTools(skillName, file, skill);
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
  assertValidSkillTools(skillName, file, skill);
  store.skills[skillName] = { ...skill, name: skillName };

  if (process.env.DEBUG_TEMPLATES) {
    app.locals.logger.debug({ skillName, file }, 'Loaded filesystem skill');
  }

  return true;
}

function assertValidSkillTools(skillName: string, file: string, skill: Omit<SkillSpec, 'name'>) {
  const toolsError = validateSkillTools(skill.tools);
  if (toolsError) {
    throw new Error(`Skill ${skillName} (${file}) has invalid tools: ${toolsError}`);
  }
}

function assertValidPromptSkills(templateName: string, file: string, prompt: DevPrompt) {
  const skillsError = validateRuleGatedNames(
    prompt.skills ?? (prompt.config as { skills?: unknown } | undefined)?.skills,
    'skills',
  );
  if (skillsError) {
    throw new Error(
      `Prompt ${templateName} (${file}) has an invalid skills binding: ${skillsError}`,
    );
  }
}

/**
 * Read just the top-level `skills` binding from a filesystem prompt yaml,
 * without touching the template store. Returns undefined when the file does
 * not exist or declares no skills. Used as the fallback binding when a
 * Langfuse-sourced prompt does not declare `config.skills`.
 */
export async function loadFilesystemPromptSkills(
  promptsDir: string,
  templateName: string,
): Promise<RuleGatedName[] | undefined> {
  const file = resolveYamlFile(promptsDir, templateName);
  if (!file) {
    return undefined;
  }

  const prompt = await derefTemplateFile<DevPrompt>(file);
  return normalizeSkillNames(prompt.skills);
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
