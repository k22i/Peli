import "@wailsio/runtime";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { createPersistOptions, createQueryClient } from "@/lib/query";
import { followSystemTheme } from "@/lib/theme";
import { createAppRouter } from "@/router";
import "./index.css";

followSystemTheme();

const queryClient = createQueryClient();
const router = createAppRouter(queryClient);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <PersistQueryClientProvider client={queryClient} persistOptions={createPersistOptions()}>
      <RouterProvider router={router} />
    </PersistQueryClientProvider>
  </StrictMode>,
);
