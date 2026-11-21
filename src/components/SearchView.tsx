import { useState } from 'react';
import { AlertCircle, MessageSquare, Search, Upload } from 'lucide-react';
import { embedQuery } from '../services/embeddingService';
import { vectorStore } from '../services/vectorStore';
import type { DocumentRecord, SearchHit } from '../types';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Select } from './ui/Select';
import { SkeletonLines } from './ui/Skeleton';

type SearchMode = 'hybrid' | 'semantic' | 'keyword';

interface SearchViewProps {
  documents: DocumentRecord[];
  onTriggerUpload: () => void;
  onAskAboutSnippet: (docId: string, prompt: string) => void;
}

function highlightKeywords(text: string, query: string): React.ReactNode {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .filter((t) => t.length >= 2);
  if (terms.length === 0) return text;

  const regex = new RegExp(`(${terms.join('|')})`, 'gi');
  const parts = text.split(regex);
  return parts.map((part, idx) =>
    idx % 2 === 1 ? (
      <mark key={idx} className="bg-mark text-ink rounded-[3px] px-0.5">
        {part}
      </mark>
    ) : (
      part
    )
  );
}

export function SearchView({
  documents,
  onTriggerUpload,
  onAskAboutSnippet,
}: SearchViewProps) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('hybrid');
  const [selectedDocId, setSelectedDocId] = useState<string>('all');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = query.trim();
    if (!cleaned) return;

    setIsSearching(true);
    setError(null);
    setHasSearched(true);

    const docIds = selectedDocId === 'all' ? undefined : [selectedDocId];

    try {
      await vectorStore.hydrate();

      if (mode === 'keyword') {
        const hits = vectorStore.keywordSearch(cleaned, { topK: 15, docIds });
        setResults(hits);
      } else if (mode === 'semantic') {
        const vec = await embedQuery(cleaned);
        const sem = await vectorStore.similaritySearch(vec, {
          topK: 15,
          docIds,
          minScore: 0.25,
        });
        setResults(
          sem.map(({ score, ...chunk }) => ({
            chunk,
            score,
            matchType: 'semantic',
            semanticScore: score,
          }))
        );
      } else {
        const vec = await embedQuery(cleaned);
        const hits = await vectorStore.hybridSearch(cleaned, vec, { topK: 15, docIds });
        setResults(hits);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Search could not be completed. Check your connection and try again.'
      );
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  if (documents.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-12 bg-surface">
        <div className="max-w-md mx-auto rounded-[10px] bg-panel border border-line p-6 space-y-3">
          <h1 className="text-[16px] font-semibold text-ink">No documents to search</h1>
          <p className="text-[13px] text-ink-secondary leading-relaxed">
            Upload PDF files to run keyword and semantic search across all extracted passages.
          </p>
          <div className="pt-1">
            <Button variant="primary" size="md" onClick={onTriggerUpload}>
              <Upload className="w-4 h-4" strokeWidth={1.5} />
              Upload PDF
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 bg-surface">
      <div className="max-w-[760px] mx-auto space-y-6">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight text-ink">Search</h1>
          <p className="text-[13px] text-ink-secondary mt-0.5">
            Find matching passages across your uploaded documents by meaning or exact terms.
          </p>
        </div>

        {/* Search form */}
        <form
          onSubmit={handleSearch}
          className="rounded-[10px] bg-panel border border-line p-4 space-y-3"
        >
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              leadingIcon={<Search className="w-4 h-4" strokeWidth={1.5} />}
              placeholder="Search concepts, definitions, or exact phrases"
            />
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={isSearching || !query.trim()}
            >
              {isSearching ? 'Searching...' : 'Search'}
            </Button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div
              role="group"
              aria-label="Search mode"
              className="inline-flex items-center p-0.5 rounded-[6px] bg-surface border border-line"
            >
              {(
                [
                  { id: 'hybrid', label: 'Hybrid' },
                  { id: 'semantic', label: 'Semantic' },
                  { id: 'keyword', label: 'Keyword' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setMode(opt.id)}
                  className={`px-2.5 h-7 rounded-[5px] text-[12px] font-medium transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                    mode === opt.id
                      ? 'bg-raised text-ink'
                      : 'text-ink-secondary hover:text-ink'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <Select
              size="sm"
              aria-label="Filter by document"
              value={selectedDocId}
              onChange={(e) => setSelectedDocId(e.target.value)}
              className="max-w-[220px]"
              options={[
                { value: 'all', label: `All documents (${documents.length})` },
                ...documents.map((d) => ({ value: d.id, label: d.fileName })),
              ]}
            />
          </div>
        </form>

        {error && (
          <div className="rounded-[8px] bg-status-error-soft border border-status-error/25 p-3.5 flex items-start gap-2.5 text-[13px] text-status-error">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
            <span>{error}</span>
          </div>
        )}

        {isSearching && (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="border-l-2 border-line pl-4 py-1">
                <SkeletonLines lines={3} />
              </div>
            ))}
          </div>
        )}

        {!isSearching && hasSearched && !error && (
          <div className="space-y-4">
            <p className="text-[12px] text-ink-muted font-mono tabular-nums">
              {results.length} {results.length === 1 ? 'match' : 'matches'}
            </p>

            {results.length === 0 ? (
              <div className="rounded-[10px] bg-panel border border-line p-6 text-center space-y-1">
                <p className="text-[14px] font-medium text-ink">
                  No matching passages found for &ldquo;{query}&rdquo;
                </p>
                <p className="text-[13px] text-ink-secondary">
                  Try broader terms or switch between Hybrid and Semantic modes.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {results.map((hit) => (
                  <div
                    key={hit.chunk.id}
                    className="border-l-2 border-line-strong pl-4 py-0.5 space-y-1.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-medium text-ink truncate max-w-[280px]">
                          {hit.chunk.fileName}
                        </span>
                        <span className="font-mono tabular-nums text-ink-muted whitespace-nowrap">
                          p. {hit.chunk.pageNumber} · {Math.round(hit.score * 100)}% ·{' '}
                          {hit.matchType}
                        </span>
                      </div>

                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          onAskAboutSnippet(
                            hit.chunk.docId,
                            `Explain this section from page ${hit.chunk.pageNumber} in simple terms: "${hit.chunk.text.slice(0, 180)}..."`
                          )
                        }
                        className="h-7 px-2 text-[12px]"
                      >
                        <MessageSquare className="w-3.5 h-3.5" strokeWidth={1.5} />
                        Ask in chat
                      </Button>
                    </div>

                    <p className="text-[13px] leading-[1.6] text-ink-secondary whitespace-pre-line">
                      {highlightKeywords(hit.chunk.text, query)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
