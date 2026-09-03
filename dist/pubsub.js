// Pubsub shapes -- macula-go's connection.Session.Publish/Subscribe/
// Unsubscribe and frame.EventInfo (frame/pubsub.go, connection/
// connection.go, connection/subscriber.go). Session (session.ts) is the
// actual FFI entry point (publish()/subscribe()), matching call()/
// serve()/the DHT methods' own shape -- this file holds the shapes that
// side needs, the same split rpc.ts/dht.ts already have.
export {};
//# sourceMappingURL=pubsub.js.map