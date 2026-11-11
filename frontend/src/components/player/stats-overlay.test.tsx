import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Stats } from "@/lib/stats";
import type * as PlayerBindings from "@bindings/player";
import { hasFocusRing } from "@/test/focus";

const mocks = vi.hoisted(() => ({ stats: vi.fn<() => Promise<Stats>>() }));
vi.mock("@bindings/player", async (importOriginal) => ({
  ...(await importOriginal<typeof PlayerBindings>()),
  Service: { Stats: mocks.stats },
}));

const { StatsOverlay } = await import("./stats-overlay");

const stats: Stats = {
  videoCodec: "h264",
  width: 1920,
  height: 1080,
  fps: 24,
  pixelFormat: "yuv420p",
  gamma: "bt.1886",
  primaries: "bt.709",
  colorMatrix: "bt.709",
  hdrShown: false,
  outputWidth: 1920,
  outputHeight: 1080,
  hwdec: "",
  droppedFrames: 0,
  decoderDrops: 0,
  audioCodec: "aac",
  audioChannels: 2,
  videoBitrate: 0,
  audioBitrate: 0,
  cacheSeconds: 10,
  cacheBytes: 0,
  cacheSpeed: 0,
  renderer: "gpu-next",
  gpuContext: "d3d11",
  displayFps: 60,
};

function renderOverlay(onClose = vi.fn<() => void>()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StatsOverlay onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

describe("StatsOverlay", () => {
  it("shows Go's stats and asks again while open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.stats.mockResolvedValue(stats);
    renderOverlay();
    expect(await screen.findByText("H.264 · 24 fps · yuv420p")).toBeInTheDocument();
    expect(screen.getByText("Software")).toBeInTheDocument();
    const asked = mocks.stats.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2100);
    expect(mocks.stats.mock.calls.length).toBeGreaterThanOrEqual(asked + 2);
    vi.useRealTimers();
  });

  it("closes from a button with a focus ring", async () => {
    mocks.stats.mockResolvedValue(stats);
    const user = userEvent.setup();
    const onClose = renderOverlay();
    const close = screen.getByRole("button", { name: "Close stats" });
    expect(hasFocusRing(close)).toBe(true);
    await user.click(close);
    expect(onClose).toHaveBeenCalled();
  });
});
