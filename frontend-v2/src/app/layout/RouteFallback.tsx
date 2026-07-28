import { Skeleton } from '@/components/ui/feedback';

/** Shown while a lazily loaded route chunk arrives. Mirrors the library's
 *  toolbar + grid rhythm so the swap doesn't jump. */
export function RouteFallback() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="ml-auto h-7 w-56" />
      </div>
      <div className="flex flex-wrap gap-3 p-4">
        {Array.from({ length: 18 }).map((_, i) => (
          <Skeleton key={i} className="h-[168px] w-[136px]" />
        ))}
      </div>
    </div>
  );
}
