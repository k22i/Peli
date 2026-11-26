import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CancellablePromise } from "@wailsio/runtime";
import { Service as Updates, State, type Status } from "@bindings/updates";
import { ToastProvider } from "@/components/ui/toast";
import { updateStatusQuery, useUpdateToast } from "@/lib/updates";

// The update toast (#83, ADR-0054): it says a release is on its way as soon
// as the feed names one, turns into "ready" with Restart once the download is
// checked, and stays out of a film's way.

const downloading: Status = {
  state: State.Downloading,
  current: "1.2.2",
  version: "1.2.3",
  written: 10,
  total: 100,
};
const ready: Status = { state: State.Ready, current: "1.2.2", version: "1.2.3", total: 100 };
const upToDate: Status = { state: State.UpToDate, current: "1.2.3" };

function Harness({ playing }: { playing: boolean }) {
  useUpdateToast(playing);
  return null;
}

function renderToast(playing = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (onPlayer: boolean) => (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <Harness playing={onPlayer} />
      </ToastProvider>
    </QueryClientProvider>
  );
  const { rerender } = render(ui(playing));
  // Go's side of it: the status events land in the query's cache.
  const status = async (next: Status) =>
    act(() => {
      client.setQueryData(updateStatusQuery.queryKey, next);
    });
  return { client, status, onPlayer: (onPlayer: boolean) => rerender(ui(onPlayer)) };
}

beforeEach(() => {
  vi.mocked(Updates.Status).mockImplementation(() => CancellablePromise.resolve(downloading));
  vi.mocked(Updates.Restart).mockImplementation(() => CancellablePromise.resolve());
});

describe("the update toast", () => {
  it("says a release is available as soon as the feed names one", async () => {
    renderToast();

    expect(await screen.findByText("Peli 1.2.3 is available")).toBeInTheDocument();
    expect(screen.getByText(/downloading it in the background/i)).toBeInTheDocument();
    // Nothing to restart into yet.
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
  });

  it("turns into the ready toast, in place, once the download is checked", async () => {
    const toast = renderToast();
    await screen.findByText("Peli 1.2.3 is available");

    await toast.status(ready);

    expect(await screen.findByText("Peli 1.2.3 is ready")).toBeInTheDocument();
    expect(screen.getByText("It installs when you restart Peli.")).toBeInTheDocument();
    // One toast, not two.
    expect(screen.queryByText("Peli 1.2.3 is available")).toBeNull();
    expect(screen.getAllByText(/^Peli 1\.2\.3/)).toHaveLength(1);
  });

  it("restarts Peli from the ready toast's button", async () => {
    const user = userEvent.setup();
    const toast = renderToast();
    await screen.findByText("Peli 1.2.3 is available");
    await toast.status(ready);

    await user.click(await screen.findByRole("button", { name: "Restart" }));

    expect(Updates.Restart).toHaveBeenCalledTimes(1);
  });

  it("waits for the player to close rather than covering a film", async () => {
    const toast = renderToast(true);
    // Go has named the release, and the effect has had its say: still nothing.
    await waitFor(() =>
      expect(toast.client.getQueryData(updateStatusQuery.queryKey)).toMatchObject({
        state: State.Downloading,
      }),
    );
    await act(async () => {});
    expect(screen.queryByText(/^Peli 1\.2\.3/)).toBeNull();

    // The player closes, and it says its piece.
    toast.onPlayer(false);
    expect(await screen.findByText("Peli 1.2.3 is available")).toBeInTheDocument();

    // A film starts: the toast goes, rather than sitting over the picture.
    toast.onPlayer(true);
    await waitFor(() => expect(screen.queryByText(/^Peli 1\.2\.3/)).toBeNull());
  });

  it("goes away when the download fails", async () => {
    const toast = renderToast();
    await screen.findByText("Peli 1.2.3 is available");

    await toast.status({
      state: State.Failed,
      current: "1.2.2",
      version: "1.2.3",
      problem: "The update didn’t download.",
    });

    await waitFor(() => expect(screen.queryByText("Peli 1.2.3 is available")).toBeNull());
  });

  it("says it even when Go has already answered by the first render", async () => {
    // The status is in the cache before anything mounts, so the effect's
    // first run is the one that talks. ToastProvider is listening from its
    // own effect, which runs after its children's.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(updateStatusQuery.queryKey, ready);
    render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <Harness playing={false} />
        </ToastProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Peli 1.2.3 is ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart" })).toBeInTheDocument();
  });

  it("says nothing when Peli is up to date", async () => {
    vi.mocked(Updates.Status).mockImplementation(() => CancellablePromise.resolve(upToDate));
    renderToast();

    await waitFor(() => expect(Updates.Status).toHaveBeenCalled());
    expect(screen.queryByText(/^Peli 1\.2\.3/)).toBeNull();
  });
});
