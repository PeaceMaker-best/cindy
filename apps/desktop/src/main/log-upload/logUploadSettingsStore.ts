/**
 * 「崩溃时自动上传日志」开关的持久层。
 *
 * File: `<userData>/log-upload-settings.json`
 *
 * 为什么单独一份文件、不并进 `analytics-settings.json`：那份文件承载的是「隐私政策同意」
 * 这个**事实记录**与使用统计的 opt-out 偏好；日志上报是另一件事，混在一起会让「恢复默认」
 * 与迁移语义互相纠缠。同意事实照旧复用 analytics 那份（不再存第二份），这里只存本功能
 * 自己的开关。
 *
 * override 语义（configuration-and-overrides §2/§4）：
 *  - 默认值 `false`（默认关闭，需求 §4.3）；
 *  - 持久化只记 override，不把默认值抄进用户配置；
 *  - 「恢复默认」= 删掉这条 override 重新跟随版本默认值，不是写一份静态 false。
 *    因为默认值就是 false，用户「打开又关掉」必须留痕（`preserveDefaults`），
 *    否则无法区分「没碰过」与「关过」——后者在合规问询时需要能自证。
 */

import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('log-upload-settings');

export interface LogUploadSettings {
  /** 崩溃时自动上传日志。默认关闭。 */
  crashAutoUploadEnabled: boolean;
}

const DEFAULTS: LogUploadSettings = {
  crashAutoUploadEnabled: false,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'log-upload-settings.json');
}

function normalize(raw: unknown): LogUploadSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    crashAutoUploadEnabled:
      typeof r.crashAutoUploadEnabled === 'boolean'
        ? r.crashAutoUploadEnabled
        : DEFAULTS.crashAutoUploadEnabled,
  };
}

const store = createOverrideSettingsFile<LogUploadSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'log-upload',
});

/**
 * 现读盘。授权闸每次判定前调用：开发版与正式版共享 userData，用户可能在另一个实例里刚刚
 * 关掉开关，进程内的旧缓存不能继续放行上传（需求 §4.3）。
 * mtime 守卫让「文件没变」时零开销。
 */
export function refreshLogUploadSettingsFromDisk(): void {
  store.invalidateIfChanged();
}

export function readLogUploadSettings(): LogUploadSettings {
  return store.read();
}

export function isCrashAutoUploadEnabled(): boolean {
  return store.read().crashAutoUploadEnabled;
}

/** 用户是否显式设置过开关（盘上有这条 override）。 */
export function isCrashAutoUploadCustomized(): boolean {
  return store.readState().customizedKeys.includes('crashAutoUploadEnabled');
}

export function setCrashAutoUploadEnabled(enabled: boolean): LogUploadSettings {
  // preserveDefaults:默认值就是 false,不保留的话「用户打开后又关掉」会被当成「未自定义」
  // 而删除 override,从此再也分不清「没碰过」与「显式关掉」。
  store.writePatch({ crashAutoUploadEnabled: enabled }, { preserveDefaults: true });
  return store.read();
}

/** 「恢复默认」：删掉 override，重新跟随当前版本默认值。 */
export function clearCrashAutoUploadOverride(): LogUploadSettings {
  store.writePatch({ crashAutoUploadEnabled: DEFAULTS.crashAutoUploadEnabled });
  return store.read();
}

export const __testing = { DEFAULTS, normalize, settingsFilePath };
