export type Handle = number | bigint;
export declare const native: {
    identityGenerate(): bigint;
    identityFromSeedBytes(seed32: Uint8Array): bigint;
    identityNodeId(handle: Handle): Uint8Array;
    identityPrivateBytes(handle: Handle): Uint8Array;
    identityFree(handle: Handle): void;
    sessionConnect(host: string, port: number, identityHandle: Handle): Promise<bigint>;
    sessionRemoteAddr(handle: Handle): string;
    sessionStationNodeId(handle: Handle): Uint8Array;
    sessionClose(handle: Handle, identityHandle: Handle, reason: string): Promise<void>;
};
