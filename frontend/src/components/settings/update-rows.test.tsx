import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CancellablePromise } from "@wailsio/runtime";
import { Service as Updates, State, type Status } from "@bindings/updates";
import { UpdateRows } from "@/components/settings/update-rows";
import { updateStatusQuery } from "@/lib/updates";

// Settings › About › Updates (#83): "Check now" looks and asks; it doesn't
// download anything until the user says so.

// The device's settings, for the "Automatic updates" switch.
vi.mock("@bindings/store", () => ({
  Service: {
    DeviceSettings: vi.fn<() => Promise<{ autoUpdate: boolean }>>(async () => ({
      autoUpdate: true,
    })),
    SaveDeviceSettings: vi.fn<() => Promise<void>>(async () => {}),
  },
}));

const idle: Status = { state: State.Idle, current: "1.2.2" };
const available: Status = {
  state: State.Available,
  current: "1.2.2",
  version: "1.2.3",
  total: 100,
};
const downloading: Status = {
  state: State.Downloading,
  current: "1.2.2",
  version: "1.2.3",
  written: 10,
  total: 100,
};

function renderRows(status: Status) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(updateStatusQuery.queryKey, status);
  render(
    <QueryClientProvider client={client}>
      <UpdateRows />
    </QueryClientProvider>,
  );
  // Go's side of it: the status events land in the query's cache.
  const setStatus = async (next: Status) =>
    act(() => {
      client.setQueryData(updateStatusQuery.queryKey, next);
    });
  return { client, setStatus };
}

beforeEach(() => {
  vi.mocked(Updates.Status).mockImplementation(() => CancellablePromise.resolve(idle));
  vi.mocked(Updates.Check).mockImplementation(() => CancellablePromise.resolve(idle));
  vi.mocked(Updates.Download).mockImplementation(() => CancellablePromise.resolve(downloading));
});

describe("Settings › About › Updates", () => {
  it("checks for an update without downloading one", async () => {
    const user = userEvent.setup();
    const rows = renderRows(idle);

    await user.click(screen.getByRole("button", { name: "Check now" }));

    expect(Updates.Check).toHaveBeenCalledTimes(1);
    expect(Updates.Download).not.toHaveBeenCalled();

    // The check finds one and Go says so: Peli asks before downloading it.
    await rows.setStatus(available);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Download Peli 1.2.3?")).toBeInTheDocument();
    expect(Updates.Download).not.toHaveBeenCalled();
  });

  it("downloads the release the user said yes to", async () => {
    const user = userEvent.setup();
    const rows = renderRows(idle);
    await user.click(screen.getByRole("button", { name: "Check now" }));
    await rows.setStatus(available);

    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Download" }));

    expect(Updates.Download).toHaveBeenCalledTimes(1);
    // Go starts downloading, and the question goes away with it.
    await rows.setStatus(downloading);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("downloads nothing when the user says not now", async () => {
    const user = userEvent.setup();
    const rows = renderRows(idle);
    await user.click(screen.getByRole("button", { name: "Check now" }));
    await rows.setStatus(available);

    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Not now" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(Updates.Download).not.toHaveBeenCalled();
    // The release waits in the row instead: one button, and it downloads.
    expect(screen.getByText(/Peli 1\.2\.3 is available/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(Updates.Download).toHaveBeenCalledTimes(1);
  });

  it("offers Restart to update, not a download, once it's ready", async () => {
    renderRows({ state: State.Ready, current: "1.2.2", version: "1.2.3", total: 100 });

    expect(await screen.findByRole("button", { name: "Restart to update" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
  });
});
