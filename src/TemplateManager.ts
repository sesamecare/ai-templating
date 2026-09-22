import { randomUUID } from 'node:crypto';

import handlebars from 'handlebars';
import type { ModelMessage } from 'ai';
import type { TemplateDelegate } from 'handlebars';
import type { LangfuseClient } from '@langfuse/client';
import { ServiceError } from '@openapi-typescript-infra/service';

import { resolveTemplateDirectories } from './template-files.js';
import { loadTemplateStore } from './template-loader.js';
import {
  buildSkillSpecFromLangfusePrompt,
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
  getVersionedTemplateKey,
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
  TemplateResolveOptions,
  TemplateStore,
  WeightedPromptGroup,
} from './types.js';

const DEFAULT_LABEL_RESOLUTION_CACHE_TTL_MS = 30_000;

export class TemplateManager implements TemplateStore {
  readonly templates: Record<string, LangfuseHandlebarsTemplate<unknown>> = {};
  readonly promptGroups: Record<string, WeightedPromptGroup<unknown>> = {};
  readonly skills: Record<string, SkillSpec> = {};
  // Fallback prompt→skills bindings read from filesystem prompt yamls, keyed
  // by base template name. Used when a Langfuse-sourced prompt does not
  // declare config.skills.
  private readonly filesystemPromptSkills = new Map<string, RuleGatedName[] | undefined>();
  // Cached label→version resolutions (see TemplateResolveOptions.label),
  // keyed by `${templateName}::label:${label}`. `version: undefined` caches
  // a miss (label doesn't exist / lookup failed) so a still-missing label
  // doesn't hit Langfuse on every call either.
  private readonly labelResolutionCache = new Map<
    string,
    { version: number | undefined; expiresAt: number }
  >();
  // Cached label->SkillSpec resolutions (see getSkills), keyed by
  // `${langfuseName}::label:${label}`. `skill: undefined` caches a miss.
  private readonly labeledSkillCache = new Map<
    string,
    { skill: SkillSpec | undefined; expiresAt: number }
  >();

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

  /**
   * Resolve skill specs by name. With `options.label`, each skill that was
   * loaded from Langfuse is re-resolved at that label instead of its
   * default/loaded body (e.g. a client-tier pin like `channel-mobile`) —
   * the same label a prompt resolves against, applied to its skills too.
   * Skills with no Langfuse origin (filesystem-only) have no labeled
   * variants and always return their single loaded body. A label that
   * doesn't exist for a given skill falls back to that default body rather
   * than failing — see {@link resolveLabeledSkill}.
   */
  async getSkills(skillNames: string[], options?: { label?: string }): Promise<SkillSpec[]> {
    return Promise.all(skillNames.map((name) => this.resolveSkill(name, options?.label)));
  }

  private async resolveSkill(name: string, label: string | undefined): Promise<SkillSpec> {
    const skill = this.skills[name];
    if (!skill) {
      throw new ServiceError(this.app, `Skill ${name} not found`, { status: 400 });
    }
    if (!label || !skill.langfuseName) {
      return skill;
    }
    const labeled = await this.resolveLabeledSkill(skill.langfuseName, label);
    return labeled ?? skill;
  }

  /**
   * Resolve an explicit-label variant of a Langfuse-sourced skill. Mirrors
   * {@link resolveLabeledTemplate}: cached with a short TTL (including a
   * cached miss), and never falls back to throwing — a label that doesn't
   * exist for this skill just isn't found here, letting the caller use the
   * default body instead.
   */
  private async resolveLabeledSkill(langfuseName: string, label: string) {
    const cacheKey = `${langfuseName}::label:${label}`;
    const cached = this.labeledSkillCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.skill;
    }

    const ttlMs = this.options.labelResolutionCacheTtlMs ?? DEFAULT_LABEL_RESOLUTION_CACHE_TTL_MS;
    let skill: SkillSpec | undefined;
    try {
      const promptDetail = await this.options.langfuse.prompt.get(langfuseName, {
        label,
        cacheTtlSeconds: 0,
      });
      skill = promptDetail
        ? buildSkillSpecFromLangfusePrompt(this.app, langfuseName, promptDetail)
        : undefined;
    } catch (error) {
      this.app.locals.logger.warn(
        {
          langfuseName,
          label,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        'Labeled skill lookup failed; falling back to default resolution',
      );
      skill = undefined;
    }

    this.labeledSkillCache.set(cacheKey, { skill, expiresAt: Date.now() + ttlMs });
    return skill;
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
    options?: TemplateResolveOptions & { context?: RuleContext },
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
    return this.getSkills(skillNames, { label: options?.label });
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
    options?: TemplateResolveOptions,
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

  private async resolveTemplate(templateName: string, options?: TemplateResolveOptions) {
    if (options?.promptVersion && this.templates[templateName]?.version !== options.promptVersion) {
      return this.getAndCacheTemplate(templateName, options.promptVersion);
    }

    if (options?.label) {
      const labeled = await this.resolveLabeledTemplate(templateName, options.label);
      if (labeled) {
        return labeled;
      }
      // Fall through to default/production resolution below: a label that
      // doesn't exist yet for this prompt (e.g. a client-tier pin like
      // "channel-mobile" not created for every prompt from day one) must
      // never fail the whole request.
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

  /**
   * Resolve a template pinned to an explicit, non-`production*` Langfuse
   * label (e.g. a client-tier pin like `channel-mobile`). Label→version
   * lookups are cached for `labelResolutionCacheTtlMs` (default 30s) since,
   * unlike an explicit `promptVersion`, a label's target version can move at
   * any time and every caller passing the same label would otherwise hit
   * Langfuse live on every call.
   *
   * This intentionally never writes to `this.templates[templateName]` (the
   * shared default/production pointer) — only to the version-keyed cache —
   * so a labeled lookup can never clobber what unlabeled callers resolve to.
   *
   * Returns `undefined` (never throws) when the label doesn't exist for this
   * prompt, or the lookup otherwise fails — callers are expected to fall
   * back to default/production resolution rather than fail the request.
   * A miss is cached too, so a still-missing label doesn't hit Langfuse on
   * every call either.
   */
  private async resolveLabeledTemplate(templateName: string, label: string) {
    const cacheKey = `${templateName}::label:${label}`;
    const cached = this.labelResolutionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.version === undefined) {
        return undefined;
      }
      const versioned = this.templates[getVersionedTemplateKey(templateName, cached.version)];
      if (versioned) {
        return versioned;
      }
    }

    const ttlMs = this.options.labelResolutionCacheTtlMs ?? DEFAULT_LABEL_RESOLUTION_CACHE_TTL_MS;
    try {
      const template = await this.getAndCacheLabeledTemplate(templateName, label);
      this.labelResolutionCache.set(cacheKey, { version: template.version, expiresAt: Date.now() + ttlMs });
      return template;
    } catch (error) {
      this.app.locals.logger.warn(
        {
          templateName,
          label,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        'Labeled template lookup failed; falling back to default resolution',
      );
      this.labelResolutionCache.set(cacheKey, { version: undefined, expiresAt: Date.now() + ttlMs });
      return undefined;
    }
  }

  private async getAndCacheLabeledTemplate(templateName: string, label: string) {
    const templateDetail = await this.options.langfuse.prompt.get(templateName, {
      label,
      cacheTtlSeconds: 0,
    });
    if (!templateDetail) {
      throw new ServiceError(this.app, `Template ${templateName} (${label}) not found`, {
        status: 400,
      });
    }

    const template = createLangfuseTemplate(templateName, templateDetail, label);
    cacheTemplateVersion(this, templateName, template);
    return template;
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
