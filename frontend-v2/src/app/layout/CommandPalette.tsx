import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { Moon, Search, Sun } from 'lucide-react';
import { cn } from '@/lib/cn';
import { data } from '@/lib/data';
import { KINDS, prettyCategory } from '@/lib/kinds';
import { qk } from '@/app/queryKeys';
import { useDebounced, useHotkey, useTheme } from '@/lib/hooks';
import { Dialog, DialogContent } from '@/components/ui/overlay';

/**
 * ⌘K search across every kind.
 *
 * With ~1,400 assets spread over 11 kinds and 60+ categories, finding one thing
 * by clicking through tabs is the slowest part of the old editor. Typing a slug
 * should get you there regardless of which kind it lives in.
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query, 180);
  const [theme, setTheme] = useTheme();

  useHotkey('mod+k', (e) => {
    e.preventDefault();
    onOpenChange(!open);
  });

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const { data: results, isFetching } = useQuery({
    queryKey: qk.search(debounced),
    queryFn: () => data.searchAll(debounced, 40),
    enabled: debounced.trim().length > 0,
    staleTime: 30_000,
  });

  const grouped = useMemo(() => {
    const out = new Map<string, typeof results>();
    for (const item of results ?? []) {
      const list = out.get(item.kind) ?? [];
      list.push(item);
      out.set(item.kind, list);
    }
    return [...out.entries()];
  }, [results]);

  const go = (path: string) => {
    onOpenChange(false);
    navigate(path);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent hideClose className="max-w-xl gap-0 p-0" aria-describedby={undefined}>
        <Command
          shouldFilter={false}
          className="flex max-h-[60vh] flex-col overflow-hidden"
          loop
        >
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Search every asset by name…"
              className="h-11 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            <kbd className="shrink-0 rounded border border-border px-1.5 py-0.5 text-2xs text-muted-foreground">
              esc
            </kbd>
          </div>

          <Command.List className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {!query.trim() && (
              <Command.Group
                heading="Actions"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground"
              >
                <Item onSelect={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
                  {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
                  Switch to {theme === 'dark' ? 'light' : 'dark'} theme
                </Item>
                {Object.values(KINDS).map((meta) => (
                  <Item key={meta.key} onSelect={() => go(`/library?kind=${meta.key}`)}>
                    <meta.icon className="size-4 text-muted-foreground" />
                    Go to {meta.label}
                  </Item>
                ))}
              </Command.Group>
            )}

            {query.trim() && !isFetching && (results?.length ?? 0) === 0 && (
              <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">
                No asset matches “{query}”.
              </p>
            )}

            {isFetching && (
              <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">Searching…</p>
            )}

            {grouped.map(([kind, items]) => {
              const meta = KINDS[kind as keyof typeof KINDS];
              return (
                <Command.Group
                  key={kind}
                  heading={meta.label}
                  className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted-foreground"
                >
                  {items?.map((item) => (
                    <Item
                      key={`${item.kind}:${item.slug}`}
                      onSelect={() =>
                        go(
                          `/library?kind=${item.kind}&cat=${encodeURIComponent(item.category)}&sel=${encodeURIComponent(item.slug)}`,
                        )
                      }
                    >
                      <meta.icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate font-mono text-xs">{item.slug}</span>
                      <span className="ml-auto shrink-0 truncate text-2xs text-muted-foreground">
                        {prettyCategory(item.category)}
                      </span>
                    </Item>
                  ))}
                </Command.Group>
              );
            })}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function Item({ children, onSelect }: { children: React.ReactNode; onSelect: () => void }) {
  return (
    <Command.Item
      onSelect={onSelect}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px]',
        'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
      )}
    >
      {children}
    </Command.Item>
  );
}
