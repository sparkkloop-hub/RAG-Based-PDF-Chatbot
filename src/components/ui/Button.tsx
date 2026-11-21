import React from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'icon';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-fg border border-transparent hover:bg-accent-hover disabled:opacity-45',
  secondary:
    'bg-raised text-ink border border-line hover:bg-raised-hover hover:border-line-strong disabled:opacity-45',
  ghost:
    'bg-transparent text-ink-secondary border border-transparent hover:bg-raised hover:text-ink disabled:opacity-40',
  danger:
    'bg-status-error-soft text-status-error border border-status-error/25 hover:bg-status-error hover:text-accent-fg disabled:opacity-45',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-[13px] gap-1.5 rounded-[6px]',
  md: 'h-10 sm:h-9 px-3.5 text-[13px] gap-2 rounded-[6px]',
  icon: 'h-10 w-10 sm:h-8 sm:w-8 p-0 justify-center rounded-[6px]',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'secondary', size = 'md', className = '', type = 'button', ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        className={`inline-flex items-center justify-center font-medium leading-none whitespace-nowrap shrink-0 transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface cursor-pointer disabled:cursor-not-allowed ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
        {...props}
      />
    );
  }
);

Button.displayName = 'Button';
