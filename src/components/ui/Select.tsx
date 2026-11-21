import React from 'react';
import { ChevronDown } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  options?: SelectOption[];
  size?: 'sm' | 'md';
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ options, size = 'md', className = '', children, ...props }, ref) => {
    const sizeClasses =
      size === 'sm' ? 'h-8 pl-2.5 pr-7 text-[12px]' : 'h-10 sm:h-9 pl-3 pr-8 text-[13px]';

    return (
      <div className="relative inline-flex items-center">
        <select
          ref={ref}
          className={`appearance-none rounded-[6px] bg-surface border border-line text-ink font-medium transition-colors duration-150 ease-out hover:border-line-strong focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50 cursor-pointer ${sizeClasses} ${className}`}
          {...props}
        >
          {options
            ? options.map((opt) => (
                <option key={opt.value} value={opt.value} className="bg-panel text-ink">
                  {opt.label}
                </option>
              ))
            : children}
        </select>
        <ChevronDown
          className="w-4 h-4 text-ink-muted pointer-events-none absolute right-2"
          strokeWidth={1.5}
          aria-hidden="true"
        />
      </div>
    );
  }
);

Select.displayName = 'Select';
