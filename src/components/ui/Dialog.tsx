import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { Button } from './Button';

interface DialogProps {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'md' | 'lg';
}

export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  size = 'md',
}: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const widthClass = size === 'lg' ? 'max-w-2xl' : 'max-w-md';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
    >
      <div
        className="fixed inset-0 bg-overlay transition-opacity duration-150 ease-out"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={`relative z-10 w-full ${widthClass} max-h-[90vh] flex flex-col rounded-[12px] bg-panel border border-line shadow-xl p-5 space-y-4`}
      >
        <div className="flex items-start justify-between gap-3 shrink-0">
          <div className="space-y-1">
            <h2 id="dialog-title" className="text-[16px] font-semibold text-ink leading-snug">
              {title}
            </h2>
            {description && (
              <p className="text-[13px] text-ink-secondary leading-relaxed">{description}</p>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close dialog">
            <X className="w-4 h-4" strokeWidth={1.5} />
          </Button>
        </div>

        {children && <div className="overflow-y-auto min-h-0 pr-0.5">{children}</div>}

        {footer && (
          <div className="flex items-center justify-end gap-2 pt-1 shrink-0">{footer}</div>
        )}
      </div>
    </div>
  );
}
