import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';

/** Shared header for full-screen editor routes: back link, title, actions. */
export function PageHeader({
  backTo,
  backLabel = 'Library',
  title,
  subtitle,
  children,
  className,
}: {
  backTo: string;
  backLabel?: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2',
        className,
      )}
    >
      <Button asChild variant="ghost" size="icon" aria-label={`Back to ${backLabel}`}>
        <Link to={backTo}>
          <ArrowLeft />
        </Link>
      </Button>
      <div className="min-w-0">
        <h1 className="truncate text-[13px] font-semibold">{title}</h1>
        {subtitle && <p className="truncate text-2xs text-muted-foreground">{subtitle}</p>}
      </div>
      {children && <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}
