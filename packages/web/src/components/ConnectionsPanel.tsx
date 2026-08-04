import { Link } from "@tanstack/react-router";

export interface EdgeView {
  id: string;
  type: string;
  from: string;
  to: string;
  direction: "outgoing" | "incoming";
  attributes?: Record<string, unknown>;
}

function bareId(ref: string): string {
  const colon = ref.indexOf(":");
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

/** Short edge-type label: "memory/relates_to@1" → "relates_to". */
function edgeLabel(typeRef: string): string {
  return typeRef.split("@")[0].split("/").pop() ?? typeRef;
}

interface ConnectionsPanelProps {
  edges: EdgeView[];
  /** id → display title, resolved from the workspace index */
  titles: Map<string, string>;
}

/**
 * The local graph: typed edges in both directions, each row linking to
 * the peer node. Peer titles come from the workspace index; unresolved
 * peers fall back to a short id.
 */
export function ConnectionsPanel({ edges, titles }: ConnectionsPanelProps) {
  if (edges.length === 0) return null;

  return (
    <section>
      <h3 className="text-sm font-semibold text-(--fg) mb-2">Connections</h3>
      <ul className="space-y-1">
        {edges.map((edge) => {
          const peerId = bareId(edge.direction === "outgoing" ? edge.to : edge.from);
          const title = titles.get(peerId) ?? `${peerId.slice(0, 8)}…`;
          return (
            <li key={edge.id} className="flex items-center gap-2 text-xs">
              <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-(--fg-muted) w-28 shrink-0 text-right">
                {edge.direction === "outgoing"
                  ? `${edgeLabel(edge.type)} →`
                  : `← ${edgeLabel(edge.type)}`}
              </span>
              <Link
                to="/memory/$id"
                params={{ id: peerId }}
                data-testid={`connection-${peerId}`}
                className="text-(--fg) hover:underline truncate"
              >
                {title}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
