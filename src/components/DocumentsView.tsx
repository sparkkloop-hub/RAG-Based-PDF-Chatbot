import { useRef, useState } from 'react';
import { BookOpen, FileText, Headphones, MessageSquare, Trash2, Upload } from 'lucide-react';
import type { DocumentRecord, UploadJob } from '../types';
import { formatFileSize, formatRelativeTime } from '../utils/format';
import { UploadProgressList } from './UploadProgressList';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';

interface DocumentsViewProps {
  documents: DocumentRecord[];
  uploadJobs: UploadJob[];
  onUploadFiles: (files: FileList | File[]) => void;
  onDismissUploadJob: (id: string) => void;
  onDeleteDocument: (id: string) => void;
  onChatWithDocument: (docId: string) => void;
  onStudyDocument: (docId: string) => void;
  onAudioOverviewDocument: (docId: string) => void;
}

export function DocumentsView({
  documents,
  uploadJobs,
  onUploadFiles,
  onDismissUploadJob,
  onDeleteDocument,
  onChatWithDocument,
  onStudyDocument,
  onAudioOverviewDocument,
}: DocumentsViewProps) {
  const [isDragActive, setIsDragActive] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DocumentRecord | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const totalPages = documents.reduce((s, d) => s + d.pageCount, 0);
  const totalChunks = documents.reduce((s, d) => s + d.chunkCount, 0);
  const totalBytes = documents.reduce((s, d) => s + d.fileSize, 0);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragActive(false);
    if (e.dataTransfer.files?.length) {
      onUploadFiles(e.dataTransfer.files);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 bg-surface">
      <div className="max-w-[820px] mx-auto space-y-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight text-ink">Documents</h1>
            <p className="text-[13px] text-ink-secondary mt-0.5">
              Uploaded PDFs are extracted, chunked, and stored locally in IndexedDB.
            </p>
          </div>
          {documents.length > 0 && (
            <p className="text-[12px] text-ink-muted font-mono tabular-nums">
              {documents.length} {documents.length === 1 ? 'file' : 'files'} · {totalPages}p ·{' '}
              {totalChunks} chunks · {formatFileSize(totalBytes)}
            </p>
          )}
        </div>

        {/* Drag-and-drop upload zone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragActive(true);
          }}
          onDragLeave={() => setIsDragActive(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          className={`rounded-[10px] border border-dashed px-6 py-8 text-center transition-colors duration-150 ease-out cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            isDragActive
              ? 'border-accent bg-accent-soft'
              : 'border-line-strong bg-panel hover:border-accent/60'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) {
                onUploadFiles(e.target.files);
                e.target.value = '';
              }
            }}
          />
          <Upload
            className="w-[18px] h-[18px] text-ink-secondary mx-auto mb-2.5"
            strokeWidth={1.5}
          />
          <p className="text-[14px] font-medium text-ink">
            Drop PDF files here, or click to browse
          </p>
          <p className="text-[12px] text-ink-secondary mt-1">
            PDF only · Maximum 20 MB per file · Multiple files supported
          </p>
        </div>

        {uploadJobs.length > 0 && (
          <UploadProgressList jobs={uploadJobs} onDismiss={onDismissUploadJob} />
        )}

        {documents.length === 0 ? (
          <div className="rounded-[10px] bg-panel border border-line px-6 py-10 text-center space-y-1.5">
            <p className="text-[14px] font-medium text-ink">No documents indexed</p>
            <p className="text-[13px] text-ink-secondary max-w-md mx-auto">
              Upload a text-based PDF above to enable grounded Q&amp;A, semantic search, and study tools.
            </p>
          </div>
        ) : (
          <div className="rounded-[10px] bg-panel border border-line overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-line text-[12px] text-ink-muted">
                    <th className="py-2.5 px-4 font-medium">Name</th>
                    <th className="py-2.5 px-3 font-medium text-right">Pages</th>
                    <th className="py-2.5 px-3 font-medium text-right">Chunks</th>
                    <th className="py-2.5 px-3 font-medium text-right">Size</th>
                    <th className="py-2.5 px-3 font-medium text-right">Added</th>
                    <th className="py-2.5 px-4 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line text-[13px]">
                  {documents.map((doc) => (
                    <tr
                      key={doc.id}
                      className="hover:bg-raised/60 transition-colors duration-150"
                    >
                      <td className="py-2.5 px-4">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-status-success shrink-0"
                            title="Ready"
                          />
                          <FileText
                            className="w-4 h-4 text-ink-muted shrink-0"
                            strokeWidth={1.5}
                          />
                          <span className="font-medium text-ink truncate max-w-[240px] sm:max-w-[320px]">
                            {doc.fileName}
                          </span>
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ink-secondary">
                        {doc.pageCount}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ink-secondary">
                        {doc.chunkCount}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-ink-muted whitespace-nowrap">
                        {formatFileSize(doc.fileSize)}
                      </td>
                      <td className="py-2.5 px-3 text-right text-[12px] text-ink-muted whitespace-nowrap">
                        {formatRelativeTime(doc.uploadedAt)}
                      </td>
                      <td className="py-2.5 px-4">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onChatWithDocument(doc.id)}
                          >
                            <MessageSquare className="w-3.5 h-3.5" strokeWidth={1.5} />
                            Chat
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onStudyDocument(doc.id)}
                          >
                            <BookOpen className="w-3.5 h-3.5" strokeWidth={1.5} />
                            Study
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Audio Overview for ${doc.fileName}`}
                            onClick={() => onAudioOverviewDocument(doc.id)}
                          >
                            <Headphones className="w-3.5 h-3.5" strokeWidth={1.5} />
                            Audio Overview
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove ${doc.fileName}`}
                            onClick={() => setPendingDelete(doc)}
                            className="hover:text-status-error hover:bg-status-error-soft"
                          >
                            <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <Dialog
        open={pendingDelete !== null}
        title="Remove document"
        description={
          pendingDelete
            ? `Delete "${pendingDelete.fileName}" and its ${pendingDelete.chunkCount} indexed vectors from browser storage?`
            : undefined
        }
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                if (pendingDelete) {
                  onDeleteDocument(pendingDelete.id);
                  setPendingDelete(null);
                }
              }}
            >
              Remove
            </Button>
          </>
        }
      />
    </div>
  );
}
