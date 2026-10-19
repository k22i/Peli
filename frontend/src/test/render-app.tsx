import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";

import { ToastProvider } from "@/components/ui/toast";
import { createQueryClient } from "@/lib/query";
import { createAppRouter } from "@/router";

// Renders the whole app at `path` with in-memory history and a fresh cache,
// and waits for the shell unless `shell` is false (welcome and sign-in have
// none).
export async function renderApp(path = "/", { shell = true } = {}) {
  const queryClient = createQueryClient();
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));

  const result = render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  if (shell) await screen.findByRole("navigation", { name: "Main" });

  return { ...result, router, queryClient };
}
