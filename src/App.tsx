import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Menu, PanelLeftOpen, Trash2, Upload } from 'lucide-react';
import { ChatWorkspace } from './components/ChatWorkspace';
import { DocumentsView } from './components/DocumentsView';
import { PdfViewerPanel } from './components/PdfViewerPanel';
import { SearchView } from './components/SearchView';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { StudyToolsView, type StudyTab } from './components/StudyToolsView';
import { ToastContainer } from './components/ToastContainer';
import { Button } from './components/ui/Button';
import { SkeletonLines } from './components/ui/Skeleton';
import { Tooltip } from './components/ui/Tooltip';
import { useDocuMind } from './hooks/useDocuMind';
import { useTheme } from './hooks/useTheme';
import { useToast } from './hooks/useToast';
import { useVoice } from './hooks/useVoice';
import type { AppView, RetrievedChunk } from './types';

const VIEW_LABELS: Record<AppView, string> = {
  chat: 'Chat',
  documents: 'Documents',
  study: 'Study tools',
  search: 'Search',
};

export default function App() {
  const [activeView, setActiveView] = useState<AppView>('chat');
  const [studyInitialDocId, setStudyInitialDocId] = useState<string | null>(null);
  const [studyInitialTab, setStudyInitialTab] = useState<StudyTab>('summarize');
  const [isDesktopSidebarCollapsed, setIsDesktopSidebarCollapsed] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [pdfViewerState, setPdfViewerState] = useState<{
    activeSource: RetrievedChunk;
    sources: RetrievedChunk[];
  } | null>(null);

  const globalFileInputRef = useRef<HTMLInputElement | null>(null);
  const { toasts, addToast, dismissToast } = useToast();
  const { theme, toggleTheme } = useTheme();

  const {
    voiceSettings,
    ttsState,
    browserVoices,
    updateVoiceSettings,
    setBrowserVoiceForLanguage,
    setGeminiVoiceForLanguage,
    speakMessage,
    togglePlayPause,
    stopPlayback,
    setPlaybackSpeed,
    continueWithBrowserVoice,
    switchToGeminiAndReplay,
    replayWithNewVoice,
    dismissVoiceChangedPrompt,
    previewVoice,
    stopPreview,
  } = useVoice();

  const {
    isBooting,
    bootError,
    documents,
    conversations,
    activeConversation,
    selectedDocIds,
    language,
    stats,
    uploadJobs,
    suggestedQuestions,
    isLoadingSuggestions,
    isGenerating,
    setLanguage,
    uploadFiles,
    dismissUploadJob,
    deleteDocument,
    toggleDocSelection,
    selectAllDocs,
    startNewChat,
    selectConversation,
    deleteConversation,
    clearActiveConversation,
    sendMessage,
    regenerateMessage,
    stopGeneration,
    incrementStat,
  } = useDocuMind({ onToast: addToast });

  // Track streaming -> completed transition for "Auto-read new answers"
  const lastStreamingIdRef = useRef<string | null>(null);
  useEffect(() => {
    const msgs = activeConversation?.messages ?? [];
    const last = msgs[msgs.length - 1];

    if (!last || last.role !== 'assistant') {
      lastStreamingIdRef.current = null;
      return;
    }

    if (last.isStreaming) {
      lastStreamingIdRef.current = last.id;
      return;
    }

    if (
      lastStreamingIdRef.current === last.id &&
      !last.isError &&
      last.content.trim().length > 0
    ) {
      lastStreamingIdRef.current = null;
      if (voiceSettings.autoRead) {
        speakMessage(last.id, last.content, language);
      }
    }
  }, [activeConversation?.messages, language, speakMessage, voiceSettings.autoRead]);

  const triggerGlobalUpload = () => {
    globalFileInputRef.current?.click();
  };

  const handleSelectView = (view: AppView) => {
    if (view !== activeView) {
      stopPlayback();
    }
    setActiveView(view);
  };

  const handleNewChat = () => {
    stopPlayback();
    startNewChat();
  };

  const handleSelectConversation = (id: string) => {
    stopPlayback();
    selectConversation(id);
  };

  const handleOpenSource = (source: RetrievedChunk, allSources: RetrievedChunk[]) => {
    setPdfViewerState({
      activeSource: source,
      sources: allSources.length > 0 ? allSources : [source],
    });
  };

  const handleDeleteDocument = async (docId: string) => {
    setPdfViewerState((prev) => {
      if (!prev) return null;
      if (prev.activeSource.docId === docId) return null;
      const remaining = prev.sources.filter((s) => s.docId !== docId);
      return { ...prev, sources: remaining };
    });
    await deleteDocument(docId);
  };

  const handleClearConversation = () => {
    stopPlayback();
    setPdfViewerState(null);
    clearActiveConversation();
  };

  const handleSendMessage = (text: string) => {
    stopPlayback();
    sendMessage(text);
  };

  const handleRegenerate = (assistantMessageId: string) => {
    stopPlayback();
    regenerateMessage(assistantMessageId);
  };

  const handleChatWithDocument = (docId: string) => {
    stopPlayback();
    startNewChat([docId]);
    setActiveView('chat');
  };

  const handleStudyDocument = (docId: string) => {
    stopPlayback();
    setStudyInitialDocId(docId);
    setStudyInitialTab('summarize');
    setActiveView('study');
  };

  const handleAudioOverviewDocument = (docId: string) => {
    stopPlayback();
    setStudyInitialDocId(docId);
    setStudyInitialTab('audio-overview');
    setActiveView('study');
  };

  const handleAskAboutSnippet = (docId: string, prompt: string) => {
    stopPlayback();
    const conv = startNewChat([docId]);
    setActiveView('chat');
    sendMessage(prompt, { baseHistory: [], existingConv: conv });
  };

  if (isBooting) {
    return (
      <div className="min-h-screen bg-surface text-ink flex items-center justify-center p-6">
        <div className="max-w-sm w-full space-y-3">
          <p className="text-[13px] font-medium text-ink-secondary">Loading workspace</p>
          <SkeletonLines lines={3} />
        </div>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="min-h-screen bg-surface text-ink flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-[10px] bg-panel border border-line p-6 flex items-start gap-3">
          <AlertCircle
            className="w-[18px] h-[18px] text-status-error shrink-0 mt-0.5"
            strokeWidth={1.5}
          />
          <div className="space-y-1">
            <h1 className="text-[16px] font-semibold text-ink">
              Browser storage unavailable
            </h1>
            <p className="text-[13px] text-ink-secondary leading-relaxed">{bootError}</p>
          </div>
        </div>
      </div>
    );
  }

  const hasChatMessages =
    activeView === 'chat' && (activeConversation?.messages.length ?? 0) > 0;

  const headerTitle =
    activeView === 'chat' && activeConversation && activeConversation.messages.length > 0
      ? activeConversation.title
      : VIEW_LABELS[activeView];

  return (
    <div className="min-h-screen h-screen bg-surface text-ink flex overflow-hidden">
      {/* Hidden global PDF file input */}
      <input
        ref={globalFileInputRef}
        type="file"
        accept=".pdf,application/pdf"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) {
            uploadFiles(e.target.files);
            e.target.value = '';
          }
        }}
      />

      {/* Collapsible Desktop Sidebar / Mobile Drawer */}
      <Sidebar
        activeView={activeView}
        onSelectView={handleSelectView}
        conversations={conversations}
        activeConversationId={activeConversation?.id ?? null}
        onNewChat={handleNewChat}
        onSelectConversation={handleSelectConversation}
        onDeleteConversation={(id) => {
          if (id === activeConversation?.id) stopPlayback();
          deleteConversation(id);
        }}
        documents={documents}
        onDeleteDocument={handleDeleteDocument}
        language={language}
        onChangeLanguage={(nextLang) => {
          stopPlayback();
          setLanguage(nextLang);
        }}
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpenSettings={() => setIsSettingsOpen(true)}
        isDesktopCollapsed={isDesktopSidebarCollapsed}
        onCollapseDesktop={() => setIsDesktopSidebarCollapsed(true)}
        isMobileOpen={isMobileSidebarOpen}
        onCloseMobile={() => setIsMobileSidebarOpen(false)}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
        {/* Minimal Top Bar */}
        <header className="h-13 px-4 sm:px-5 border-b border-line bg-surface flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsMobileSidebarOpen(true)}
              aria-label="Open sidebar"
              className="lg:hidden"
            >
              <Menu className="w-[18px] h-[18px]" strokeWidth={1.5} />
            </Button>

            {isDesktopSidebarCollapsed && (
              <Tooltip content="Expand sidebar" side="bottom">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setIsDesktopSidebarCollapsed(false)}
                  aria-label="Expand sidebar"
                  className="hidden lg:inline-flex"
                >
                  <PanelLeftOpen className="w-4 h-4" strokeWidth={1.5} />
                </Button>
              </Tooltip>
            )}

            <span className="text-[14px] font-medium text-ink truncate">{headerTitle}</span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {hasChatMessages && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearConversation}
                className="text-ink-secondary hover:text-status-error"
              >
                <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                Clear
              </Button>
            )}
            {activeView === 'documents' && (
              <Button variant="primary" size="sm" onClick={triggerGlobalUpload}>
                <Upload className="w-3.5 h-3.5" strokeWidth={1.5} />
                Upload PDF
              </Button>
            )}
          </div>
        </header>

        <div className="flex-1 flex min-h-0 overflow-hidden">
          <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
            {activeView === 'chat' && (
              <ChatWorkspace
                documents={documents}
                conversation={activeConversation}
                stats={stats}
                selectedDocIds={selectedDocIds}
                language={language}
                uploadJobs={uploadJobs}
                suggestedQuestions={suggestedQuestions}
                isLoadingSuggestions={isLoadingSuggestions}
                isGenerating={isGenerating}
                onChangeLanguage={(nextLang) => {
                  stopPlayback();
                  setLanguage(nextLang);
                }}
                onSendMessage={handleSendMessage}
                onRegenerate={handleRegenerate}
                onStopGeneration={stopGeneration}
                onToggleDocSelection={toggleDocSelection}
                onSelectAllDocs={selectAllDocs}
                onUploadFiles={uploadFiles}
                onDismissUploadJob={dismissUploadJob}
                onTriggerUpload={triggerGlobalUpload}
                ttsState={ttsState}
                voiceSettings={voiceSettings}
                browserVoices={browserVoices}
                onToggleListen={togglePlayPause}
                onStopAudio={stopPlayback}
                onChangeAudioSpeed={setPlaybackSpeed}
                onContinueWithBrowser={continueWithBrowserVoice}
                onSwitchToGeminiAndReplay={switchToGeminiAndReplay}
                onUpdateVoiceSettings={updateVoiceSettings}
                onSetBrowserVoice={setBrowserVoiceForLanguage}
                onSetGeminiVoice={setGeminiVoiceForLanguage}
                onPreviewVoice={previewVoice}
                onStopPreview={stopPreview}
                onReplayWithNewVoice={replayWithNewVoice}
                onDismissVoiceChangedPrompt={dismissVoiceChangedPrompt}
                onOpenSettings={() => setIsSettingsOpen(true)}
                activeSourceId={pdfViewerState?.activeSource.id ?? null}
                onOpenSource={handleOpenSource}
                onToast={addToast}
              />
            )}

            {activeView === 'documents' && (
              <DocumentsView
                documents={documents}
                uploadJobs={uploadJobs}
                onUploadFiles={uploadFiles}
                onDismissUploadJob={dismissUploadJob}
                onDeleteDocument={handleDeleteDocument}
                onChatWithDocument={handleChatWithDocument}
                onStudyDocument={handleStudyDocument}
                onAudioOverviewDocument={handleAudioOverviewDocument}
              />
            )}

            {activeView === 'study' && (
              <StudyToolsView
                key={`${studyInitialDocId ?? 'all'}-${studyInitialTab}`}
                documents={documents}
                initialDocId={studyInitialDocId}
                initialTab={studyInitialTab}
                language={language}
                onTriggerUpload={triggerGlobalUpload}
                onStatIncrement={incrementStat}
                activeSourceId={pdfViewerState?.activeSource.id ?? null}
                onOpenSource={handleOpenSource}
                onToast={addToast}
              />
            )}

            {activeView === 'search' && (
              <SearchView
                documents={documents}
                onTriggerUpload={triggerGlobalUpload}
                onAskAboutSnippet={handleAskAboutSnippet}
              />
            )}
          </div>

          <PdfViewerPanel
            activeSource={pdfViewerState?.activeSource ?? null}
            allSources={pdfViewerState?.sources ?? []}
            onSelectSource={(source) =>
              setPdfViewerState((prev) =>
                prev
                  ? { ...prev, activeSource: source }
                  : { activeSource: source, sources: [source] }
              )
            }
            onClose={() => setPdfViewerState(null)}
          />
        </div>
      </div>

      <SettingsDialog
        open={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        language={language}
        voiceSettings={voiceSettings}
        browserVoices={browserVoices}
        ttsState={ttsState}
        onUpdateVoiceSettings={updateVoiceSettings}
        onSetBrowserVoice={setBrowserVoiceForLanguage}
        onSetGeminiVoice={setGeminiVoiceForLanguage}
        onChangeSpeed={setPlaybackSpeed}
        onPreviewVoice={previewVoice}
        onStopPreview={stopPreview}
      />

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
