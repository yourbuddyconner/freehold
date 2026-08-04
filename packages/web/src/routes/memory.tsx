import { createRoute } from "@tanstack/react-router";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/memory",
  component: MemoryPage,
});

function MemoryPage() {
  return (
    <div>
      <h2 className="font-serif text-2xl font-semibold mb-4">Memory</h2>
      {/* TODO(F8): Search bar, filter chips, taxonomy tree, memory cards with ProvenanceFooter */}
      <p className="text-[--fg-muted] text-sm">
        Memory browser coming in F8. Connect an agent via{" "}
        <code className="font-mono text-xs">freehold mcp setup claude-code</code> to start building
        memories.
      </p>
    </div>
  );
}
