import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";

import { Placeholder } from "@/components/placeholder";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { buttonVariants } from "@/components/ui/button";
import { appVersionQuery } from "@/lib/app-info";

export const Route = createFileRoute("/settings")({
  component: Settings,
});

// Skeleton until the settings screen (#17); appearance is the design
// system's manual light/dark override (#13).
function Settings() {
  const version = useQuery(appVersionQuery);

  return (
    <Placeholder title="Settings">
      <ThemeSwitcher />
      <p className="text-muted-foreground">Version {version.data ?? "…"}</p>
      <Link to="/gallery" className={buttonVariants({ variant: "link", size: "sm" })}>
        Design system
      </Link>
    </Placeholder>
  );
}
