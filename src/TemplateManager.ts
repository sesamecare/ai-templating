import { randomUUID } from 'node:crypto';

import handlebars from 'handlebars';
import type { ModelMessage } from 'ai';
import type { TemplateDelegate } from 'handlebars';
import type { LangfuseClient } from '@langfuse/client';
import { ServiceError } from '@openapi-typescript-infra/service';

import { resolveTemplateDirectories } from './template-files.js';
import { loadTemplateStore } from './template-loader.js';
import {
  getPromptMetaByName,
  isPartialPromptName,
  isSkillPromptName,
  iterateAllPrompts,
  loadLangfusePartialByName,
  loadLangfuseSkillByName,
  loadProductionTemplates,
} from './sources/langfuse.js';
import {
  loadFilesystemPartialByName,
  loadFilesystemPromptSkills,
  loadFilesystemSkillByName,
  loadFilesystemTemplateByName,
} from './sources/filesystem.js';
import { hasRuleGatedEntries, normalizeSkillName, resolveRuleGatedNames } from './skill-tools.js';
import {
  cacheTemplateVersion,
  createLangfuseTemplate,
  getProductionLabel,
  mergeProductionTemplateIntoStore,
  selectPromptVariant,
} from './template-store.js';
import type {
  LangfuseReloadRequest,
  LangfuseHandlebarsTemplate,
  RuleContext,
  RuleGatedName,
  SkillSpec,
  TemplateApp,
  TemplateDirectories,
  TemplateManagerOptions,
  TemplateStore,
  WeightedPromptGroup,
} from './types.js';

export class TemplateManager implements TemplateStore {
  readonly templates: Record<string, LangfuseHandlebarsTemplate<unknown>> = {};
  readonly promptGroups: Record<string, WeightedPromptGroup<unknown>> = {};
  readonly skills: Record<string, SkillSpec> = {};
  // Fallback prompt→skills bindings read from filesystem prompt yamls, keyed
  // by base template name. Used when a Langfuse-sourced prompt does not
  // declare config.skills.
  private readonly filesystemPromptSkills = new Map<string, RuleGatedName[] | undefined>();

  constructor(
    private readonly app: TemplateApp,
    private readonly options: TemplateManagerOptions,
  ) {}

  static iterateAllPrompts(langfuse: LangfuseClient) {
    return iterateAllPrompts(langfuse);
  }

  async loadTemplates() {
    await loadTemplateStore(
      this.app,
      this.options.langfuse,
      this,
      resolveTemplateDirectories(this.options),
    );
  }

  getSkills(skillNames: string[]) {
    return skillNames.map((name) => {
      const skill = this.skills[name];
      if (!skill) {
        throw new ServiceError(this.app, `Skill ${name} not found`, { status: 400 });
      }
      return skill;
    });
  }

  /**
   * Resolve the skills bound to a prompt (via the top-level `skills` list in
   * a filesystem prompt yaml, or `config.skills` on a Langfuse prompt).
   * When the resolved (e.g. Langfuse production) template does not declare
   * skills, the binding falls back to the local prompt yaml, so promoting a
   * prompt to Langfuse without copying `config.skills` does not silently
   * unbind its skills. An explicit empty `config.skills` list disables the
   * fallback.
   *
   * Binding entries may be rule-gated (`{ name, include?, exclude? }`); rules
   * are evaluated against `options.context`, which is required when any
   * entry carries a rule so gating can never silently no-op.
   *
   * Pass the same `conversationUuid` you will pass to {@link render} so that
   * weighted prompt groups resolve to the same variant in both calls.
   */
  async getPromptSkills(
    templateName: string,
    options?: {
      promptVersion?: number;
      conversationUuid?: string;
      context?: RuleContext;
    },
  ): Promise<SkillSpec[]> {
    const templateInfo = await this.resolveTemplate(templateName, options);
    const entries = templateInfo.skills ?? (await this.getFilesystemPromptSkills(templateName));
    if (!entries?.length) {
      return [];
    }

    if (hasRuleGatedEntries(entries) && !options?.context) {
      throw new ServiceError(
        this.app,
        `Prompt ${templateName} has rule-gated skills; getPromptSkills requires options.context`,
        { status: 500 },
      );
    }

    const skillNames = resolveRuleGatedNames(entries, options?.context ?? { flow: '' });
    return this.getSkills(skillNames);
  }

  private async getFilesystemPromptSkills(templateName: string) {
    if (!this.filesystemPromptSkills.has(templateName)) {
      const directories = resolveTemplateDirectories(this.options);
      this.filesystemPromptSkills.set(
        templateName,
        await loadFilesystemPromptSkills(directories.promptsDir, templateName),
      );
    }
    return this.filesystemPromptSkills.get(templateName);
  }

  async getAndCacheTemplate(templateName: string, version?: number, label?: string) {
    const templateDetail = await this.options.langfuse.prompt.get(
      templateName,
      version ? { version, cacheTtlSeconds: 0 } : label ? { label, cacheTtlSeconds: 0 } : undefined,
    );
    if (!templateDetail) {
      throw new ServiceError(
        this.app,
        `Template ${templateName}${version ? ` (v${version})` : ''}${label ? ` (${label})` : ''} not found`,
        { status: 400 },
      );
    }

    const template = createLangfuseTemplate(templateName, templateDetail, label);
    if (getProductionLabel(templateDetail.labels)) {
      mergeProductionTemplateIntoStore(this, templateName, template, templateDetail.labels);
    } else {
      const current = this.templates[templateName];
      if (!current || (current.version !== -1 && current.version < template.version)) {
        this.templates[templateName] = template;
      }
    }
    cacheTemplateVersion(this, templateName, template);
    return template;
  }

  async reloadFromLangfuse(update: LangfuseReloadRequest = {}) {
    if (!update.promptName) {
      this.clearStore();
      await this.loadTemplates();
      return;
    }

    const directories = resolveTemplateDirectories(this.options);

    if (isPartialPromptName(update.promptName)) {
      await this.reloadPartialFromLangfuse(update.promptName, directories);
      return;
    }

    if (isSkillPromptName(update.promptName)) {
      await this.reloadSkillFromLangfuse(update.promptName, directories);
      return;
    }

    await this.reloadPromptFromLangfuse({ ...update, promptName: update.promptName }, directories);
  }

  async render<T>(
    template: string | TemplateDelegate<T>,
    data: T,
    placeholders: Record<string, ModelMessage[]> | undefined,
    options?: {
      promptVersion?: number;
      conversationUuid?: string;
    },
  ): Promise<{
    messages: ModelMessage[];
    config?: LangfuseHandlebarsTemplate['config'];
    metadata?: Record<string, string>;
  }> {
    if (typeof template === 'string') {
      const templateInfo = await this.resolveTemplate(template, options);
      const messages = templateInfo
        .delegate(data, placeholders)
        .filter((message) => message.content);
      return {
        messages,
        config: templateInfo.config,
        metadata: {
          langfusePrompt: templateInfo.tag,
        },
      };
    }

    const raw = template(data);
    const messages = raw.split('---').map<ModelMessage>((message) => {
      const [role, ...content] = message
        .trim()
        .split('\n')
        .map((line) => line.trim());
      if (role.startsWith('role:')) {
        return {
          role: role.replace('role:', '').trim() as 'system' | 'user' | 'assistant',
          content: content.join('\n'),
        };
      }
      return { role: 'user', content: message.trim() };
    });

    return { messages };
  }

  private async resolveTemplate(
    templateName: string,
    options?: {
      promptVersion?: number;
      conversationUuid?: string;
    },
  ) {
    if (options?.promptVersion && this.templates[templateName]?.version !== options.promptVersion) {
      return this.getAndCacheTemplate(templateName, options.promptVersion);
    }

    if (!this.templates[templateName] && !this.promptGroups[templateName]) {
      await this.getAndCacheTemplate(templateName);
    }

    const templateInfo = this.templates[templateName];
    if (templateInfo) {
      return templateInfo;
    }

    const group = this.promptGroups[templateName];
    if (group) {
      return selectPromptVariant(options?.conversationUuid || randomUUID(), group);
    }

    throw new ServiceError(this.app, `Template ${templateName} not found`, { status: 400 });
  }

  private clearStore() {
    clearRecord(this.templates);
    clearRecord(this.promptGroups);
    clearRecord(this.skills);
    this.filesystemPromptSkills.clear();
  }

  private async reloadPartialFromLangfuse(promptName: string, directories: TemplateDirectories) {
    const partialName = promptName.replace(/partial[:/]/, '');
    const localPartial = loadFilesystemPartialByName(directories.promptsDir, partialName);

    if (localPartial) {
      handlebars.registerPartial(partialName, localPartial.code);
      return;
    }

    const langfusePartial = await loadLangfusePartialByName(
      this.app,
      this.options.langfuse,
      promptName,
    );
    if (langfusePartial) {
      handlebars.registerPartial(partialName, langfusePartial.code);
      return;
    }

    handlebars.unregisterPartial(partialName);
  }

  private async reloadSkillFromLangfuse(promptName: string, directories: TemplateDirectories) {
    const skillPath = promptName.replace(/skill[:/]/, '');
    const skillName = normalizeSkillName(skillPath);

    delete this.skills[skillName];

    const hasLocalSkill = await loadFilesystemSkillByName(
      this.app,
      this,
      directories.skillsDir,
      skillPath,
    );
    if (hasLocalSkill) {
      return;
    }

    const langfuseSkill = await loadLangfuseSkillByName(
      this.app,
      this.options.langfuse,
      promptName,
    );
    if (langfuseSkill) {
      this.skills[skillName] = langfuseSkill;
    }
  }

  private async reloadPromptFromLangfuse(
    update: Required<Pick<LangfuseReloadRequest, 'promptName'>> & LangfuseReloadRequest,
    directories: TemplateDirectories,
  ) {
    const templateName = update.promptName;

    this.clearTemplateEntries(templateName);
    this.filesystemPromptSkills.delete(templateName);
    await loadFilesystemTemplateByName(this.app, this, directories.promptsDir, templateName);

    const promptMeta = await getPromptMetaByName(this.options.langfuse, templateName);
    const productionLabels =
      promptMeta?.labels.filter((label) => label.startsWith('production')) ?? [];

    if (productionLabels.length > 0) {
      await loadProductionTemplates(
        this.app,
        this.options.langfuse,
        this,
        new Map([[templateName, productionLabels]]),
      );
      return;
    }

    if (this.templates[templateName]?.version === -1) {
      return;
    }

    const promptDetail = await this.options.langfuse.prompt.get(
      templateName,
      update.version
        ? { version: update.version, cacheTtlSeconds: 0 }
        : update.label
          ? { label: update.label, cacheTtlSeconds: 0 }
          : undefined,
    );

    if (!promptDetail) {
      return;
    }

    const template = createLangfuseTemplate(templateName, promptDetail, update.label);
    this.templates[templateName] = template;
    cacheTemplateVersion(this, templateName, template);
  }

  private clearTemplateEntries(templateName: string) {
    delete this.templates[templateName];
    delete this.promptGroups[templateName];

    for (const key of Object.keys(this.templates)) {
      if (key.startsWith(`${templateName}::`) || key.startsWith(`${templateName}#`)) {
        delete this.templates[key];
      }
    }
  }
}

export { selectPromptVariant } from './template-store.js';

function clearRecord<T>(record: Record<string, T>) {
  for (const key of Object.keys(record)) {
    delete record[key];
  }
}
