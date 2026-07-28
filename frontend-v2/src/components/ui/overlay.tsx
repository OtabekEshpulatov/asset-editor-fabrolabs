/**
 * Overlay surfaces: Dialog (centered) and Sheet (edge drawer).
 *
 * The old editor hand-rolled a modal shell in five components — each with its
 * own backdrop, its own Escape handler, and no focus trapping. These are Radix
 * underneath, so focus, scroll-lock and Escape are correct once, everywhere.
 *
 * Sheet is what replaces the old stacked Lightbox -> ActionsModal -> FrameEditor
 * tower: inspection lives in a side drawer, real work gets a real route.
 */

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const Overlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/70 backdrop-blur-[2px]',
      'data-[state=open]:animate-in data-[state=closed]:animate-out',
      'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
      className,
    )}
    {...props}
  />
));
Overlay.displayName = 'Overlay';

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }
>(({ className, children, hideClose, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <Overlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2',
        'flex-col gap-4 rounded-lg border border-border bg-card p-4 shadow-2xl',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
        'data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95',
        className,
      )}
      {...props}
    >
      {children}
      {!hideClose && (
        <DialogPrimitive.Close
          className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-ring"
          aria-label="Close"
        >
          <X className="size-4" />
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = 'DialogContent';

const sheetVariants = cva(
  'fixed z-50 flex flex-col gap-0 border-border bg-card shadow-2xl ' +
    'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-200',
  {
    variants: {
      side: {
        right:
          'inset-y-0 right-0 h-full w-full max-w-[420px] border-l ' +
          'data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
        left:
          'inset-y-0 left-0 h-full w-full max-w-[420px] border-r ' +
          'data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left',
        bottom:
          'inset-x-0 bottom-0 max-h-[85vh] border-t rounded-t-xl ' +
          'data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom',
      },
    },
    defaultVariants: { side: 'right' },
  },
);

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> &
    VariantProps<typeof sheetVariants>
>(({ side, className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <Overlay />
    <DialogPrimitive.Content ref={ref} className={cn(sheetVariants({ side }), className)} {...props}>
      {children}
      <DialogPrimitive.Close
        className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-ring"
        aria-label="Close"
      >
        <X className="size-4" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
SheetContent.displayName = 'SheetContent';

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 pr-8', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3', className)}
      {...props}
    />
  );
}

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-sm font-semibold text-foreground', className)}
    {...props}
  />
));
DialogTitle.displayName = 'DialogTitle';

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-xs text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = 'DialogDescription';
