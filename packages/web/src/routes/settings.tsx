import { createRoute } from "@tanstack/react-router";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/settings",
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <div>
      <h2 className="font-serif text-2xl font-semibold mb-4">Settings</h2>
      {/* TODO(F9): Principal cards, agent registration, ontology package installation */}
      <p className="text-[--fg-muted] text-sm">
        Settings coming in F9. Manage principals, register agents, and install ontology packages.
      </p>
    </div>
  );
}
