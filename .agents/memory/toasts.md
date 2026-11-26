---
name: toasts
description: "base-ui toasts in Peli: the provider subscribes in a parent effect so a toast added in a child's mount effect is lost (defer a microtask); the update toast's one id and states"
metadata:
  type: project
---

Peli's toasts are base-ui's (`components/ui/toast.tsx`): `toastManager.add({ id, ... })` upserts by id and refreshes the timer, `update(id, …)` patches, `close(id)` hides, `timeout: 0` keeps it until it's used or swiped. `type: "loading"` never auto-dismisses and shows a spinner; `type: "error"` gets the iOS error buzz from the `withErrorHaptic` wrapper.

**The gotcha:** `Toast.Provider` subscribes to the manager in its own `useEffect`, and a parent's effects run *after* its children's. So `toastManager.add` called from a child's first mount effect reaches nobody and the toast silently never appears. Peli hit this on the update toast (its status is in the query cache at mount when the rig pre-seeds it; a future `meta.persist` on the status query would hit it in the app too). `useUpdateToast` defers its `add`/`close` to `queueMicrotask`, which lands after every mount effect; `src/lib/updates.test.tsx` has a case that seeds the cache before `render` and fails without the deferral.

**The update toast (#83, ADR-0054)** is one toast with one id (`"peli-update"`), so it turns from "Peli 1.2.3 is available" (loading, while `State.Downloading`) into "Peli 1.2.3 is ready" with Restart (`State.Ready`) in place instead of stacking. It closes on `Failed`, on `UpToDate`, and while the player route is open, then comes back when the player closes.

**Why:** a toast that only appeared after the whole `.app` was downloaded made updating a trip to Settings › About; the first-render drop made it unreliable.

**How to apply:** any new toast added from an effect that can run on first render needs the same deferral, or add it from an event handler instead. Related: [[native-feel]], [[settings-panes]].
