import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PRICING } from '../core/pricing';
import type { Settings } from '../shared/types';

/** Defaults shared by the desktop app and the Electron-free CLI. */
export function defaultSettings(): Settings {
  const home = homedir();
  return {
    claudeSessionsDir: join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects'),
    codexSessionsDir: join(process.env.CODEX_HOME || join(home, '.codex'), 'sessions'),
    theme: 'system',
    notifications: false,
    activeWindowSeconds: 45,
    pricing: { ...DEFAULT_PRICING },
    claudeBinary: '',
    allowPrMerge: false,
  };
}
