import { Bot, Braces, Sparkles, TerminalSquare } from 'lucide-react';

import type { LLMProvider } from '../../types/app';

import ClaudeLogo from './ClaudeLogo';
import CodexLogo from './CodexLogo';
import CursorLogo from './CursorLogo';
import OpenCodeLogo from './OpenCodeLogo';

type SessionProviderLogoProps = {
  provider?: LLMProvider | string | null;
  className?: string;
};

export default function SessionProviderLogo({
  provider = 'claude',
  className = 'w-5 h-5',
}: SessionProviderLogoProps) {
  if (provider === 'cursor') {
    return <CursorLogo className={className} />;
  }

  if (provider === 'codex') {
    return <CodexLogo className={className} />;
  }

  if (provider === 'opencode') {
    return <OpenCodeLogo className={className} />;
  }

  if (provider === 'gemini') {
    return <Sparkles aria-label="Gemini CLI" className={`${className} text-info`} />;
  }

  if (provider === 'hermes') {
    return <TerminalSquare aria-label="Hermes Agent" className={`${className} text-warning`} />;
  }

  if (provider === 'grok') {
    return <Braces aria-label="Grok Build" className={`${className} text-zinc-800 dark:text-zinc-100`} />;
  }

  if (provider === 'antigravity') {
    return <Bot aria-label="Antigravity" className={`${className} text-indigo-500`} />;
  }

  if (provider === 'claude') return <ClaudeLogo className={className} />;
  return <TerminalSquare aria-label={String(provider || 'Agent')} className={`${className} text-muted-foreground`} />;
}
