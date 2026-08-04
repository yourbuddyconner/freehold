import { createRootRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/AppShell";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return <AppShell />;
}
