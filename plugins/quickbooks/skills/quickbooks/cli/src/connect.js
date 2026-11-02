// Browser connection: the user's own Chrome over CDP (a local endpoint, default http://127.0.0.1:9222).
import { Cdp, Page } from "./cdp.js";

export class ConnectError extends Error {
  constructor(message, code = 6) { super(message); this.exitCode = code; }
}

/** Connect to the user's own browser; returns { runtime, cdp, page, close() }. Secrets are never logged. */
export async function connect(opts = {}) {
  const cdpUrl = opts.cdpUrl || process.env.QBO_CDP_URL || "http://127.0.0.1:9222";
  let cdp;
  try { cdp = await Cdp.connect(cdpUrl); }
  catch (e) { throw new ConnectError(`could not reach the browser over CDP: ${String(e.message).replace(/wss?:\/\/\S+/g, "<cdp>")}`); }
  const page = await Page.open(cdp, { reuse: true, matchUrl: /qbo\.intuit\.com/ });
  return {
    runtime: "cdp", cdp, page,
    async close() { cdp.close(); },
  };
}
