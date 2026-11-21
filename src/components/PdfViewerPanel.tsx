import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  FileText,
  Info,
  Maximize2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { getPdfFile } from '../services/storageService';
import type { RetrievedChunk } from '../types';
import { matchChunkToTextItems, type HighlightMatchResult } from '../utils/pdfHighlight';
import { Button } from './ui/Button';
import { Select } from './ui/Select';
import { Skeleton } from './ui/Skeleton';
import { Tooltip } from './ui/Tooltip';

if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}

interface PdfViewerPanelProps {
  activeSource: RetrievedChunk | null;
  allSources: RetrievedChunk[];
  onSelectSource: (source: RetrievedChunk) => void;
  onClose: () => void;
}

interface PageDimensions {
  width: number;
  height: number;
}

interface PositionedSpan {
  index: number;
  str: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  angle: number;
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 2.4;
const ZOOM_STEP = 0.2;

function truncateName(name: string, maxLen = 28): string {
  if (name.length <= maxLen) return name;
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx > 0 && name.length - dotIdx <= 6) {
    const ext = name.slice(dotIdx);
    return `${name.slice(0, maxLen - ext.length - 1)}…${ext}`;
  }
  return `${name.slice(0, maxLen - 1)}…`;
}

interface PdfPageItemProps {
  pdfDoc: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  defaultSize: PageDimensions;
  shouldRender: boolean;
  highlightChunkText: string | null;
  highlightKey: string | null;
  isCitedPage: boolean;
  onMatchQuality: (quality: HighlightMatchResult['matchQuality']) => void;
  onHighlightReady: (pageNumber: number, el: HTMLElement | null) => void;
  registerPageEl: (pageNumber: number, el: HTMLDivElement | null) => void;
}

function PdfPageItem({
  pdfDoc,
  pageNumber,
  scale,
  defaultSize,
  shouldRender,
  highlightChunkText,
  highlightKey,
  isCitedPage,
  onMatchQuality,
  onHighlightReady,
  registerPageEl,
}: PdfPageItemProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const firstHighlightRef = useRef<HTMLSpanElement | null>(null);
  const notifiedKeyRef = useRef<string | null>(null);

  const [pageBaseSize, setPageBaseSize] = useState<PageDimensions>(defaultSize);
  const [spans, setSpans] = useState<PositionedSpan[]>([]);
  const [isRendering, setIsRendering] = useState(false);
  const [hasRendered, setHasRendered] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  useEffect(() => {
    setPageBaseSize(defaultSize);
  }, [defaultSize]);

  // Reset rendered flag when document changes
  useEffect(() => {
    setHasRendered(false);
    setSpans([]);
    setPageError(null);
    notifiedKeyRef.current = null;
  }, [pdfDoc, pageNumber]);

  useEffect(() => {
    if (!shouldRender) return;

    let cancelled = false;
    let renderTask: pdfjsLib.RenderTask | null = null;

    const renderPage = async () => {
      setIsRendering(true);
      setPageError(null);

      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1 });
        setPageBaseSize((prev) =>
          Math.abs(prev.width - baseViewport.width) > 0.5 ||
          Math.abs(prev.height - baseViewport.height) > 0.5
            ? { width: baseViewport.width, height: baseViewport.height }
            : prev
        );

        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;

        const outputScale = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
        canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(outputScale, 0, 0, outputScale, 0, 0);

        renderTask = page.render({
          canvasContext: ctx,
          canvas,
          viewport,
        });

        await renderTask.promise;
        if (cancelled) return;

        const textContent = await page.getTextContent();
        if (cancelled) return;

        const nextSpans: PositionedSpan[] = [];
        textContent.items.forEach((rawItem, idx) => {
          if (!('str' in rawItem)) return;
          const item = rawItem as {
            str: string;
            width?: number;
            height?: number;
            transform: number[];
          };
          if (!item.str) return;

          const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
          const angle = Math.atan2(tx[1], tx[0]);
          const fontHeight =
            Math.hypot(tx[2], tx[3]) || Math.hypot(tx[0], tx[1]) || 12 * viewport.scale;
          const left = tx[4];
          const top = tx[5] - fontHeight * 0.88;
          const width = Math.max(0, (item.width ?? 0) * viewport.scale);
          const height = Math.max(fontHeight * 1.14, 10);

          nextSpans.push({
            index: idx,
            str: item.str,
            left,
            top,
            width,
            height,
            fontSize: fontHeight,
            angle,
          });
        });

        setSpans(nextSpans);
        setHasRendered(true);
      } catch (err) {
        if (cancelled) return;
        const name = err instanceof Error ? err.name : '';
        if (name === 'RenderingCancelledException') return;
        setPageError('Could not render this page.');
      } finally {
        if (!cancelled) {
          setIsRendering(false);
        }
      }
    };

    renderPage();

    return () => {
      cancelled = true;
      if (renderTask) {
        try {
          renderTask.cancel();
        } catch {
          // Ignore cancel errors
        }
      }
    };
  }, [pdfDoc, pageNumber, scale, shouldRender]);

  const highlightResult = useMemo<HighlightMatchResult | null>(() => {
    if (!highlightChunkText || spans.length === 0) return null;
    return matchChunkToTextItems(
      spans.map((s) => s.str),
      highlightChunkText
    );
  }, [spans, highlightChunkText]);

  useEffect(() => {
    if (!isCitedPage || !hasRendered) return;
    if (!highlightResult) {
      onMatchQuality('none');
      return;
    }
    onMatchQuality(highlightResult.matchQuality);
  }, [isCitedPage, hasRendered, highlightResult, onMatchQuality]);

  useEffect(() => {
    if (!isCitedPage || !hasRendered || !highlightKey) return;
    if (notifiedKeyRef.current === highlightKey) return;
    notifiedKeyRef.current = highlightKey;
    onHighlightReady(pageNumber, firstHighlightRef.current);
  }, [isCitedPage, hasRendered, highlightKey, pageNumber, onHighlightReady, highlightResult]);

  const displayWidth = Math.round(pageBaseSize.width * scale);
  const displayHeight = Math.round(pageBaseSize.height * scale);

  return (
    <div
      ref={(el) => registerPageEl(pageNumber, el)}
      data-pdf-page={pageNumber}
      className="flex flex-col items-center"
    >
      <div
        className={`relative bg-white rounded-[4px] overflow-hidden border transition-colors duration-150 ${
          isCitedPage ? 'border-accent/60' : 'border-line'
        }`}
        style={{ width: `${displayWidth}px`, height: `${displayHeight}px` }}
      >
        {shouldRender ? (
          <>
            <canvas ref={canvasRef} className="block" />

            {/* Positioned text layer for selection & citation highlighting */}
            <div
              className="absolute inset-0 overflow-hidden select-text"
              aria-label={`Page ${pageNumber} text layer`}
            >
              {spans.map((span, spanIdx) => {
                const isMatched = highlightResult?.matchedIndices.has(spanIdx) ?? false;
                const isFirst = isMatched && highlightResult?.firstMatchIndex === spanIdx;
                const transformStyle =
                  Math.abs(span.angle) > 0.01 ? `rotate(${span.angle}rad)` : undefined;

                return (
                  <span
                    key={span.index}
                    ref={isFirst ? firstHighlightRef : undefined}
                    data-pdf-highlight={isFirst ? 'first' : isMatched ? 'match' : undefined}
                    style={{
                      position: 'absolute',
                      left: `${span.left}px`,
                      top: `${span.top}px`,
                      minWidth: span.width > 0 ? `${span.width}px` : undefined,
                      height: `${span.height}px`,
                      fontSize: `${span.fontSize}px`,
                      lineHeight: 1,
                      whiteSpace: 'pre',
                      transform: transformStyle,
                      transformOrigin: transformStyle ? '0% 85%' : undefined,
                    }}
                    className={
                      isMatched
                        ? 'text-transparent bg-pdf-highlight ring-1 ring-pdf-highlight-ring rounded-[2px]'
                        : 'text-transparent'
                    }
                  >
                    {span.str}
                  </span>
                );
              })}
            </div>

            {isRendering && !hasRendered && (
              <div className="absolute inset-0 bg-panel p-6 flex flex-col gap-3">
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-11/12" />
                <Skeleton className="h-3.5 w-5/6" />
                <Skeleton className="h-3.5 w-full mt-2" />
                <Skeleton className="h-3.5 w-3/4" />
              </div>
            )}

            {pageError && (
              <div className="absolute inset-0 bg-panel flex items-center justify-center p-4">
                <p className="text-[12px] text-status-error">{pageError}</p>
              </div>
            )}
          </>
        ) : (
          <div className="w-full h-full bg-panel p-6 flex flex-col gap-3">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-11/12" />
            <Skeleton className="h-3.5 w-4/5" />
          </div>
        )}
      </div>

      <span className="mt-1.5 text-[11px] font-mono tabular-nums text-ink-muted">
        Page {pageNumber}
      </span>
    </div>
  );
}

export function PdfViewerPanel({
  activeSource,
  allSources,
  onSelectSource,
  onClose,
}: PdfViewerPanelProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const pageElementsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const programmaticScrollUntilRef = useRef<number>(0);

  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [loadedDocId, setLoadedDocId] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [basePageSize, setBasePageSize] = useState<PageDimensions>({ width: 612, height: 792 });
  const [isLoadingDoc, setIsLoadingDoc] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [scale, setScale] = useState(1);
  const [isFitWidth, setIsFitWidth] = useState(true);
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set([1]));
  const [matchQuality, setMatchQuality] = useState<HighlightMatchResult['matchQuality'] | null>(
    null
  );

  // Deduplicated source list for switcher (keeps unique chunk IDs)
  const switchableSources = useMemo(() => {
    if (!activeSource) return [];
    const list = allSources.length > 0 ? allSources : [activeSource];
    const seen = new Set<string>();
    return list.filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
  }, [activeSource, allSources]);

  const computeFitWidthScale = useCallback(
    (pageWidth: number) => {
      const container = scrollContainerRef.current;
      if (!container || pageWidth <= 0) return 1;
      const available = Math.max(240, container.clientWidth - 36);
      const next = available / pageWidth;
      return Math.max(MIN_SCALE, Math.min(1.6, Number(next.toFixed(2))));
    },
    []
  );

  // Load PDF document from IndexedDB whenever docId changes
  useEffect(() => {
    if (!activeSource) {
      setPdfDoc(null);
      setLoadedDocId(null);
      setNumPages(0);
      setLoadError(null);
      return;
    }

    const targetDocId = activeSource.docId;
    let cancelled = false;
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;

    const loadDocument = async () => {
      setIsLoadingDoc(true);
      setLoadError(null);
      setPdfDoc(null);
      setLoadedDocId(null);
      setNumPages(0);
      setMatchQuality(null);

      try {
        const stored = await getPdfFile(targetDocId);
        if (cancelled) return;

        if (!stored || !stored.blob) {
          setLoadError(
            'The original PDF file is not stored in this browser. Re-upload this document to preview it here.'
          );
          setIsLoadingDoc(false);
          return;
        }

        const buffer = await stored.blob.arrayBuffer();
        if (cancelled) return;

        loadingTask = pdfjsLib.getDocument({
          data: new Uint8Array(buffer),
          useSystemFonts: true,
        });

        const doc = await loadingTask.promise;
        if (cancelled) {
          await loadingTask.destroy();
          return;
        }

        const firstPage = await doc.getPage(1);
        if (cancelled) {
          await loadingTask.destroy();
          return;
        }

        const vp = firstPage.getViewport({ scale: 1 });
        const dims = { width: vp.width, height: vp.height };

        setBasePageSize(dims);
        setNumPages(doc.numPages);
        setPdfDoc(doc);
        setLoadedDocId(targetDocId);
        setIsFitWidth(true);
        setScale(computeFitWidthScale(dims.width));
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.toLowerCase().includes('password')) {
          setLoadError('This PDF is password-protected and cannot be displayed.');
        } else {
          setLoadError(
            'This PDF file appears to be corrupted or unreadable. Try re-uploading it.'
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoadingDoc(false);
        }
      }
    };

    loadDocument();

    return () => {
      cancelled = true;
      if (loadingTask) {
        loadingTask.destroy().catch(() => {});
      }
    };
  }, [activeSource?.docId, computeFitWidthScale]);

  // Keep fit-width scale synced when container resizes
  useEffect(() => {
    if (!isFitWidth || !pdfDoc) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const update = () => {
      setScale(computeFitWidthScale(basePageSize.width));
    };

    update();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      update();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [isFitWidth, pdfDoc, basePageSize.width, computeFitWidthScale]);

  const registerPageEl = useCallback((pageNum: number, el: HTMLDivElement | null) => {
    if (el) {
      pageElementsRef.current.set(pageNum, el);
    } else {
      pageElementsRef.current.delete(pageNum);
    }
  }, []);

  const scrollToPage = useCallback(
    (targetPage: number, behavior: ScrollBehavior = 'smooth') => {
      if (numPages <= 0) return;
      const clamped = Math.max(1, Math.min(numPages, targetPage));
      setCurrentPage(clamped);
      setPageInput(String(clamped));
      setVisiblePages((prev) => {
        const next = new Set(prev);
        next.add(clamped);
        if (clamped > 1) next.add(clamped - 1);
        if (clamped < numPages) next.add(clamped + 1);
        return next;
      });

      programmaticScrollUntilRef.current = Date.now() + 550;
      const el = pageElementsRef.current.get(clamped);
      if (el) {
        el.scrollIntoView({ behavior, block: 'start' });
      }
    },
    [numPages]
  );

  // Jump to cited page when document finishes loading or active source changes
  useEffect(() => {
    if (!activeSource || !pdfDoc || loadedDocId !== activeSource.docId || numPages === 0) return;
    setMatchQuality(null);
    const targetPage = Math.max(1, Math.min(numPages, activeSource.pageNumber));
    const raf = requestAnimationFrame(() => {
      scrollToPage(targetPage, 'auto');
    });
    return () => cancelAnimationFrame(raf);
  }, [activeSource?.id, activeSource?.docId, activeSource?.pageNumber, pdfDoc, loadedDocId, numPages, scrollToPage]);

  // Lazy rendering with IntersectionObserver
  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root || !pdfDoc || numPages === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        setVisiblePages((prev) => {
          let changed = false;
          const next = new Set(prev);
          for (const entry of entries) {
            const p = Number((entry.target as HTMLElement).dataset.pdfPage);
            if (!p) continue;
            if (entry.isIntersecting && !next.has(p)) {
              next.add(p);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      { root, rootMargin: '420px 0px', threshold: 0.01 }
    );

    pageElementsRef.current.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [pdfDoc, numPages, scale]);

  // Sync currentPage indicator while user manually scrolls
  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root || !pdfDoc || numPages === 0) return;

    let rafId = 0;
    const handleScroll = () => {
      if (Date.now() < programmaticScrollUntilRef.current) return;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const rootRect = root.getBoundingClientRect();
        const anchorY = rootRect.top + rootRect.height * 0.28;
        let closestPage = currentPage;
        let closestDist = Infinity;

        pageElementsRef.current.forEach((el, pageNum) => {
          const rect = el.getBoundingClientRect();
          const dist = Math.abs(rect.top - anchorY);
          if (dist < closestDist) {
            closestDist = dist;
            closestPage = pageNum;
          }
        });

        setCurrentPage((prev) => {
          if (prev !== closestPage) {
            setPageInput(String(closestPage));
            return closestPage;
          }
          return prev;
        });
      });
    };

    root.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      root.removeEventListener('scroll', handleScroll);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [pdfDoc, numPages, currentPage]);

  // Keyboard shortcuts: Esc closes, Left/Right arrows change pages
  useEffect(() => {
    if (!activeSource) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.key === 'ArrowLeft' && currentPage > 1) {
        e.preventDefault();
        scrollToPage(currentPage - 1);
      } else if (e.key === 'ArrowRight' && currentPage < numPages) {
        e.preventDefault();
        scrollToPage(currentPage + 1);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeSource, currentPage, numPages, onClose, scrollToPage]);

  const handleHighlightReady = useCallback(
    (_pageNum: number, highlightEl: HTMLElement | null) => {
      if (!highlightEl) return;
      programmaticScrollUntilRef.current = Date.now() + 600;
      highlightEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    []
  );

  const handleJumpToCitation = () => {
    if (!activeSource || numPages === 0) return;
    const citedPage = Math.max(1, Math.min(numPages, activeSource.pageNumber));
    const pageEl = pageElementsRef.current.get(citedPage);
    const firstHighlight = pageEl?.querySelector<HTMLElement>('[data-pdf-highlight="first"]');
    if (firstHighlight) {
      programmaticScrollUntilRef.current = Date.now() + 600;
      setCurrentPage(citedPage);
      setPageInput(String(citedPage));
      firstHighlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      scrollToPage(citedPage, 'smooth');
    }
  };

  const handleZoomOut = () => {
    setIsFitWidth(false);
    setScale((prev) => Math.max(MIN_SCALE, Number((prev - ZOOM_STEP).toFixed(2))));
  };

  const handleZoomIn = () => {
    setIsFitWidth(false);
    setScale((prev) => Math.min(MAX_SCALE, Number((prev + ZOOM_STEP).toFixed(2))));
  };

  const handleFitWidth = () => {
    setIsFitWidth(true);
    setScale(computeFitWidthScale(basePageSize.width));
  };

  const commitPageInput = () => {
    const parsed = parseInt(pageInput, 10);
    if (!Number.isFinite(parsed) || numPages === 0) {
      setPageInput(String(currentPage));
      return;
    }
    scrollToPage(parsed);
  };

  if (!activeSource) return null;

  const citedPageNum =
    numPages > 0 ? Math.max(1, Math.min(numPages, activeSource.pageNumber)) : activeSource.pageNumber;
  const pageNumbers = Array.from({ length: numPages }, (_, i) => i + 1);

  return (
    <aside
      aria-label="PDF document viewer"
      className="fixed inset-0 z-40 lg:static lg:z-auto lg:w-[46%] lg:min-w-[420px] lg:max-w-[680px] lg:h-full bg-panel lg:border-l border-line flex flex-col min-w-0 shrink-0"
    >
      {/* Top Bar: Document title / source switcher + Close */}
      <div className="h-13 px-3.5 border-b border-line bg-panel flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <FileText className="w-4 h-4 text-ink-secondary shrink-0" strokeWidth={1.5} />
          {switchableSources.length > 1 ? (
            <Select
              size="sm"
              aria-label="Switch cited source"
              value={activeSource.id}
              onChange={(e) => {
                const found = switchableSources.find((s) => s.id === e.target.value);
                if (found) onSelectSource(found);
              }}
              className="max-w-[260px] sm:max-w-[320px]"
              options={switchableSources.map((s) => ({
                value: s.id,
                label: `${truncateName(s.fileName, 24)} · p. ${s.pageNumber}`,
              }))}
            />
          ) : (
            <span
              className="text-[13px] font-medium text-ink truncate"
              title={activeSource.fileName}
            >
              {activeSource.fileName}
            </span>
          )}
        </div>

        <Tooltip content="Close (Esc)" side="bottom">
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close PDF viewer">
            <X className="w-4 h-4" strokeWidth={1.5} />
          </Button>
        </Tooltip>
      </div>

      {/* Viewer Controls Toolbar */}
      <div className="px-3.5 py-2 border-b border-line bg-surface flex flex-wrap items-center justify-between gap-2 shrink-0">
        {/* Page controls */}
        <div className="flex items-center gap-1">
          <Tooltip content="Previous page (Left arrow)" side="bottom">
            <Button
              variant="ghost"
              size="icon"
              disabled={!pdfDoc || currentPage <= 1}
              onClick={() => scrollToPage(currentPage - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft className="w-4 h-4" strokeWidth={1.5} />
            </Button>
          </Tooltip>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              commitPageInput();
            }}
            className="flex items-center gap-1.5"
          >
            <input
              type="text"
              inputMode="numeric"
              aria-label="Current page number"
              disabled={!pdfDoc || numPages === 0}
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ''))}
              onBlur={commitPageInput}
              className="w-11 h-7 px-1.5 text-center rounded-[6px] bg-panel border border-line text-[12px] font-mono tabular-nums text-ink focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-45"
            />
            <span className="text-[12px] font-mono tabular-nums text-ink-muted">
              / {numPages || '–'}
            </span>
          </form>

          <Tooltip content="Next page (Right arrow)" side="bottom">
            <Button
              variant="ghost"
              size="icon"
              disabled={!pdfDoc || currentPage >= numPages}
              onClick={() => scrollToPage(currentPage + 1)}
              aria-label="Next page"
            >
              <ChevronRight className="w-4 h-4" strokeWidth={1.5} />
            </Button>
          </Tooltip>
        </div>

        {/* Zoom controls */}
        <div className="flex items-center gap-1">
          <Tooltip content="Zoom out" side="bottom">
            <Button
              variant="ghost"
              size="icon"
              disabled={!pdfDoc || scale <= MIN_SCALE}
              onClick={handleZoomOut}
              aria-label="Zoom out"
            >
              <ZoomOut className="w-4 h-4" strokeWidth={1.5} />
            </Button>
          </Tooltip>

          <span className="w-11 text-center text-[12px] font-mono tabular-nums text-ink-secondary">
            {Math.round(scale * 100)}%
          </span>

          <Tooltip content="Zoom in" side="bottom">
            <Button
              variant="ghost"
              size="icon"
              disabled={!pdfDoc || scale >= MAX_SCALE}
              onClick={handleZoomIn}
              aria-label="Zoom in"
            >
              <ZoomIn className="w-4 h-4" strokeWidth={1.5} />
            </Button>
          </Tooltip>

          <div className="w-px h-4 bg-line mx-0.5" aria-hidden="true" />

          <Tooltip content="Fit to width" side="bottom">
            <Button
              variant={isFitWidth ? 'secondary' : 'ghost'}
              size="sm"
              disabled={!pdfDoc}
              onClick={handleFitWidth}
              aria-pressed={isFitWidth}
              className={`h-7 px-2 text-[12px] ${
                isFitWidth ? 'text-accent border-accent/40 bg-accent-soft' : 'text-ink-secondary'
              }`}
            >
              <Maximize2 className="w-3.5 h-3.5" strokeWidth={1.5} />
              <span className="hidden sm:inline">Fit width</span>
            </Button>
          </Tooltip>
        </div>
      </div>

      {/* Citation Context Strip */}
      <div className="px-3.5 py-2 border-b border-line bg-panel flex flex-wrap items-center justify-between gap-2 text-[12px] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-block w-2 h-2 rounded-full bg-accent shrink-0" aria-hidden="true" />
          <span className="text-ink-secondary truncate">
            Cited passage on{' '}
            <span className="font-mono tabular-nums text-ink">p. {citedPageNum}</span>
          </span>

          {matchQuality === 'approximate' && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] bg-raised border border-line text-[11px] text-ink-secondary shrink-0">
              <Info className="w-3 h-3 text-ink-muted" strokeWidth={1.5} />
              Approximate match
            </span>
          )}

          {matchQuality === 'none' && pdfDoc && !isLoadingDoc && (
            <span className="text-[11px] text-ink-muted shrink-0">
              Text highlight unavailable on this page
            </span>
          )}
        </div>

        {pdfDoc && (
          <button
            type="button"
            onClick={handleJumpToCitation}
            className="inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-[4px]"
          >
            <Crosshair className="w-3.5 h-3.5" strokeWidth={1.5} />
            Jump to highlight
          </button>
        )}
      </div>

      {/* Scrollable PDF Viewport */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-auto bg-surface p-4 space-y-5"
      >
        {isLoadingDoc && (
          <div className="max-w-[560px] mx-auto space-y-4">
            <div className="rounded-[6px] bg-panel border border-line p-6 space-y-3 min-h-[420px]">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-11/12" />
              <Skeleton className="h-3.5 w-5/6" />
              <Skeleton className="h-3.5 w-full mt-4" />
              <Skeleton className="h-3.5 w-4/5" />
            </div>
          </div>
        )}

        {!isLoadingDoc && loadError && (
          <div className="max-w-md mx-auto mt-10 rounded-[10px] bg-panel border border-line p-5 flex items-start gap-3">
            <AlertCircle
              className="w-[18px] h-[18px] text-status-error shrink-0 mt-0.5"
              strokeWidth={1.5}
            />
            <div className="space-y-1">
              <h2 className="text-[14px] font-semibold text-ink">Unable to open PDF</h2>
              <p className="text-[13px] text-ink-secondary leading-relaxed">{loadError}</p>
            </div>
          </div>
        )}

        {!isLoadingDoc && !loadError && pdfDoc && (
          <div className="flex flex-col items-center gap-5 min-w-fit">
            {pageNumbers.map((pageNum) => {
              const isCitedPage =
                loadedDocId === activeSource.docId && pageNum === citedPageNum;
              const shouldRender =
                visiblePages.has(pageNum) ||
                pageNum === currentPage ||
                Math.abs(pageNum - currentPage) <= 1 ||
                isCitedPage;

              return (
                <PdfPageItem
                  key={`${loadedDocId}-${pageNum}`}
                  pdfDoc={pdfDoc}
                  pageNumber={pageNum}
                  scale={scale}
                  defaultSize={basePageSize}
                  shouldRender={shouldRender}
                  highlightChunkText={isCitedPage ? activeSource.text : null}
                  highlightKey={isCitedPage ? activeSource.id : null}
                  isCitedPage={isCitedPage}
                  onMatchQuality={setMatchQuality}
                  onHighlightReady={handleHighlightReady}
                  registerPageEl={registerPageEl}
                />
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
