import { FolderOpen, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_PRICING } from '../../core/pricing';
import type { ModelPricing, Settings, ThemePreference } from '../../shared/types';
import { bridge } from '../lib/bridge';
import { useStore } from '../store';

function PricingRow({ model, pricing, onChange, onRemove }: { model: string; pricing: ModelPricing; onChange: (next: ModelPricing) => void; onRemove: () => void }) {
  const field = (key: keyof ModelPricing, label: string) => (
    <td>
      <input
        type="number"
        min={0}
        step={0.01}
        value={pricing[key]}
        aria-label={`${model} ${label} price per million tokens`}
        onChange={(e) => onChange({ ...pricing, [key]: Math.max(0, Number(e.target.value) || 0) })}
      />
    </td>
  );
  return (
    <tr>
      <th scope="row" className="mono">
        {model}
      </th>
      {field('input', 'input')}
      {field('output', 'output')}
      {field('cacheRead', 'cache read')}
      {field('cacheWrite', 'cache write')}
      <td>
        <button type="button" className="icon-button" onClick={onRemove} aria-label={`Remove pricing for ${model}`} title="Remove">
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </td>
    </tr>
  );
}

/** Mounted only while open, so the draft is seeded from current settings on each open. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [draft, setDraft] = useState<Settings>(settings);
  const [newModel, setNewModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const pick = async (key: 'claudeSessionsDir' | 'codexSessionsDir') => {
    const chosen = await bridge()?.pickDirectory(draft[key]);
    if (chosen) setDraft((d) => ({ ...d, [key]: chosen }));
  };

  const save = async () => {
    const api = bridge();
    if (!api) return;
    setSaving(true);
    try {
      if (draft.notifications && typeof Notification !== 'undefined' && Notification.permission === 'default') {
        await Notification.requestPermission();
      }
      const saved = await api.setSettings(draft);
      setSettings(saved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const models = Object.keys(draft.pricing).sort();

  return (
    <dialog ref={ref} className="dialog settings-dialog" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-labelledby="settings-title">
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2 id="settings-title">Settings</h2>

        <fieldset>
          <legend>Session directories</legend>
          <p className="muted small">AgentLens only reads these folders. Nothing is sent anywhere.</p>
          {(
            [
              ['claudeSessionsDir', 'Claude Code projects'],
              ['codexSessionsDir', 'Codex sessions'],
            ] as Array<['claudeSessionsDir' | 'codexSessionsDir', string]>
          ).map(([key, label]) => (
            <label key={key} className="field">
              <span>{label}</span>
              <span className="field-row">
                <input type="text" value={draft[key]} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} spellCheck={false} />
                <button type="button" className="btn" onClick={() => void pick(key)} aria-label={`Browse for ${label}`}>
                  <FolderOpen size={14} aria-hidden="true" />
                </button>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset>
          <legend>Appearance</legend>
          <div className="radio-row" role="radiogroup" aria-label="Theme">
            {(['system', 'light', 'dark'] as ThemePreference[]).map((theme) => (
              <label key={theme} className="chip" aria-pressed={draft.theme === theme}>
                <input type="radio" name="theme" value={theme} checked={draft.theme === theme} onChange={() => setDraft((d) => ({ ...d, theme }))} className="sr-only" />
                {theme[0]?.toUpperCase() + theme.slice(1)}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Behavior</legend>
          <label className="field checkbox">
            <input type="checkbox" checked={draft.notifications} onChange={(e) => setDraft((d) => ({ ...d, notifications: e.target.checked }))} />
            <span>Desktop notification when an agent finishes or errors</span>
          </label>
          <label className="field">
            <span>Consider an agent idle after this many seconds without log activity</span>
            <input type="number" min={5} max={3600} value={draft.activeWindowSeconds} onChange={(e) => setDraft((d) => ({ ...d, activeWindowSeconds: Math.min(3600, Math.max(5, Number(e.target.value) || 45)) }))} style={{ width: 90 }} />
          </label>
        </fieldset>

        <fieldset>
          <legend>Workflows</legend>
          <p className="muted small">Workflows run headless Claude Code sessions on this machine, one per role.</p>
          <label className="field">
            <span>Claude Code CLI path (blank = auto-detect)</span>
            <input type="text" value={draft.claudeBinary} onChange={(e) => setDraft((d) => ({ ...d, claudeBinary: e.target.value }))} placeholder="e.g. ~/.local/bin/claude" spellCheck={false} />
          </label>
          <label className="field checkbox">
            <input type="checkbox" checked={draft.allowPrMerge} onChange={(e) => setDraft((d) => ({ ...d, allowPrMerge: e.target.checked }))} />
            <span>Allow agents to merge pull requests</span>
          </label>
          <p className="muted small">Lets the PR merger role run gh pr merge. Off by default.</p>
        </fieldset>

        <fieldset>
          <legend>Pricing (USD per million tokens)</legend>
          <p className="muted small">Model names match by prefix, so <code>claude-opus-5-5</code> covers dated variants. Edit to match your plan.</p>
          <div className="pricing-table-wrap">
            <table className="kv pricing">
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Input</th>
                  <th scope="col">Output</th>
                  <th scope="col">Cache read</th>
                  <th scope="col">Cache write</th>
                  <th scope="col">
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <PricingRow
                    key={model}
                    model={model}
                    pricing={draft.pricing[model] as ModelPricing}
                    onChange={(next) => setDraft((d) => ({ ...d, pricing: { ...d.pricing, [model]: next } }))}
                    onRemove={() =>
                      setDraft((d) => {
                        const pricing = { ...d.pricing };
                        delete pricing[model];
                        return { ...d, pricing };
                      })
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
          <div className="field-row">
            <input type="text" placeholder="model id, e.g. claude-opus-5-5" value={newModel} onChange={(e) => setNewModel(e.target.value)} aria-label="New model id" spellCheck={false} />
            <button
              type="button"
              className="btn"
              disabled={!newModel.trim()}
              onClick={() => {
                const id = newModel.trim().toLowerCase();
                if (!id) return;
                setDraft((d) => ({ ...d, pricing: { ...d.pricing, [id]: d.pricing[id] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }));
                setNewModel('');
              }}
            >
              <Plus size={14} aria-hidden="true" /> Add model
            </button>
            <button type="button" className="btn" onClick={() => setDraft((d) => ({ ...d, pricing: { ...DEFAULT_PRICING } }))}>
              <RotateCcw size={14} aria-hidden="true" /> Reset defaults
            </button>
          </div>
        </fieldset>

        {error && <p className="error-text">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
