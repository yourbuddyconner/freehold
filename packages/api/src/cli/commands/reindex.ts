import type { BaseOpts } from "../run.js";
import { handleError, makeClient, output } from "../run.js";

export async function runReindex(opts: BaseOpts): Promise<void> {
  const client = makeClient(opts);
  try {
    const result = await client.reindex();
    output(result, opts.json, (d) => {
      const r = d as { status?: string };
      console.log(`Reindex: ${r.status ?? "ok"}`);
    });
    process.exit(0);
  } catch (err) {
    handleError(err);
  }
}
