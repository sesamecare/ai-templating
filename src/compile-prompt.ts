import handlebars from 'handlebars';
import type { RuntimeOptions } from 'handlebars';
import { ChatMessageType } from '@langfuse/client';
import type { ChatPromptClient, TextPromptClient } from '@langfuse/client';
import type { ModelMessage } from 'ai';

import type { LangfuseTemplateDelegate } from './types.js';

export function compileLangfusePrompt<T>(
  promptDetail:
    | Pick<TextPromptClient, 'type' | 'prompt'>
    | Pick<ChatPromptClient, 'prompt' | 'type'>,
): LangfuseTemplateDelegate<T> {
  if (promptDetail.type === 'chat') {
    const promptMessages = promptDetail.prompt as ChatPromptClient['prompt'];
    const compiledHandlebars = promptMessages.map((message) => {
      if (message.type === ChatMessageType.Placeholder) {
        return message.name;
      }

      const chatMessage = message as { role: ModelMessage['role']; content: string };

      return {
        role: chatMessage.role as ModelMessage['role'],
        template: handlebars.compile(chatMessage.content),
      };
    });

    return function renderChatPrompt(
      context: T,
      placeholders: Record<string, ModelMessage[]> | undefined,
      options?: RuntimeOptions,
    ) {
      const messages: ModelMessage[] = [];
      for (const entry of compiledHandlebars) {
        if (typeof entry === 'string') {
          messages.push(...(placeholders?.[entry] ?? []));
          continue;
        }

        messages.push({
          role: entry.role,
          content: entry.template(context, options),
        } as unknown as ModelMessage);
      }

      return messages;
    };
  }

  const template = handlebars.compile(promptDetail.prompt);
  return (
    context: T,
    placeholders: Record<string, ModelMessage[]> | undefined,
    options?: RuntimeOptions,
  ) => {
    void placeholders;

    return [
      {
        role: 'user',
        content: template(context, options),
      },
    ];
  };
}
