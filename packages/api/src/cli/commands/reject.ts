import type { BaseOpts } from "../run.js";
import { handleError, makeClient, output } from "../run.js";

export interface RejectOpts extends BaseOpts {
  hash: string;
}

export async function runReject(opts: RejectOpts): Promise<void> {
  const client = makeClient(opts);
  try {
    const result = await client.reject(opts.hash);
    output(result, opts.json, (d) => {
      const r = d as { status?: string };
      console.log(`Proposal ${opts.hash.slice(0, 12)}: rejected (${r.status ?? "ok"})`);
    });
    process.exit(0);
  } catch (err) {
    handleError(err);
  }
}
