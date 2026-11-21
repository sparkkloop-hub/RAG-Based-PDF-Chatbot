import { useMemo, useState } from 'react';
import {
  BookOpen,
  FileText,
  FolderOpen,
  MessageSquare,
  Moon,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  Sun,
  Trash2,
  X,
} from 'lucide-react';
import type { ThemeMode } from '../hooks/useTheme';
import type { AppView, Conversation, DocumentRecord, ResponseLanguage } from '../types';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';
import { Tooltip } from './ui/Tooltip';

interface SidebarProps {
  activeView: AppView;
  onSelectView: (view: AppView) => void;
  conversations: Conversation[];
  activeConversationId: string | null;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  documents: DocumentRecord[];
  onDeleteDocument: (id: string) => void;
  language: ResponseLanguage;
  onChangeLanguage: (lang: ResponseLanguage) => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  isDesktopCollapsed: boolean;
  onCollapseDesktop: () => void;
  isMobileOpen: boolean;
  onCloseMobile: () => void;
}

const NAV_ITEMS: { id: AppView; label: string; icon: typeof MessageSquare }[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'documents', label: 'Documents', icon: FolderOpen },
  { id: 'study', label: 'Study tools', icon: BookOpen },
  { id: 'search', label: 'Search', icon: Search },
];

type TimeBucket = 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older';

function getTimeBucket(timestamp: number): TimeBucket {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const oneDay = 24 * 60 * 60 * 1000;
  const startOfYesterday = startOfToday - oneDay;
  const startOfLast7Days = startOfToday - 7 * oneDay;

  if (timestamp >= startOfToday) return 'Today';
  if (timestamp >= startOfYesterday) return 'Yesterday';
  if (timestamp >= startOfLast7Days) return 'Previous 7 days';
  return 'Older';
}

const BUCKET_ORDER: TimeBucket[] = ['Today', 'Yesterday', 'Previous 7 days', 'Older'];

export function Sidebar({
  activeView,
  onSelectView,
  conversations,
  activeConversationId,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
  documents,
  onDeleteDocument,
  language,
  onChangeLanguage,
  theme,
  onToggleTheme,
  onOpenSettings,
  isDesktopCollapsed,
  onCollapseDesktop,
  isMobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const [docPendingDelete, setDocPendingDelete] = useState<DocumentRecord | null>(null);

  const groupedConversations = useMemo(() => {
    const groups: Record<TimeBucket, Conversation[]> = {
      Today: [],
      Yesterday: [],
      'Previous 7 days': [],
      Older: [],
    };
    for (const conv of conversations) {
      groups[getTimeBucket(conv.updatedAt)].push(conv);
    }
    return groups;
  }, [conversations]);

  const handleNavClick = (view: AppView) => {
    onSelectView(view);
    onCloseMobile();
  };

  const sidebarContent = (
    <div className="flex flex-col h-full bg-panel border-r border-line w-[260px] select-none">
      {/* Header: simple text wordmark + collapse button */}
      <div className="px-4 h-13 flex items-center justify-between border-b border-line shrink-0">
        <button
          type="button"
          onClick={() => handleNavClick('chat')}
          className="text-[15px] font-semibold tracking-tight text-ink cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-[4px] px-0.5"
        >
          DocuMind
        </button>

        <Tooltip content="Collapse sidebar" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            onClick={onCollapseDesktop}
            aria-label="Collapse sidebar"
            className="hidden lg:inline-flex"
          >
            <PanelLeftClose className="w-4 h-4" strokeWidth={1.5} />
          </Button>
        </Tooltip>

        <Button
          variant="ghost"
          size="icon"
          onClick={onCloseMobile}
          aria-label="Close sidebar"
          className="lg:hidden"
        >
          <X className="w-4 h-4" strokeWidth={1.5} />
        </Button>
      </div>

      {/* New Chat Button + Workspace Nav */}
      <div className="p-3 space-y-2 border-b border-line shrink-0">
        <Button
          variant="primary"
          size="md"
          onClick={() => {
            onNewChat();
            onSelectView('chat');
            onCloseMobile();
          }}
          className="w-full"
        >
          <Plus className="w-4 h-4" strokeWidth={1.5} />
          New chat
        </Button>

        <nav aria-label="Workspace views" className="space-y-0.5 pt-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavClick(item.id)}
                className={`w-full flex items-center justify-between gap-2 px-2.5 h-9 sm:h-8 rounded-[6px] text-[13px] font-medium transition-colors duration-150 ease-out cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  isActive
                    ? 'bg-accent-soft text-accent'
                    : 'text-ink-secondary hover:text-ink hover:bg-raised'
                }`}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <Icon className="w-4 h-4 shrink-0" strokeWidth={1.5} />
                  <span className="truncate">{item.label}</span>
                </span>
                {item.id === 'documents' && documents.length > 0 && (
                  <span className="text-[12px] font-mono tabular-nums text-ink-muted">
                    {documents.length}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Scrollable Documents & History */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
        {/* Documents section */}
        <section aria-label="Uploaded documents">
          <div className="px-2 mb-1.5 flex items-center justify-between">
            <h2 className="text-[12px] font-medium text-ink-muted">Documents</h2>
            <span className="text-[12px] font-mono tabular-nums text-ink-muted">
              {documents.length}
            </span>
          </div>

          {documents.length === 0 ? (
            <p className="px-2 text-[12px] text-ink-muted leading-relaxed">
              No documents uploaded yet.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {documents.map((doc) => (
                <li
                  key={doc.id}
                  className="group relative flex items-center justify-between gap-2 px-2 h-8 rounded-[6px] hover:bg-raised transition-colors duration-150"
                >
                  <button
                    type="button"
                    onClick={() => handleNavClick('documents')}
                    className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-[4px]"
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full bg-status-success shrink-0"
                      title="Indexed and ready"
                    />
                    <FileText
                      className="w-3.5 h-3.5 text-ink-muted shrink-0"
                      strokeWidth={1.5}
                    />
                    <span className="text-[13px] text-ink truncate flex-1">
                      {doc.fileName}
                    </span>
                    <span className="text-[12px] font-mono tabular-nums text-ink-muted shrink-0 group-hover:opacity-0 transition-opacity duration-150">
                      {doc.pageCount}p
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setDocPendingDelete(doc)}
                    aria-label={`Delete ${doc.fileName}`}
                    className="absolute right-1.5 p-1 rounded-[4px] text-ink-muted hover:text-status-error hover:bg-status-error-soft opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* History section grouped by date */}
        <section aria-label="Conversation history">
          <div className="px-2 mb-1.5 flex items-center justify-between">
            <h2 className="text-[12px] font-medium text-ink-muted">History</h2>
            {conversations.length > 0 && (
              <span className="text-[12px] font-mono tabular-nums text-ink-muted">
                {conversations.length}
              </span>
            )}
          </div>

          {conversations.length === 0 ? (
            <p className="px-2 text-[12px] text-ink-muted leading-relaxed">
              Past conversations will appear here.
            </p>
          ) : (
            <div className="space-y-3.5">
              {BUCKET_ORDER.map((bucket) => {
                const items = groupedConversations[bucket];
                if (items.length === 0) return null;

                return (
                  <div key={bucket} className="space-y-0.5">
                    <p className="px-2 text-[11px] font-medium text-ink-muted">
                      {bucket}
                    </p>
                    <ul className="space-y-0.5">
                      {items.map((conv) => {
                        const isSelected =
                          activeView === 'chat' && conv.id === activeConversationId;
                        return (
                          <li key={conv.id} className="group relative flex items-center">
                            <button
                              type="button"
                              onClick={() => {
                                onSelectConversation(conv.id);
                                onSelectView('chat');
                                onCloseMobile();
                              }}
                              className={`w-full text-left px-2 h-8 pr-7 rounded-[6px] text-[13px] truncate transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                                isSelected
                                  ? 'bg-raised text-ink font-medium'
                                  : 'text-ink-secondary hover:bg-raised hover:text-ink'
                              }`}
                            >
                              {conv.title}
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onDeleteConversation(conv.id);
                              }}
                              aria-label={`Delete conversation ${conv.title}`}
                              className="absolute right-1 p-1 rounded-[4px] text-ink-muted hover:text-status-error hover:bg-status-error-soft opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                            >
                              <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* Bottom Settings: Language & Theme controls */}
      <div className="px-3 py-2.5 border-t border-line flex items-center justify-between gap-2 shrink-0">
        <div
          role="group"
          aria-label="Response language"
          className="inline-flex items-center p-0.5 rounded-[6px] bg-surface border border-line"
        >
          <button
            type="button"
            onClick={() => onChangeLanguage('en')}
            className={`px-2.5 h-7 rounded-[5px] text-[12px] font-medium transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              language === 'en'
                ? 'bg-raised text-ink'
                : 'text-ink-secondary hover:text-ink'
            }`}
          >
            EN
          </button>
          <button
            type="button"
            onClick={() => onChangeLanguage('ta')}
            className={`px-2.5 h-7 rounded-[5px] text-[12px] font-medium transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              language === 'ta'
                ? 'bg-raised text-ink'
                : 'text-ink-secondary hover:text-ink'
            }`}
          >
            தமிழ்
          </button>
        </div>

        <div className="flex items-center gap-1">
          <Tooltip content={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              {theme === 'dark' ? (
                <Sun className="w-4 h-4" strokeWidth={1.5} />
              ) : (
                <Moon className="w-4 h-4" strokeWidth={1.5} />
              )}
            </Button>
          </Tooltip>

          <Tooltip content="Voice & app settings">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                onOpenSettings();
                onCloseMobile();
              }}
              aria-label="Open settings"
            >
              <Settings className="w-4 h-4" strokeWidth={1.5} />
            </Button>
          </Tooltip>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {!isDesktopCollapsed && (
        <aside className="hidden lg:block shrink-0 h-screen sticky top-0">
          {sidebarContent}
        </aside>
      )}

      {isMobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            onClick={onCloseMobile}
            className="fixed inset-0 bg-overlay transition-opacity duration-150"
            aria-hidden="true"
          />
          <aside className="relative z-10 h-full max-w-[85vw] shadow-xl">
            {sidebarContent}
          </aside>
        </div>
      )}

      <Dialog
        open={docPendingDelete !== null}
        title="Remove document"
        description={
          docPendingDelete
            ? `Delete "${docPendingDelete.fileName}" and all ${docPendingDelete.chunkCount} indexed chunks from browser storage? This action cannot be undone.`
            : undefined
        }
        onClose={() => setDocPendingDelete(null)}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setDocPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                if (docPendingDelete) {
                  onDeleteDocument(docPendingDelete.id);
                  setDocPendingDelete(null);
                }
              }}
            >
              Remove
            </Button>
          </>
        }
      />
    </>
  );
}
