import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { Placeholder } from "@/components/placeholder";
import { appVersionQuery } from "@/lib/app-info";

export const Route = createFileRoute("/settings")({
  component: Settings,
});

// Skeleton until the settings screen (#17).
function Settings() {
  const version = useQuery(appVersionQuery);

  return (
    <Placeholder title="Settings">
      <p className="text-muted-foreground">Version {version.data ?? "…"}</p>
    </Placeholder>
  );
}
