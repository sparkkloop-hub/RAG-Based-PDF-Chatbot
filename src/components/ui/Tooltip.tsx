import React, { useId, useState } from 'react';

interface TooltipProps {
  content: string;
  side?: 'top' | 'bottom';
  children: React.ReactNode;
}

export function Tooltip({ content, side = 'top', children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open && (
        <span
          id={id}
          role="tooltip"
          className={`pointer-events-none absolute left-1/2 -translate-x-1/2 z-40 px-2 py-1 rounded-[6px] bg-raised border border-line-strong text-[12px] font-medium text-ink whitespace-nowrap shadow-md transition-opacity duration-150 ease-out ${
            side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
          }`}
        >
          {content}
        </span>
      )}
    </span>
  );
}
