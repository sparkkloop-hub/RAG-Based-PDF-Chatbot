import { useEffect, useState } from 'react';
import { Activity, Volume2 } from 'lucide-react';
import {
  PLAYBACK_SPEEDS,
  type PreviewVoiceParams,
} from '../services/ttsService';
import type {
  GeminiVoiceName,
  PlaybackRate,
  ResponseLanguage,
  SavedBrowserVoice,
  TTSState,
  VoiceEngine,
  VoiceSettings,
} from '../types';
import { HealthCheckPanel } from './HealthCheckPanel';
import { VoiceListSelector } from './VoicePickerPopover';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Select } from './ui/Select';

type SettingsTab = 'voice' | 'health';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  language: ResponseLanguage;
  voiceSettings: VoiceSettings;
  browserVoices: SpeechSynthesisVoice[];
  ttsState: TTSState;
  onUpdateVoiceSettings: (patch: Partial<VoiceSettings>) => void;
  onSetBrowserVoice: (language: ResponseLanguage, voice: SavedBrowserVoice | null) => void;
  onSetGeminiVoice: (language: ResponseLanguage, voice: GeminiVoiceName) => void;
  onChangeSpeed: (speed: PlaybackRate) => void;
  onPreviewVoice: (params: PreviewVoiceParams) => void;
  onStopPreview: () => void;
}

export function SettingsDialog({
  open,
  onClose,
  language,
  voiceSettings,
  browserVoices,
  ttsState,
  onUpdateVoiceSettings,
  onSetBrowserVoice,
  onSetGeminiVoice,
  onChangeSpeed,
  onPreviewVoice,
  onStopPreview,
}: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('voice');

  useEffect(() => {
    if (!open) {
      onStopPreview();
    }
  }, [open, onStopPreview]);

  useEffect(() => {
    if (activeTab !== 'voice') {
      onStopPreview();
    }
  }, [activeTab, onStopPreview]);

  const handleClose = () => {
    onStopPreview();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      size={activeTab === 'health' ? 'lg' : 'md'}
      title="Settings"
      description={
        activeTab === 'health'
          ? 'Run on-demand diagnostics against server routes and browser capabilities. Nothing runs automatically or is cached.'
          : 'Configure voice playback and reading preferences. Changes sync immediately with the Listen picker.'
      }
      footer={
        <Button variant="primary" size="sm" onClick={handleClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-4">
        {/* Settings Section Tabs */}
        <div
          role="tablist"
          aria-label="Settings sections"
          className="inline-flex items-center gap-1 rounded-[8px] bg-surface border border-line p-1"
        >
          <button
            type="button"
            role="tab"
            id="settings-tab-voice"
            aria-selected={activeTab === 'voice'}
            aria-controls="settings-panel-voice"
            onClick={() => setActiveTab('voice')}
            className={`inline-flex items-center gap-1.5 h-7 px-3 rounded-[6px] text-[12px] font-medium transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              activeTab === 'voice'
                ? 'bg-accent-soft text-accent'
                : 'text-ink-secondary hover:text-ink'
            }`}
          >
            <Volume2 className="w-3.5 h-3.5" strokeWidth={1.5} />
            <span>Voice</span>
          </button>

          <button
            type="button"
            role="tab"
            id="settings-tab-health"
            aria-selected={activeTab === 'health'}
            aria-controls="settings-panel-health"
            onClick={() => setActiveTab('health')}
            className={`inline-flex items-center gap-1.5 h-7 px-3 rounded-[6px] text-[12px] font-medium transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              activeTab === 'health'
                ? 'bg-accent-soft text-accent'
                : 'text-ink-secondary hover:text-ink'
            }`}
          >
            <Activity className="w-3.5 h-3.5" strokeWidth={1.5} />
            <span>Health check</span>
          </button>
        </div>

        {/* Voice Tab Panel */}
        {activeTab === 'voice' && (
          <div
            role="tabpanel"
            id="settings-panel-voice"
            aria-labelledby="settings-tab-voice"
            className="space-y-4 pt-1"
          >
            <div className="pb-1.5 border-b border-line flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-ink">Voice</h3>
              <span className="text-[12px] text-ink-muted">
                Saved for: {language === 'ta' ? 'Tamil (ta-IN)' : 'English'}
              </span>
            </div>

            {/* Voice Engine */}
            <fieldset className="space-y-2">
              <legend className="text-[12px] font-medium text-ink-secondary">
                Voice engine
              </legend>
              <div className="grid grid-cols-1 gap-2">
                {(
                  [
                    {
                      id: 'browser' as VoiceEngine,
                      title: 'Browser voice (fast, free)',
                      subtitle: 'Uses voices installed in your browser with instant startup.',
                    },
                    {
                      id: 'gemini' as VoiceEngine,
                      title: 'Gemini voice (natural quality)',
                      subtitle: 'Generates studio-quality speech for English and Tamil.',
                    },
                  ] as const
                ).map((option) => {
                  const selected = voiceSettings.engine === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => onUpdateVoiceSettings({ engine: option.id })}
                      className={`w-full text-left rounded-[8px] border px-3 py-2.5 transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                        selected
                          ? 'bg-accent-soft border-accent/50'
                          : 'bg-surface border-line hover:border-line-strong'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[13px] font-medium text-ink">{option.title}</span>
                        <span
                          className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center shrink-0 ${
                            selected ? 'border-accent' : 'border-line-strong'
                          }`}
                        >
                          {selected && <span className="w-2 h-2 rounded-full bg-accent" />}
                        </span>
                      </div>
                      <p className="text-[12px] text-ink-secondary mt-0.5">{option.subtitle}</p>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {/* Per-Language Voice List with Preview buttons */}
            <div className="space-y-1.5">
              <p className="text-[12px] font-medium text-ink-secondary">
                Voice ({language === 'ta' ? 'Tamil' : 'English'})
              </p>

              <VoiceListSelector
                language={language}
                voiceSettings={voiceSettings}
                browserVoices={browserVoices}
                ttsState={ttsState}
                onUpdateVoiceSettings={onUpdateVoiceSettings}
                onSetBrowserVoice={onSetBrowserVoice}
                onSetGeminiVoice={onSetGeminiVoice}
                onPreviewVoice={onPreviewVoice}
                maxHeightClass="max-h-56"
              />
            </div>

            {/* Default Speed */}
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="settings-default-speed"
                className="text-[13px] text-ink"
              >
                Default speed
              </label>
              <Select
                id="settings-default-speed"
                size="sm"
                value={String(voiceSettings.speed)}
                onChange={(e) => onChangeSpeed(Number(e.target.value) as PlaybackRate)}
                options={PLAYBACK_SPEEDS.map((s) => ({
                  value: String(s),
                  label: `${s}x`,
                }))}
              />
            </div>

            {/* Auto-read toggle */}
            <div className="flex items-center justify-between gap-3 pt-1">
              <div>
                <p id="auto-read-label" className="text-[13px] font-medium text-ink">
                  Auto-read new answers
                </p>
                <p className="text-[12px] text-ink-secondary">
                  Automatically speak responses when they finish generating.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={voiceSettings.autoRead}
                aria-labelledby="auto-read-label"
                onClick={() => onUpdateVoiceSettings({ autoRead: !voiceSettings.autoRead })}
                className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-panel ${
                  voiceSettings.autoRead
                    ? 'bg-accent border-accent'
                    : 'bg-raised border-line-strong'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-surface transition-transform duration-150 ${
                    voiceSettings.autoRead ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
          </div>
        )}

        {/* Health Check Tab Panel */}
        {activeTab === 'health' && (
          <div
            role="tabpanel"
            id="settings-panel-health"
            aria-labelledby="settings-tab-health"
          >
            <HealthCheckPanel />
          </div>
        )}
      </div>
    </Dialog>
  );
}
