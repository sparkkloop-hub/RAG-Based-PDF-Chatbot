interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className = '' }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={`rounded-[6px] bg-raised border border-line/40 ${className}`}
    />
  );
}

export function SkeletonLines({ lines = 3 }: { lines?: number }) {
  const widths = ['w-full', 'w-11/12', 'w-4/5', 'w-3/4'];
  return (
    <div className="space-y-2.5" role="status" aria-label="Loading">
      {Array.from({ length: lines }).map((_, idx) => (
        <Skeleton
          key={idx}
          className={`h-3.5 ${widths[idx % widths.length]}`}
        />
      ))}
    </div>
  );
}
