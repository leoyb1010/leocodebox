import { useTranslation } from 'react-i18next';
import { DarkModeToggle } from '../../../../shared/view/ui';
import type { CodeEditorSettingsState, ProjectSortOrder } from '../../types/types';
import LanguageSelector from '../../../../shared/view/ui/LanguageSelector';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';
import { useAppPreferences } from '../../../../contexts/PreferencesContext';

type AppearanceSettingsTabProps = {
  projectSortOrder: ProjectSortOrder;
  onProjectSortOrderChange: (value: ProjectSortOrder) => void;
  codeEditorSettings: CodeEditorSettingsState;
  onCodeEditorWordWrapChange: (value: boolean) => void;
  onCodeEditorShowMinimapChange: (value: boolean) => void;
  onCodeEditorLineNumbersChange: (value: boolean) => void;
  onCodeEditorFontSizeChange: (value: string) => void;
};

export default function AppearanceSettingsTab({
  projectSortOrder,
  onProjectSortOrderChange,
  codeEditorSettings,
  onCodeEditorWordWrapChange,
  onCodeEditorShowMinimapChange,
  onCodeEditorLineNumbersChange,
  onCodeEditorFontSizeChange,
}: AppearanceSettingsTabProps) {
  const { t } = useTranslation('settings');
  const { preferences, saving, updatePreferences } = useAppPreferences();

  return (
    <div className="space-y-8">
      <SettingsSection title="本地 Agent 默认值">
        <SettingsCard divided>
          <SettingsRow label="默认 Agent" description="新会话默认使用的本地 Agent CLI">
            <select
              value={preferences.defaultProvider}
              disabled={saving}
              onChange={(event) => void updatePreferences({ defaultProvider: event.target.value as typeof preferences.defaultProvider })}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-40"
            >
              <option value="codex">Codex</option>
              <option value="opencode">OpenCode</option>
              <option value="claude">Claude Code</option>
              <option value="cursor">Cursor Agent</option>
            </select>
          </SettingsRow>
          <SettingsRow label="默认模型" description="留空时使用 Agent CLI 自身默认模型">
            <input
              key={`${preferences.defaultProvider}:${preferences.defaultModel}`}
              defaultValue={preferences.defaultModel}
              disabled={saving}
              placeholder="CLI 默认"
              onBlur={(event) => void updatePreferences({ defaultModel: event.target.value })}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-52"
            />
          </SettingsRow>
          <SettingsRow label="默认权限模式" description="新会话启动时采用的工具授权策略">
            <select
              value={preferences.permissionMode}
              disabled={saving}
              onChange={(event) => void updatePreferences({ permissionMode: event.target.value as typeof preferences.permissionMode })}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-40"
            >
              <option value="default">每次确认</option>
              <option value="acceptEdits">自动接受编辑</option>
              <option value="bypassPermissions">跳过权限确认</option>
              <option value="plan">只读规划</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="界面密度与强调色">
        <SettingsCard divided>
          <SettingsRow label="信息密度" description="重度使用推荐紧凑模式">
            <select
              value={preferences.density}
              disabled={saving}
              onChange={(event) => void updatePreferences({ density: event.target.value as typeof preferences.density })}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-36"
            >
              <option value="compact">紧凑</option>
              <option value="comfortable">舒适</option>
            </select>
          </SettingsRow>
          <SettingsRow label="强调色" description="用于选择、焦点和主要操作">
            <select
              value={preferences.accent}
              disabled={saving}
              onChange={(event) => void updatePreferences({ accent: event.target.value as typeof preferences.accent })}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-36"
            >
              <option value="blue">蓝色</option>
              <option value="green">绿色</option>
              <option value="amber">琥珀色</option>
            </select>
          </SettingsRow>
          <SettingsRow label="减少动态效果" description="关闭非必要过渡和位移动画">
            <SettingsToggle
              checked={preferences.reduceMotion}
              onChange={(value) => void updatePreferences({ reduceMotion: value })}
              ariaLabel="减少动态效果"
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.darkMode.label')}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.darkMode.label')}
            description={t('appearanceSettings.darkMode.description')}
          >
            <DarkModeToggle ariaLabel={t('appearanceSettings.darkMode.label')} />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('mainTabs.appearance')}>
        <SettingsCard>
          <LanguageSelector />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.projectSorting.label')}>
        <SettingsCard>
          <SettingsRow
            label={t('appearanceSettings.projectSorting.label')}
            description={t('appearanceSettings.projectSorting.description')}
          >
            <select
              value={projectSortOrder}
              onChange={(event) => onProjectSortOrderChange(event.target.value as ProjectSortOrder)}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground touch-manipulation focus:border-primary focus:ring-1 focus:ring-primary sm:w-36"
            >
              <option value="name">{t('appearanceSettings.projectSorting.alphabetical')}</option>
              <option value="date">{t('appearanceSettings.projectSorting.recentActivity')}</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('appearanceSettings.codeEditor.title')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('appearanceSettings.codeEditor.wordWrap.label')}
            description={t('appearanceSettings.codeEditor.wordWrap.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.wordWrap}
              onChange={onCodeEditorWordWrapChange}
              ariaLabel={t('appearanceSettings.codeEditor.wordWrap.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.showMinimap.label')}
            description={t('appearanceSettings.codeEditor.showMinimap.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.showMinimap}
              onChange={onCodeEditorShowMinimapChange}
              ariaLabel={t('appearanceSettings.codeEditor.showMinimap.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.lineNumbers.label')}
            description={t('appearanceSettings.codeEditor.lineNumbers.description')}
          >
            <SettingsToggle
              checked={codeEditorSettings.lineNumbers}
              onChange={onCodeEditorLineNumbersChange}
              ariaLabel={t('appearanceSettings.codeEditor.lineNumbers.label')}
            />
          </SettingsRow>

          <SettingsRow
            label={t('appearanceSettings.codeEditor.fontSize.label')}
            description={t('appearanceSettings.codeEditor.fontSize.description')}
          >
            <select
              value={codeEditorSettings.fontSize}
              onChange={(event) => onCodeEditorFontSizeChange(event.target.value)}
              className="w-full rounded-lg border border-input bg-card p-2.5 text-sm text-foreground touch-manipulation focus:border-primary focus:ring-1 focus:ring-primary sm:w-28"
            >
              <option value="10">10px</option>
              <option value="11">11px</option>
              <option value="12">12px</option>
              <option value="13">13px</option>
              <option value="14">14px</option>
              <option value="15">15px</option>
              <option value="16">16px</option>
              <option value="18">18px</option>
              <option value="20">20px</option>
            </select>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
