import { createRoute } from "@tanstack/react-router";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/verify",
  component: VerifyPage,
});

function VerifyPage() {
  return (
    <div>
      <h2 className="font-serif text-2xl font-semibold mb-4">Verify</h2>
      {/* TODO(F9): Run button, integrity/authorship/governance rows, changeset timeline */}
      <p className="text-[--fg-muted] text-sm">
        Verification dashboard coming in F9. Proves the integrity and authorship of your entire
        memory graph.
      </p>
    </div>
  );
}
