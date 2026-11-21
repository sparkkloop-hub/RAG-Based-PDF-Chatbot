import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, ChevronDown, Play, Square } from 'lucide-react';
import {
  GEMINI_VOICES,
  MISSING_TAMIL_VOICE_MESSAGE,
  ttsService,
  type PreviewVoiceParams,
} from '../services/ttsService';
import type {
  GeminiVoiceName,
  ResponseLanguage,
  SavedBrowserVoice,
  TTSState,
  VoiceEngine,
  VoiceSettings,
} from '../types';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';

export interface VoiceListSelectorProps {
  language: ResponseLanguage;
  voiceSettings: VoiceSettings;
  browserVoices: SpeechSynthesisVoice[];
  ttsState: TTSState;
  onUpdateVoiceSettings: (patch: Partial<VoiceSettings>) => void;
  onSetBrowserVoice: (language: ResponseLanguage, voice: SavedBrowserVoice | null) => void;
  onSetGeminiVoice: (language: ResponseLanguage, voice: GeminiVoiceName) => void;
  onPreviewVoice: (params: PreviewVoiceParams) => void;
  maxHeightClass?: string;
}

/**
 * Shared selectable voice list with a Preview button on every voice row.
 * Used identically by Settings -> Voice and the Listen voice picker popover
 * so both stay immediately synchronized through voiceSettingsStore.
 */
export function VoiceListSelector({
  language,
  voiceSettings,
  browserVoices,
  ttsState,
  onUpdateVoiceSettings,
  onSetBrowserVoice,
  onSetGeminiVoice,
  onPreviewVoice,
  maxHeightClass = 'max-h-52',
}: VoiceListSelectorProps) {
  const filteredBrowserVoices = ttsService.getBrowserVoicesForLanguage(language);
  const langPrefs = voiceSettings.voices[language];
  const savedBrowser = langPrefs.browser;

  const matchedVoice = savedBrowser
    ? filteredBrowserVoices.find((v) => v.voiceURI === savedBrowser.voiceURI) ??
      filteredBrowserVoices.find((v) => v.name === savedBrowser.name) ??
      null
    : null;

  const isSavedBrowserVoiceUnavailable =
    voiceSettings.engine === 'browser' &&
    savedBrowser !== null &&
    filteredBrowserVoices.length > 0 &&
    matchedVoice === null;

  const missingTamilVoice =
    voiceSettings.engine === 'browser' &&
    language === 'ta' &&
    filteredBrowserVoices.length === 0;

  const noBrowserVoices =
    voiceSettings.engine === 'browser' &&
    browserVoices.length === 0 &&
    filteredBrowserVoices.length === 0;

  if (voiceSettings.engine === 'gemini') {
    return (
      <div className="space-y-1.5">
        <div
          role="radiogroup"
          aria-label={`Gemini voices for ${language === 'ta' ? 'Tamil' : 'English'}`}
          className={`${maxHeightClass} overflow-y-auto space-y-1 pr-0.5`}
        >
          {GEMINI_VOICES.map((voice) => {
            const isSelected = langPrefs.gemini === voice.name;
            const previewKey = `gemini:${language}:${voice.name}`;
            const isPreviewing = ttsState.previewingKey === previewKey;
            return (
              <div
                key={voice.name}
                className={`flex items-center justify-between gap-2 rounded-[6px] border px-2.5 py-1.5 transition-colors duration-150 ${
                  isSelected
                    ? 'bg-accent-soft border-accent/50'
                    : 'bg-surface border-line hover:border-line-strong'
                }`}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => onSetGeminiVoice(language, voice.name)}
                  className="flex-1 min-w-0 flex items-center gap-2 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-[4px]"
                >
                  <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                    {isSelected && (
                      <Check className="w-3.5 h-3.5 text-accent" strokeWidth={2} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12px] font-medium text-ink truncate">
                      {voice.name}
                    </span>
                    <span className="block text-[11px] text-ink-muted truncate">
                      {voice.description}
                    </span>
                  </span>
                </button>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPreviewVoice({
                      key: previewKey,
                      engine: 'gemini',
                      language,
                      geminiVoiceName: voice.name,
                    });
                  }}
                  aria-label={
                    isPreviewing
                      ? `Stop preview of ${voice.name}`
                      : `Preview ${voice.name} voice`
                  }
                  className={`inline-flex items-center gap-1 h-6 px-2 rounded-[5px] border text-[11px] font-medium shrink-0 transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                    isPreviewing
                      ? 'bg-accent text-white border-accent'
                      : 'bg-panel border-line text-ink-secondary hover:text-ink hover:border-line-strong'
                  }`}
                >
                  {isPreviewing ? (
                    <>
                      <Square className="w-2.5 h-2.5 fill-current" strokeWidth={1.5} />
                      <span>Stop</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-2.5 h-2.5" strokeWidth={1.5} />
                      <span>Preview</span>
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {ttsState.previewError && (
          <div
            role="alert"
            className="rounded-[6px] bg-status-warning-soft border border-status-warning/30 px-2.5 py-1.5 flex items-start gap-1.5 text-[11px] text-ink"
          >
            <AlertCircle
              className="w-3.5 h-3.5 text-status-warning shrink-0 mt-0.5"
              strokeWidth={1.5}
            />
            <span className="leading-snug">{ttsState.previewError}</span>
          </div>
        )}
      </div>
    );
  }

  // Browser voices list
  if (filteredBrowserVoices.length === 0) {
    return (
      <div className="rounded-[8px] bg-status-warning-soft border border-status-warning/30 p-3 space-y-2">
        <div className="flex items-start gap-2 text-[12px] text-ink">
          <AlertCircle
            className="w-4 h-4 text-status-warning shrink-0 mt-0.5"
            strokeWidth={1.5}
          />
          <p className="leading-snug">
            {missingTamilVoice
              ? MISSING_TAMIL_VOICE_MESSAGE
              : noBrowserVoices
              ? 'No voices are available in this browser. Switch to Gemini voice.'
              : 'No matching browser voice is installed for this language.'}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onUpdateVoiceSettings({ engine: 'gemini' })}
        >
          Switch to Gemini voice
        </Button>
      </div>
    );
  }

  const isAutoSelected = savedBrowser === null;
  const autoPreviewKey = `browser:${language}:__auto__`;
  const isAutoPreviewing = ttsState.previewingKey === autoPreviewKey;

  return (
    <div className="space-y-1.5">
      <div
        role="radiogroup"
        aria-label={`Browser voices for ${language === 'ta' ? 'Tamil' : 'English'}`}
        className={`${maxHeightClass} overflow-y-auto space-y-1 pr-0.5`}
      >
        {/* Automatic default row */}
        <div
          className={`flex items-center justify-between gap-2 rounded-[6px] border px-2.5 py-1.5 transition-colors duration-150 ${
            isAutoSelected
              ? 'bg-accent-soft border-accent/50'
              : 'bg-surface border-line hover:border-line-strong'
          }`}
        >
          <button
            type="button"
            role="radio"
            aria-checked={isAutoSelected}
            onClick={() => onSetBrowserVoice(language, null)}
            className="flex-1 min-w-0 flex items-center gap-2 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-[4px]"
          >
            <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
              {isAutoSelected && (
                <Check className="w-3.5 h-3.5 text-accent" strokeWidth={2} />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-medium text-ink truncate">
                Automatic
              </span>
              <span className="block text-[11px] text-ink-muted truncate">
                {language === 'ta' ? 'ta-IN default' : 'en-IN / en-US default'}
              </span>
            </span>
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPreviewVoice({
                key: autoPreviewKey,
                engine: 'browser',
                language,
                browserVoiceURI: null,
              });
            }}
            aria-label={isAutoPreviewing ? 'Stop preview' : 'Preview automatic browser voice'}
            className={`inline-flex items-center gap-1 h-6 px-2 rounded-[5px] border text-[11px] font-medium shrink-0 transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              isAutoPreviewing
                ? 'bg-accent text-white border-accent'
                : 'bg-panel border-line text-ink-secondary hover:text-ink hover:border-line-strong'
            }`}
          >
            {isAutoPreviewing ? (
              <>
                <Square className="w-2.5 h-2.5 fill-current" strokeWidth={1.5} />
                <span>Stop</span>
              </>
            ) : (
              <>
                <Play className="w-2.5 h-2.5" strokeWidth={1.5} />
                <span>Preview</span>
              </>
            )}
          </button>
        </div>

        {/* Installed browser voices */}
        {filteredBrowserVoices.map((voice) => {
          const isSelected = matchedVoice?.voiceURI === voice.voiceURI;
          const previewKey = `browser:${language}:${voice.voiceURI}`;
          const isPreviewing = ttsState.previewingKey === previewKey;
          return (
            <div
              key={voice.voiceURI}
              className={`flex items-center justify-between gap-2 rounded-[6px] border px-2.5 py-1.5 transition-colors duration-150 ${
                isSelected
                  ? 'bg-accent-soft border-accent/50'
                  : 'bg-surface border-line hover:border-line-strong'
              }`}
            >
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() =>
                  onSetBrowserVoice(language, {
                    voiceURI: voice.voiceURI,
                    name: voice.name,
                  })
                }
                className="flex-1 min-w-0 flex items-center gap-2 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-[4px]"
              >
                <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                  {isSelected && (
                    <Check className="w-3.5 h-3.5 text-accent" strokeWidth={2} />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-medium text-ink truncate">
                    {voice.name}
                  </span>
                  <span className="block text-[11px] text-ink-muted truncate">
                    {voice.lang}
                  </span>
                </span>
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onPreviewVoice({
                    key: previewKey,
                    engine: 'browser',
                    language,
                    browserVoiceURI: voice.voiceURI,
                    browserVoiceName: voice.name,
                  });
                }}
                aria-label={
                  isPreviewing
                    ? `Stop preview of ${voice.name}`
                    : `Preview ${voice.name}`
                }
                className={`inline-flex items-center gap-1 h-6 px-2 rounded-[5px] border text-[11px] font-medium shrink-0 transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  isPreviewing
                    ? 'bg-accent text-white border-accent'
                    : 'bg-panel border-line text-ink-secondary hover:text-ink hover:border-line-strong'
                }`}
              >
                {isPreviewing ? (
                  <>
                    <Square className="w-2.5 h-2.5 fill-current" strokeWidth={1.5} />
                    <span>Stop</span>
                  </>
                ) : (
                  <>
                    <Play className="w-2.5 h-2.5" strokeWidth={1.5} />
                    <span>Preview</span>
                  </>
                )}
              </button>
            </div>
          );
        })}
      </div>

      {isSavedBrowserVoiceUnavailable && savedBrowser && (
        <div className="rounded-[6px] bg-status-warning-soft border border-status-warning/30 px-2.5 py-1.5 flex items-start gap-1.5 text-[11px] text-ink">
          <AlertCircle
            className="w-3.5 h-3.5 text-status-warning shrink-0 mt-0.5"
            strokeWidth={1.5}
          />
          <span className="leading-snug">
            Saved voice &ldquo;{savedBrowser.name}&rdquo; is unavailable in this browser.
          </span>
        </div>
      )}

      {ttsState.previewError && (
        <div
          role="alert"
          className="rounded-[6px] bg-status-warning-soft border border-status-warning/30 px-2.5 py-1.5 flex items-start gap-1.5 text-[11px] text-ink"
        >
          <AlertCircle
            className="w-3.5 h-3.5 text-status-warning shrink-0 mt-0.5"
            strokeWidth={1.5}
          />
          <span className="leading-snug">{ttsState.previewError}</span>
        </div>
      )}
    </div>
  );
}

export interface VoicePickerPopoverProps {
  language: ResponseLanguage;
  voiceSettings: VoiceSettings;
  browserVoices: SpeechSynthesisVoice[];
  ttsState: TTSState;
  onUpdateVoiceSettings: (patch: Partial<VoiceSettings>) => void;
  onSetBrowserVoice: (language: ResponseLanguage, voice: SavedBrowserVoice | null) => void;
  onSetGeminiVoice: (language: ResponseLanguage, voice: GeminiVoiceName) => void;
  onPreviewVoice: (params: PreviewVoiceParams) => void;
  onStopPreview: () => void;
}

export function VoicePickerPopover({
  language,
  voiceSettings,
  browserVoices,
  ttsState,
  onUpdateVoiceSettings,
  onSetBrowserVoice,
  onSetGeminiVoice,
  onPreviewVoice,
  onStopPreview,
}: VoicePickerPopoverProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const handleOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        onStopPreview();
      }
    };

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        onStopPreview();
      }
    };

    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [open, onStopPreview]);

  const langPrefs = voiceSettings.voices[language];
  const currentVoiceLabel =
    voiceSettings.engine === 'gemini'
      ? langPrefs.gemini
      : langPrefs.browser?.name ?? 'Auto';

  const compactVoiceName =
    currentVoiceLabel.length > 16
      ? `${currentVoiceLabel.slice(0, 15).trim()}…`
      : currentVoiceLabel;

  return (
    <div ref={containerRef} className="relative inline-flex">
      <Tooltip content={`Voice: ${currentVoiceLabel} (${voiceSettings.engine === 'gemini' ? 'Gemini' : 'Browser'})`}>
        <button
          type="button"
          onClick={() => {
            if (open) {
              setOpen(false);
              onStopPreview();
            } else {
              setOpen(true);
            }
          }}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label="Choose voice"
          className={`inline-flex items-center gap-1 h-7 px-2 rounded-[6px] text-[12px] transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            open
              ? 'bg-raised text-ink'
              : 'text-ink-muted hover:text-ink hover:bg-raised'
          }`}
        >
          <span className="max-w-[110px] truncate">{compactVoiceName}</span>
          <ChevronDown className="w-3 h-3 shrink-0" strokeWidth={1.5} />
        </button>
      </Tooltip>

      {open && (
        <div
          role="dialog"
          aria-label="Voice picker"
          className="absolute left-0 top-full mt-1.5 w-72 sm:w-80 rounded-[10px] bg-panel border border-line shadow-lg p-2.5 space-y-2.5 z-30"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-ink">Voice</span>
            <span className="text-[11px] text-ink-muted">
              {language === 'ta' ? 'Tamil (ta-IN)' : 'English'}
            </span>
          </div>

          {/* Engine switcher synced with Settings -> Voice */}
          <div
            role="tablist"
            aria-label="Voice engine"
            className="grid grid-cols-2 gap-1 rounded-[6px] bg-surface border border-line p-0.5"
          >
            {(
              [
                { id: 'browser' as VoiceEngine, label: 'Browser' },
                { id: 'gemini' as VoiceEngine, label: 'Gemini' },
              ] as const
            ).map((opt) => {
              const selected = voiceSettings.engine === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => onUpdateVoiceSettings({ engine: opt.id })}
                  className={`h-7 rounded-[5px] text-[12px] font-medium transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                    selected
                      ? 'bg-accent-soft text-accent'
                      : 'text-ink-secondary hover:text-ink'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          <VoiceListSelector
            language={language}
            voiceSettings={voiceSettings}
            browserVoices={browserVoices}
            ttsState={ttsState}
            onUpdateVoiceSettings={onUpdateVoiceSettings}
            onSetBrowserVoice={onSetBrowserVoice}
            onSetGeminiVoice={onSetGeminiVoice}
            onPreviewVoice={onPreviewVoice}
            maxHeightClass="max-h-52"
          />
        </div>
      )}
    </div>
  );
}
