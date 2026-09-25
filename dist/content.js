// Node-served content (macula 12.6.0, D27): a node shares content by serving
// it on its own ~<node_id>/content_v1 and announcing it in the DHT; a fetch
// finds the announcements, dials each sharer through the station it names, and
// checks the block, the manifest and every chunk against the content id it
// asked for, so it trusts no sharer and needs no realm key.
/** A content id as the 50 bytes the native layer takes. */
export function mcid50(mcid) {
    if (typeof mcid === "string") {
        if (!/^[0-9a-fA-F]{100}$/.test(mcid))
            throw new Error("macula-ts: a content id is 100 hex characters (50 bytes)");
        return Uint8Array.from(Buffer.from(mcid, "hex"));
    }
    if (mcid.length !== 50)
        throw new Error(`macula-ts: a content id is 50 bytes, got ${mcid.length}`);
    return mcid;
}
/** Content no node announces in the realm. */
export class NotSharedError extends Error {
    constructor() {
        super("macula-ts: no node shares that content in that realm");
        this.name = "NotSharedError";
    }
}
/** Content every announcing node failed to give; `detail` names each failure
 * (unreachable, not the content asked for, over the bounds, ...). */
export class ContentUnavailableError extends Error {
    detail;
    constructor(detail) {
        super(`macula-ts: no sharer gave the content: ${detail}`);
        this.detail = detail;
        this.name = "ContentUnavailableError";
    }
}
/** The native layer's content errors, as the classes they name. */
export function contentError(e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message === "not_shared")
        return new NotSharedError();
    const unavailable = /^unavailable:([\s\S]*)$/.exec(message);
    if (unavailable)
        return new ContentUnavailableError(unavailable[1] ?? "");
    return e instanceof Error ? e : new Error(message);
}
/** How long a whole fetch waits when not told: 5 minutes. */
export const DEFAULT_CONTENT_TIMEOUT_MS = 300_000;
//# sourceMappingURL=content.js.map