// DHT record shapes -- macula-go's dht package (FindRecord/FindRecords/
// FindRecordsByType/PutRecord), thin CALL wrappers to the mesh's own
// reserved `_dht.*` procedures under the DHT's own all-zero realm
// (threaded internally by macula-go's dht package, never passed from
// here -- see cabi/dht.go). Session (session.ts) is the actual FFI
// entry point for these, matching call()/serve()'s own shape (a
// Session-bound method, using that Session's own retained Identity to
// sign); this file holds the shapes both directions share, the same
// split rpc.ts has for call()/serve().
/** Record type tags -- macula-go's dht.Type* constants (dht/record.go).
 * There is no client-side constructor for StationEndpoint in macula-go
 * (stations publish those themselves, not clients) -- it's listed here
 * because Session.findRecord/findRecords/findRecordsByType can still
 * return one, not because a Session.putRecord* method can build one. */
export var DhtRecordType;
(function (DhtRecordType) {
    DhtRecordType[DhtRecordType["ProcedureAdvertisement"] = 6] = "ProcedureAdvertisement";
    DhtRecordType[DhtRecordType["ContentAnnouncement"] = 17] = "ContentAnnouncement";
    DhtRecordType[DhtRecordType["StationEndpoint"] = 18] = "StationEndpoint";
})(DhtRecordType || (DhtRecordType = {}));
/** Default TTL for a record built by Session.putProcedureAdvertisement()/
 * putContentAnnouncement() when the caller doesn't specify one --
 * matches macula-go's dht.DefaultTTL (48h). */
export const DHT_DEFAULT_TTL_MS = 48 * 60 * 60 * 1000;
//# sourceMappingURL=dht.js.map