import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type * as Runtime from "@wailsio/runtime";

import type { QRCode } from "@bindings/account";
import type { Profile } from "@bindings/store";
import { renderApp } from "@/test/render-app";

vi.mock("@bindings/appinfo", () => ({
  Service: { Version: vi.fn<() => Promise<string>>(() => Promise.resolve("1.2.3")) },
}));

const openURL = vi.hoisted(() => vi.fn<(url: string) => Promise<void>>(async () => {}));
vi.mock("@wailsio/runtime", async (original) => ({
  ...(await original<typeof Runtime>()),
  Browser: { OpenURL: openURL },
}));

type Failure = { code?: string | undefined; message: string };

// Stand-ins for the Go store, keychain and account services. The phone is
// approve(): it settles the wait for the newest code.
const backend = vi.hoisted(() => ({
  profiles: [] as Profile[],
  current: undefined as Profile | undefined,
  keychain: null as string | null,
  // What StartQRSignIn fails with, once.
  startFails: undefined as Failure | undefined,
  starts: 0,
  // How long a new code lasts.
  lifetime: 5 * 60 * 1000,
  waits: [] as { code: string; settle: (failure?: Failure) => void; cancelled: boolean }[],
}));

const error = (f: Failure) => new Error(f.message, f.code ? { cause: { code: f.code } } : {});

// A Wails call's promise, with the cancel the hook calls.
function cancellable<T>(promise: Promise<T>, onCancel: () => void = () => {}) {
  return Object.assign(promise, {
    cancel: async () => {
      onCancel();
    },
  });
}

vi.mock("@bindings/store", () => ({
  Service: {
    Profiles: async () => backend.profiles,
    CurrentProfile: async () => backend.current,
    ProfileSettings: async () => ({
      audioLanguages: [],
      subtitleLanguage: "",
      subtitleSize: "medium",
      captions: "system",
    }),
    DeviceSettings: async () => ({ hardwareDecoding: true, diagnostics: false }),
    Addons: async () => [],
    VisibleAddons: async () => [],
  },
}));

vi.mock("@bindings/secrets", () => ({
  Service: {
    Available: async () => {
      if (backend.keychain) throw new Error(backend.keychain);
    },
  },
}));

vi.mock("@bindings/account", () => ({
  Service: {
    Status: async () => ({ signedIn: backend.current?.nuvioIndex != null, sessionEnded: false }),
    StartQRSignIn: () =>
      cancellable(
        (async (): Promise<QRCode> => {
          const failure = backend.startFails;
          backend.startFails = undefined;
          if (failure) throw error(failure);
          backend.starts++;
          const code = `ABC${String(backend.starts).padStart(3, "0")}`;
          return {
            url: `https://nuvio.tv/link?code=${code}`,
            code,
            linkUrl: "https://nuvio.tv/link",
            expiresAt: new Date(Date.now() + backend.lifetime).toISOString(),
            size: 21,
            path: "M0 0h7v1h-7z",
          };
        })(),
      ),
    WaitQRSignIn: (code: string) => {
      const wait: (typeof backend.waits)[number] = { code, settle: () => {}, cancelled: false };
      backend.waits.push(wait);
      return cancellable(
        new Promise<Profile>((resolve, reject) => {
          wait.settle = (failure) => {
            if (failure) {
              reject(error(failure));
              return;
            }
            const kevin: Profile = { id: 2, name: "Kevin", nuvioIndex: 1 };
            backend.profiles = [...backend.profiles, kevin];
            backend.current = kevin;
            resolve(kevin);
          };
        }),
        () => {
          wait.cancelled = true;
        },
      );
    },
  },
}));

beforeEach(() => {
  backend.profiles = [];
  backend.current = undefined;
  backend.keychain = null;
  backend.startFails = undefined;
  backend.starts = 0;
  backend.lifetime = 5 * 60 * 1000;
  backend.waits = [];
  openURL.mockClear();
});

// The wait for the code on screen, once it has started.
async function waitForWait(code: string) {
  await waitFor(() =>
    expect(backend.waits.some((w) => w.code === code && !w.cancelled)).toBe(true),
  );
  return backend.waits.findLast((w) => w.code === code && !w.cancelled)!;
}

async function renderQR() {
  const app = await renderApp("/qr-sign-in", { shell: false });
  await screen.findByRole("heading", { level: 1, name: "Sign in with your phone" });
  return app;
}

describe("QR sign-in", () => {
  it("is reached from the welcome screen, shows the code and signs in when the phone approves", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/", { shell: false });

    await user.click(await screen.findByRole("link", { name: "Sign in with your phone" }));
    await screen.findByRole("heading", { level: 1, name: "Sign in with your phone" });

    expect(
      await screen.findByRole("img", { name: "QR code for https://nuvio.tv/link?code=ABC001" }),
    ).toBeVisible();
    expect(screen.getByLabelText("A B C 0 0 1")).toHaveTextContent("ABC001");
    expect(screen.getByText(/^expires in [45]:\d\d$/)).toBeVisible();
    expect(screen.getByText(/Waiting for approval/)).toBeVisible();

    (await waitForWait("ABC001")).settle();

    expect(await screen.findByRole("navigation", { name: "Main" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
    expect(await screen.findByText("Signed in as Kevin")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Profile: Kevin" })).toBeVisible();
  });

  it("opens the link page in the browser", async () => {
    const user = userEvent.setup();
    await renderQR();

    await user.click(await screen.findByRole("button", { name: "nuvio.tv/link" }));

    expect(openURL).toHaveBeenCalledWith("https://nuvio.tv/link?code=ABC001");
  });

  it("offers a new code when the code expires", async () => {
    const user = userEvent.setup();
    await renderQR();
    (await waitForWait("ABC001")).settle({
      code: "qr_expired",
      message: "nuvio: device login expired",
    });

    expect(await screen.findByText("The code expired")).toBeVisible();
    expect(screen.queryByText(/Waiting for approval/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("button", { name: "New code" }));

    expect(
      await screen.findByRole("img", { name: "QR code for https://nuvio.tv/link?code=ABC002" }),
    ).toBeVisible();
    expect(screen.queryByText("The code expired")).toBeNull();
    await waitForWait("ABC002");
  });

  it("shows the code as expired when the countdown runs out", async () => {
    backend.lifetime = 1000;
    await renderQR();

    expect(await screen.findByText("The code expired", {}, { timeout: 3000 })).toBeVisible();
    expect(screen.getByRole("button", { name: "New code" })).toBeVisible();
  });

  it("swaps the code for a new one, ending the old wait", async () => {
    const user = userEvent.setup();
    await renderQR();
    const first = await waitForWait("ABC001");

    await user.click(screen.getByRole("button", { name: "New code" }));

    expect(await screen.findByLabelText("A B C 0 0 2")).toBeVisible();
    expect(first.cancelled).toBe(true);
    await waitForWait("ABC002");
  });

  it("explains a failure to start and tries again", async () => {
    backend.startFails = { code: "unreachable", message: "nuvio: backend unreachable" };
    const user = userEvent.setup();
    await renderQR();

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Can’t reach Nuvio")).toBeVisible();
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByLabelText("A B C 0 0 1")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains a sign-in that fails after approval", async () => {
    await renderQR();
    (await waitForWait("ABC001")).settle({
      code: "unavailable",
      message: "nuvio: backend unavailable",
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Nuvio isn’t responding");
    expect(screen.queryByText(/Waiting for approval/)).toBeNull();
  });

  it("stops waiting when the user goes back", async () => {
    backend.profiles = [{ id: 1, name: "Guest", guest: true }];
    backend.current = backend.profiles[0];
    const user = userEvent.setup();
    const { router } = await renderApp("/settings");

    await user.click(await screen.findByRole("link", { name: "Sign in" }));
    await user.click(await screen.findByRole("link", { name: "Sign in with your phone instead" }));
    await screen.findByRole("heading", { level: 1, name: "Sign in with your phone" });
    const wait = await waitForWait("ABC001");
    await user.click(screen.getByRole("button", { name: "Back" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
    expect(wait.cancelled).toBe(true);
  });

  it("goes to the picker when there's more than one profile", async () => {
    backend.profiles = [{ id: 1, name: "Guest", guest: true }];
    backend.current = backend.profiles[0];
    await renderQR();

    (await waitForWait("ABC001")).settle();

    await screen.findByRole("heading", { level: 1, name: "Who’s watching?" });
    expect(await screen.findByText("Signed in to Nuvio")).toBeInTheDocument();
  });
});
