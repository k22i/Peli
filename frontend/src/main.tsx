import "@wailsio/runtime";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ToastProvider } from "@/components/ui/toast";
import { createPersistOptions, createQueryClient } from "@/lib/query";
import { startNativeTabBar } from "@/components/shell/use-tab-bar";
import { isIOS, startPlatform } from "@/lib/platform";
import { startTheme } from "@/lib/theme";
import { createAppRouter } from "@/router";
import "./index.css";

startTheme();
startPlatform();

const queryClient = createQueryClient();
const router = createAppRouter(queryClient);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

// The iOS app asks once whether it has the native tab bar (iOS 26, #129)
// before the first paint, so the CSS one never flashes in first.
// The desktop renders at once, as before.
if (isIOS()) void startNativeTabBar().then(() => render(root));
else render(root);

function render(container: HTMLElement) {
  createRoot(container).render(
    <StrictMode>
      <PersistQueryClientProvider client={queryClient} persistOptions={createPersistOptions()}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </PersistQueryClientProvider>
    </StrictMode>,
  );
}
