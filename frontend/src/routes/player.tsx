import { createFileRoute } from "@tanstack/react-router";

import { PlayerPage } from "@/components/player/player-page";

export const Route = createFileRoute("/player")({
  // The whole window, over the video: no shell.
  staticData: { chrome: "none" },
  component: PlayerPage,
});
