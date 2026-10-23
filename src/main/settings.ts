import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_PRICING } from '../core/pricing';
import type { Settings } from '../shared/types';

export function defaultSettings(): Settings {
  const home = homedir();
  const claudeDir = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, 'projects') : join(home, '.claude', 'projects');
  const codexDir = process.env.CODEX_HOME ? join(process.env.CODEX_HOME, 'sessions') : join(home, '.codex', 'sessions');
  return {
    claudeSessionsDir: claudeDir,
    codexSessionsDir: codexDir,
    theme: 'system',
    notifications: false,
    activeWindowSeconds: 45,
    pricing: { ...DEFAULT_PRICING },
    claudeBinary: '',
    allowPrMerge: false,
  };
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Merge persisted settings over defaults, ignoring anything malformed. */
export function sanitizeSettings(raw: unknown): Settings {
  const defaults = defaultSettings();
  if (!isObject(raw)) return defaults;
  const out: Settings = { ...defaults, pricing: { ...defaults.pricing } };
  if (typeof raw.claudeSessionsDir === 'string' && raw.claudeSessionsDir.trim()) out.claudeSessionsDir = raw.claudeSessionsDir;
  if (typeof raw.codexSessionsDir === 'string' && raw.codexSessionsDir.trim()) out.codexSessionsDir = raw.codexSessionsDir;
  if (raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system') out.theme = raw.theme;
  if (typeof raw.notifications === 'boolean') out.notifications = raw.notifications;
  if (typeof raw.activeWindowSeconds === 'number' && raw.activeWindowSeconds >= 5 && raw.activeWindowSeconds <= 3600) out.activeWindowSeconds = raw.activeWindowSeconds;
  if (typeof raw.claudeBinary === 'string') out.claudeBinary = raw.claudeBinary.trim();
  if (typeof raw.allowPrMerge === 'boolean') out.allowPrMerge = raw.allowPrMerge;
  if (isObject(raw.pricing)) {
    for (const [model, value] of Object.entries(raw.pricing)) {
      if (!isObject(value)) continue;
      const n = (k: string) => (typeof value[k] === 'number' && (value[k] as number) >= 0 ? (value[k] as number) : 0);
      out.pricing[model] = { input: n('input'), output: n('output'), cacheRead: n('cacheRead'), cacheWrite: n('cacheWrite') };
    }
  }
  return out;
}

export class SettingsStore {
  private current: Settings;

  constructor() {
    this.current = this.read();
  }

  get(): Settings {
    return this.current;
  }

  set(next: unknown): Settings {
    this.current = sanitizeSettings(next);
    const file = settingsPath();
    try {
      if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(this.current, null, 2));
    } catch (error) {
      console.error('[settings] failed to persist', error);
    }
    return this.current;
  }

  private read(): Settings {
    try {
      const file = settingsPath();
      if (!existsSync(file)) return defaultSettings();
      return sanitizeSettings(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return defaultSettings();
    }
  }
}
