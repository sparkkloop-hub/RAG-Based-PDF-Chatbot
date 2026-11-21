import { useState } from 'react';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';
import type { RetrievedChunk } from '../types';
import { Chip } from './ui/Chip';

interface SourcesPanelProps {
  sources: RetrievedChunk[];
  activeSourceId?: string | null;
  onOpenSource?: (source: RetrievedChunk, allSources: RetrievedChunk[]) => void;
}

function truncateFileName(name: string, maxLen = 24): string {
  if (name.length <= maxLen) return name;
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx > 0 && name.length - dotIdx <= 6) {
    const ext = name.slice(dotIdx);
    return `${name.slice(0, maxLen - ext.length - 1)}…${ext}`;
  }
  return `${name.slice(0, maxLen - 1)}…`;
}

export function SourcesPanel({ sources, activeSourceId, onOpenSource }: SourcesPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});

  if (!sources || sources.length === 0) return null;

  // Deduplicate file+page pairs for compact collapsed chips while keeping the first matching chunk
  const uniqueChips: { key: string; source: RetrievedChunk }[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    const key = `${s.docId}::${s.pageNumber}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueChips.push({ key, source: s });
    }
  }

  const toggleSnippet = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2 py-1">
        <button
          type="button"
          onClick={() => setIsOpen((v) => !v)}
          aria-expanded={isOpen}
          className="inline-flex items-center gap-1 py-1 px-1.5 -ml-1.5 text-[12px] font-medium text-ink-secondary hover:text-ink transition-colors duration-150 ease-out cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-[6px]"
        >
          {isOpen ? (
            <ChevronDown className="w-4 h-4 text-ink-muted" strokeWidth={1.5} />
          ) : (
            <ChevronRight className="w-4 h-4 text-ink-muted" strokeWidth={1.5} />
          )}
          <span className="tabular-nums">
            {sources.length} {sources.length === 1 ? 'source' : 'sources'}
          </span>
        </button>

        {!isOpen && (
          <div className="flex flex-wrap items-center gap-1.5">
            {uniqueChips.slice(0, 4).map(({ key, source }) => {
              const isSelected = activeSourceId === source.id;
              return (
                <Chip
                  key={key}
                  asStatic={!onOpenSource}
                  active={isSelected}
                  onClick={onOpenSource ? () => onOpenSource(source, sources) : undefined}
                  title={
                    onOpenSource
                      ? `Open ${source.fileName}, page ${source.pageNumber}`
                      : `${source.fileName}, page ${source.pageNumber}`
                  }
                  className="py-1 px-2 text-[12px] font-normal"
                >
                  <FileText
                    className={`w-3 h-3 shrink-0 ${
                      isSelected ? 'text-accent' : 'text-ink-muted'
                    }`}
                    strokeWidth={1.5}
                  />
                  <span className="truncate max-w-[160px]">
                    {truncateFileName(source.fileName)}
                  </span>
                  <span
                    className={`font-mono tabular-nums ${
                      isSelected ? 'text-accent' : 'text-ink-muted'
                    }`}
                  >
                    p. {source.pageNumber}
                  </span>
                </Chip>
              );
            })}
            {uniqueChips.length > 4 && (
              <button
                type="button"
                onClick={() => setIsOpen(true)}
                className="text-[12px] text-ink-muted hover:text-ink tabular-nums px-1 py-0.5 rounded-[4px] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                +{uniqueChips.length - 4} more
              </button>
            )}
          </div>
        )}
      </div>

      {isOpen && (
        <div className="mt-2 space-y-3 pl-1">
          {sources.map((source) => {
            const isLong = source.text.length > 280;
            const isExpanded = Boolean(expandedIds[source.id]);
            const isSelected = activeSourceId === source.id;
            const displayText =
              isLong && !isExpanded ? `${source.text.slice(0, 280).trim()}…` : source.text;

            return (
              <div
                key={source.id}
                className={`border-l-2 pl-3.5 py-0.5 space-y-1 transition-colors duration-150 ${
                  isSelected ? 'border-accent' : 'border-line-strong'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                  {onOpenSource ? (
                    <button
                      type="button"
                      onClick={() => onOpenSource(source, sources)}
                      className="inline-flex items-center gap-1.5 font-medium text-ink hover:text-accent transition-colors duration-150 truncate max-w-[360px] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-[4px]"
                    >
                      <FileText className="w-3.5 h-3.5 text-ink-muted shrink-0" strokeWidth={1.5} />
                      <span className="truncate">{source.fileName}</span>
                    </button>
                  ) : (
                    <span className="font-medium text-ink truncate max-w-[360px]">
                      {source.fileName}
                    </span>
                  )}

                  <div className="flex items-center gap-2.5 shrink-0">
                    <span className="font-mono tabular-nums text-ink-muted whitespace-nowrap">
                      p. {source.pageNumber} · {Math.round(source.score * 100)}%
                    </span>
                    {onOpenSource && (
                      <button
                        type="button"
                        onClick={() => onOpenSource(source, sources)}
                        className="text-[12px] font-medium text-accent hover:underline cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-[4px]"
                      >
                        View in PDF
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-[13px] leading-[1.55] text-ink-secondary whitespace-pre-line">
                  {displayText}
                </p>
                {isLong && (
                  <button
                    type="button"
                    onClick={() => toggleSnippet(source.id)}
                    className="text-[12px] font-medium text-accent hover:underline cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-[4px]"
                  >
                    {isExpanded ? 'Show less' : 'Show full excerpt'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
