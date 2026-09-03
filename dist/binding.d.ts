export type Handle = number | bigint;
export declare const native: {
    identityGenerate(): bigint;
    identityFromSeedBytes(seed32: Uint8Array): bigint;
    identityNodeId(handle: Handle): Uint8Array;
    identityPrivateBytes(handle: Handle): Uint8Array;
    identityFree(handle: Handle): void;
};
