import { createFileRoute } from "@tanstack/react-router";

import { StreamsPage } from "@/components/streams/streams-page";
import { streamsSearch } from "@/lib/playback";

export const Route = createFileRoute("/streams/$type/$id")({
  validateSearch: streamsSearch,
  component: StreamsPage,
});
