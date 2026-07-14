import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '../../../shared/view/ui';
import SettingsCard from '../../settings/view/SettingsCard';
import SettingsRow from '../../settings/view/SettingsRow';
import SettingsSection from '../../settings/view/SettingsSection';
import { MCP_PROVIDER_NAMES } from '../constants';
import { useMcpOverview } from '../hooks/useMcpOverview';

/**
 * Read-only, cross-CLI roll-up of installed MCP servers. Shows the user what
 * they already have and where, before any 1.42 write flow. Never mutates config.
 */
export default function McpOverview() {
  const { t } = useTranslation();
  const { rows, loading, errors } = useMcpOverview(true);

  return (
    <SettingsSection
      className="mb-6"
      title={t('mcpOverview.title', { defaultValue: 'MCP 全景（跨 CLI 只读）' })}
      description={t('mcpOverview.description', {
        defaultValue: '汇总各 Agent CLI 账户级已安装的 MCP 服务器，按名称去重。仅查看，不做修改。',
      })}
    >
      {errors.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {t('mcpOverview.partialError', { defaultValue: '部分 CLI 配置未能读取：' })}
          {errors.join('；')}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <SettingsCard divided>
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="flex items-center justify-between gap-4 px-4 py-4">
              <div className="skeleton h-4 w-40 rounded" />
              <div className="skeleton h-5 w-24 rounded" />
            </div>
          ))}
        </SettingsCard>
      ) : rows.length === 0 ? (
        <SettingsCard>
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {t('mcpOverview.empty', { defaultValue: '还没有检测到任何已安装的 MCP 服务器。' })}
          </div>
        </SettingsCard>
      ) : (
        <SettingsCard divided>
          {rows.map((row) => (
            <SettingsRow
              key={row.name}
              label={row.name}
              description={row.transports.length > 0 ? row.transports.join(' · ') : undefined}
            >
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                {row.managed && (
                  <Badge variant="outline" className="gap-1 text-muted-foreground">
                    <Lock className="h-3 w-3" />
                    {t('mcpOverview.managed', { defaultValue: '托管' })}
                  </Badge>
                )}
                {row.providers.map((provider) => (
                  <Badge key={provider} variant="secondary">
                    {MCP_PROVIDER_NAMES[provider]}
                  </Badge>
                ))}
              </div>
            </SettingsRow>
          ))}
        </SettingsCard>
      )}
    </SettingsSection>
  );
}
