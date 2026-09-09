// Context Library worker: private Subject-owned collections plus a read-only agent singleton. The
// vendor auto-provisions one account per connection and exposes a management UI.

export { ContextCollectionDurableObject } from "./context-collection.js";
export { UserLibraryDurableObject } from "./user-library.js";
export { LibraryRegistryDurableObject } from "./registry-do.js";
export {
  GatekeeperVendor, ContextAccount, ContextVerifier, ContextGatekeeper,
} from "./library-gatekeeper.js";

/** Keep ES Module worker format; this worker is used over RPC/DOs, not HTTP. */
export default {
  async fetch(): Promise<Response> {
    return new Response("Context Library worker is running.", {
      headers: { "content-type": "text/plain" },
    });
  },
};
