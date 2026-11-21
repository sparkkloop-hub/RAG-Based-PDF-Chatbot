import React from 'react';
import { AlertCircle, Pause, Play, RotateCcw, Square, Volume2 } from 'lucide-react';
import {
  PLAYBACK_SPEEDS,
  VOICE_CHANGED_PROMPT_MESSAGE,
  type PreviewVoiceParams,
} from '../services/ttsService';
import type {
  GeminiVoiceName,
  PlaybackRate,
  ResponseLanguage,
  SavedBrowserVoice,
  TTSState,
  VoiceSettings,
} from '../types';
import { VoicePickerPopover } from './VoicePickerPopover';
import { Button } from './ui/Button';
import { Select } from './ui/Select';
import { Tooltip } from './ui/Tooltip';

function formatAudioTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export interface AudioPlayerBarProps {
  isPlaying: boolean;
  isLoading?: boolean;
  statusLabel: string;
  speed: PlaybackRate;
  onTogglePlayPause: () => void;
  onStop?: () => void;
  onChangeSpeed: (speed: PlaybackRate) => void;
  /** Non-seekable percent progress (0..100), used by Listen */
  progressPercent?: number;
  /** Interactive seek bar values (in seconds), used by Audio Overview */
  currentTimeSec?: number;
  durationSec?: number;
  onSeek?: (nextTimeSec: number) => void;
  /** Optional extra control slot on the right (e.g., Download WAV) */
  extraActions?: React.ReactNode;
  ariaLabel?: string;
}

export function AudioPlayerBar({
  isPlaying,
  isLoading = false,
  statusLabel,
  speed,
  onTogglePlayPause,
  onStop,
  onChangeSpeed,
  progressPercent = 0,
  currentTimeSec,
  durationSec,
  onSeek,
  extraActions,
  ariaLabel = 'Audio playback controls',
}: AudioPlayerBarProps) {
  const hasSeekBar =
    typeof onSeek === 'function' &&
    typeof currentTimeSec === 'number' &&
    typeof durationSec === 'number';

  const safeDuration = hasSeekBar ? Math.max(0, durationSec ?? 0) : 0;
  const clampedTime = hasSeekBar
    ? Math.max(0, Math.min(safeDuration, currentTimeSec ?? 0))
    : 0;

  const handleBarKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === ' ' && e.target === e.currentTarget) {
      e.preventDefault();
      onTogglePlayPause();
    }
  };

  return (
    <div
      role="region"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={handleBarKeyDown}
      className="rounded-[8px] bg-panel border border-line px-3 py-2 flex flex-wrap sm:flex-nowrap items-center gap-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={onTogglePlayPause}
          aria-label={isPlaying ? 'Pause audio' : 'Play audio'}
          className="h-8 w-8 p-0 text-ink"
        >
          {isPlaying ? (
            <Pause className="w-4 h-4" strokeWidth={1.5} />
          ) : (
            <Play className="w-4 h-4" strokeWidth={1.5} />
          )}
        </Button>

        {onStop && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onStop}
            aria-label="Stop audio"
            className="h-8 w-8 p-0 text-ink-secondary hover:text-ink"
          >
            <Square className="w-3 h-3 fill-current" strokeWidth={1.5} />
          </Button>
        )}
      </div>

      {/* Progress / Interactive Seek Bar */}
      <div className="flex-1 min-w-[140px] space-y-1">
        <div className="flex items-center justify-between gap-2 text-[11px] text-ink-muted">
          <span className="truncate">{statusLabel}</span>
          {hasSeekBar ? (
            <span className="font-mono tabular-nums shrink-0">
              {formatAudioTime(clampedTime)} / {formatAudioTime(safeDuration)}
            </span>
          ) : (
            <span className="font-mono tabular-nums shrink-0">{progressPercent}%</span>
          )}
        </div>

        {hasSeekBar ? (
          <input
            type="range"
            min={0}
            max={safeDuration > 0 ? safeDuration : 1}
            step={0.1}
            value={safeDuration > 0 ? clampedTime : 0}
            disabled={safeDuration <= 0}
            onChange={(e) => onSeek?.(Number(e.target.value))}
            aria-label="Seek audio position"
            aria-valuetext={`${formatAudioTime(clampedTime)} of ${formatAudioTime(safeDuration)}`}
            className="w-full h-1.5 accent-accent bg-raised rounded-full cursor-pointer disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        ) : (
          <div
            role="progressbar"
            aria-label="Audio playback progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressPercent}
            className="h-[3px] w-full rounded-full bg-raised overflow-hidden"
          >
            <div
              className="h-full bg-accent transition-all duration-150 ease-out rounded-full"
              style={{ width: `${Math.max(isLoading ? 12 : 2, progressPercent)}%` }}
            />
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <Select
          size="sm"
          aria-label="Playback speed"
          value={String(speed)}
          onChange={(e) => onChangeSpeed(Number(e.target.value) as PlaybackRate)}
          className="h-7 text-[12px] font-mono tabular-nums"
          options={PLAYBACK_SPEEDS.map((s) => ({
            value: String(s),
            label: `${s}x`,
          }))}
        />
        {extraActions}
      </div>
    </div>
  );
}

interface ListenButtonGroupProps {
  messageId: string;
  language: ResponseLanguage;
  ttsState: TTSState;
  voiceSettings: VoiceSettings;
  browserVoices: SpeechSynthesisVoice[];
  onTogglePlayPause: () => void;
  onStop: () => void;
  onUpdateVoiceSettings: (patch: Partial<VoiceSettings>) => void;
  onSetBrowserVoice: (language: ResponseLanguage, voice: SavedBrowserVoice | null) => void;
  onSetGeminiVoice: (language: ResponseLanguage, voice: GeminiVoiceName) => void;
  onPreviewVoice: (params: PreviewVoiceParams) => void;
  onStopPreview: () => void;
}

export function ListenButtonGroup({
  messageId,
  language,
  ttsState,
  voiceSettings,
  browserVoices,
  onTogglePlayPause,
  onStop,
  onUpdateVoiceSettings,
  onSetBrowserVoice,
  onSetGeminiVoice,
  onPreviewVoice,
  onStopPreview,
}: ListenButtonGroupProps) {
  const isActive = ttsState.activeMessageId === messageId;
  const status = isActive ? ttsState.status : 'idle';
  const isPlaying = status === 'playing';
  const isPaused = status === 'paused';
  const isLoading = status === 'loading';

  const label = isLoading
    ? 'Preparing audio'
    : isPlaying
    ? 'Pause'
    : isPaused
    ? 'Resume'
    : 'Listen';

  const ariaLabel = isLoading
    ? 'Preparing audio playback'
    : isPlaying
    ? 'Pause audio playback'
    : isPaused
    ? 'Resume audio playback'
    : 'Listen to answer';

  return (
    <span className="inline-flex items-center gap-0.5">
      <Tooltip content={label}>
        <Button
          variant="ghost"
          size="sm"
          onClick={onTogglePlayPause}
          aria-label={ariaLabel}
          aria-pressed={isPlaying}
          className={`h-7 px-2 text-[12px] ${
            isPlaying || isLoading
              ? 'text-accent hover:text-accent'
              : 'text-ink-muted hover:text-ink'
          }`}
        >
          {isPlaying ? (
            <Pause className="w-3.5 h-3.5" strokeWidth={1.5} />
          ) : isPaused ? (
            <Play className="w-3.5 h-3.5" strokeWidth={1.5} />
          ) : (
            <Volume2 className="w-3.5 h-3.5" strokeWidth={1.5} />
          )}
          <span>{label}</span>
        </Button>
      </Tooltip>

      {(isPlaying || isPaused || isLoading) && (
        <Tooltip content="Stop playback">
          <Button
            variant="ghost"
            size="sm"
            onClick={onStop}
            aria-label="Stop audio playback"
            className="h-7 px-1.5 text-[12px] text-ink-muted hover:text-ink"
          >
            <Square className="w-3 h-3 fill-current" strokeWidth={1.5} />
            <span className="sr-only">Stop</span>
          </Button>
        </Tooltip>
      )}

      <VoicePickerPopover
        language={language}
        voiceSettings={voiceSettings}
        browserVoices={browserVoices}
        ttsState={ttsState}
        onUpdateVoiceSettings={onUpdateVoiceSettings}
        onSetBrowserVoice={onSetBrowserVoice}
        onSetGeminiVoice={onSetGeminiVoice}
        onPreviewVoice={onPreviewVoice}
        onStopPreview={onStopPreview}
      />
    </span>
  );
}

interface MessageAudioBarProps {
  messageId: string;
  ttsState: TTSState;
  onTogglePlayPause: () => void;
  onStop: () => void;
  onChangeSpeed: (speed: PlaybackRate) => void;
  onContinueWithBrowser: () => void;
  onSwitchToGemini: () => void;
  onReplayWithNewVoice: () => void;
  onDismissVoiceChangedPrompt: () => void;
  onOpenSettings: () => void;
}

export function MessageAudioBar({
  messageId,
  ttsState,
  onTogglePlayPause,
  onStop,
  onChangeSpeed,
  onContinueWithBrowser,
  onSwitchToGemini,
  onReplayWithNewVoice,
  onDismissVoiceChangedPrompt,
  onOpenSettings,
}: MessageAudioBarProps) {
  const isActive = ttsState.activeMessageId === messageId;
  if (!isActive) return null;

  const {
    status,
    progress,
    speed,
    error,
    missingTamilBrowserVoice,
    midPlaybackFallbackPrompt,
    voiceChangedPrompt,
    notice,
    engineUsed,
    activeVoiceLabel,
    isFallback,
    fallbackReason,
  } = ttsState;

  const showControls = status === 'loading' || status === 'playing' || status === 'paused';

  const statusLabel =
    status === 'loading'
      ? engineUsed === 'gemini'
        ? 'Generating Gemini voice...'
        : 'Starting voice...'
      : status === 'paused'
      ? 'Paused'
      : 'Playing';

  return (
    <div className="mt-2 space-y-1.5">
      {showControls && (
        <div className="space-y-1">
          <AudioPlayerBar
            isPlaying={status === 'playing'}
            isLoading={status === 'loading'}
            statusLabel={statusLabel}
            speed={speed}
            progressPercent={progress}
            onTogglePlayPause={onTogglePlayPause}
            onStop={onStop}
            onChangeSpeed={onChangeSpeed}
          />
          {activeVoiceLabel && (
            <div className="px-1 space-y-0.5">
              <p className="text-[11px] text-ink-muted">
                Now playing:{' '}
                <span className="text-ink-secondary font-mono">{activeVoiceLabel}</span>
              </p>
              {isFallback && fallbackReason && (
                <p className="text-[11px] text-ink-secondary flex items-start gap-1.5">
                  <AlertCircle
                    className="w-3.5 h-3.5 text-status-warning shrink-0 mt-0.5"
                    strokeWidth={1.5}
                  />
                  <span>{fallbackReason}</span>
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {voiceChangedPrompt && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-[8px] bg-panel border border-line px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink"
        >
          <span className="text-ink-secondary">{VOICE_CHANGED_PROMPT_MESSAGE}</span>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button variant="secondary" size="sm" onClick={onReplayWithNewVoice}>
              <RotateCcw className="w-3.5 h-3.5" strokeWidth={1.5} />
              <span>Replay</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={onDismissVoiceChangedPrompt}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {notice && <p className="text-[12px] text-ink-secondary px-1">{notice}</p>}

      {error && (
        <div
          role="alert"
          className="rounded-[8px] bg-status-warning-soft border border-status-warning/30 px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink"
        >
          <span className="inline-flex items-start gap-2 min-w-0 flex-1">
            <AlertCircle
              className="w-4 h-4 text-status-warning shrink-0 mt-0.5"
              strokeWidth={1.5}
            />
            <span className="leading-snug">{error}</span>
          </span>
          {midPlaybackFallbackPrompt ? (
            <div className="flex items-center gap-1.5 shrink-0">
              <Button variant="secondary" size="sm" onClick={onContinueWithBrowser}>
                Continue
              </Button>
              <Button variant="ghost" size="sm" onClick={onStop}>
                Stop
              </Button>
            </div>
          ) : missingTamilBrowserVoice ? (
            <Button variant="secondary" size="sm" onClick={onSwitchToGemini}>
              Switch to Gemini voice
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={onOpenSettings}>
              Voice settings
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
