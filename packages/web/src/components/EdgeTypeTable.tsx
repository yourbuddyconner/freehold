import { cn } from "~/lib/cn";

interface EdgeType {
  name: string;
  domain?: string;
  range?: string;
  cardinality?: string;
}

interface EdgeTypeTableProps {
  edgeTypes: EdgeType[];
  className?: string;
}

export function EdgeTypeTable({ edgeTypes, className }: EdgeTypeTableProps) {
  if (edgeTypes.length === 0) {
    return (
      <div className={cn("rounded-lg border border-(--border) bg-(--bg-subtle) p-6", className)}>
        <p className="text-sm text-(--fg-muted)">No edge types defined.</p>
      </div>
    );
  }

  return (
    <div className={cn("rounded-lg border border-(--border) overflow-hidden", className)}>
      <table className="w-full text-sm border-collapse">
        <thead className="bg-(--bg-subtle)">
          <tr className="border-b border-(--border)">
            <th className="text-left px-4 py-2.5 font-medium text-(--fg)">Name</th>
            <th className="text-left px-4 py-2.5 font-medium text-(--fg)">Domain</th>
            <th className="text-left px-4 py-2.5 font-medium text-(--fg)">Range</th>
            <th className="text-left px-4 py-2.5 font-medium text-(--fg)">Cardinality</th>
          </tr>
        </thead>
        <tbody>
          {edgeTypes.map((edge) => (
            <tr key={edge.name} className="border-b border-(--border)/50 hover:bg-(--bg-subtle)">
              <td className="px-4 py-2.5 font-mono text-xs text-(--fg)">{edge.name}</td>
              <td className="px-4 py-2.5 font-mono text-xs text-(--fg-muted)">
                {edge.domain ?? "—"}
              </td>
              <td className="px-4 py-2.5 font-mono text-xs text-(--fg-muted)">
                {edge.range ?? "—"}
              </td>
              <td className="px-4 py-2.5 font-mono text-xs text-(--fg-muted)">
                {edge.cardinality ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
