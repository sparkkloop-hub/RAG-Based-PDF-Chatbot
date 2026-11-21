import React from 'react';

export interface ChipProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  asStatic?: boolean;
}

export function Chip({
  active = false,
  asStatic = false,
  className = '',
  children,
  type = 'button',
  ...props
}: ChipProps) {
  const base =
    'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[6px] text-[12px] leading-tight font-medium border transition-colors duration-150 ease-out';

  const tone = active
    ? 'bg-accent-soft border-accent/40 text-accent'
    : 'bg-surface border-line text-ink-secondary hover:border-line-strong hover:text-ink hover:bg-panel';

  if (asStatic) {
    return (
      <span
        className={`${base} bg-panel border-line text-ink-secondary ${className}`}
      >
        {children}
      </span>
    );
  }

  return (
    <button
      type={type}
      className={`${base} ${tone} cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface disabled:opacity-45 disabled:cursor-not-allowed ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
