/** A content id (MCID): 50 bytes, tag 2 (SHA-384), a codec byte (0x55 a raw
 * block of at most 256 KiB, 0x56 a manifest over 256 KiB chunks) and the
 * 48-byte hash. Given as 100 hex characters or 50 bytes. */
export type Mcid = string | Uint8Array;
/** A content id as the 50 bytes the native layer takes. */
export declare function mcid50(mcid: Mcid): Uint8Array;
/** Bounds on one fetch; each defaults as macula's does. */
export interface ContentOptions {
    /** Largest content accepted, 256 MiB by default. */
    readonly maxBytes?: number;
    /** Most chunks a manifest may have, 16,384 by default. */
    readonly maxChunks?: number;
    /** Chunk streams open at once, 4 by default. */
    readonly parallel?: number;
    /** Deadline of one stream, 15 s by default. */
    readonly chunkTimeoutMs?: number;
    /** Deadline of the whole fetch, 5 minutes by default. */
    readonly timeoutMs?: number;
}
/** Content no node announces in the realm. */
export declare class NotSharedError extends Error {
    constructor();
}
/** Content every announcing node failed to give; `detail` names each failure
 * (unreachable, not the content asked for, over the bounds, ...). */
export declare class ContentUnavailableError extends Error {
    readonly detail: string;
    constructor(detail: string);
}
/** The native layer's content errors, as the classes they name. */
export declare function contentError(e: unknown): Error;
/** How long a whole fetch waits when not told: 5 minutes. */
export declare const DEFAULT_CONTENT_TIMEOUT_MS = 300000;
