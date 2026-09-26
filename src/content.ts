// Node-served content (macula 12.6.0, D27): a node shares content by serving
// it on its own ~<node_id>/content_v1 and announcing it in the DHT; a fetch
// finds the announcements, dials each sharer through the station it names, and
// checks the block, the manifest and every chunk against the content id it
// asked for, so it trusts no sharer and needs no realm key.

/** A content id (MCID): 50 bytes, tag 2 (SHA-384), a codec byte (0x55 a raw
 * block of at most 256 KiB, 0x56 a manifest over 256 KiB chunks) and the
 * 48-byte hash. Given as 100 hex characters or 50 bytes. */
export type Mcid = string | Uint8Array;

/** A content id as the 50 bytes the native layer takes. */
export function mcid50(mcid: Mcid): Uint8Array {
  if (typeof mcid === "string") {
    if (!/^[0-9a-fA-F]{100}$/.test(mcid)) throw new Error("macula-ts: a content id is 100 hex characters (50 bytes)");
    return Uint8Array.from(Buffer.from(mcid, "hex"));
  }
  if (mcid.length !== 50) throw new Error(`macula-ts: a content id is 50 bytes, got ${mcid.length}`);
  return mcid;
}

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
export class NotSharedError extends Error {
  constructor() {
    super("macula-ts: no node shares that content in that realm");
    this.name = "NotSharedError";
  }
}

/** Content every announcing node failed to give; `detail` names each failure
 * (unreachable, not the content asked for, over the bounds, ...). */
export class ContentUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(`macula-ts: no sharer gave the content: ${detail}`);
    this.name = "ContentUnavailableError";
  }
}

/** How long a whole fetch waits when not told: 5 minutes. */
export const DEFAULT_CONTENT_TIMEOUT_MS = 300_000;
