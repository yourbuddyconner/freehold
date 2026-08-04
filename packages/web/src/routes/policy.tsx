import { createRoute } from "@tanstack/react-router";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/policy",
  component: PolicyPage,
});

function PolicyPage() {
  return (
    <div>
      <h2 className="font-serif text-2xl font-semibold mb-4">Policy</h2>
      {/* TODO(F9): Rule cards, YAML editor drawer, recent applications */}
      <p className="text-[--fg-muted] text-sm">
        Policy editor coming in F9. Rules govern which agent writes require your approval.
      </p>
    </div>
  );
}
