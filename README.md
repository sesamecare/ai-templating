# ai-templating

`@sesamecare-oss/ai-templating` loads prompts and skills for [Typescript services](/openapi-typescript-infra/service) from:

- local files under `private/prompts` and `private/skills`
- Langfuse prompts, partials, and skills

It compiles prompts with Handlebars, registers a shared helper set, supports Langfuse production variants, and exposes a small `TemplateManager` API for service code.

## Common Use Case

The normal pattern is:

1. Create a Langfuse client
2. Construct a `TemplateManager`
3. Load templates during service startup
4. Render prompts by name inside request or workflow code

```ts
import path from 'node:path';

import { TemplateManager } from '@sesamecare-oss/ai-templating';

export async function start(app: AgentApp) {
  const templates = new TemplateManager(app, {
    langfuse: app.locals.langfuse,
    rootDir: path.join(process.cwd(), 'private'),
  });

  await templates.loadTemplates();
  app.locals.templates = templates;
}
```

Later, render a prompt:

```ts
const { messages, config, metadata } = await app.locals.templates.render(
  'patient/base-prompt',
  {
    patientName: 'Ada Lovelace',
    appointmentDate: '2026-03-21T14:00:00.000Z',
  },
  {
    conversation: priorMessages,
  },
  {
    conversationUuid: '7d1a227d-bf49-4fcb-9db0-04f7c767d0b0',
  },
);
```

`render()` returns:

- `messages`: the final AI SDK `ModelMessage[]`
- `config`: model config attached to the prompt when present
- `metadata.langfusePrompt`: the serialized Langfuse prompt tag for tracing

## Requirements

`TemplateManager` expects a service-style app object whose `locals` include:

- `logger` from `@openapi-typescript-infra/service`

The Langfuse client is passed explicitly in `TemplateManagerOptions.langfuse`.

Missing templates or skills throw `ServiceError` with status `400`.

## Directory Layout

`rootDir` is the directory that contains `prompts/` and `skills/`.

By default the package looks for:

- `<rootDir>/prompts`
- `<rootDir>/skills`

Example:

```ts
const templates = new TemplateManager(app, {
  langfuse,
  rootDir: '/srv/service/private',
});
```

Typical local layout:

```text
private/
  prompts/
    patient/
      base-prompt.yaml
      base-prompt.hbs
    shared/
      header.partial.hbs
  skills/
    patient/
      triage.yaml
```

Prompt and skill names are derived from paths relative to the configured `rootDir`:

- `private/prompts/patient/base-prompt.yaml` -> `patient/base-prompt`
- `private/prompts/shared/header.partial.hbs` -> partial `shared/header`
- `private/skills/patient/triage.yaml` -> skill `patient_triage`

## Local Prompt Example

`private/prompts/patient/base-prompt.yaml`

```yaml
messages:
  - role: system
    content:
      $ref: ./base-prompt.hbs
config:
  model: gpt-4.1
  temperature: 0
  topK: 0
  topP: 1
```

`private/prompts/patient/base-prompt.hbs`

```hbs
{{> shared/header}}

You are helping {{patientName}}.
The appointment is scheduled for {{formatDate appointmentDate}}.
```

`private/prompts/shared/header.partial.hbs`

```hbs
Be direct, accurate, and concise.
```

## Local Skill Example

`private/skills/patient/triage.yaml`

```yaml
description: Decide which patient support workflow should be used.
detail: |
  Use this skill when the user is asking to schedule, reschedule, cancel,
  or clarify an appointment-related request.
tools:
  - appointments_search
  - appointments_reschedule
```

Load skills by name:

```ts
const [triageSkill] = app.locals.templates.getSkills(['patient_triage']);
```

## Langfuse Conventions

The package treats certain Langfuse prompt names specially.

### Standard prompts

Use the prompt name directly, for example:

- `patient/base-prompt`

Production labels control which Langfuse version is loaded:

- `production`
- `production-canary`
- `production-whatever`

If multiple production labels exist for the same prompt name, they are grouped and selected deterministically per `conversationUuid`. Variant weights come from `config.promptWeight`.

### Partials

Name partial prompts with either:

- `partial:shared/header`
- `partial/shared/header`

These become Handlebars partials named `shared/header`.

### Skills

Name skill prompts with either:

- `skill:patient/triage`
- `skill/patient/triage`

For Langfuse skills:

- prompt text becomes `detail`
- `config.description` is required
- `config.tools` is optional and must be an array of strings

## Public API

The main API surface is intentionally small:

### `new TemplateManager(app, options)`

Construct the manager. `options` supports:

- `langfuse`
- `rootDir`

### `await templates.loadTemplates()`

Loads local templates, local skills, Langfuse inventory, partials, and production prompts into memory.

### `await templates.render(name, data, placeholders?, options?)`

Renders a template by name.

Options:

- `promptVersion`: force a specific Langfuse version
- `conversationUuid`: stable seed for weighted variant selection

### `templates.getSkills(names)`

Returns skill specs in the requested order.

### `await templates.getAndCacheTemplate(name, version?, label?)`

Fetches a Langfuse template directly and stores it in the in-memory cache.

### `await templates.reloadFromLangfuse(update?)`

Refreshes templates, skills, or partials from Langfuse.

- with `promptName`, it reloads only the affected prompt when possible
- without `promptName`, it falls back to a full reload

## Built-in Helpers

The package registers:

- the helper set from `handlebars-helpers`
- `howLongAgo(date)`
- `formatDate(date, format?)`
- `formatCents(cents)`
- `eq(a, b)`

These are available to both filesystem prompts and Langfuse prompts.

## Notes

- Node `>=22` is required.
- The package is designed for service environments built on `@openapi-typescript-infra/service`.
- `TemplateManager.iterateAllPrompts(langfuse)` is exported if you need raw Langfuse prompt inventory iteration.
