// Whether the app under test is the iOS one. Set it before rendering; the
// setup resets it after each test.
export const ios = { on: false };

export function onIOS() {
  ios.on = true;
}
