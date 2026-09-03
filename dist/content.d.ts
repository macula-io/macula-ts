/** Thrown by Session.getContent() when the station reports the content
 * isn't known to it (macula-go's content.ErrNotFound) -- an expected,
 * routine outcome for a transfer mechanism with no durability
 * guarantee, not a transport failure. Unlike DhtRecord's findRecord()
 * (which resolves `null` for its own equivalent "not found" case),
 * getContent() throws instead: its whole contract is "hand back the
 * bytes or fail", and there is no sensible non-throwing value to return
 * in place of the `Uint8Array` a caller asked for. */
export declare class ContentNotFoundError extends Error {
    /** The mcid that produced this error, hex-encoded (the same string
     * that was passed to getContent()). */
    readonly mcid: string;
    constructor(mcid: string);
}
