import "@wailsio/runtime";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ToastProvider, toastManager } from "@/components/ui/toast";
import { Service as Diagnostics } from "@bindings/diagnostics";
import { installErrorHandlers, onMemoryWarning, restoreRoute } from "@/lib/diagnostics";
import { installDevCrash } from "@/lib/dev-crash";
import { createPersistOptions, createQueryClient } from "@/lib/query";
import { startNativeTabBar } from "@/components/shell/use-tab-bar";
import { isIOS, startPlatform } from "@/lib/platform";
import { startTheme } from "@/lib/theme";
import { createAppRouter } from "@/router";
import "./index.css";

startTheme();
startPlatform();
// Uncaught errors and rejections go to Go's log (#127).
installErrorHandlers();
// Back from a WebKit content-process kill: the route it was on, or Home if
// it died twice in a row. Before the router reads the address.
const recovered = restoreRoute();

const queryClient = createQueryClient();
const router = createAppRouter(queryClient);
// iOS is low on memory: drop the queries nothing shows.
onMemoryWarning(queryClient);
// The rig's crash commands as window.peliDev, for the simulator's cmd.js
// (a pelidev build only).
if (isIOS()) {
  Diagnostics.Info()
    .then((info) => info.dev && installDevCrash())
    .catch(() => {});
}

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
  // After the toast provider has mounted: a toast added before it is lost.
  if (recovered === "home") {
    setTimeout(() => toastManager.add({ title: "Peli reloaded to free memory" }), 500);
  }
}
