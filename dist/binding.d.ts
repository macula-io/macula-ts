/** An opaque Go value's handle (runtime/cgo.Handle), as the addon returns it. */
export type Handle = bigint;
/** What a listener (a subscription, a served procedure, a served stream
 * procedure) is handed, on the event loop: an event or closed notice with its
 * JSON, or a request with the pending call's or stream's handle. */
export interface Delivery {
    readonly kind: "event" | "closed" | "request";
    readonly json: string;
    readonly handle: Handle;
}
export type Listener = (delivery: Delivery) => void;
export declare const native: {
    keyGenerate(profile: string): Promise<Handle>;
    keyLoad(path: string, profile: string): Promise<Handle>;
    keySave(key: Handle, path: string): Promise<void>;
    keyNodeId(key: Handle): Uint8Array;
    keyPublicKey(key: Handle): Uint8Array;
    keyProfile(key: Handle): string;
    keySign(key: Handle, data: Uint8Array): Promise<Uint8Array>;
    keyDeviceRequestProof(key: Handle, realm: Uint8Array, procedure: string, requestJson: string, rule: number): Promise<string>;
    deviceRequestMessage(publicKey: Uint8Array, realm: Uint8Array, procedure: string, timestampMs: number, nonce: Uint8Array, requestJson: string, rule: number): Uint8Array;
    keyFree(key: Handle): void;
    verify(data: Uint8Array, signature: Uint8Array, publicKey: Uint8Array, profile: string): boolean;
    poolConnect(key: Handle, seedsJson: string, optionsJson: string): Promise<Handle>;
    poolClose(pool: Handle): Promise<void>;
    poolNodeId(pool: Handle): Uint8Array;
    poolStatus(pool: Handle): string;
    poolCall(pool: Handle, realm: Uint8Array, procedure: string, payloadJson: string, provider: Uint8Array | null, timeoutMs: number, bytesMode: number): Promise<string>;
    poolProviders(pool: Handle, realm: Uint8Array, procedure: string, timeoutMs: number): Promise<string>;
    poolPublish(pool: Handle, realm: Uint8Array, topic: string, payloadJson: string, ttlMs: number): Promise<void>;
    poolSubscribe(pool: Handle, realm: Uint8Array, topic: string, bytesMode: number, listener: Listener): Promise<Handle>;
    subscriptionStop(subscription: Handle): Promise<void>;
    poolFindRecord(pool: Handle, key: Uint8Array, timeoutMs: number, bytesMode: number): Promise<string>;
    poolFindRecords(pool: Handle, key: Uint8Array, timeoutMs: number, bytesMode: number): Promise<string>;
    poolFindRecordsByType(pool: Handle, type: number, timeoutMs: number, bytesMode: number): Promise<string>;
    poolPutRecord(pool: Handle, wire: Uint8Array, timeoutMs: number): Promise<void>;
    poolShareContent(pool: Handle, realm: Uint8Array, data: Uint8Array, name: string, timeoutMs: number): Promise<Uint8Array>;
    poolUnshareContent(pool: Handle, realm: Uint8Array, mcid: Uint8Array, timeoutMs: number): Promise<void>;
    poolGetContent(pool: Handle, realm: Uint8Array, mcid: Uint8Array, maxBytes: number, maxChunks: number, parallel: number, chunkTimeoutMs: number, timeoutMs: number): Promise<Uint8Array>;
    poolServe(pool: Handle, realm: Uint8Array, procedure: string, bytesMode: number, listener: Listener): Promise<Handle>;
    poolServeStream(pool: Handle, realm: Uint8Array, procedure: string, mode: number, bytesMode: number, listener: Listener): Promise<Handle>;
    pendingReply(pending: Handle, resultJson: string): void;
    pendingError(pending: Handle, message: string): void;
    servedStop(served: Handle): Promise<void>;
    poolOpenStream(pool: Handle, realm: Uint8Array, procedure: string, mode: number, payloadJson: string, provider: Uint8Array | null, deadlineMs: number, timeoutMs: number): Promise<Handle>;
    streamSendBytes(stream: Handle, data: Uint8Array): Promise<void>;
    streamSendJson(stream: Handle, valueJson: string): Promise<void>;
    streamCloseSend(stream: Handle): Promise<void>;
    streamClose(stream: Handle): Promise<void>;
    streamReply(stream: Handle, payloadJson: string): Promise<void>;
    streamAbort(stream: Handle, code: string, message: string): Promise<void>;
    streamRecv(stream: Handle, timeoutMs: number, bytesMode: number): Promise<string>;
    streamRequest(stream: Handle, bytesMode: number): string;
    streamFree(stream: Handle): Promise<void>;
};
