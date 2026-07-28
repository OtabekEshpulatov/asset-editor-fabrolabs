import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/controls';
import { useTheme } from '@/lib/hooks';

/**
 * `refetchOnWindowFocus` is deliberate: it is what replaces the old editor's
 * global "reload" button. Assets can be edited out of band, and the answer to
 * that is for the app to refresh itself when you come back to the tab, not for
 * every user to remember to press a button in the header.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

export function Providers({ children }: { children: React.ReactNode }) {
  const [theme] = useTheme();
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={350} skipDelayDuration={200}>
        {children}
        <Toaster
          position="bottom-right"
          theme={theme}
          closeButton
          toastOptions={{
            classNames: {
              toast: 'border-border bg-popover text-popover-foreground text-[13px]',
            },
          }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
