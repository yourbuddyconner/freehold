import type { BaseOpts } from "../run.js";
import { checkHeld, handleError, makeClient, output } from "../run.js";

export interface RememberOpts extends BaseOpts {
  content: string;
  agent: string;
  type?: string;
  classify?: string;
}

export async function runRemember(opts: RememberOpts): Promise<void> {
  const client = makeClient(opts);
  try {
    let result: Record<string, unknown> | undefined;

    // If type/classify are specified, use createEntity directly instead of remember shortcut
    if (opts.type || opts.classify) {
      const attributes = { statement: opts.content };
      const body: Record<string, unknown> = {
        agent: opts.agent,
        type: opts.type || "memory/Note@1",
        attributes,
      };
      if (opts.classify) {
        body.classification = opts.classify;
      }
      result = (await client.createEntity(
        body as Parameters<typeof client.createEntity>[0]
      )) as Record<string, unknown>;
    } else {
      result = (await client.remember({
        agent: opts.agent,
        content: opts.content,
      })) as Record<string, unknown>;
    }

    checkHeld(result);
    output(result, opts.json, (d) => {
      const r = d as { status: string; noteId?: string; nodeId?: string; changeset?: string };
      console.log(`Remembered [${r.status}]`);
      if (r.noteId) console.log(`  Note ID:   ${r.noteId}`);
      if (r.nodeId) console.log(`  Node ID:   ${r.nodeId}`);
      if (r.changeset) console.log(`  Changeset: ${r.changeset}`);
    });
    process.exit(0);
  } catch (err) {
    handleError(err);
  }
}
