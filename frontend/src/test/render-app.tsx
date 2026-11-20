import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";

import { ToastProvider } from "@/components/ui/toast";
import { createQueryClient } from "@/lib/query";
import { createAppRouter } from "@/router";

// Renders the whole app at `path` with in-memory history and a fresh cache,
// and waits for the shell unless `shell` is false (welcome and sign-in have
// none). `seed` fills the cache first, as a restored persisted cache would.
export async function renderApp(
  path = "/",
  { shell = true, seed }: { shell?: boolean; seed?: (client: QueryClient) => void } = {},
) {
  const queryClient = createQueryClient();
  seed?.(queryClient);
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));

  const result = render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  // The first render in a file loads the routes cold, which can take longer
  // than findBy's default second on a busy machine.
  if (shell) await screen.findByRole("navigation", { name: "Main" }, { timeout: 10_000 });

  return { ...result, router, queryClient };
}
