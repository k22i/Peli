import { createFileRoute } from "@tanstack/react-router";

import { Placeholder } from "@/components/placeholder";

// Reached from the profile menu; the addon manager is #38.
export const Route = createFileRoute("/addons")({
  component: () => <Placeholder title="Addons" />,
});
