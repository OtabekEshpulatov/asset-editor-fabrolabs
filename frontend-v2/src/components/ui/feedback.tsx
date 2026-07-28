/**
 * Status surfaces: Badge, Skeleton, EmptyState, ErrorState, DropdownMenu.
 *
 * These exist so "nothing here", "still loading" and "it broke" look the same
 * everywhere. In the old editor each screen improvised its own — a bare
 * `Loading…`, a grey paragraph, or nothing at all.
 */

import * as React from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import { cva, type VariantProps } from 'class-variance-authority';
import { AlertTriangle, RotateCw, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from './button';

// --- badge -------------------------------------------------------------------

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium leading-none',
  {
    variants: {
      variant: {
        default: 'bg-secondary text-secondary-foreground',
        outline: 'border border-border text-muted-foreground',
        primary: 'bg-primary/15 text-primary',
        success: 'bg-success/15 text-success',
        warning: 'bg-warning/15 text-warning',
        danger: 'bg-destructive/15 text-destructive',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

/** forwardRef is required, not cosmetic: badges get wrapped in a Tooltip, and
 *  Radix's trigger clones its child with a ref to position the popper. A plain
 *  function component silently drops it and the tooltip mispositions. */
export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
  ),
);
Badge.displayName = 'Badge';

// --- skeleton ----------------------------------------------------------------

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('relative overflow-hidden rounded-md bg-muted', className)}
      aria-hidden
      {...props}
    >
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-foreground/[0.06] to-transparent" />
    </div>
  );
}

// --- empty / error -----------------------------------------------------------

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-14 text-center',
        className,
      )}
    >
      {Icon && <Icon className="size-7 text-muted-foreground/60" strokeWidth={1.5} />}
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      {description && (
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-6 py-12 text-center',
        className,
      )}
    >
      <AlertTriangle className="size-7 text-destructive" strokeWidth={1.5} />
      <div className="space-y-1">
        <p className="text-[13px] font-medium text-foreground">Something went wrong</p>
        <p className="max-w-md text-xs leading-relaxed text-muted-foreground">{message}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCw />
          Try again
        </Button>
      )}
    </div>
  );
}

// --- dropdown menu -----------------------------------------------------------

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 min-w-[11rem] overflow-hidden rounded-md border border-border bg-popover p-1',
        'text-popover-foreground shadow-xl',
        'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
        className,
      )}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = 'DropdownMenuContent';

export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5',
      'text-[13px] outline-none transition-colors focus:bg-accent focus:text-accent-foreground',
      'data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-3.5',
      destructive && 'text-destructive focus:bg-destructive/10 focus:text-destructive',
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = 'DropdownMenuItem';

export function DropdownMenuSeparator({ className }: { className?: string }) {
  return <DropdownMenuPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} />;
}

export function DropdownMenuLabel({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn('px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground', className)}
      {...props}
    />
  );
}

// --- scroll area -------------------------------------------------------------

export const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root ref={ref} className={cn('relative overflow-hidden', className)} {...props}>
    <ScrollAreaPrimitive.Viewport className="h-full w-full [&>div]:!block">
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollAreaPrimitive.Scrollbar
      orientation="vertical"
      className="flex w-2 touch-none select-none p-0.5 transition-colors"
    >
      <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border" />
    </ScrollAreaPrimitive.Scrollbar>
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = 'ScrollArea';
