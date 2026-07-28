import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Menu, Moon, RefreshCw, Search, Sun } from 'lucide-react';
import { cn } from '@/lib/cn';
import { isMockData } from '@/lib/data';
import { useHotkey, useTheme } from '@/lib/hooks';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/controls';
import { Sheet, SheetContent } from '@/components/ui/overlay';
import { Sidebar } from './Sidebar';
import { CommandPalette } from './CommandPalette';

export function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const qc = useQueryClient();

  useHotkey('mod+k', () => setPaletteOpen(true));

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      {/* Persistent nav on desktop; a drawer below lg. */}
      <Sidebar className="hidden w-60 shrink-0 lg:flex" />

      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="left" className="w-64 p-0">
          <Sidebar className="h-full w-full border-r-0" />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
          >
            <Menu />
          </Button>

          {/* Search is the primary header affordance now. The old header's
              "reload" button is gone: queries refetch on window focus, and any
              view that needs an explicit refresh has one in context. */}
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className={cn(
              'flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-input bg-elevated px-2.5',
              'text-[13px] text-muted-foreground transition-colors hover:bg-accent focus-ring sm:max-w-md',
            )}
          >
            <Search className="size-3.5 shrink-0" />
            <span className="truncate">Search assets…</span>
            <kbd className="ml-auto hidden shrink-0 rounded border border-border px-1.5 py-0.5 text-2xs sm:block">
              ⌘K
            </kbd>
          </button>

          <div className="ml-auto flex items-center gap-1">
            {isMockData && (
              <Tooltip label="Running on generated fixtures — no backend, no storage. Data resets on reload.">
                <span className="hidden items-center gap-1 rounded bg-warning/15 px-2 py-1 text-2xs font-medium text-warning sm:inline-flex">
                  <FlaskConical className="size-3" />
                  Prototype data
                </span>
              </Tooltip>
            )}

            <Tooltip label="Refresh everything">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => qc.invalidateQueries()}
                aria-label="Refresh"
              >
                <RefreshCw />
              </Button>
            </Tooltip>

            <Tooltip label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                aria-label="Toggle theme"
              >
                {theme === 'dark' ? <Sun /> : <Moon />}
              </Button>
            </Tooltip>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
