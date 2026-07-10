import { ExternalLink } from 'lucide-react';

import { LEOCODEBOX_WORDMARK_FONT_FAMILY } from '../../../../constants/branding';
import { useVersionCheck } from '../../../../hooks/useVersionCheck';

const OWNER_URL = 'https://github.com/leoyuan';

export default function AboutTab() {
  const { currentVersion } = useVersionCheck('siteboon', 'claudecodeui');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <img src="/logo.svg" alt="leocodebox" className="h-10 w-10" />
        <div>
          <div className="flex items-center gap-2">
            <span
              className="text-base font-semibold text-foreground"
              style={{ fontFamily: LEOCODEBOX_WORDMARK_FONT_FAMILY }}
            >
              leocodebox
            </span>
            <span className="rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              v{currentVersion}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">本地多智能体开发工作台</p>
        </div>
      </div>

      <div className="border-y border-border/50 py-4 text-sm text-muted-foreground">
        <p>所有 Agent CLI、会话、配置与凭据均在本机运行和保存，不依赖云端账户。</p>
      </div>

      <a
        href={OWNER_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        个人主页
        <ExternalLink className="h-3.5 w-3.5" />
      </a>

      <div className="flex gap-4 text-xs text-muted-foreground/70">
        <a href="/LICENSE" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">LICENSE</a>
        <a href="/NOTICE" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">NOTICE 与第三方声明</a>
      </div>
    </div>
  );
}
