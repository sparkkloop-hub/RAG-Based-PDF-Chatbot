import { useEffect, useRef, useState } from 'react';
import {
  AlignLeft,
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  Copy,
  FileText,
  Globe,
  HelpCircle,
  ListChecks,
  Mic,
  MicOff,
  Paperclip,
  RefreshCw,
  Square,
  Upload,
} from 'lucide-react';
import { useSpeechRecognition } from '../hooks/useSpeechRecognition';
import {
  abortAllExtraInfoRequests,
  abortExtraInfoRequest,
  clearExtraInfoCacheForMessage,
  ExtraInfoError,
  fetchExtraInfo,
  getCachedExtraInfo,
  isExtraInfoInFlight,
} from '../services/extraInfoService';
import type { PreviewVoiceParams } from '../services/ttsService';
import type {
  AppStats,
  ChatMessage,
  Conversation,
  DocumentRecord,
  ExtraInfoRecord,
  GeminiVoiceName,
  PlaybackRate,
  ResponseLanguage,
  RetrievedChunk,
  SavedBrowserVoice,
  TTSState,
  UploadJob,
  VoiceSettings,
} from '../types';
import {
  AdditionalInfoPanel,
  getExtraInfoTtsId,
} from './AdditionalInfoPanel';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ListenButtonGroup, MessageAudioBar } from './MessageAudioControls';
import { SourcesPanel } from './SourcesPanel';
import { UploadProgressList } from './UploadProgressList';
import { Button } from './ui/Button';
import { Chip } from './ui/Chip';
import { Select } from './ui/Select';
import { Skeleton, SkeletonLines } from './ui/Skeleton';
import { Tooltip } from './ui/Tooltip';

interface ChatWorkspaceProps {
  documents: DocumentRecord[];
  conversation: Conversation | null;
  stats: AppStats;
  selectedDocIds: string[];
  language: ResponseLanguage;
  uploadJobs: UploadJob[];
  suggestedQuestions: string[];
  isLoadingSuggestions: boolean;
  isGenerating: boolean;
  onChangeLanguage: (lang: ResponseLanguage) => void;
  onSendMessage: (text: string) => void;
  onRegenerate: (assistantMessageId: string) => void;
  onStopGeneration: () => void;
  onToggleDocSelection: (docId: string) => void;
  onSelectAllDocs: () => void;
  onUploadFiles: (files: FileList | File[]) => void;
  onDismissUploadJob: (id: string) => void;
  onTriggerUpload: () => void;
  ttsState: TTSState;
  voiceSettings: VoiceSettings;
  browserVoices: SpeechSynthesisVoice[];
  onToggleListen: (messageId: string, content: string, lang: ResponseLanguage) => void;
  onStopAudio: () => void;
  onChangeAudioSpeed: (speed: PlaybackRate) => void;
  onContinueWithBrowser: () => void;
  onSwitchToGeminiAndReplay: (messageId: string, content: string, lang: ResponseLanguage) => void;
  onUpdateVoiceSettings: (patch: Partial<VoiceSettings>) => void;
  onSetBrowserVoice: (language: ResponseLanguage, voice: SavedBrowserVoice | null) => void;
  onSetGeminiVoice: (language: ResponseLanguage, voice: GeminiVoiceName) => void;
  onPreviewVoice: (params: PreviewVoiceParams) => void;
  onStopPreview: () => void;
  onReplayWithNewVoice: () => void;
  onDismissVoiceChangedPrompt: () => void;
  onOpenSettings: () => void;
  activeSourceId?: string | null;
  onOpenSource?: (source: RetrievedChunk, allSources: RetrievedChunk[]) => void;
  onToast: (type: 'success' | 'error' | 'info', title: string, message?: string) => void;
}

const SLASH_COMMANDS = [
  {
    command: '/summarize',
    label: 'Summarize',
    description: 'Map-reduce summary of selected documents',
    icon: BookOpen,
  },
  {
    command: '/mcq 5',
    label: 'Generate MCQs',
    description: 'Create 5 multiple-choice questions with answers',
    icon: ListChecks,
  },
  {
    command: '/short-answer 5',
    label: 'Short answers',
    description: 'Generate 5 short-answer study questions',
    icon: HelpCircle,
  },
  {
    command: '/explain ',
    label: 'Explain simply',
    description: 'Explain a topic from your documents in plain language',
    icon: AlignLeft,
  },
];

export function ChatWorkspace({
  documents,
  conversation,
  stats,
  selectedDocIds,
  language,
  uploadJobs,
  suggestedQuestions,
  isLoadingSuggestions,
  isGenerating,
  onChangeLanguage,
  onSendMessage,
  onRegenerate,
  onStopGeneration,
  onToggleDocSelection,
  onSelectAllDocs,
  onUploadFiles,
  onDismissUploadJob,
  onTriggerUpload,
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
  activeSourceId,
  onOpenSource,
  onToast,
}: ChatWorkspaceProps) {
  const [input, setInput] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);

  // Per-message Additional Information panel state (keyed by messageId)
  const [extraInfoPanels, setExtraInfoPanels] = useState<
    Record<
      string,
      {
        isOpen: boolean;
        isLoading: boolean;
        error: string | null;
        retryAvailableAt: number | null;
        record: ExtraInfoRecord | null;
      }
    >
  >({});
  const [cooldownNowMs, setCooldownNowMs] = useState<number>(() => Date.now());

  const {
    isSupported: isSpeechInputSupported,
    isListening: isMicListening,
    startListening,
    stopListening,
  } = useSpeechRecognition({
    language,
    onTranscript: (transcript) => setInput(transcript),
    onError: (msg) => onToast('error', 'Voice input', msg),
  });

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scopeMenuRef = useRef<HTMLDivElement | null>(null);

  const messages = conversation?.messages ?? [];
  const hasMessages = messages.length > 0;
  const totalPages = documents.reduce((sum, d) => sum + d.pageCount, 0);

  // Abort pending web-search fetches when switching conversations or unmounting
  useEffect(() => {
    abortAllExtraInfoRequests();
    setExtraInfoPanels({});

    return () => {
      abortAllExtraInfoRequests();
    };
  }, [conversation?.id]);

  // Tick once per second only while any panel has an active quota cooldown
  const hasActiveCooldown = Object.values(extraInfoPanels).some(
    (p) => typeof p.retryAvailableAt === 'number' && p.retryAvailableAt > cooldownNowMs
  );

  useEffect(() => {
    if (!hasActiveCooldown) return;
    const timer = window.setInterval(() => {
      setCooldownNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hasActiveCooldown]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.content]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  useEffect(() => {
    if (!scopeMenuOpen) return;
    const handleOutside = (e: MouseEvent) => {
      if (scopeMenuRef.current && !scopeMenuRef.current.contains(e.target as Node)) {
        setScopeMenuOpen(false);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setScopeMenuOpen(false);
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [scopeMenuOpen]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (isMicListening) {
      stopListening();
    }
    const trimmed = input.trim();
    if (!trimmed || isGenerating) return;
    setInput('');
    onSendMessage(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleCopyMessage = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // Clipboard blocked
    }
  };

  const findQuestionForAssistantMessage = (assistantMessageId: string): string => {
    const targetIdx = messages.findIndex((m) => m.id === assistantMessageId);
    if (targetIdx > 0) {
      for (let i = targetIdx - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user' && messages[i].content.trim()) {
          return messages[i].content.trim();
        }
      }
    }
    return '';
  };

  const extractTopicHints = (sources?: RetrievedChunk[]): string[] => {
    if (!Array.isArray(sources) || sources.length === 0) return [];
    const hints: string[] = [];
    const seen = new Set<string>();

    for (const chunk of sources.slice(0, 2)) {
      const cleanDocName = (chunk.fileName || '')
        .replace(/\.pdf$/i, '')
        .replace(/[_-]+/g, ' ')
        .trim();

      const lines = (chunk.text || '')
        .split(/\r?\n/)
        .map((line) => line.replace(/^[\s#*\-•\d.)]+/, '').replace(/\s+/g, ' ').trim())
        .filter((line) => line.length >= 4);

      // Prefer a short heading-like line among the first 3 lines; otherwise take a short opening phrase
      const headingLine =
        lines.slice(0, 3).find((l) => l.length <= 75) ?? lines[0] ?? '';

      let snippetTitle = headingLine;
      if (snippetTitle.length > 75) {
        const sentenceBreak = snippetTitle.slice(0, 75).search(/[.!?;:](?:\s|$)/);
        if (sentenceBreak >= 20) {
          snippetTitle = snippetTitle.slice(0, sentenceBreak).trim();
        } else {
          const lastSpace = snippetTitle.slice(0, 75).lastIndexOf(' ');
          snippetTitle = snippetTitle
            .slice(0, lastSpace > 20 ? lastSpace : 75)
            .trim();
        }
      }

      const hint =
        cleanDocName && snippetTitle
          ? `${cleanDocName}: ${snippetTitle}`
          : snippetTitle || cleanDocName;

      const normalized = hint.trim().slice(0, 110);
      if (normalized && !seen.has(normalized.toLowerCase())) {
        seen.add(normalized.toLowerCase());
        hints.push(normalized);
      }
    }

    return hints.slice(0, 2);
  };

  const loadExtraInfoForMessage = async (
    targetMsg: ChatMessage,
    question: string,
    forceRefresh: boolean
  ) => {
    const messageId = targetMsg.id;
    const answer = targetMsg.content;
    const topicHints = extractTopicHints(targetMsg.sources);

    // Prevent duplicate in-flight requests for the same answer
    if (isExtraInfoInFlight(messageId, language)) {
      setExtraInfoPanels((prev) => ({
        ...prev,
        [messageId]: {
          isOpen: true,
          isLoading: true,
          error: null,
          retryAvailableAt: prev[messageId]?.retryAvailableAt ?? null,
          record: prev[messageId]?.record ?? null,
        },
      }));
      return;
    }

    if (!forceRefresh) {
      const cached = await getCachedExtraInfo(messageId, language);
      if (cached) {
        setExtraInfoPanels((prev) => ({
          ...prev,
          [messageId]: {
            isOpen: true,
            isLoading: false,
            error: null,
            retryAvailableAt: null,
            record: cached,
          },
        }));
        return;
      }
    }

    // Respect active quota cooldown if user attempts refresh before timer finishes
    const existingPanel = extraInfoPanels[messageId];
    if (
      existingPanel?.retryAvailableAt &&
      existingPanel.retryAvailableAt > Date.now()
    ) {
      setCooldownNowMs(Date.now());
      setExtraInfoPanels((prev) => ({
        ...prev,
        [messageId]: {
          ...(prev[messageId] ?? {
            isLoading: false,
            error: null,
            retryAvailableAt: null,
            record: null,
          }),
          isOpen: true,
        },
      }));
      return;
    }

    setExtraInfoPanels((prev) => ({
      ...prev,
      [messageId]: {
        isOpen: true,
        isLoading: true,
        error: null,
        retryAvailableAt: null,
        record: forceRefresh ? prev[messageId]?.record ?? null : null,
      },
    }));

    try {
      const record = await fetchExtraInfo({
        messageId,
        question,
        answer,
        topicHints,
        language,
        forceRefresh,
      });

      setExtraInfoPanels((prev) => ({
        ...prev,
        [messageId]: {
          isOpen: true,
          isLoading: false,
          error: null,
          retryAvailableAt: null,
          record,
        },
      }));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;

      const isQuotaErr = err instanceof ExtraInfoError && err.isQuotaError;
      const cooldownSec =
        isQuotaErr && err.retryAfterSeconds && err.retryAfterSeconds > 0
          ? err.retryAfterSeconds
          : isQuotaErr
          ? 30
          : null;
      const now = Date.now();
      const retryAvailableAt = cooldownSec ? now + cooldownSec * 1000 : null;
      if (retryAvailableAt) {
        setCooldownNowMs(now);
      }

      const errMsg =
        err instanceof Error
          ? err.message
          : 'Could not load additional web information right now.';

      setExtraInfoPanels((prev) => ({
        ...prev,
        [messageId]: {
          isOpen: true,
          isLoading: false,
          error: errMsg,
          retryAvailableAt,
          record: prev[messageId]?.record ?? null,
        },
      }));
    }
  };

  const handleToggleExtraInfo = (targetMsg: ChatMessage) => {
    const current = extraInfoPanels[targetMsg.id];
    if (current?.isOpen) {
      handleCloseExtraInfo(targetMsg.id);
      return;
    }

    const question =
      findQuestionForAssistantMessage(targetMsg.id) ||
      targetMsg.commandLabel?.trim() ||
      'Question about uploaded document';
    void loadExtraInfoForMessage(targetMsg, question, false);
  };

  const handleCloseExtraInfo = (messageId: string) => {
    abortExtraInfoRequest(messageId);
    if (ttsState.activeMessageId === getExtraInfoTtsId(messageId)) {
      onStopAudio();
    }
    setExtraInfoPanels((prev) => {
      const existing = prev[messageId];
      if (!existing) return prev;
      return {
        ...prev,
        [messageId]: { ...existing, isOpen: false, isLoading: false },
      };
    });
  };

  const handleRefreshExtraInfo = (targetMsg: ChatMessage) => {
    if (extraInfoPanels[targetMsg.id]?.isLoading) return;
    if (ttsState.activeMessageId === getExtraInfoTtsId(targetMsg.id)) {
      onStopAudio();
    }
    const question =
      findQuestionForAssistantMessage(targetMsg.id) ||
      targetMsg.commandLabel?.trim() ||
      'Question about uploaded document';
    void loadExtraInfoForMessage(targetMsg, question, true);
  };

  const handleRegenerateWithCleanup = (messageId: string) => {
    handleCloseExtraInfo(messageId);
    void clearExtraInfoCacheForMessage(messageId);
    setExtraInfoPanels((prev) => {
      if (!prev[messageId]) return prev;
      const next = { ...prev };
      delete next[messageId];
      return next;
    });
    onRegenerate(messageId);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onUploadFiles(e.dataTransfer.files);
    }
  };

  const showSlashMenu = input.startsWith('/') && !input.includes(' ');
  const filteredSlashCommands = showSlashMenu
    ? SLASH_COMMANDS.filter((c) => c.command.toLowerCase().startsWith(input.toLowerCase()))
    : [];

  const scopeLabel =
    documents.length === 0
      ? 'No documents'
      : selectedDocIds.length === 0
      ? `All documents (${documents.length})`
      : selectedDocIds.length === 1
      ? documents.find((d) => d.id === selectedDocIds[0])?.fileName ?? '1 document'
      : `${selectedDocIds.length} selected`;

  return (
    <div
      className="flex-1 flex flex-col min-h-0 relative bg-surface"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setIsDragging(false);
      }}
      onDrop={handleDrop}
    >
      {/* Drag-and-drop overlay */}
      {isDragging && (
        <div className="absolute inset-4 z-30 rounded-[12px] bg-panel/95 border border-dashed border-accent flex flex-col items-center justify-center text-center p-6 pointer-events-none">
          <Upload className="w-5 h-5 text-accent mb-2" strokeWidth={1.5} />
          <p className="text-[14px] font-medium text-ink">Drop PDF files to upload</p>
          <p className="text-[12px] text-ink-secondary mt-1">
            PDF only, up to 20 MB per file.
          </p>
        </div>
      )}

      {/* Main scrollable conversation viewport */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
        <div className="max-w-[760px] mx-auto space-y-6">
          {/* Slim inline upload progress rows */}
          {uploadJobs.length > 0 && (
            <UploadProgressList jobs={uploadJobs} onDismiss={onDismissUploadJob} />
          )}

          {/* Minimal Welcome State */}
          {!hasMessages && (
            <div className="pt-6 sm:pt-12 pb-4 space-y-6">
              <div className="space-y-1.5">
                <h1 className="text-[24px] sm:text-[28px] font-semibold tracking-tight text-ink leading-[1.2]">
                  Ask your documents
                </h1>
                <p className="text-[13px] text-ink-secondary tabular-nums">
                  {documents.length} {documents.length === 1 ? 'document' : 'documents'}
                  {totalPages > 0 ? ` · ${totalPages} pages` : ''}
                  {' · '}
                  {stats.totalQuestionsAsked}{' '}
                  {stats.totalQuestionsAsked === 1 ? 'question' : 'questions'} asked
                </p>
              </div>

              {/* Dashed drag-and-drop upload zone */}
              <div
                role="button"
                tabIndex={0}
                onClick={onTriggerUpload}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onTriggerUpload();
                  }
                }}
                className="rounded-[10px] border border-dashed border-line-strong bg-panel px-5 py-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 hover:border-accent/70 transition-colors duration-150 ease-out cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <div className="flex items-start gap-3">
                  <Upload
                    className="w-[18px] h-[18px] text-ink-secondary shrink-0 mt-0.5"
                    strokeWidth={1.5}
                  />
                  <div className="space-y-0.5">
                    <p className="text-[14px] font-medium text-ink">
                      {documents.length === 0
                        ? 'Drop PDF files here or choose from your computer'
                        : 'Add more PDF files to your workspace'}
                    </p>
                    <p className="text-[12px] text-ink-secondary">
                      Text-based PDFs up to 20 MB each. Indexed and saved locally in your browser.
                    </p>
                  </div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTriggerUpload();
                  }}
                  className="self-start sm:self-center"
                >
                  Choose PDF
                </Button>
              </div>

              {/* Suggested prompts as plain outlined chips */}
              {documents.length > 0 && (
                <div className="space-y-2.5">
                  <p className="text-[12px] font-medium text-ink-muted">Suggested prompts</p>
                  {isLoadingSuggestions ? (
                    <div className="flex flex-wrap gap-2">
                      <Skeleton className="h-8 w-52" />
                      <Skeleton className="h-8 w-64" />
                      <Skeleton className="h-8 w-44" />
                      <Skeleton className="h-8 w-56" />
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {suggestedQuestions.slice(0, 4).map((q, idx) => (
                        <Chip
                          key={idx}
                          disabled={isGenerating}
                          onClick={() => onSendMessage(q)}
                          className="text-left py-2 px-3 text-[13px] font-normal text-ink"
                        >
                          {q}
                        </Chip>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Quiet slash-command reference when docs exist */}
              {documents.length > 0 && (
                <div className="pt-2 border-t border-line flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-ink-muted">
                  <span>Quick commands:</span>
                  {SLASH_COMMANDS.map((cmd) => (
                    <button
                      key={cmd.command}
                      type="button"
                      disabled={isGenerating}
                      onClick={() => {
                        if (cmd.command.endsWith(' ')) {
                          setInput(cmd.command);
                          textareaRef.current?.focus();
                        } else {
                          onSendMessage(cmd.command);
                        }
                      }}
                      className="font-mono text-[12px] text-ink-secondary hover:text-accent transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-[4px]"
                    >
                      {cmd.command.trim()}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Chat Thread */}
          {hasMessages && (
            <div className="space-y-6 pb-4">
              {messages.map((msg) => {
                const isUser = msg.role === 'user';

                if (isUser) {
                  return (
                    <div key={msg.id} className="flex justify-end">
                      <div className="max-w-[85%] rounded-[10px] bg-raised border border-line px-4 py-2.5 text-[14px] leading-[1.55] text-ink whitespace-pre-wrap break-words">
                        {msg.content}
                      </div>
                    </div>
                  );
                }

                // AI answer rendered as plain text directly on the page background (no colored bubble)
                return (
                  <article key={msg.id} className="space-y-1.5">
                    <div className="flex items-center gap-2 text-[12px] text-ink-muted">
                      <span className="font-medium text-ink-secondary">DocuMind</span>
                      {msg.commandLabel && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{msg.commandLabel}</span>
                        </>
                      )}
                      {msg.generalKnowledgeUsed && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>Includes general knowledge</span>
                        </>
                      )}
                      {msg.language === 'ta' && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>தமிழ்</span>
                        </>
                      )}
                    </div>

                    {msg.isStreaming && !msg.content ? (
                      <div className="pt-1.5 max-w-[600px]">
                        <SkeletonLines lines={3} />
                      </div>
                    ) : msg.isError ? (
                      <div className="rounded-[8px] bg-status-error-soft border border-status-error/25 px-3.5 py-2.5 text-[13px] text-status-error">
                        {msg.content}
                      </div>
                    ) : (
                      <div>
                        <MarkdownRenderer content={msg.content} />
                        {msg.isStreaming && (
                          <span
                            className="inline-block w-[2px] h-[15px] ml-1 align-middle bg-accent dm-streaming-cursor"
                            aria-label="Streaming response"
                          />
                        )}
                      </div>
                    )}

                    {/* Compact collapsible Sources row */}
                    {msg.sources && msg.sources.length > 0 && (
                      <SourcesPanel
                        sources={msg.sources}
                        activeSourceId={activeSourceId}
                        onOpenSource={onOpenSource}
                      />
                    )}

                    {/* Subtle action row */}
                    {!msg.isStreaming && msg.content && (
                      <div className="pt-1 flex flex-wrap items-center gap-1">
                        <Tooltip content={copiedId === msg.id ? 'Copied' : 'Copy answer'}>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleCopyMessage(msg.id, msg.content)}
                            className="h-7 px-2 text-[12px] text-ink-muted hover:text-ink"
                          >
                            {copiedId === msg.id ? (
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

                        <Tooltip content="Regenerate response">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isGenerating}
                            onClick={() => handleRegenerateWithCleanup(msg.id)}
                            className="h-7 px-2 text-[12px] text-ink-muted hover:text-ink"
                          >
                            <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.5} />
                            <span>Regenerate</span>
                          </Button>
                        </Tooltip>

                        {!msg.isError && (
                          <ListenButtonGroup
                            messageId={msg.id}
                            language={language}
                            ttsState={ttsState}
                            voiceSettings={voiceSettings}
                            browserVoices={browserVoices}
                            onTogglePlayPause={() =>
                              onToggleListen(msg.id, msg.content, language)
                            }
                            onStop={onStopAudio}
                            onUpdateVoiceSettings={onUpdateVoiceSettings}
                            onSetBrowserVoice={onSetBrowserVoice}
                            onSetGeminiVoice={onSetGeminiVoice}
                            onPreviewVoice={onPreviewVoice}
                            onStopPreview={onStopPreview}
                          />
                        )}

                        {!msg.isError && (() => {
                          const panelState = extraInfoPanels[msg.id];
                          const isPanelOpen = Boolean(panelState?.isOpen);
                          const isPanelLoading = Boolean(panelState?.isLoading);
                          const panelId = `extra-info-panel-${msg.id}`;
                          return (
                            <Tooltip
                              content={
                                isPanelOpen
                                  ? 'Hide additional web information'
                                  : 'Search the web for additional information'
                              }
                            >
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleToggleExtraInfo(msg)}
                                aria-expanded={isPanelOpen}
                                aria-controls={panelId}
                                aria-label="Additional information from the web"
                                className={`h-7 px-2 text-[12px] ${
                                  isPanelOpen || isPanelLoading
                                    ? 'text-accent hover:text-accent'
                                    : 'text-ink-muted hover:text-ink'
                                }`}
                              >
                                <Globe className="w-3.5 h-3.5" strokeWidth={1.5} />
                                <span>
                                  {isPanelLoading
                                    ? 'Searching...'
                                    : 'Additional information'}
                                </span>
                              </Button>
                            </Tooltip>
                          );
                        })()}
                      </div>
                    )}

                    {/* Compact Audio Control Bar when this answer is active */}
                    {!msg.isStreaming && !msg.isError && msg.content && (
                      <MessageAudioBar
                        messageId={msg.id}
                        ttsState={ttsState}
                        onTogglePlayPause={() =>
                          onToggleListen(msg.id, msg.content, language)
                        }
                        onStop={onStopAudio}
                        onChangeSpeed={onChangeAudioSpeed}
                        onContinueWithBrowser={onContinueWithBrowser}
                        onSwitchToGemini={() =>
                          onSwitchToGeminiAndReplay(msg.id, msg.content, language)
                        }
                        onReplayWithNewVoice={onReplayWithNewVoice}
                        onDismissVoiceChangedPrompt={onDismissVoiceChangedPrompt}
                        onOpenSettings={onOpenSettings}
                      />
                    )}

                    {/* Additional Information (Web Grounded) Panel */}
                    {!msg.isStreaming &&
                      !msg.isError &&
                      msg.content &&
                      extraInfoPanels[msg.id]?.isOpen && (() => {
                        const panel = extraInfoPanels[msg.id];
                        const retryCountdownSec =
                          typeof panel.retryAvailableAt === 'number'
                            ? Math.max(
                                0,
                                Math.ceil((panel.retryAvailableAt - cooldownNowMs) / 1000)
                              )
                            : 0;
                        return (
                          <AdditionalInfoPanel
                            panelId={`extra-info-panel-${msg.id}`}
                            messageId={msg.id}
                            isLoading={panel.isLoading}
                            error={panel.error}
                            retryCountdownSec={retryCountdownSec}
                            record={panel.record}
                            language={language}
                            ttsState={ttsState}
                            voiceSettings={voiceSettings}
                            browserVoices={browserVoices}
                            onToggleListen={onToggleListen}
                            onStopAudio={onStopAudio}
                            onChangeAudioSpeed={onChangeAudioSpeed}
                            onContinueWithBrowser={onContinueWithBrowser}
                            onSwitchToGeminiAndReplay={onSwitchToGeminiAndReplay}
                            onUpdateVoiceSettings={onUpdateVoiceSettings}
                            onSetBrowserVoice={onSetBrowserVoice}
                            onSetGeminiVoice={onSetGeminiVoice}
                            onPreviewVoice={onPreviewVoice}
                            onStopPreview={onStopPreview}
                            onReplayWithNewVoice={onReplayWithNewVoice}
                            onDismissVoiceChangedPrompt={onDismissVoiceChangedPrompt}
                            onOpenSettings={onOpenSettings}
                            onRefresh={() => handleRefreshExtraInfo(msg)}
                            onClose={() => handleCloseExtraInfo(msg.id)}
                          />
                        );
                      })()}
                  </article>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
      </div>

      {/* Pinned Bottom Composer */}
      <div className="px-4 sm:px-6 pb-4 pt-2 border-t border-line bg-surface shrink-0">
        <div className="max-w-[760px] mx-auto relative">
          {/* Slash Command Popover */}
          {filteredSlashCommands.length > 0 && (
            <div className="absolute bottom-full left-0 right-0 mb-2 rounded-[10px] bg-panel border border-line shadow-lg overflow-hidden z-20">
              <div className="px-3 py-1.5 border-b border-line text-[12px] text-ink-muted">
                Commands
              </div>
              <div className="py-1">
                {filteredSlashCommands.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.command}
                      type="button"
                      onClick={() => {
                        setInput(item.command);
                        textareaRef.current?.focus();
                      }}
                      className="w-full px-3 py-2 flex items-center gap-2.5 text-left hover:bg-raised transition-colors duration-150 cursor-pointer"
                    >
                      <Icon className="w-4 h-4 text-ink-secondary shrink-0" strokeWidth={1.5} />
                      <span className="font-mono text-[12px] font-medium text-ink whitespace-nowrap">
                        {item.command.trim()}
                      </span>
                      <span className="text-[12px] text-ink-secondary truncate">
                        {item.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            className="rounded-[10px] bg-panel border border-line focus-within:border-accent transition-colors duration-150 ease-out"
          >
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isGenerating}
              placeholder={
                documents.length === 0
                  ? 'Upload a PDF to ask questions...'
                  : language === 'ta'
                  ? 'உங்கள் ஆவணங்களைப் பற்றி கேளுங்கள் அல்லது /summarize என உள்ளிடவும்...'
                  : 'Ask a question about your documents, or type / for commands...'
              }
              className="w-full bg-transparent resize-none px-3.5 pt-3 pb-2 text-[14px] leading-[1.55] text-ink placeholder:text-ink-muted focus:outline-none max-h-40"
            />

            {/* Composer Control Row */}
            <div className="px-2.5 pb-2.5 pt-1 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
                {/* Attach PDF button */}
                <Tooltip content="Attach PDF">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={onTriggerUpload}
                    aria-label="Attach PDF"
                  >
                    <Paperclip className="w-4 h-4" strokeWidth={1.5} />
                  </Button>
                </Tooltip>

                {/* Document Scope Popover Selector */}
                <div className="relative" ref={scopeMenuRef}>
                  <button
                    type="button"
                    disabled={documents.length === 0}
                    onClick={() => setScopeMenuOpen((v) => !v)}
                    aria-expanded={scopeMenuOpen}
                    className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[6px] bg-surface border border-line text-[12px] font-medium text-ink-secondary hover:text-ink hover:border-line-strong transition-colors duration-150 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed max-w-[200px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <FileText className="w-3.5 h-3.5 text-ink-muted shrink-0" strokeWidth={1.5} />
                    <span className="truncate">{scopeLabel}</span>
                    <ChevronDown className="w-3.5 h-3.5 text-ink-muted shrink-0" strokeWidth={1.5} />
                  </button>

                  {scopeMenuOpen && documents.length > 0 && (
                    <div className="absolute bottom-full left-0 mb-2 w-64 rounded-[10px] bg-panel border border-line shadow-lg p-1.5 z-30">
                      <button
                        type="button"
                        onClick={() => {
                          onSelectAllDocs();
                          setScopeMenuOpen(false);
                        }}
                        className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-[6px] text-[12px] text-left transition-colors duration-150 cursor-pointer ${
                          selectedDocIds.length === 0
                            ? 'bg-accent-soft text-accent font-medium'
                            : 'text-ink hover:bg-raised'
                        }`}
                      >
                        <span>All documents ({documents.length})</span>
                        {selectedDocIds.length === 0 && (
                          <Check className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} />
                        )}
                      </button>

                      <div className="my-1 border-t border-line" />

                      <div className="max-h-48 overflow-y-auto space-y-0.5">
                        {documents.map((doc) => {
                          const isChecked = selectedDocIds.includes(doc.id);
                          return (
                            <button
                              key={doc.id}
                              type="button"
                              onClick={() => onToggleDocSelection(doc.id)}
                              className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-[6px] text-[12px] text-left transition-colors duration-150 cursor-pointer ${
                                isChecked
                                  ? 'bg-raised text-ink font-medium'
                                  : 'text-ink-secondary hover:bg-raised hover:text-ink'
                              }`}
                            >
                              <span className="truncate">{doc.fileName}</span>
                              {isChecked && (
                                <Check
                                  className="w-3.5 h-3.5 text-accent shrink-0"
                                  strokeWidth={1.5}
                                />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* Language Selector */}
                <Select
                  size="sm"
                  aria-label="Response language"
                  value={language}
                  onChange={(e) => onChangeLanguage(e.target.value as ResponseLanguage)}
                  options={[
                    { value: 'en', label: 'English' },
                    { value: 'ta', label: 'தமிழ்' },
                  ]}
                />
              </div>

              {/* Microphone (optional Web Speech API) + Send / Stop */}
              <div className="flex items-center gap-1.5 shrink-0">
                {isSpeechInputSupported && !isGenerating && (
                  <Tooltip
                    content={
                      isMicListening
                        ? 'Stop voice input'
                        : `Voice input (${language === 'ta' ? 'ta-IN' : 'en-IN'})`
                    }
                  >
                    <Button
                      variant={isMicListening ? 'secondary' : 'ghost'}
                      size="icon"
                      onClick={() => {
                        if (isMicListening) {
                          stopListening();
                        } else {
                          startListening(input);
                        }
                      }}
                      aria-label={isMicListening ? 'Stop voice input' : 'Start voice input'}
                      aria-pressed={isMicListening}
                      className={
                        isMicListening
                          ? 'text-accent border-accent/50 bg-accent-soft'
                          : ''
                      }
                    >
                      {isMicListening ? (
                        <MicOff className="w-4 h-4" strokeWidth={1.5} />
                      ) : (
                        <Mic className="w-4 h-4" strokeWidth={1.5} />
                      )}
                    </Button>
                  </Tooltip>
                )}

                {isGenerating ? (
                  <Tooltip content="Stop generating">
                    <Button
                      variant="secondary"
                      size="icon"
                      onClick={onStopGeneration}
                      aria-label="Stop generating"
                    >
                      <Square className="w-3.5 h-3.5 fill-current" strokeWidth={1.5} />
                    </Button>
                  </Tooltip>
                ) : (
                  <Tooltip content="Send (Enter)">
                    <Button
                      type="submit"
                      variant="primary"
                      size="icon"
                      disabled={!input.trim() || documents.length === 0}
                      aria-label="Send message"
                    >
                      <ArrowUp className="w-4 h-4" strokeWidth={1.5} />
                    </Button>
                  </Tooltip>
                )}
              </div>
            </div>
          </form>

          <p className="text-[12px] text-ink-muted mt-2 text-center">
            Grounded in retrieved excerpts. Enter to send, Shift+Enter for a new line.
          </p>
        </div>
      </div>
    </div>
  );
}
