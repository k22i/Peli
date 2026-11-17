import { CancelledError, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Service as Diagnostics } from "@bindings/diagnostics";
import {
  installErrorHandlers,
  recoveredParam,
  reportError,
  reportsPerMinute,
  resetReports,
  restoreRoute,
  restoreTarget,
  routeKey,
  trimCaches,
} from "@/lib/diagnostics";

beforeEach(() => resetReports());
afterEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("reportError", () => {
  it("sends the message and stack", () => {
    const error = new TypeError("x is undefined");
    expect(reportError("js", error)).toBe(true);
    expect(Diagnostics.Report).toHaveBeenCalledWith("js", "TypeError: x is undefined", error.stack);
  });

  it("drops aborted fetches and cancelled queries", () => {
    expect(reportError("rejection", new DOMException("aborted", "AbortError"))).toBe(false);
    expect(reportError("rejection", new CancelledError())).toBe(false);
    expect(Diagnostics.Report).not.toHaveBeenCalled();
  });

  it("sends at most 20 a minute", () => {
    const now = 1_000_000;
    let sent = 0;
    for (let i = 0; i < 30; i++) if (reportError("js", new Error(`e${i}`), now + i)) sent++;
    expect(sent).toBe(reportsPerMinute);
    expect(reportError("js", new Error("later"), now + 61_000)).toBe(true);
  });

  it("hears the window's errors and rejections", () => {
    const undo = installErrorHandlers(window);
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("thrown") }));
    const rejection = new Event("unhandledrejection");
    Object.assign(rejection, { reason: "a string reason" });
    window.dispatchEvent(rejection);
    undo();
    expect(Diagnostics.Report).toHaveBeenCalledWith("js", "Error: thrown", expect.any(String));
    expect(Diagnostics.Report).toHaveBeenCalledWith("rejection", "a string reason", "");
  });
});

describe("the route to come back to", () => {
  it("is the location, but the player's title instead of the player", () => {
    expect(restoreTarget({ pathname: "/movies", href: "/movies?genre=Drama", state: {} })).toBe(
      "/movies?genre=Drama",
    );
    expect(
      restoreTarget({
        pathname: "/player",
        href: "/player",
        state: {
          player: {
            watching: { contentId: "tt7366338", contentType: "series" },
          },
        },
      }),
    ).toBe("/title/series/tt7366338");
    expect(restoreTarget({ pathname: "/player", href: "/player", state: {} })).toBe("/");
  });

  it("does nothing on a normal launch", () => {
    window.history.replaceState(null, "", "/#/library");
    sessionStorage.setItem(routeKey, "/movies");
    expect(restoreRoute(window)).toBeNull();
    expect(window.location.hash).toBe("#/library");
  });

  it("restores the saved route after a reload, and takes the marker off", () => {
    window.history.replaceState(null, "", `/?${recoveredParam}=reload#/anime`);
    sessionStorage.setItem(routeKey, "/title/series/tt1?season=2");
    expect(restoreRoute(window)).toBe("reload");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#/title/series/tt1?season=2");
  });

  it("falls back to Go's route in the address, but never the player", () => {
    window.history.replaceState(null, "", `/?${recoveredParam}=reload#/shows`);
    expect(restoreRoute(window)).toBe("reload");
    expect(window.location.hash).toBe("#/shows");

    window.history.replaceState(null, "", `/?${recoveredParam}=reload#/player`);
    restoreRoute(window);
    expect(window.location.hash).toBe("#/");
  });

  it("goes Home after two deaths in a row", () => {
    window.history.replaceState(null, "", `/?${recoveredParam}=home#/`);
    sessionStorage.setItem(routeKey, "/anime");
    expect(restoreRoute(window)).toBe("home");
    expect(window.location.hash).toBe("#/");
  });
});

describe("trimCaches", () => {
  it("drops the queries nothing uses and keeps the ones on screen", async () => {
    const client = new QueryClient();
    await client.prefetchQuery({ queryKey: ["unused"], queryFn: () => 1 });
    const observer = new QueryObserver(client, { queryKey: ["used"], queryFn: () => 2 });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(client.getQueryData(["used"])).toBe(2));

    expect(trimCaches(client)).toBe(1);
    expect(client.getQueryData(["unused"])).toBeUndefined();
    expect(client.getQueryData(["used"])).toBe(2);
    unsubscribe();
  });
});
