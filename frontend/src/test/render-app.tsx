import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";

import { createQueryClient } from "@/lib/query";
import { createAppRouter } from "@/router";

// Renders the whole app at `path` with in-memory history and a fresh cache.
export async function renderApp(path = "/") {
  const queryClient = createQueryClient();
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));

  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole("navigation", { name: "Main" });

  return { ...result, router, queryClient };
}
