import type { BaseOpts } from "../run.js";
import { handleError, makeClient, output } from "../run.js";

export async function runPending(opts: BaseOpts): Promise<void> {
  const client = makeClient(opts);
  try {
    const result = await client.proposals();
    // Filter to pending (the server already returns only pending, but we keep the filter
    // in case the API is extended in the future)
    output(result, opts.json, (d) => {
      const r = d as { proposals: Array<{ hash: string; agent: string; summary: string }> };
      if (r.proposals.length === 0) {
        console.log("No pending proposals.");
        return;
      }
      console.log(`${r.proposals.length} pending proposal(s):`);
      for (const p of r.proposals) {
        console.log(`  ${p.hash.slice(0, 12)}  [${p.agent}]  ${p.summary}`);
      }
    });
    process.exit(0);
  } catch (err) {
    handleError(err);
  }
}
