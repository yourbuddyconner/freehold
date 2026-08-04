import type { BaseOpts } from "../run.js";
import { handleError, makeClient, output } from "../run.js";

export interface ApproveOpts extends BaseOpts {
  hash: string;
}

export async function runApprove(opts: ApproveOpts): Promise<void> {
  const client = makeClient(opts);
  try {
    const result = await client.approve(opts.hash);
    output(result, opts.json, (d) => {
      const r = d as { status?: string };
      console.log(`Proposal ${opts.hash.slice(0, 12)}: ${r.status ?? "processed"}`);
    });
    process.exit(0);
  } catch (err) {
    handleError(err);
  }
}
