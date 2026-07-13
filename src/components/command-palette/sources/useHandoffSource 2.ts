import { useCallback, useState } from 'react';

import { apiClient } from '../../../utils/apiClient';
import type { LLMProvider } from '../../../types/app';

export const HANDOFF_TARGET_PROVIDERS: LLMProvider[] = ['claude', 'codex', 'cursor', 'opencode'];

type HistoryMessage = {
  kind?: string;
  role?: 'user' | 'assistant';
  content?: string;
};

type HistoryResponse = {
  success?: boolean;
  data?: { messages?: HistoryMessage[] };
};

const MAX_CONTEXT_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 1200;

/**
 * The dumbest handoff that works: recent messages quoted verbatim under a
 * short preamble. No summarization — the user edits the draft before sending.
 */
export function buildHandoffText(sourceProvider: string, messages: HistoryMessage[]): string {
  const transcript = messages
    .filter((message) => (message.role === 'user' || message.role === 'assistant')
      && typeof message.content === 'string' && message.content.trim())
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((message) => {
      const text = message.content!.trim();
      const clipped = text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
      return `[${message.role}] ${clipped}`;
    })
    .join('\n\n');

  return [
    `【接力】以下上下文来自另一个 ${sourceProvider} 会话，请基于它继续工作。`,
    '',
    transcript || '（原会话暂无可引用的文本消息）',
    '',
    '接着做：',
    '',
  ].join('\n');
}

export function useHandoffSource() {
  const [preparing, setPreparing] = useState(false);

  const prepare = useCallback(async (sessionId: string, sourceProvider: string): Promise<string> => {
    setPreparing(true);
    try {
      const response = await apiClient.get<HistoryResponse>(
        `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages`,
        { limit: 40 },
      );
      const messages = response?.data?.messages ?? [];
      return buildHandoffText(sourceProvider, messages);
    } finally {
      setPreparing(false);
    }
  }, []);

  return { prepare, preparing };
}
