import { useState } from 'react';
import {
  AlertCircle,
  AlignLeft,
  BookOpen,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Headphones,
  HelpCircle,
  ListChecks,
  Upload,
  XCircle,
} from 'lucide-react';
import {
  explainConceptSimply,
  generateMCQs,
  generateShortAnswers,
  summarizeDocuments,
} from '../services/ragService';
import type {
  DocumentRecord,
  MCQItem,
  ResponseLanguage,
  RetrievedChunk,
  ShortAnswerItem,
} from '../types';
import { downloadTextFile } from '../utils/format';
import { AudioOverviewPanel } from './AudioOverviewPanel';
import { MarkdownRenderer } from './MarkdownRenderer';
import { SourcesPanel } from './SourcesPanel';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Select } from './ui/Select';
import { SkeletonLines } from './ui/Skeleton';

export type StudyTab = 'summarize' | 'mcq' | 'short-answer' | 'explain' | 'audio-overview';

interface StudyToolsViewProps {
  documents: DocumentRecord[];
  initialDocId?: string | null;
  initialTab?: StudyTab;
  language: ResponseLanguage;
  onTriggerUpload: () => void;
  onStatIncrement: (key: 'totalSummariesGenerated' | 'totalQuizzesGenerated') => void;
  activeSourceId?: string | null;
  onOpenSource?: (source: RetrievedChunk, allSources: RetrievedChunk[]) => void;
  onToast: (type: 'success' | 'error' | 'info', title: string, message?: string) => void;
}

const LETTERS = ['A', 'B', 'C', 'D'];

export function StudyToolsView({
  documents,
  initialDocId,
  initialTab = 'summarize',
  language,
  onTriggerUpload,
  onStatIncrement,
  activeSourceId,
  onOpenSource,
  onToast,
}: StudyToolsViewProps) {
  const [activeTab, setActiveTab] = useState<StudyTab>(initialTab);
  const [targetDocId, setTargetDocId] = useState<string>(initialDocId || 'all');

  // Summarize state
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summaryProgress, setSummaryProgress] = useState({ status: '', percent: 0 });
  const [summaryText, setSummaryText] = useState('');
  const [summaryMeta, setSummaryMeta] = useState<{
    strategy: 'direct' | 'map-reduce';
    chunksProcessed: number;
  } | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [copiedSummary, setCopiedSummary] = useState(false);

  // MCQ state
  const [mcqCount, setMcqCount] = useState(5);
  const [isGeneratingMcqs, setIsGeneratingMcqs] = useState(false);
  const [mcqs, setMcqs] = useState<MCQItem[]>([]);
  const [mcqAnswers, setMcqAnswers] = useState<Record<number, number>>({});
  const [revealAllMcqs, setRevealAllMcqs] = useState(false);
  const [mcqError, setMcqError] = useState<string | null>(null);

  // Short-answer state
  const [shortCount, setShortCount] = useState(5);
  const [isGeneratingShort, setIsGeneratingShort] = useState(false);
  const [shortItems, setShortItems] = useState<ShortAnswerItem[]>([]);
  const [revealedShort, setRevealedShort] = useState<Record<number, boolean>>({});
  const [shortError, setShortError] = useState<string | null>(null);

  // Explain simply state
  const [explainTopic, setExplainTopic] = useState('');
  const [isExplaining, setIsExplaining] = useState(false);
  const [explainResult, setExplainResult] = useState<{
    explanation: string;
    sources: RetrievedChunk[];
  } | null>(null);
  const [explainError, setExplainError] = useState<string | null>(null);

  const selectedDocIds =
    targetDocId === 'all' || !documents.some((d) => d.id === targetDocId)
      ? []
      : [targetDocId];

  const targetDocLabel =
    selectedDocIds.length === 1
      ? documents.find((d) => d.id === selectedDocIds[0])?.fileName ?? 'Selected document'
      : `All documents (${documents.length})`;

  const handleSummarize = async () => {
    setIsSummarizing(true);
    setSummaryError(null);
    setSummaryProgress({ status: 'Preparing chunks...', percent: 10 });
    try {
      const res = await summarizeDocuments(selectedDocIds, language, (status, percent) => {
        setSummaryProgress({ status, percent });
      });
      setSummaryText(res.summary);
      setSummaryMeta({ strategy: res.strategy, chunksProcessed: res.chunksProcessed });
      onStatIncrement('totalSummariesGenerated');
      onToast('success', 'Summary ready', `${res.chunksProcessed} chunks processed.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to generate summary.';
      setSummaryError(msg);
      onToast('error', 'Summarization failed', msg);
    } finally {
      setIsSummarizing(false);
    }
  };

  const handleDownloadSummary = (ext: 'md' | 'txt') => {
    if (!summaryText) return;
    const slug = targetDocLabel.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    downloadTextFile(
      `documind_summary_${slug}.${ext}`,
      summaryText,
      ext === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8'
    );
  };

  const handleGenerateMcqs = async () => {
    setIsGeneratingMcqs(true);
    setMcqError(null);
    setMcqAnswers({});
    setRevealAllMcqs(false);
    try {
      const items = await generateMCQs(selectedDocIds, mcqCount, language);
      setMcqs(items);
      onStatIncrement('totalQuizzesGenerated');
      onToast('success', 'MCQs ready', `Generated ${items.length} questions.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to generate MCQs.';
      setMcqError(msg);
      onToast('error', 'MCQ generation failed', msg);
    } finally {
      setIsGeneratingMcqs(false);
    }
  };

  const handleDownloadMcqs = () => {
    if (mcqs.length === 0) return;
    const content = mcqs
      .map(
        (q, i) =>
          `## Question ${i + 1}\n${q.question}\n\n` +
          q.options.map((o, oi) => `- ${LETTERS[oi] ?? oi + 1}. ${o}`).join('\n') +
          `\n\n**Answer:** ${LETTERS[q.correctIndex] ?? q.correctIndex + 1}\n` +
          `**Explanation:** ${q.explanation}\n` +
          `**Source:** ${q.sourceFile} (p. ${q.sourcePage})`
      )
      .join('\n\n---\n\n');
    downloadTextFile('documind_mcqs.md', content, 'text/markdown;charset=utf-8');
  };

  const handleGenerateShort = async () => {
    setIsGeneratingShort(true);
    setShortError(null);
    setRevealedShort({});
    try {
      const items = await generateShortAnswers(selectedDocIds, shortCount, language);
      setShortItems(items);
      onStatIncrement('totalQuizzesGenerated');
      onToast('success', 'Questions ready', `Generated ${items.length} short-answer prompts.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to generate questions.';
      setShortError(msg);
      onToast('error', 'Generation failed', msg);
    } finally {
      setIsGeneratingShort(false);
    }
  };

  const handleExplain = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsExplaining(true);
    setExplainError(null);
    try {
      const res = await explainConceptSimply(explainTopic, selectedDocIds, language);
      setExplainResult(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to generate explanation.';
      setExplainError(msg);
      onToast('error', 'Explanation failed', msg);
    } finally {
      setIsExplaining(false);
    }
  };

  if (documents.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-12 bg-surface">
        <div className="max-w-md mx-auto rounded-[10px] bg-panel border border-line p-6 space-y-3">
          <h1 className="text-[16px] font-semibold text-ink">No documents available</h1>
          <p className="text-[13px] text-ink-secondary leading-relaxed">
            Upload at least one PDF document to generate summaries, multiple-choice questions, short-answer drills, or plain-language explanations.
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

  const answeredCount = Object.keys(mcqAnswers).length;
  const correctCount = Object.entries(mcqAnswers).filter(
    ([idx, choice]) => mcqs[Number(idx)]?.correctIndex === choice
  ).length;

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 bg-surface">
      <div className="max-w-[760px] mx-auto space-y-6">
        {/* Header + Scope */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight text-ink">Study tools</h1>
            <p className="text-[13px] text-ink-secondary mt-0.5">
              Grounded summaries, quizzes, and explanations in{' '}
              {language === 'ta' ? 'Tamil' : 'English'}.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <label htmlFor="study-doc-select" className="text-[12px] text-ink-muted">
              Scope
            </label>
            <Select
              id="study-doc-select"
              size="sm"
              value={targetDocId}
              onChange={(e) => setTargetDocId(e.target.value)}
              className="max-w-[220px]"
              options={[
                { value: 'all', label: `All documents (${documents.length})` },
                ...documents.map((d) => ({
                  value: d.id,
                  label: `${d.fileName} (${d.pageCount}p)`,
                })),
              ]}
            />
          </div>
        </div>

        {/* Clean Tab Bar */}
        <div
          role="tablist"
          aria-label="Study tool mode"
          className="flex items-center gap-1 border-b border-line overflow-x-auto"
        >
          {[
            { id: 'summarize' as const, label: 'Summarize', icon: BookOpen },
            { id: 'mcq' as const, label: 'MCQs', icon: ListChecks },
            { id: 'short-answer' as const, label: 'Short answers', icon: HelpCircle },
            { id: 'explain' as const, label: 'Explain simply', icon: AlignLeft },
            { id: 'audio-overview' as const, label: 'Audio Overview', icon: Headphones },
          ].map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={active}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-1.5 px-3 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  active
                    ? 'border-accent text-ink'
                    : 'border-transparent text-ink-secondary hover:text-ink'
                }`}
              >
                <Icon className="w-4 h-4" strokeWidth={1.5} />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* SUMMARIZE */}
        {activeTab === 'summarize' && (
          <div className="space-y-4">
            <div className="rounded-[10px] bg-panel border border-line p-4 flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-0.5">
                <h2 className="text-[14px] font-semibold text-ink">Document summary</h2>
                <p className="text-[12px] text-ink-secondary">
                  Uses map-reduce synthesis for multi-batch documents. Scope: {targetDocLabel}.
                </p>
              </div>
              <Button
                variant="primary"
                size="md"
                disabled={isSummarizing}
                onClick={handleSummarize}
              >
                {isSummarizing ? 'Summarizing...' : 'Generate summary'}
              </Button>
            </div>

            {isSummarizing && (
              <div className="rounded-[10px] bg-panel border border-line p-4 space-y-3">
                <div className="flex items-center justify-between text-[12px]">
                  <span className="text-ink-secondary">{summaryProgress.status}</span>
                  <span className="font-mono tabular-nums text-ink-muted">
                    {summaryProgress.percent}%
                  </span>
                </div>
                <div className="h-[3px] rounded-full bg-raised overflow-hidden">
                  <div
                    className="h-full bg-accent transition-all duration-150 ease-out rounded-full"
                    style={{ width: `${Math.max(5, summaryProgress.percent)}%` }}
                  />
                </div>
                <SkeletonLines lines={4} />
              </div>
            )}

            {summaryError && (
              <div className="rounded-[8px] bg-status-error-soft border border-status-error/25 p-3.5 flex items-start gap-2.5 text-[13px] text-status-error">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
                <span>{summaryError}</span>
              </div>
            )}

            {summaryText && !isSummarizing && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3 pb-2.5 border-b border-line">
                  <p className="text-[12px] text-ink-muted">
                    {targetDocLabel}
                    {summaryMeta && (
                      <>
                        {' · '}
                        {summaryMeta.strategy === 'map-reduce' ? 'Map-reduce' : 'Direct'}
                        {' · '}
                        <span className="font-mono tabular-nums">
                          {summaryMeta.chunksProcessed} chunks
                        </span>
                      </>
                    )}
                  </p>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        await navigator.clipboard.writeText(summaryText);
                        setCopiedSummary(true);
                        setTimeout(() => setCopiedSummary(false), 1600);
                      }}
                    >
                      {copiedSummary ? (
                        <Check className="w-3.5 h-3.5 text-status-success" strokeWidth={1.5} />
                      ) : (
                        <Copy className="w-3.5 h-3.5" strokeWidth={1.5} />
                      )}
                      {copiedSummary ? 'Copied' : 'Copy'}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleDownloadSummary('md')}
                    >
                      <Download className="w-3.5 h-3.5" strokeWidth={1.5} />
                      .md
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleDownloadSummary('txt')}
                    >
                      <Download className="w-3.5 h-3.5" strokeWidth={1.5} />
                      .txt
                    </Button>
                  </div>
                </div>
                <MarkdownRenderer content={summaryText} />
              </div>
            )}
          </div>
        )}

        {/* MCQS */}
        {activeTab === 'mcq' && (
          <div className="space-y-4">
            <div className="rounded-[10px] bg-panel border border-line p-4 flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-0.5">
                <h2 className="text-[14px] font-semibold text-ink">Multiple-choice questions</h2>
                <p className="text-[12px] text-ink-secondary">
                  Practice with grounded explanations and page references.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  size="sm"
                  aria-label="Number of MCQs"
                  value={String(mcqCount)}
                  onChange={(e) => setMcqCount(Number(e.target.value))}
                  options={[3, 5, 8, 10, 12, 15].map((n) => ({
                    value: String(n),
                    label: `${n} questions`,
                  }))}
                />
                <Button
                  variant="primary"
                  size="md"
                  disabled={isGeneratingMcqs}
                  onClick={handleGenerateMcqs}
                >
                  {isGeneratingMcqs ? 'Generating...' : 'Generate'}
                </Button>
              </div>
            </div>

            {isGeneratingMcqs && (
              <div className="rounded-[10px] bg-panel border border-line p-5">
                <SkeletonLines lines={5} />
              </div>
            )}

            {mcqError && (
              <div className="rounded-[8px] bg-status-error-soft border border-status-error/25 p-3.5 flex items-start gap-2.5 text-[13px] text-status-error">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
                <span>{mcqError}</span>
              </div>
            )}

            {!isGeneratingMcqs && mcqs.length > 0 && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-secondary">
                  <span className="font-mono tabular-nums">
                    Score: {correctCount} / {mcqs.length} ({answeredCount} answered)
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRevealAllMcqs((v) => !v)}
                    >
                      {revealAllMcqs ? 'Hide answers' : 'Reveal all'}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={handleDownloadMcqs}>
                      <Download className="w-3.5 h-3.5" strokeWidth={1.5} />
                      Export .md
                    </Button>
                  </div>
                </div>

                {mcqs.map((q, qIdx) => {
                  const chosen = mcqAnswers[qIdx];
                  const isAnswered = chosen !== undefined;
                  const showSolution = isAnswered || revealAllMcqs;

                  return (
                    <div
                      key={qIdx}
                      className="rounded-[10px] bg-panel border border-line p-4 space-y-3"
                    >
                      <h3 className="text-[14px] font-medium text-ink leading-snug">
                        <span className="font-mono tabular-nums text-ink-muted mr-2">
                          {String(qIdx + 1).padStart(2, '0')}.
                        </span>
                        {q.question}
                      </h3>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {q.options.map((opt, oIdx) => {
                          const isCorrectOption = oIdx === q.correctIndex;
                          const isChosenOption = chosen === oIdx;

                          let optionTone =
                            'bg-surface border-line text-ink hover:border-line-strong';
                          if (showSolution) {
                            if (isCorrectOption) {
                              optionTone =
                                'bg-status-success-soft border-status-success/40 text-ink';
                            } else if (isChosenOption && !isCorrectOption) {
                              optionTone =
                                'bg-status-error-soft border-status-error/40 text-ink';
                            } else {
                              optionTone = 'bg-surface border-line text-ink-muted';
                            }
                          }

                          return (
                            <button
                              key={oIdx}
                              type="button"
                              onClick={() =>
                                setMcqAnswers((prev) => ({ ...prev, [qIdx]: oIdx }))
                              }
                              className={`text-left rounded-[6px] border px-3 py-2 text-[13px] transition-colors duration-150 flex items-start gap-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${optionTone}`}
                            >
                              <span className="font-mono text-[12px] text-ink-muted mt-0.5 shrink-0">
                                {LETTERS[oIdx] ?? oIdx + 1}.
                              </span>
                              <span className="flex-1 leading-snug">{opt}</span>
                              {showSolution && isCorrectOption && (
                                <CheckCircle2
                                  className="w-4 h-4 text-status-success shrink-0 mt-0.5"
                                  strokeWidth={1.5}
                                />
                              )}
                              {showSolution && isChosenOption && !isCorrectOption && (
                                <XCircle
                                  className="w-4 h-4 text-status-error shrink-0 mt-0.5"
                                  strokeWidth={1.5}
                                />
                              )}
                            </button>
                          );
                        })}
                      </div>

                      {showSolution && (
                        <div className="border-l-2 border-line-strong pl-3 py-0.5 space-y-1 text-[12px]">
                          <p className="text-ink-secondary leading-relaxed">
                            <span className="font-medium text-ink">Explanation:</span>{' '}
                            {q.explanation}
                          </p>
                          <p className="font-mono tabular-nums text-ink-muted">
                            {q.sourceFile} · p. {q.sourcePage}
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* SHORT ANSWERS */}
        {activeTab === 'short-answer' && (
          <div className="space-y-4">
            <div className="rounded-[10px] bg-panel border border-line p-4 flex flex-wrap items-center justify-between gap-4">
              <div className="space-y-0.5">
                <h2 className="text-[14px] font-semibold text-ink">Short-answer questions</h2>
                <p className="text-[12px] text-ink-secondary">
                  Review key concepts with collapsible model answers.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  size="sm"
                  aria-label="Number of short-answer questions"
                  value={String(shortCount)}
                  onChange={(e) => setShortCount(Number(e.target.value))}
                  options={[3, 5, 8, 10].map((n) => ({
                    value: String(n),
                    label: `${n} questions`,
                  }))}
                />
                <Button
                  variant="primary"
                  size="md"
                  disabled={isGeneratingShort}
                  onClick={handleGenerateShort}
                >
                  {isGeneratingShort ? 'Generating...' : 'Generate'}
                </Button>
              </div>
            </div>

            {isGeneratingShort && (
              <div className="rounded-[10px] bg-panel border border-line p-5">
                <SkeletonLines lines={5} />
              </div>
            )}

            {shortError && (
              <div className="rounded-[8px] bg-status-error-soft border border-status-error/25 p-3.5 flex items-start gap-2.5 text-[13px] text-status-error">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
                <span>{shortError}</span>
              </div>
            )}

            {!isGeneratingShort && shortItems.length > 0 && (
              <div className="space-y-3">
                {shortItems.map((item, idx) => {
                  const isOpen = Boolean(revealedShort[idx]);
                  return (
                    <div
                      key={idx}
                      className="rounded-[10px] bg-panel border border-line p-4 space-y-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <h3 className="text-[14px] font-medium text-ink leading-snug">
                          <span className="font-mono tabular-nums text-ink-muted mr-2">
                            {String(idx + 1).padStart(2, '0')}.
                          </span>
                          {item.question}
                        </h3>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            setRevealedShort((prev) => ({ ...prev, [idx]: !prev[idx] }))
                          }
                        >
                          {isOpen ? 'Hide' : 'Show answer'}
                        </Button>
                      </div>

                      {isOpen && (
                        <div className="border-l-2 border-line-strong pl-3.5 py-0.5 space-y-2 text-[13px]">
                          <p className="text-ink leading-relaxed">{item.answer}</p>
                          {item.keyPoints.length > 0 && (
                            <ul className="list-disc pl-4 space-y-1 text-[12px] text-ink-secondary">
                              {item.keyPoints.map((kp, ki) => (
                                <li key={ki}>{kp}</li>
                              ))}
                            </ul>
                          )}
                          <p className="text-[12px] font-mono tabular-nums text-ink-muted">
                            {item.sourceFile} · p. {item.sourcePage}
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* EXPLAIN SIMPLY */}
        {activeTab === 'explain' && (
          <div className="space-y-4">
            <form
              onSubmit={handleExplain}
              className="rounded-[10px] bg-panel border border-line p-4 space-y-3"
            >
              <div className="space-y-0.5">
                <h2 className="text-[14px] font-semibold text-ink">Explain simply</h2>
                <p className="text-[12px] text-ink-secondary">
                  Enter a concept or section from your documents for a plain-language breakdown.
                </p>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  type="text"
                  value={explainTopic}
                  onChange={(e) => setExplainTopic(e.target.value)}
                  placeholder="Enter a term, concept, or leave blank for the main ideas"
                />
                <Button type="submit" variant="primary" size="md" disabled={isExplaining}>
                  {isExplaining ? 'Explaining...' : 'Explain'}
                </Button>
              </div>
            </form>

            {isExplaining && (
              <div className="py-2">
                <SkeletonLines lines={4} />
              </div>
            )}

            {explainError && (
              <div className="rounded-[8px] bg-status-error-soft border border-status-error/25 p-3.5 flex items-start gap-2.5 text-[13px] text-status-error">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
                <span>{explainError}</span>
              </div>
            )}

            {explainResult && !isExplaining && (
              <div className="pt-1">
                <MarkdownRenderer content={explainResult.explanation} />
                <SourcesPanel
                  sources={explainResult.sources}
                  activeSourceId={activeSourceId}
                  onOpenSource={onOpenSource}
                />
              </div>
            )}
          </div>
        )}

        {/* AUDIO OVERVIEW */}
        {activeTab === 'audio-overview' && (
          <AudioOverviewPanel
            documents={documents}
            selectedDocIds={selectedDocIds}
            targetDocLabel={targetDocLabel}
            language={language}
            onToast={onToast}
          />
        )}
      </div>
    </div>
  );
}
