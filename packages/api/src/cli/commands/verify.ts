import type { BaseOpts } from "../run.js";
import { handleError, makeClient, output } from "../run.js";

export async function runVerify(opts: BaseOpts): Promise<void> {
  const client = makeClient(opts);
  let ok = true;
  try {
    const result = await client.verify();
    ok = result.ok;
    output(result, opts.json, (d) => {
      const r = d as {
        ok: boolean;
        stateHash?: string;
        degraded?: Array<{ id: string; reason: string }>;
      };
      console.log(`Integrity: ${r.ok ? "OK" : "DEGRADED"}`);
      if (r.stateHash) console.log(`State hash: ${r.stateHash}`);
      if (r.degraded && r.degraded.length > 0) {
        console.log("Degraded nodes:");
        for (const item of r.degraded) {
          console.log(`  ${item.id}: ${item.reason}`);
        }
      }
    });
  } catch (err) {
    handleError(err);
  }
  process.exit(ok ? 0 : 1);
}
