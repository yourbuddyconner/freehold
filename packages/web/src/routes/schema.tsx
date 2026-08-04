import { createRoute } from "@tanstack/react-router";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/schema",
  component: SchemaPage,
});

function SchemaPage() {
  return (
    <div>
      <h2 className="font-serif text-2xl font-semibold mb-4">Schema</h2>
      {/* TODO(F8): Types tab, Edges tab, Taxonomy tab */}
      <p className="text-[--fg-muted] text-sm">
        Schema viewer coming in F8. Agents can propose new entity types; proposals land in the
        Inbox.
      </p>
    </div>
  );
}
