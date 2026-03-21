import { readFileSync } from 'node:fs';
import path from 'node:path';

import $RefParser from '@apidevtools/json-schema-ref-parser';

import type { TemplateDirectories, TemplateManagerOptions } from './types.js';

export function resolveTemplateDirectories(
  options: Pick<TemplateManagerOptions, 'rootDir'> = {},
): TemplateDirectories {
  const rootDir = options.rootDir ?? process.cwd();

  return {
    promptsDir: path.join(rootDir, 'prompts'),
    skillsDir: path.join(rootDir, 'skills'),
  };
}

export function getPromptNameFromFile(rootDir: string, file: string) {
  const relativePath = toRelativePosixPath(rootDir, file);
  return relativePath.slice(0, -path.extname(relativePath).length);
}

export function getSkillNameFromFile(rootDir: string, file: string) {
  return getPromptNameFromFile(rootDir, file).replace(/\//g, '_');
}

export function getPartialNameFromFile(rootDir: string, file: string) {
  return toRelativePosixPath(rootDir, file).replace(/\.partial\.hbs$/, '');
}

export async function derefTemplateFile<T>(file: string) {
  const parser = new $RefParser();
  return (await parser.dereference(file, {
    resolve: {
      file: {
        read(input: { url: string }) {
          return readFileSync(input.url, 'utf-8');
        },
      },
    },
  })) as unknown as T;
}

function toRelativePosixPath(rootDir: string, file: string) {
  return path.relative(rootDir, file).split(path.sep).join('/');
}
