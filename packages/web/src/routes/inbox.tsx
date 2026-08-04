import { createRoute } from "@tanstack/react-router";
import { Route as RootRoute } from "./__root";

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: "/inbox",
  component: InboxPage,
});

function InboxPage() {
  return (
    <div>
      <h2 className="font-serif text-2xl font-semibold mb-4">Inbox</h2>
      {/* TODO(F8): Real inbox with proposal cards, approve/reject actions */}
      <p className="text-[--fg-muted] text-sm">
        No pending proposals. Governed writes from agents will appear here for your approval.
      </p>
    </div>
  );
}
