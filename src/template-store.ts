import type { ChatPromptClient, TextPromptClient } from '@langfuse/client';

import { compileLangfusePrompt } from './compile-prompt.js';
import type { WeightedItem } from './weighted-selector.js';
import { normalize, weightedPick } from './weighted-selector.js';
import type {
  DevPrompt,
  LangfuseHandlebarsTemplate,
  LangfusePromptDetail,
  TemplateConfig,
  TemplateStore,
  WeightedPromptGroup,
} from './types.js';

export function createDevTemplate<T>(
  templateName: string,
  prompt: DevPrompt,
): LangfuseHandlebarsTemplate<T> {
  return {
    name: templateName,
    variant: getVariantName(templateName),
    version: -1,
    config: prompt.config,
    tag: JSON.stringify({ version: 'dev', name: templateName }),
    delegate: compileLangfusePrompt({ type: 'chat', prompt: prompt.messages }),
  };
}

export function createLangfuseTemplate<T>(
  templateName: string,
  promptDetail: LangfusePromptDetail | TextPromptClient | ChatPromptClient,
  label?: string,
): LangfuseHandlebarsTemplate<T> {
  const normalizedPrompt = normalizeLangfusePromptDetail(promptDetail);
  const variantLabel = label ?? getProductionLabel(normalizedPrompt.labels);
  const variantName = variantLabel ? getVariantName(variantLabel) : '';

  return {
    name: variantName ? `${templateName}#${variantName}` : templateName,
    variant: variantName,
    version: normalizedPrompt.version,
    tag: normalizedPrompt.toJSON(),
    config: normalizedPrompt.config as TemplateConfig | undefined,
    delegate: compileLangfusePrompt(normalizedPrompt),
  };
}

export function mergeProductionTemplateIntoStore(
  store: TemplateStore,
  templateName: string,
  template: LangfuseHandlebarsTemplate<unknown>,
  labels: readonly string[],
) {
  if (!getProductionLabel(labels)) {
    return;
  }

  const currentGroup = store.promptGroups[templateName];
  if (currentGroup) {
    store.promptGroups[templateName] = {
      baseName: currentGroup.baseName,
      variants: normalize([
        ...currentGroup.variants.filter((entry) => entry.template.variant !== template.variant),
        toPromptVariant(template),
      ]),
    };
    return;
  }

  const currentTemplate = store.templates[templateName];
  if (currentTemplate && currentTemplate.variant !== template.variant) {
    store.promptGroups[templateName] = {
      baseName: templateName,
      variants: normalize([toPromptVariant(currentTemplate), toPromptVariant(template)]),
    };
    delete store.templates[templateName];
    return;
  }

  if (!currentTemplate || currentTemplate.version < template.version) {
    store.templates[templateName] = template;
  }
}

export function cacheTemplateVersion(
  store: TemplateStore,
  templateName: string,
  template: LangfuseHandlebarsTemplate<unknown>,
) {
  store.templates[getVersionedTemplateKey(templateName, template.version)] = template;
}

export function getVersionedTemplateKey(templateName: string, version: number) {
  return `${templateName}::${version}`;
}

export function getProductionLabel(labels: readonly string[]) {
  return labels.find((label) => label.startsWith('production'));
}

export function getVariantName(label: string) {
  return label.replace(/^production-?/, '');
}

export async function selectPromptVariant<T>(
  conversationUuid: string,
  group: WeightedPromptGroup<T>,
): Promise<LangfuseHandlebarsTemplate<T>> {
  const items: WeightedItem[] = group.variants.map((variant) => ({
    key: variant.template.name,
    weight: variant.weight,
  }));
  const selectedName = weightedPick(items, conversationUuid);
  const selectedVariant = group.variants.find((variant) => variant.template.name === selectedName);

  if (!selectedVariant) {
    throw new Error(`Selected variant ${selectedName} not found in group ${group.baseName}`);
  }

  return selectedVariant.template;
}

function toPromptVariant(template: LangfuseHandlebarsTemplate<unknown>) {
  return {
    template,
    weight: template.config?.promptWeight,
  };
}

function normalizeLangfusePromptDetail(
  promptDetail: LangfusePromptDetail | TextPromptClient | ChatPromptClient,
): LangfusePromptDetail {
  if (typeof promptDetail.prompt === 'string') {
    return {
      type: 'text',
      prompt: promptDetail.prompt,
      labels: promptDetail.labels,
      version: promptDetail.version,
      config: promptDetail.config,
      toJSON: () => promptDetail.toJSON(),
    };
  }

  return {
    type: 'chat',
    prompt: promptDetail.prompt,
    labels: promptDetail.labels,
    version: promptDetail.version,
    config: promptDetail.config,
    toJSON: () => promptDetail.toJSON(),
  };
}
