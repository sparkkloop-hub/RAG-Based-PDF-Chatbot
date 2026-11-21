import { AlertCircle, CheckCircle2, FileText, X } from 'lucide-react';
import type { UploadJob, UploadStage } from '../types';
import { formatFileSize } from '../utils/format';

interface UploadProgressListProps {
  jobs: UploadJob[];
  onDismiss: (id: string) => void;
}

const STAGE_LABELS: Record<UploadStage, string> = {
  extracting: 'Extracting',
  chunking: 'Chunking',
  embedding: 'Embedding',
  ready: 'Ready',
  error: 'Failed',
};

export function UploadProgressList({ jobs, onDismiss }: UploadProgressListProps) {
  if (jobs.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {jobs.map((job) => {
        const isError = job.stage === 'error';
        const isReady = job.stage === 'ready';

        return (
          <div
            key={job.id}
            className={`rounded-[8px] border px-3 py-2 transition-colors duration-150 ${
              isError
                ? 'bg-status-error-soft border-status-error/30'
                : 'bg-panel border-line'
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                {isError ? (
                  <AlertCircle
                    className="w-4 h-4 text-status-error shrink-0"
                    strokeWidth={1.5}
                  />
                ) : isReady ? (
                  <CheckCircle2
                    className="w-4 h-4 text-status-success shrink-0"
                    strokeWidth={1.5}
                  />
                ) : (
                  <FileText
                    className="w-4 h-4 text-ink-muted shrink-0"
                    strokeWidth={1.5}
                  />
                )}
                <span className="text-[13px] font-medium text-ink truncate">
                  {job.fileName}
                </span>
                <span className="text-[12px] font-mono tabular-nums text-ink-muted shrink-0 hidden sm:inline">
                  {formatFileSize(job.fileSize)}
                </span>
              </div>

              <div className="flex items-center gap-2.5 shrink-0">
                <span
                  className={`text-[12px] font-medium whitespace-nowrap ${
                    isError
                      ? 'text-status-error'
                      : isReady
                      ? 'text-status-success'
                      : 'text-ink-secondary'
                  }`}
                >
                  {STAGE_LABELS[job.stage]}
                  {!isError && !isReady && (
                    <span className="font-mono tabular-nums text-ink-muted ml-1.5">
                      {job.progress}%
                    </span>
                  )}
                </span>

                {(isError || isReady) && (
                  <button
                    type="button"
                    onClick={() => onDismiss(job.id)}
                    aria-label="Dismiss upload status"
                    className="text-ink-muted hover:text-ink transition-colors duration-150 p-0.5 cursor-pointer rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <X className="w-3.5 h-3.5" strokeWidth={1.5} />
                  </button>
                )}
              </div>
            </div>

            {isError ? (
              <p className="text-[12px] text-status-error mt-1 leading-snug">
                {job.error || job.detail}
              </p>
            ) : !isReady ? (
              <div className="mt-2 space-y-1">
                <div className="h-[3px] w-full rounded-full bg-raised overflow-hidden">
                  <div
                    className="h-full bg-accent transition-all duration-150 ease-out rounded-full"
                    style={{ width: `${Math.max(4, job.progress)}%` }}
                  />
                </div>
                <p className="text-[12px] text-ink-muted truncate">{job.detail}</p>
              </div>
            ) : job.warning ? (
              <p className="text-[12px] text-status-warning mt-1 leading-snug">
                {job.warning}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
