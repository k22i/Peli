// Whether the app under test is the iOS one. Set it before rendering; the
// setup resets it after each test.
export const ios = { on: false };

export function onIOS() {
  ios.on = true;
}

// The compact iOS shell (an iPhone): the iOS app and a narrow window.
// Returns what puts the window back; call it in afterEach.
export function onCompactIOS(): () => void {
  ios.on = true;
  const original = window.matchMedia;
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: query === "(max-width: 699.98px), (max-height: 499.98px)",
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
  return () => {
    window.matchMedia = original;
  };
}
