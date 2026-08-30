/**
 * Main-side kill switch for the interrupted-turn auto-resume guard.
 *
 * File: <userData>/interrupted-turn-auto-resume-settings.json
 * Shape: { "enabled": true }
 *
 * 默认开启：上游把「已经干到一半」的 turn 打断时（SSE 流被切断，SDK 报
 * `server_error` 且自己不重试，见 maker-ipc/interruptedTurnAutoResume.ts 文件头），
 * 守卫自动补发一次续跑指令接续任务。本开关既是 Settings UI 中的用户偏好，也是
 * 守卫自身出问题时可手改文件的逃生门。
 *
 * 与 silent-stop 的开关**刻意分成两个文件**：两套自愈的判据、额度和故障模式都不同，
 * 逃生门必须能分别关——一套误动作时不该被迫把另一套也停掉。
 */
import { app } from 'electron';
import path from 'node:path';

import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './override-settings-file.js';

const log = desktopMakerLogger.child('interrupted-turn-auto-resume-store');

export interface InterruptedTurnAutoResumeSettings {
  enabled: boolean;
}

const DEFAULTS: InterruptedTurnAutoResumeSettings = {
  enabled: true,
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'interrupted-turn-auto-resume-settings.json');
}

function normalize(raw: unknown): InterruptedTurnAutoResumeSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULTS.enabled,
  };
}

const store = createOverrideSettingsFile<InterruptedTurnAutoResumeSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULTS,
  normalize,
  log,
  label: 'interrupted turn auto resume',
  maxBytes: 4_096,
  preserveUnreadableFile: true,
});

/**
 * kill switch 是守卫出问题时的逃生门：用户手动编辑文件后必须立即生效，不能等 app
 * 重启。mtime 没变时只做一次 stat；变更后下一次 guard 判定会重读。
 */
export function readInterruptedTurnAutoResumeSettings(): InterruptedTurnAutoResumeSettings {
  store.invalidateIfChanged();
  return store.read();
}

export function readInterruptedTurnAutoResumeSettingsState(): OverrideSettingsState<
  InterruptedTurnAutoResumeSettings
> {
  store.invalidateIfChanged();
  return store.readState();
}

export async function writeInterruptedTurnAutoResumeEnabled(enabled: boolean): Promise<void> {
  await store.writePatchAtomic({ enabled });
}

export async function resetInterruptedTurnAutoResumeSettings(): Promise<
  InterruptedTurnAutoResumeSettings
> {
  return store.resetAtomic();
}

export const __testing = {
  normalize,
  invalidate: store.invalidateIfChanged,
};
