import { ExternalLink } from 'lucide-react';

import { LEOCODEBOX_WORDMARK_FONT_FAMILY } from '../../../../../../constants/branding';
import type { ReleaseInfo } from '../../../../../../types/sharedTypes';

type VersionInfoSectionProps = {
  currentVersion: string;
  updateAvailable: boolean;
  latestVersion: string | null;
  releaseInfo: ReleaseInfo | null;
};

export default function VersionInfoSection({
  currentVersion,
  updateAvailable,
  latestVersion,
  releaseInfo,
}: VersionInfoSectionProps) {
  return (
    <div className="border-t border-border/50 pt-6">
      <div className="flex items-center gap-3">
        <img src="/logo.svg" alt="leocodebox" className="h-9 w-9" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold" style={{ fontFamily: LEOCODEBOX_WORDMARK_FONT_FAMILY }}>
              leocodebox
            </span>
            <span className="rounded-md bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">v{currentVersion}</span>
            {updateAvailable && latestVersion && (
              <span className="rounded-md bg-green-500/10 px-2 py-0.5 text-[10px] text-green-600 dark:text-green-400">
                可更新到 {latestVersion}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">本地模式，无账号和云端同步依赖</p>
        </div>
      </div>
      {releaseInfo?.htmlUrl && (
        <a
          href={releaseInfo.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          查看版本信息 <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}
