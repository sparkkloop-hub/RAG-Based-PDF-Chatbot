import React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  leadingIcon?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ leadingIcon, className = '', ...props }, ref) => {
    if (leadingIcon) {
      return (
        <div className="relative flex items-center w-full">
          <span className="absolute left-3 text-ink-muted pointer-events-none flex items-center">
            {leadingIcon}
          </span>
          <input
            ref={ref}
            className={`w-full h-10 sm:h-9 pl-9 pr-3 rounded-[6px] bg-surface border border-line text-[14px] text-ink placeholder:text-ink-muted transition-colors duration-150 ease-out hover:border-line-strong focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50 ${className}`}
            {...props}
          />
        </div>
      );
    }

    return (
      <input
        ref={ref}
        className={`w-full h-10 sm:h-9 px-3 rounded-[6px] bg-surface border border-line text-[14px] text-ink placeholder:text-ink-muted transition-colors duration-150 ease-out hover:border-line-strong focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50 ${className}`}
        {...props}
      />
    );
  }
);

Input.displayName = 'Input';

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = '', ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={`w-full rounded-[8px] bg-surface border border-line px-3 py-2 text-[14px] leading-[1.55] text-ink placeholder:text-ink-muted transition-colors duration-150 ease-out hover:border-line-strong focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50 resize-none ${className}`}
        {...props}
      />
    );
  }
);

Textarea.displayName = 'Textarea';
