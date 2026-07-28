import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppShell } from './layout/AppShell';
import { RouteFallback } from './layout/RouteFallback';

/**
 * Routes are real, lazily loaded, and deep-linkable.
 *
 * The old editor had two routes and reached everything else through modals
 * stacked three deep (lightbox -> actions -> frame editor), which could not be
 * linked, bookmarked, or reloaded into. Anything you can spend minutes inside
 * now gets its own URL.
 */
const LibraryPage = lazy(() => import('@/features/library/LibraryPage'));
const SpriteActionsPage = lazy(() => import('@/features/actions/SpriteActionsPage'));
const SceneEditorPage = lazy(() => import('@/features/scene/SceneEditorPage'));
const WorldGraphPage = lazy(() => import('@/features/world/WorldGraphPage'));

const withSuspense = (node: React.ReactNode) => (
  <Suspense fallback={<RouteFallback />}>{node}</Suspense>
);

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/library?kind=character" replace /> },
      { path: 'library', element: withSuspense(<LibraryPage />) },
      { path: 'sprites/:slug/actions', element: withSuspense(<SpriteActionsPage />) },
      // One editor serves still backgrounds and live scenes; the tabs it offers
      // depend on the asset (zones always, objects/transitions for live scenes).
      { path: 'scenes/:slug', element: withSuspense(<SceneEditorPage />) },
      { path: 'worlds/:worldId', element: withSuspense(<WorldGraphPage />) },
      { path: '*', element: <Navigate to="/library?kind=character" replace /> },
    ],
  },
]);
