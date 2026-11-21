import { useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Globe,
  RefreshCw,
  X,
} from 'lucide-react';
import type { PreviewVoiceParams } from '../services/ttsService';
import type {
  ExtraInfoRecord,
  GeminiVoiceName,
  PlaybackRate,
  ResponseLanguage,
  SavedBrowserVoice,
  TTSState,
  VoiceSettings,
} from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ListenButtonGroup, MessageAudioBar } from './MessageAudioControls';
import { Button } from './ui/Button';
import { SkeletonLines } from './ui/Skeleton';
import { Tooltip } from './ui/Tooltip';

const FALLBACK_NOTICE =
  "Live web search is unavailable right now. This is from the AI's general knowledge and is not verified.";

export interface AdditionalInfoPanelProps {
  panelId: string;
  messageId: string;
  isLoading: boolean;
  error: string | null;
  retryCountdownSec: number;
  record: ExtraInfoRecord | null;
  language: ResponseLanguage;
  ttsState: TTSState;
  voiceSettings: VoiceSettings;
  browserVoices: SpeechSynthesisVoice[];
  onToggleListen: (ttsId: string, content: string, lang: ResponseLanguage) => void;
  onStopAudio: () => void;
  onChangeAudioSpeed: (speed: PlaybackRate) => void;
  onContinueWithBrowser: () => void;
  onSwitchToGeminiAndReplay: (
    ttsId: string,
    content: string,
    lang: ResponseLanguage
  ) => void;
  onUpdateVoiceSettings: (patch: Partial<VoiceSettings>) => void;
  onSetBrowserVoice: (language: ResponseLanguage, voice: SavedBrowserVoice | null) => void;
  onSetGeminiVoice: (language: ResponseLanguage, voice: GeminiVoiceName) => void;
  onPreviewVoice: (params: PreviewVoiceParams) => void;
  onStopPreview: () => void;
  onReplayWithNewVoice: () => void;
  onDismissVoiceChangedPrompt: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  onClose: () => void;
}

export function getExtraInfoTtsId(messageId: string): string {
  return `extra-info:${messageId}`;
}

export function AdditionalInfoPanel({
  panelId,
  messageId,
  isLoading,
  error,
  retryCountdownSec,
  record,
  language,
  ttsState,
  voiceSettings,
  browserVoices,
  onToggleListen,
  onStopAudio,
  onChangeAudioSpeed,
  onContinueWithBrowser,
  onSwitchToGeminiAndReplay,
  onUpdateVoiceSettings,
  onSetBrowserVoice,
  onSetGeminiVoice,
  onPreviewVoice,
  onStopPreview,
  onReplayWithNewVoice,
  onDismissVoiceChangedPrompt,
  onOpenSettings,
  onRefresh,
  onClose,
}: AdditionalInfoPanelProps) {
  const [copied, setCopied] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const ttsId = getExtraInfoTtsId(messageId);
  const effectiveLang = record?.language ?? language;
  const isFallback = Boolean(record?.isGeneralKnowledgeFallback);
  const groundedErrors = record?.groundedErrors ?? [];
  const hasVerifiedSources = Boolean(record && !isFallback && record.sources.length > 0);
  const hasDisplayableContent = Boolean(
    record &&
      !record.noRelevantInfo &&
      record.content &&
      (isFallback || (!record.noReliableSources && record.sources.length > 0))
  );
  const isCooldownActive = retryCountdownSec > 0;

  const handleCopy = async () => {
    if (!record?.content) return;
    try {
      await navigator.clipboard.writeText(record.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access denied
    }
  };

  return (
    <section
      id={panelId}
      role="region"
      aria-label="Additional information from the web"
      className="mt-2.5 rounded-[8px] border border-line bg-panel overflow-hidden"
    >
      {/* Distinct external header */}
      <div className="px-3.5 py-2 border-b border-line bg-raised/60 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Globe
            className="w-3.5 h-3.5 text-accent shrink-0"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <h3 className="text-[12px] font-medium text-ink-secondary truncate">
            Additional information (from the web, not from your documents)
          </h3>
          <span className="hidden sm:inline-flex items-center px-1.5 py-0.5 rounded-[4px] border border-line bg-surface text-[11px] font-medium text-ink-muted shrink-0">
            External
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {record && record.language !== language && !isLoading && !isCooldownActive && (
            <button
              type="button"
              onClick={onRefresh}
              aria-label={
                language === 'ta'
                  ? 'Refresh additional information in Tamil'
                  : 'Refresh additional information in English'
              }
              className="text-[11px] font-medium text-accent hover:underline underline-offset-2 px-1.5 py-0.5 rounded-[4px] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {language === 'ta' ? 'தமிழில் புதுப்பி' : 'Refresh in English'}
            </button>
          )}
          <Tooltip content="Close">
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label="Close additional information"
              className="h-7 w-7 text-ink-muted hover:text-ink"
            >
              <X className="w-3.5 h-3.5" strokeWidth={1.5} />
            </Button>
          </Tooltip>
        </div>
      </div>

      {/* Panel body */}
      <div className="px-3.5 py-3 space-y-3">
        {isLoading ? (
          <div className="space-y-2.5" role="status" aria-live="polite">
            <p className="text-[12px] font-medium text-ink-secondary">
              Searching the web...
            </p>
            <SkeletonLines lines={3} />
          </div>
        ) : error ? (
          <div
            role="alert"
            className="rounded-[6px] bg-status-error-soft border border-status-error/25 px-3 py-2.5 flex flex-wrap items-center justify-between gap-2 text-[13px] text-ink"
          >
            <span className="inline-flex items-start gap-2 min-w-0 flex-1">
              <AlertCircle
                className="w-4 h-4 text-status-error shrink-0 mt-0.5"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              <span className="leading-snug">{error}</span>
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={isCooldownActive}
              onClick={onRefresh}
              aria-label={
                isCooldownActive
                  ? `Try again in ${retryCountdownSec} seconds`
                  : 'Retry additional information search'
              }
              className="tabular-nums"
            >
              {isCooldownActive ? `Try again in ${retryCountdownSec}s` : 'Try again'}
            </Button>
          </div>
        ) : record && record.noRelevantInfo ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-ink-secondary">
            <span className="inline-flex items-start gap-2 min-w-0 flex-1">
              <AlertCircle
                className="w-4 h-4 text-ink-muted shrink-0 mt-0.5"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              <span>No relevant additional information found.</span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={isCooldownActive}
              onClick={onRefresh}
              aria-label="Retry search for additional information"
              className="h-7 px-2 text-[12px] text-ink-muted hover:text-ink tabular-nums"
            >
              <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.5} />
              <span>
                {isCooldownActive ? `Retry in ${retryCountdownSec}s` : 'Refresh'}
              </span>
            </Button>
          </div>
        ) : record && !isFallback && (record.noReliableSources || record.sources.length === 0) ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-ink-secondary">
            <span className="inline-flex items-start gap-2 min-w-0 flex-1">
              <AlertCircle
                className="w-4 h-4 text-ink-muted shrink-0 mt-0.5"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              <span>No reliable web sources were found for this question.</span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={isCooldownActive}
              onClick={onRefresh}
              aria-label="Retry web search"
              className="h-7 px-2 text-[12px] text-ink-muted hover:text-ink tabular-nums"
            >
              <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.5} />
              <span>
                {isCooldownActive ? `Retry in ${retryCountdownSec}s` : 'Refresh'}
              </span>
            </Button>
          </div>
        ) : record && hasDisplayableContent ? (
          <>
            {isFallback && (
              <div
                role="note"
                className="rounded-[6px] bg-status-warning-soft border border-status-warning/30 px-3 py-2 space-y-2 text-[12px] text-ink"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="inline-flex items-start gap-2 min-w-0 flex-1">
                    <AlertCircle
                      className="w-3.5 h-3.5 text-status-warning shrink-0 mt-0.5"
                      strokeWidth={1.5}
                      aria-hidden="true"
                    />
                    <span className="leading-snug">
                      {record.fallbackNotice || FALLBACK_NOTICE}
                    </span>
                  </span>

                  {groundedErrors.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setDetailsOpen((prev) => !prev)}
                      aria-expanded={detailsOpen}
                      aria-controls={`${panelId}-grounded-errors`}
                      aria-label={
                        detailsOpen
                          ? 'Hide web search error details'
                          : 'Show web search error details'
                      }
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-secondary hover:text-ink transition-colors duration-150 shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-[4px] px-1 py-0.5"
                    >
                      {detailsOpen ? (
                        <ChevronDown className="w-3 h-3" strokeWidth={1.5} />
                      ) : (
                        <ChevronRight className="w-3 h-3" strokeWidth={1.5} />
                      )}
                      <span>Details</span>
                    </button>
                  )}
                </div>

                {detailsOpen && groundedErrors.length > 0 && (
                  <div
                    id={`${panelId}-grounded-errors`}
                    className="rounded-[6px] bg-surface border border-line p-2.5 space-y-1.5 font-mono text-[11px] leading-[1.45] text-ink-secondary overflow-x-auto"
                  >
                    {groundedErrors.map((errItem, idx) => (
                      <div key={`${errItem.model}-${idx}`} className="break-words">
                        <span className="text-ink font-medium">{errItem.model}</span>
                        {' · '}
                        <span>
                          {errItem.status !== null ? `HTTP ${errItem.status}` : 'Error'}
                        </span>
                        {': '}
                        <span>{errItem.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {record.hasConflict && (
              <div
                role="note"
                className="rounded-[6px] bg-status-warning-soft border border-status-warning/30 px-3 py-2 flex items-center gap-2 text-[12px] text-ink"
              >
                <AlertCircle
                  className="w-3.5 h-3.5 text-status-warning shrink-0"
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
                <span>This differs from your document.</span>
              </div>
            )}

            <MarkdownRenderer content={record.content} />

            {/* Web sources list (shown strictly from groundingMetadata.groundingChunks) */}
            {hasVerifiedSources && (
              <div className="pt-2.5 border-t border-line space-y-1.5">
                <p className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                  Web sources
                </p>
                <ul className="space-y-1">
                  {record.sources.map((src, index) => {
                    const showDomainSeparately =
                      src.domain.toLowerCase() !== src.title.toLowerCase();
                    return (
                      <li key={`${src.uri}-${index}`}>
                        <a
                          href={src.uri}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="group inline-flex items-center gap-1.5 max-w-full text-[12px] text-ink-secondary hover:text-accent transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-[4px]"
                        >
                          <ExternalLink
                            className="w-3 h-3 text-ink-muted group-hover:text-accent shrink-0"
                            strokeWidth={1.5}
                            aria-hidden="true"
                          />
                          <span className="truncate font-medium text-ink group-hover:text-accent">
                            {src.title}
                          </span>
                          {showDomainSeparately && (
                            <span className="text-[11px] text-ink-muted shrink-0">
                              · {src.domain}
                            </span>
                          )}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* Panel action controls */}
            <div className="pt-1 border-t border-line flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1">
                <Tooltip content={copied ? 'Copied' : 'Copy additional information'}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCopy}
                    aria-label="Copy additional information"
                    className="h-7 px-2 text-[12px] text-ink-muted hover:text-ink"
                  >
                    {copied ? (
                      <>
                        <Check
                          className="w-3.5 h-3.5 text-status-success"
                          strokeWidth={1.5}
                        />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" strokeWidth={1.5} />
                        <span>Copy</span>
                      </>
                    )}
                  </Button>
                </Tooltip>

                <ListenButtonGroup
                  messageId={ttsId}
                  language={effectiveLang}
                  ttsState={ttsState}
                  voiceSettings={voiceSettings}
                  browserVoices={browserVoices}
                  onTogglePlayPause={() =>
                    onToggleListen(ttsId, record.content, effectiveLang)
                  }
                  onStop={onStopAudio}
                  onUpdateVoiceSettings={onUpdateVoiceSettings}
                  onSetBrowserVoice={onSetBrowserVoice}
                  onSetGeminiVoice={onSetGeminiVoice}
                  onPreviewVoice={onPreviewVoice}
                  onStopPreview={onStopPreview}
                />

                <Tooltip
                  content={
                    isCooldownActive
                      ? `Wait ${retryCountdownSec}s before refreshing`
                      : 'Refresh additional information'
                  }
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isLoading || isCooldownActive}
                    onClick={onRefresh}
                    aria-label="Refresh additional information"
                    className="h-7 px-2 text-[12px] text-ink-muted hover:text-ink tabular-nums"
                  >
                    <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.5} />
                    <span>
                      {isCooldownActive ? `Wait ${retryCountdownSec}s` : 'Refresh'}
                    </span>
                  </Button>
                </Tooltip>
              </div>

              <Button
                variant="ghost"
                size="sm"
                onClick={onClose}
                aria-label="Close additional information panel"
                className="h-7 px-2 text-[12px] text-ink-muted hover:text-ink"
              >
                <X className="w-3.5 h-3.5" strokeWidth={1.5} />
                <span>Close</span>
              </Button>
            </div>

            <MessageAudioBar
              messageId={ttsId}
              ttsState={ttsState}
              onTogglePlayPause={() =>
                onToggleListen(ttsId, record.content, effectiveLang)
              }
              onStop={onStopAudio}
              onChangeSpeed={onChangeAudioSpeed}
              onContinueWithBrowser={onContinueWithBrowser}
              onSwitchToGemini={() =>
                onSwitchToGeminiAndReplay(ttsId, record.content, effectiveLang)
              }
              onReplayWithNewVoice={onReplayWithNewVoice}
              onDismissVoiceChangedPrompt={onDismissVoiceChangedPrompt}
              onOpenSettings={onOpenSettings}
            />
          </>
        ) : null}
      </div>
    </section>
  );
}
