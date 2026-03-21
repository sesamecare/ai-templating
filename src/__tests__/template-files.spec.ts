import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  getPartialNameFromFile,
  getPromptNameFromFile,
  getSkillNameFromFile,
  resolveTemplateDirectories,
} from '../template-files.js';

describe('template file naming', () => {
  test('derives prompt names from relative yaml paths', () => {
    const promptsDir = path.join('/repo', 'prompts');
    const file = path.join(promptsDir, 'patient', 'base-prompt.yaml');

    expect(getPromptNameFromFile(promptsDir, file)).toBe('patient/base-prompt');
  });

  test('derives partial names from relative partial paths', () => {
    const promptsDir = path.join('/repo', 'prompts');
    const file = path.join(promptsDir, 'shared', 'header.partial.hbs');

    expect(getPartialNameFromFile(promptsDir, file)).toBe('shared/header');
  });

  test('derives skill names using underscore separators', () => {
    const skillsDir = path.join('/repo', 'skills');
    const file = path.join(skillsDir, 'patient', 'triage.yaml');

    expect(getSkillNameFromFile(skillsDir, file)).toBe('patient_triage');
  });
});

describe('resolveTemplateDirectories', () => {
  test('defaults to prompts and skills directories under the provided root', () => {
    expect(resolveTemplateDirectories({ langfuse: {} as never, rootDir: '/repo' })).toEqual({
      promptsDir: path.join('/repo', 'prompts'),
      skillsDir: path.join('/repo', 'skills'),
    });
  });
});
