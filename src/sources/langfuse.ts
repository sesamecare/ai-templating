import handlebars from 'handlebars';
import type { LangfuseClient } from '@langfuse/client';
import type { PromptMeta } from '@langfuse/core';

import type { TemplateApp, TemplatePartialSource, TemplateStore } from '../types.js';
import { cacheTemplateVersion, createLangfuseTemplate, getVariantName } from '../template-store.js';
import { normalize } from '../weighted-selector.js';

type PromptSummary = Pick<PromptMeta, 'name' | 'labels'>;

interface ParsedSkillConfig {
  description: string;
  tools?: string[];
}

export async function* iterateAllPrompts(langfuse: LangfuseClient) {
  let page = 1;
  let hasMore = true;
  const pageSize = 100;

  while (hasMore) {
    const response = await langfuse.api.prompts.list({ limit: pageSize, page });
    for (const prompt of response.data ?? []) {
      yield prompt;
    }
    hasMore = !!response.data && response.data.length === pageSize;
    page += 1;
  }
}

export async function getPromptMetaByName(langfuse: LangfuseClient, promptName: string) {
  for await (const prompt of iterateAllPrompts(langfuse)) {
    if (prompt.name === promptName) {
      return prompt;
    }
  }

  return undefined;
}

export async function loadLangfuseInventory(
  app: TemplateApp,
  langfuse: LangfuseClient,
  store: TemplateStore,
  partials: Map<string, TemplatePartialSource>,
) {
  const productionLabelsByName = new Map<string, string[]>();

  for await (const prompt of iterateAllPrompts(langfuse)) {
    if (isPartialPrompt(prompt.name)) {
      await loadLangfusePartial(app, langfuse, partials, prompt);
      continue;
    }

    if (isSkillPrompt(prompt.name)) {
      await loadLangfuseSkill(app, langfuse, store, prompt);
      continue;
    }

    productionLabelsByName.set(
      prompt.name,
      prompt.labels.filter((label) => label.startsWith('production')),
    );
  }

  return productionLabelsByName;
}

export async function loadProductionTemplates(
  app: TemplateApp,
  langfuse: LangfuseClient,
  store: TemplateStore,
  labelsByName: Map<string, string[]>,
) {
  for (const [templateName, labels] of labelsByName.entries()) {
    if (labels.length === 0) {
      continue;
    }

    if (labels.length === 1) {
      const [label] = labels;
      const promptDetail = await langfuse.prompt.get(templateName, {
        label,
        cacheTtlSeconds: 0,
      });
      const template = createLangfuseTemplate(templateName, promptDetail, label);

      store.templates[templateName] = template;
      cacheTemplateVersion(store, templateName, template);

      if (process.env.DEBUG_TEMPLATES) {
        app.locals.logger.debug(
          { template: templateName, version: promptDetail.version, label },
          'Registered Langfuse template',
        );
      }
      continue;
    }

    const variants = [];
    for (const label of labels) {
      const promptDetail = await langfuse.prompt.get(templateName, {
        label,
        cacheTtlSeconds: 0,
      });
      const template = createLangfuseTemplate(templateName, promptDetail, label);

      variants.push({
        template,
        weight: template.config?.promptWeight,
      });
      store.templates[`${templateName}#${getVariantName(label)}`] = template;
      cacheTemplateVersion(store, templateName, template);
    }

    store.promptGroups[templateName] = {
      baseName: templateName,
      variants: normalize(variants),
    };

    if (process.env.DEBUG_TEMPLATES) {
      app.locals.logger.debug(
        {
          baseName: templateName,
          variants: variants.map((variant) => ({
            variant: variant.template.variant,
            weight: variant.weight,
          })),
        },
        'Registered weighted prompt group',
      );
    }
  }
}

export async function loadLangfusePartialByName(
  app: TemplateApp,
  langfuse: LangfuseClient,
  promptName: string,
) {
  const partials = new Map<string, TemplatePartialSource>();
  await loadLangfusePartial(app, langfuse, partials, { name: promptName, labels: [] });
  return partials.values().next().value;
}

export async function loadLangfuseSkillByName(
  app: TemplateApp,
  langfuse: LangfuseClient,
  promptName: string,
) {
  const store: TemplateStore = {
    templates: {},
    promptGroups: {},
    skills: {},
  };
  await loadLangfuseSkill(app, langfuse, store, { name: promptName, labels: [] });
  return Object.values(store.skills)[0];
}

async function loadLangfusePartial(
  app: TemplateApp,
  langfuse: LangfuseClient,
  partials: Map<string, TemplatePartialSource>,
  prompt: PromptSummary,
) {
  const partialName = prompt.name.replace(/partial[:/]/, '');
  const existing = partials.get(partialName);

  if (existing?.source === 'langfuse') {
    throw new Error(`Partial ${partialName} already exists, cannot add ${prompt.name}`);
  }

  if (existing) {
    app.locals.logger.warn({ name: partialName }, 'Filesystem partial hides Langfuse partial');
    return;
  }

  const promptDetail = await langfuse.prompt.get(prompt.name);
  if (!promptDetail) {
    return;
  }

  if (typeof promptDetail.prompt !== 'string') {
    app.locals.logger.error({ name: prompt.name }, 'Partial prompt must be a text prompt');
    return;
  }

  partials.set(partialName, {
    source: 'langfuse',
    name: prompt.name,
    code: promptDetail.prompt,
    version: String(promptDetail.version),
  });
}

async function loadLangfuseSkill(
  app: TemplateApp,
  langfuse: LangfuseClient,
  store: TemplateStore,
  prompt: PromptSummary,
) {
  const skillName = prompt.name.replace(/skill[:/]/, '').replace(/\//g, '_');
  const promptDetail = await langfuse.prompt.get(prompt.name);
  if (!promptDetail) {
    return;
  }

  if (typeof promptDetail.prompt !== 'string') {
    app.locals.logger.error({ name: prompt.name }, 'Skill prompt must be a text prompt');
    return;
  }

  const parsedConfig = parseSkillConfig(promptDetail.config);
  if (typeof parsedConfig === 'string') {
    app.locals.logger.error({ name: prompt.name }, parsedConfig);
    return;
  }

  store.skills[skillName] = {
    name: skillName,
    description: parsedConfig.description,
    detail: handlebars.compile(promptDetail.prompt)({}),
    tools: parsedConfig.tools,
  };
}

function parseSkillConfig(config: unknown): ParsedSkillConfig | string {
  const description = (config as { description?: unknown } | undefined)?.description;
  if (typeof description !== 'string' || !description) {
    return 'Skill prompt missing description';
  }

  const tools = (config as { tools?: unknown } | undefined)?.tools;
  if (tools !== undefined && !Array.isArray(tools)) {
    return 'Skill prompt has invalid tool list - must be array or undefined';
  }

  return {
    description,
    tools: tools?.filter((tool): tool is string => typeof tool === 'string'),
  };
}

function isPartialPrompt(name: string) {
  return /^(.*\/)?partial[:/]/.test(name);
}

function isSkillPrompt(name: string) {
  return /^(.*\/)?skill[:/]/.test(name);
}

export { isPartialPrompt as isPartialPromptName, isSkillPrompt as isSkillPromptName };
