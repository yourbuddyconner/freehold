import { createRoute } from "@tanstack/react-router";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/",
  component: IndexPage,
});

function IndexPage() {
  return (
    <div>
      <h2 className="font-serif text-2xl font-semibold mb-2">Welcome to Freehold</h2>
      <p className="text-(--fg-muted)">Your agent memory — owned, governed, verifiable.</p>
    </div>
  );
}
