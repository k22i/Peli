import { createFileRoute } from "@tanstack/react-router";

import { LivePage } from "@/components/livetv/live-page";
import { liveSearch } from "@/lib/livetv";

// Live TV (ADR-0066): the channels by group, or the guide.
export const Route = createFileRoute("/live")({
  validateSearch: liveSearch,
  component: LivePage,
});
