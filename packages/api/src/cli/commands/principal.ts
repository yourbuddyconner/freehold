import type { BaseOpts } from "../run.js";
import { handleError, makeClient, output } from "../run.js";

export interface PrincipalAddOpts extends BaseOpts {
  name: string;
  graph?: string;
  role?: string;
  kind?: "user" | "agent" | "service";
}

export async function runPrincipalAdd(opts: PrincipalAddOpts): Promise<void> {
  const client = makeClient(opts);
  try {
    const result = await client.addPrincipal({
      name: opts.name,
      kind: opts.kind ?? "user",
      role: opts.role,
    });
    output(result, opts.json, (d) => {
      const r = d as typeof result;
      console.log(`Principal: ${r.name} (${r.kind})`);
      console.log(`Admission: ${r.admission}`);
      console.log(`Key file:  ${r.keyPath}`);
      console.log(`Next step: ${r.instruction}`);
    });
    process.exit(0);
  } catch (err) {
    handleError(err);
  }
}
