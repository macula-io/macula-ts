// N-API glue for macula-ts. Purpose-built for exactly the functions
// cabi/main.go exports -- not a generic FFI bridge (that's what koffi
// was, and koffi's own install requires a compile/fetch step on every
// consumer's machine, which is the whole reason this file exists
// instead). libmacula.a is produced by `go build -buildmode=c-archive`
// (see package.json's build:native) and linked statically into this
// addon at build time, so the published .node file is self-contained:
// no separate .so to locate at runtime, no dlopen.
//
// Handle convention (matches cabi/main.go's own doc comment and
// macula-io/macula-php's cabi, which proved this first): an opaque
// Go-side value crosses as a uintptr_t from runtime/cgo.Handle. We
// surface it to JS as a BigInt (not a plain number) specifically to
// avoid silent precision loss -- a JS `number` can only represent
// integers exactly up to 2^53, and nothing here guarantees cgo.Handle
// values stay under that forever. ToHandle() accepts a BigInt or a
// Number from the JS side for convenience, but the addon always
// returns BigInt.
#include <napi.h>

#include <cstdint>
#include <cstring>
#include <string>
#include <unordered_map>

#include "libmacula.h"

namespace {

// cabi/main.go's errOut convention: on failure, *errOut is a
// C.CString-allocated heap string the caller must free via
// macula_free_string. The koffi-era binding.ts never freed it (see
// its own doc comment admitting the leak); this version does, since
// hand-writing the glue means there's no excuse not to.
bool CheckErr(Napi::Env env, char* errOut) {
  if (errOut == nullptr) return true;
  std::string msg(errOut);
  macula_free_string(errOut);
  Napi::Error::New(env, msg).ThrowAsJavaScriptException();
  return false;
}

// Accepts either a JS BigInt or a JS Number (small handles fit in
// either) and returns the underlying uintptr_t. Throws a JS
// TypeError via Napi's own validation helpers on anything else.
uintptr_t ToHandle(const Napi::Env& env, const Napi::Value& v, bool* ok) {
  *ok = true;
  if (v.IsBigInt()) {
    bool lossless = false;
    uint64_t u = v.As<Napi::BigInt>().Uint64Value(&lossless);
    return static_cast<uintptr_t>(u);
  }
  if (v.IsNumber()) {
    double d = v.As<Napi::Number>().DoubleValue();
    return static_cast<uintptr_t>(d);
  }
  *ok = false;
  Napi::TypeError::New(env, "expected a BigInt or Number handle").ThrowAsJavaScriptException();
  return 0;
}

Napi::Value IdentityGenerate(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  char* errOut = nullptr;
  uintptr_t handle = macula_identity_generate(&errOut);
  if (!CheckErr(env, errOut)) return env.Null();
  return Napi::BigInt::New(env, static_cast<uint64_t>(handle));
}

Napi::Value IdentityFromSeedBytes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsTypedArray()) {
    Napi::TypeError::New(env, "expected a 32-byte Uint8Array seed").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Uint8Array seed = info[0].As<Napi::Uint8Array>();
  if (seed.ByteLength() != 32) {
    Napi::RangeError::New(env, "seed must be exactly 32 bytes").ThrowAsJavaScriptException();
    return env.Null();
  }
  char* errOut = nullptr;
  uintptr_t handle = macula_identity_from_seed_bytes(seed.Data(), &errOut);
  if (!CheckErr(env, errOut)) return env.Null();
  return Napi::BigInt::New(env, static_cast<uint64_t>(handle));
}

Napi::Value IdentityNodeId(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  uintptr_t handle = ToHandle(env, info.Length() > 0 ? info[0] : env.Undefined(), &ok);
  if (!ok) return env.Null();

  Napi::Buffer<uint8_t> out = Napi::Buffer<uint8_t>::New(env, 32);
  int rc = macula_identity_node_id(handle, out.Data());
  if (rc != 0) {
    Napi::Error::New(env, "invalid or already-freed identity handle").ThrowAsJavaScriptException();
    return env.Null();
  }
  return out;
}

Napi::Value IdentityPrivateBytes(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  uintptr_t handle = ToHandle(env, info.Length() > 0 ? info[0] : env.Undefined(), &ok);
  if (!ok) return env.Null();

  Napi::Buffer<uint8_t> out = Napi::Buffer<uint8_t>::New(env, 32);
  int rc = macula_identity_private_bytes(handle, out.Data());
  if (rc != 0) {
    Napi::Error::New(env, "invalid or already-freed identity handle").ThrowAsJavaScriptException();
    return env.Null();
  }
  return out;
}

Napi::Value IdentityFree(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  uintptr_t handle = ToHandle(env, info.Length() > 0 ? info[0] : env.Undefined(), &ok);
  if (!ok) return env.Undefined();
  macula_identity_free(handle);
  return env.Undefined();
}

// IdentitySign: a generic Ed25519 signing primitive (cabi/identity_sign.go's
// macula_identity_sign, a direct identity.KeyPair.Sign wrapper). No
// application-specific message format lives here or on the Go side --
// data is signed exactly as given. Pure local computation (ed25519.Sign),
// no network I/O -- synchronous, like IdentityNodeId above, not
// Napi::AsyncWorker-backed.
Napi::Value IdentitySign(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  uintptr_t handle = ToHandle(env, info.Length() > 0 ? info[0] : env.Undefined(), &ok);
  if (!ok) return env.Null();
  if (info.Length() < 2 || !info[1].IsTypedArray()) {
    Napi::TypeError::New(env, "expected (identityHandle, data: Uint8Array)").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Uint8Array data = info[1].As<Napi::Uint8Array>();

  Napi::Buffer<uint8_t> out = Napi::Buffer<uint8_t>::New(env, 64);
  int rc = macula_identity_sign(handle, data.Data(), static_cast<int>(data.ByteLength()), out.Data());
  if (rc != 0) {
    Napi::Error::New(env, "invalid or already-freed identity handle").ThrowAsJavaScriptException();
    return env.Null();
  }
  return out;
}

// Session.connect/close are real network I/O (a QUIC dial plus a
// CONNECT/HELLO round trip, up to macula-go's own 30s handshake
// timeout for connect; a 250ms drain sleep plus a write for close).
// cabi/main.go's exported functions are ordinary blocking C calls --
// they have no async awareness of their own, by design (see their doc
// comments) -- so calling either of them synchronously from here would
// block Node's *entire* event loop for however long the network takes.
// AsyncWorker runs Execute() on a libuv threadpool thread instead of
// the main thread, and cgo handles being entered from a foreign OS
// thread correctly (this is the same reason node-gyp/libuv's
// threadpool exists at all: to give blocking C/C++/cgo calls somewhere
// to run without freezing JS). OnOK/OnError then hop back onto the
// main thread to resolve/reject the Promise, which is the only place
// touching a Napi::Env or V8 handle is safe.

class ConnectWorker : public Napi::AsyncWorker {
 public:
  ConnectWorker(Napi::Env env, Napi::Promise::Deferred deferred, std::string host,
                uint16_t port, uintptr_t identityHandle)
      : Napi::AsyncWorker(env),
        deferred_(deferred),
        host_(std::move(host)),
        port_(port),
        identityHandle_(identityHandle) {}

  void Execute() override {
    char* errOut = nullptr;
    uintptr_t handle =
        macula_session_connect(const_cast<char*>(host_.c_str()), port_, identityHandle_, &errOut);
    if (errOut != nullptr) {
      std::string msg(errOut);
      macula_free_string(errOut);
      SetError(msg);
      return;
    }
    sessionHandle_ = handle;
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    deferred_.Resolve(Napi::BigInt::New(Env(), static_cast<uint64_t>(sessionHandle_)));
  }

  void OnError(const Napi::Error& e) override {
    Napi::HandleScope scope(Env());
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  std::string host_;
  uint16_t port_;
  uintptr_t identityHandle_;
  uintptr_t sessionHandle_ = 0;
};

Napi::Value SessionConnect(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsString() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "expected (host: string, port: number, identityHandle: BigInt|Number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string host = info[0].As<Napi::String>().Utf8Value();
  int32_t port = info[1].As<Napi::Number>().Int32Value();
  if (port < 0 || port > 65535) {
    Napi::RangeError::New(env, "port must be 0-65535").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  bool ok = false;
  uintptr_t identityHandle = ToHandle(env, info[2], &ok);
  if (!ok) return env.Undefined();

  auto deferred = Napi::Promise::Deferred::New(env);
  auto* worker = new ConnectWorker(env, deferred, std::move(host), static_cast<uint16_t>(port), identityHandle);
  worker->Queue();
  return deferred.Promise();
}

Napi::Value SessionRemoteAddr(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  uintptr_t handle = ToHandle(env, info.Length() > 0 ? info[0] : env.Undefined(), &ok);
  if (!ok) return env.Null();

  char* errOut = nullptr;
  char* addr = macula_session_remote_addr(handle, &errOut);
  if (!CheckErr(env, errOut)) return env.Null();
  std::string result(addr);
  macula_free_string(addr);
  return Napi::String::New(env, result);
}

Napi::Value SessionStationNodeId(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  uintptr_t handle = ToHandle(env, info.Length() > 0 ? info[0] : env.Undefined(), &ok);
  if (!ok) return env.Null();

  Napi::Buffer<uint8_t> out = Napi::Buffer<uint8_t>::New(env, 32);
  int rc = macula_session_station_node_id(handle, out.Data());
  if (rc != 0) {
    Napi::Error::New(env, "invalid or already-closed session handle").ThrowAsJavaScriptException();
    return env.Null();
  }
  return out;
}

class CloseWorker : public Napi::AsyncWorker {
 public:
  CloseWorker(Napi::Env env, Napi::Promise::Deferred deferred, uintptr_t sessionHandle,
              uintptr_t identityHandle, std::string reason)
      : Napi::AsyncWorker(env),
        deferred_(deferred),
        sessionHandle_(sessionHandle),
        identityHandle_(identityHandle),
        reason_(std::move(reason)) {}

  void Execute() override {
    char* errOut = nullptr;
    int rc = macula_session_close(sessionHandle_, identityHandle_, const_cast<char*>(reason_.c_str()), &errOut);
    if (errOut != nullptr) {
      std::string msg(errOut);
      macula_free_string(errOut);
      SetError(msg);
      return;
    }
    (void)rc;
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    deferred_.Resolve(Env().Undefined());
  }

  void OnError(const Napi::Error& e) override {
    Napi::HandleScope scope(Env());
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  uintptr_t sessionHandle_;
  uintptr_t identityHandle_;
  std::string reason_;
};

Napi::Value SessionClose(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  uintptr_t sessionHandle = ToHandle(env, info.Length() > 0 ? info[0] : env.Undefined(), &ok);
  if (!ok) return env.Undefined();
  uintptr_t identityHandle = ToHandle(env, info.Length() > 1 ? info[1] : env.Undefined(), &ok);
  if (!ok) return env.Undefined();
  std::string reason = (info.Length() > 2 && info[2].IsString()) ? info[2].As<Napi::String>().Utf8Value() : "";

  auto deferred = Napi::Promise::Deferred::New(env);
  auto* worker = new CloseWorker(env, deferred, sessionHandle, identityHandle, std::move(reason));
  worker->Queue();
  return deferred.Promise();
}

// ---------------------------------------------------------------------
// Unary RPC: caller role (macula_session_call).
// ---------------------------------------------------------------------
//
// A real CALL/RESULT-or-ERROR round trip -- a signed frame out and a
// wait for the matching reply, up to the caller-supplied timeout -- so
// like Connect/Close this must run off Node's main thread. See
// cabi/rpc.go's macula_session_call for the JSON envelope this resolves
// with (the addon does not interpret it -- src/rpc.ts does).

// Reads an optional 32-byte realm out of a JS value: undefined/null
// means "use the default (all-zero) realm", anything else must be a
// 32-byte Uint8Array. realmBuf is the caller-owned 32-byte storage the
// returned pointer aliases into (nullptr when no realm was given) --
// callers keep it alive as a class member for the AsyncWorker's whole
// lifetime, exactly like host_/procedure_/etc. below, since Execute()
// cannot safely touch the original JS Uint8Array off the main thread.
unsigned char* ReadOptionalRealm(const Napi::Env& env, const Napi::Value& v, uint8_t* realmBuf, bool* ok) {
  *ok = true;
  if (v.IsUndefined() || v.IsNull()) return nullptr;
  if (!v.IsTypedArray()) {
    *ok = false;
    Napi::TypeError::New(env, "expected a 32-byte Uint8Array realm, or undefined/null").ThrowAsJavaScriptException();
    return nullptr;
  }
  Napi::Uint8Array arr = v.As<Napi::Uint8Array>();
  if (arr.ByteLength() != 32) {
    *ok = false;
    Napi::RangeError::New(env, "realm must be exactly 32 bytes").ThrowAsJavaScriptException();
    return nullptr;
  }
  std::memcpy(realmBuf, arr.Data(), 32);
  return realmBuf;
}

class SessionCallWorker : public Napi::AsyncWorker {
 public:
  SessionCallWorker(Napi::Env env, Napi::Promise::Deferred deferred, uintptr_t sessionHandle,
                     uintptr_t identityHandle, std::string procedure, bool hasRealm, uint8_t realm[32],
                     std::string payloadJson, int64_t timeoutMs)
      : Napi::AsyncWorker(env),
        deferred_(deferred),
        sessionHandle_(sessionHandle),
        identityHandle_(identityHandle),
        procedure_(std::move(procedure)),
        hasRealm_(hasRealm),
        payloadJson_(std::move(payloadJson)),
        timeoutMs_(timeoutMs) {
    if (hasRealm_) std::memcpy(realm_, realm, 32);
  }

  void Execute() override {
    char* errOut = nullptr;
    char* envelope = macula_session_call(sessionHandle_, identityHandle_, const_cast<char*>(procedure_.c_str()),
                                          hasRealm_ ? realm_ : nullptr, const_cast<char*>(payloadJson_.c_str()),
                                          timeoutMs_, &errOut);
    if (errOut != nullptr) {
      std::string msg(errOut);
      macula_free_string(errOut);
      SetError(msg);
      return;
    }
    envelopeJson_.assign(envelope);
    macula_free_string(envelope);
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    deferred_.Resolve(Napi::String::New(Env(), envelopeJson_));
  }

  void OnError(const Napi::Error& e) override {
    Napi::HandleScope scope(Env());
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  uintptr_t sessionHandle_;
  uintptr_t identityHandle_;
  std::string procedure_;
  bool hasRealm_;
  uint8_t realm_[32] = {0};
  std::string payloadJson_;
  int64_t timeoutMs_;
  std::string envelopeJson_;
};

Napi::Value SessionCall(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 6 || !info[2].IsString() || !info[4].IsString() || !info[5].IsNumber()) {
    Napi::TypeError::New(env, "expected (sessionHandle, identityHandle, procedure: string, realm: "
                               "Uint8Array|undefined, payloadJson: string, timeoutMs: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  bool ok = false;
  uintptr_t sessionHandle = ToHandle(env, info[0], &ok);
  if (!ok) return env.Undefined();
  uintptr_t identityHandle = ToHandle(env, info[1], &ok);
  if (!ok) return env.Undefined();
  std::string procedure = info[2].As<Napi::String>().Utf8Value();
  uint8_t realmBuf[32];
  unsigned char* realmPtr = ReadOptionalRealm(env, info[3], realmBuf, &ok);
  if (!ok) return env.Undefined();
  std::string payloadJson = info[4].As<Napi::String>().Utf8Value();
  int64_t timeoutMs = info[5].As<Napi::Number>().Int64Value();

  auto deferred = Napi::Promise::Deferred::New(env);
  auto* worker = new SessionCallWorker(env, deferred, sessionHandle, identityHandle, std::move(procedure),
                                        realmPtr != nullptr, realmBuf, std::move(payloadJson), timeoutMs);
  worker->Queue();
  return deferred.Promise();
}

// ---------------------------------------------------------------------
// UCAN (cabi/ucan.go): mint/decode are pure local operations (no
// network I/O -- no cgo call here ever blocks on the wire), so both
// call straight into cabi synchronously, the same convention
// IdentityGenerate/IdentityNodeId use above. SessionCallWithUcan is
// SessionCall (above) plus one attached token -- real network I/O, so
// unlike mint/decode it IS Napi::AsyncWorker-backed.
// ---------------------------------------------------------------------

Napi::Value UcanMint(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 9 || !info[1].IsString() || !info[2].IsString() || !info[3].IsString() || !info[6].IsString()) {
    Napi::TypeError::New(env, "expected (identityHandle, issuer: string, audience: string, capabilitiesJson: "
                               "string, expiresAt: number|undefined, notBefore: number|undefined, nonce: string, "
                               "factsJson: string|undefined, proofsJson: string|undefined)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  bool ok = false;
  uintptr_t identityHandle = ToHandle(env, info[0], &ok);
  if (!ok) return env.Undefined();
  std::string issuer = info[1].As<Napi::String>().Utf8Value();
  std::string audience = info[2].As<Napi::String>().Utf8Value();
  std::string capabilitiesJson = info[3].As<Napi::String>().Utf8Value();

  int hasExpiresAt = info[4].IsNumber() ? 1 : 0;
  int64_t expiresAt = hasExpiresAt ? info[4].As<Napi::Number>().Int64Value() : 0;
  int hasNotBefore = info[5].IsNumber() ? 1 : 0;
  int64_t notBefore = hasNotBefore ? info[5].As<Napi::Number>().Int64Value() : 0;

  std::string nonce = info[6].As<Napi::String>().Utf8Value();

  bool hasFacts = info[7].IsString();
  std::string factsJson = hasFacts ? info[7].As<Napi::String>().Utf8Value() : std::string();
  bool hasProofs = info[8].IsString();
  std::string proofsJson = hasProofs ? info[8].As<Napi::String>().Utf8Value() : std::string();

  char* errOut = nullptr;
  char* token = macula_ucan_mint(identityHandle, const_cast<char*>(issuer.c_str()), const_cast<char*>(audience.c_str()),
                                  const_cast<char*>(capabilitiesJson.c_str()), hasExpiresAt, expiresAt, hasNotBefore,
                                  notBefore, const_cast<char*>(nonce.c_str()),
                                  hasFacts ? const_cast<char*>(factsJson.c_str()) : nullptr,
                                  hasProofs ? const_cast<char*>(proofsJson.c_str()) : nullptr, &errOut);
  if (!CheckErr(env, errOut)) return env.Null();
  std::string result(token);
  macula_free_string(token);
  return Napi::String::New(env, result);
}

Napi::Value UcanDecode(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "expected (token: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  std::string token = info[0].As<Napi::String>().Utf8Value();

  char* errOut = nullptr;
  char* json = macula_ucan_decode(const_cast<char*>(token.c_str()), &errOut);
  if (!CheckErr(env, errOut)) return env.Null();
  std::string result(json);
  macula_free_string(json);
  return Napi::String::New(env, result);
}

class SessionCallWithUcanWorker : public Napi::AsyncWorker {
 public:
  SessionCallWithUcanWorker(Napi::Env env, Napi::Promise::Deferred deferred, uintptr_t sessionHandle,
                             uintptr_t identityHandle, std::string procedure, bool hasRealm, uint8_t realm[32],
                             std::string payloadJson, int64_t timeoutMs, std::string ucanToken)
      : Napi::AsyncWorker(env),
        deferred_(deferred),
        sessionHandle_(sessionHandle),
        identityHandle_(identityHandle),
        procedure_(std::move(procedure)),
        hasRealm_(hasRealm),
        payloadJson_(std::move(payloadJson)),
        timeoutMs_(timeoutMs),
        ucanToken_(std::move(ucanToken)) {
    if (hasRealm_) std::memcpy(realm_, realm, 32);
  }

  void Execute() override {
    char* errOut = nullptr;
    char* envelope = macula_session_call_with_ucan(sessionHandle_, identityHandle_, const_cast<char*>(procedure_.c_str()),
                                                     hasRealm_ ? realm_ : nullptr, const_cast<char*>(payloadJson_.c_str()),
                                                     timeoutMs_, const_cast<char*>(ucanToken_.c_str()), &errOut);
    if (errOut != nullptr) {
      std::string msg(errOut);
      macula_free_string(errOut);
      SetError(msg);
      return;
    }
    envelopeJson_.assign(envelope);
    macula_free_string(envelope);
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    deferred_.Resolve(Napi::String::New(Env(), envelopeJson_));
  }

  void OnError(const Napi::Error& e) override {
    Napi::HandleScope scope(Env());
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  uintptr_t sessionHandle_;
  uintptr_t identityHandle_;
  std::string procedure_;
  bool hasRealm_;
  uint8_t realm_[32] = {0};
  std::string payloadJson_;
  int64_t timeoutMs_;
  std::string ucanToken_;
  std::string envelopeJson_;
};

Napi::Value SessionCallWithUcan(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 7 || !info[2].IsString() || !info[4].IsString() || !info[5].IsNumber() || !info[6].IsString()) {
    Napi::TypeError::New(env, "expected (sessionHandle, identityHandle, procedure: string, realm: "
                               "Uint8Array|undefined, payloadJson: string, timeoutMs: number, ucanToken: string)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  bool ok = false;
  uintptr_t sessionHandle = ToHandle(env, info[0], &ok);
  if (!ok) return env.Undefined();
  uintptr_t identityHandle = ToHandle(env, info[1], &ok);
  if (!ok) return env.Undefined();
  std::string procedure = info[2].As<Napi::String>().Utf8Value();
  uint8_t realmBuf[32];
  unsigned char* realmPtr = ReadOptionalRealm(env, info[3], realmBuf, &ok);
  if (!ok) return env.Undefined();
  std::string payloadJson = info[4].As<Napi::String>().Utf8Value();
  int64_t timeoutMs = info[5].As<Napi::Number>().Int64Value();
  std::string ucanToken = info[6].As<Napi::String>().Utf8Value();

  auto deferred = Napi::Promise::Deferred::New(env);
  auto* worker = new SessionCallWithUcanWorker(env, deferred, sessionHandle, identityHandle, std::move(procedure),
                                                realmPtr != nullptr, realmBuf, std::move(payloadJson), timeoutMs,
                                                std::move(ucanToken));
  worker->Queue();
  return deferred.Promise();
}

// ---------------------------------------------------------------------
// Unary RPC: provider role (advertise + serve-wait-for-call + reply).
// ---------------------------------------------------------------------

class SessionAdvertiseWorker : public Napi::AsyncWorker {
 public:
  SessionAdvertiseWorker(Napi::Env env, Napi::Promise::Deferred deferred, uintptr_t sessionHandle,
                          uintptr_t identityHandle, bool hasRealm, uint8_t realm[32], std::string procedure,
                          bool unadvertise)
      : Napi::AsyncWorker(env),
        deferred_(deferred),
        sessionHandle_(sessionHandle),
        identityHandle_(identityHandle),
        hasRealm_(hasRealm),
        procedure_(std::move(procedure)),
        unadvertise_(unadvertise) {
    if (hasRealm_) std::memcpy(realm_, realm, 32);
  }

  void Execute() override {
    char* errOut = nullptr;
    if (unadvertise_) {
      macula_session_unadvertise(sessionHandle_, identityHandle_, hasRealm_ ? realm_ : nullptr,
                                  const_cast<char*>(procedure_.c_str()), &errOut);
    } else {
      macula_session_advertise(sessionHandle_, identityHandle_, hasRealm_ ? realm_ : nullptr,
                                const_cast<char*>(procedure_.c_str()), &errOut);
    }
    if (errOut != nullptr) {
      std::string msg(errOut);
      macula_free_string(errOut);
      SetError(msg);
    }
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    deferred_.Resolve(Env().Undefined());
  }

  void OnError(const Napi::Error& e) override {
    Napi::HandleScope scope(Env());
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  uintptr_t sessionHandle_;
  uintptr_t identityHandle_;
  bool hasRealm_;
  uint8_t realm_[32] = {0};
  std::string procedure_;
  bool unadvertise_;
};

Napi::Value SessionAdvertiseOrUnadvertise(const Napi::CallbackInfo& info, bool unadvertise) {
  Napi::Env env = info.Env();
  if (info.Length() < 4 || !info[3].IsString()) {
    Napi::TypeError::New(env, "expected (sessionHandle, identityHandle, realm: Uint8Array|undefined, procedure: string)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  bool ok = false;
  uintptr_t sessionHandle = ToHandle(env, info[0], &ok);
  if (!ok) return env.Undefined();
  uintptr_t identityHandle = ToHandle(env, info[1], &ok);
  if (!ok) return env.Undefined();
  uint8_t realmBuf[32];
  unsigned char* realmPtr = ReadOptionalRealm(env, info[2], realmBuf, &ok);
  if (!ok) return env.Undefined();
  std::string procedure = info[3].As<Napi::String>().Utf8Value();

  auto deferred = Napi::Promise::Deferred::New(env);
  auto* worker = new SessionAdvertiseWorker(env, deferred, sessionHandle, identityHandle, realmPtr != nullptr,
                                             realmBuf, std::move(procedure), unadvertise);
  worker->Queue();
  return deferred.Promise();
}

Napi::Value SessionAdvertise(const Napi::CallbackInfo& info) { return SessionAdvertiseOrUnadvertise(info, false); }
Napi::Value SessionUnadvertise(const Napi::CallbackInfo& info) { return SessionAdvertiseOrUnadvertise(info, true); }

// ServeWaitForCall resolves with a BigInt pendingCall handle when a
// matching CALL arrived, or `null` when nothing did this tick (a plain
// timeout, or a foreign CALL macula-go already auto-refused on our
// behalf -- see cabi/serve.go's own doc on why those two collapse to
// the same "keep polling" signal rather than being distinguished here).
class ServeWaitForCallWorker : public Napi::AsyncWorker {
 public:
  ServeWaitForCallWorker(Napi::Env env, Napi::Promise::Deferred deferred, uintptr_t sessionHandle,
                          uintptr_t identityHandle, bool hasRealm, uint8_t realm[32], std::string procedure,
                          int64_t timeoutMs)
      : Napi::AsyncWorker(env),
        deferred_(deferred),
        sessionHandle_(sessionHandle),
        identityHandle_(identityHandle),
        hasRealm_(hasRealm),
        procedure_(std::move(procedure)),
        timeoutMs_(timeoutMs) {
    if (hasRealm_) std::memcpy(realm_, realm, 32);
  }

  void Execute() override {
    char* errOut = nullptr;
    int noCall = 0;
    uintptr_t handle = macula_serve_wait_for_call(sessionHandle_, identityHandle_, hasRealm_ ? realm_ : nullptr,
                                                   const_cast<char*>(procedure_.c_str()), timeoutMs_, &noCall,
                                                   &errOut);
    if (errOut != nullptr) {
      std::string msg(errOut);
      macula_free_string(errOut);
      SetError(msg);
      return;
    }
    noCall_ = noCall != 0;
    pendingHandle_ = handle;
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    if (noCall_) {
      deferred_.Resolve(Env().Null());
      return;
    }
    deferred_.Resolve(Napi::BigInt::New(Env(), static_cast<uint64_t>(pendingHandle_)));
  }

  void OnError(const Napi::Error& e) override {
    Napi::HandleScope scope(Env());
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  uintptr_t sessionHandle_;
  uintptr_t identityHandle_;
  bool hasRealm_;
  uint8_t realm_[32] = {0};
  std::string procedure_;
  int64_t timeoutMs_;
  bool noCall_ = false;
  uintptr_t pendingHandle_ = 0;
};

Napi::Value ServeWaitForCall(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 5 || !info[3].IsString() || !info[4].IsNumber()) {
    Napi::TypeError::New(env, "expected (sessionHandle, identityHandle, realm: Uint8Array|undefined, "
                               "procedure: string, timeoutMs: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  bool ok = false;
  uintptr_t sessionHandle = ToHandle(env, info[0], &ok);
  if (!ok) return env.Undefined();
  uintptr_t identityHandle = ToHandle(env, info[1], &ok);
  if (!ok) return env.Undefined();
  uint8_t realmBuf[32];
  unsigned char* realmPtr = ReadOptionalRealm(env, info[2], realmBuf, &ok);
  if (!ok) return env.Undefined();
  std::string procedure = info[3].As<Napi::String>().Utf8Value();
  int64_t timeoutMs = info[4].As<Napi::Number>().Int64Value();

  auto deferred = Napi::Promise::Deferred::New(env);
  auto* worker = new ServeWaitForCallWorker(env, deferred, sessionHandle, identityHandle, realmPtr != nullptr,
                                             realmBuf, std::move(procedure), timeoutMs);
  worker->Queue();
  return deferred.Promise();
}

// macula_pending_call_procedure/_payload_json are local field reads (no
// network I/O) -- safe to call synchronously, matching
// SessionRemoteAddr/SessionStationNodeId's own convention above.

Napi::Value PendingCallProcedure(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  uintptr_t handle = ToHandle(env, info.Length() > 0 ? info[0] : env.Undefined(), &ok);
  if (!ok) return env.Null();

  char* errOut = nullptr;
  char* proc = macula_pending_call_procedure(handle, &errOut);
  if (!CheckErr(env, errOut)) return env.Null();
  std::string result(proc);
  macula_free_string(proc);
  return Napi::String::New(env, result);
}

Napi::Value PendingCallPayloadJson(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  uintptr_t handle = ToHandle(env, info.Length() > 0 ? info[0] : env.Undefined(), &ok);
  if (!ok) return env.Null();

  char* errOut = nullptr;
  char* payload = macula_pending_call_payload_json(handle, &errOut);
  if (!CheckErr(env, errOut)) return env.Null();
  std::string result(payload);
  macula_free_string(payload);
  return Napi::String::New(env, result);
}

// macula_pending_call_reply_result/_error each block until macula-go
// has actually sent the reply frame -- real network I/O, off the main
// thread, same reasoning as ConnectWorker/CloseWorker above.

class PendingCallReplyWorker : public Napi::AsyncWorker {
 public:
  PendingCallReplyWorker(Napi::Env env, Napi::Promise::Deferred deferred, uintptr_t pendingHandle, bool isError,
                          std::string text)
      : Napi::AsyncWorker(env),
        deferred_(deferred),
        pendingHandle_(pendingHandle),
        isError_(isError),
        text_(std::move(text)) {}

  void Execute() override {
    char* errOut = nullptr;
    if (isError_) {
      macula_pending_call_reply_error(pendingHandle_, const_cast<char*>(text_.c_str()), &errOut);
    } else {
      macula_pending_call_reply_result(pendingHandle_, const_cast<char*>(text_.c_str()), &errOut);
    }
    if (errOut != nullptr) {
      std::string msg(errOut);
      macula_free_string(errOut);
      SetError(msg);
    }
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    deferred_.Resolve(Env().Undefined());
  }

  void OnError(const Napi::Error& e) override {
    Napi::HandleScope scope(Env());
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  uintptr_t pendingHandle_;
  bool isError_;
  std::string text_;
};

Napi::Value PendingCallReply(const Napi::CallbackInfo& info, bool isError) {
  Napi::Env env = info.Env();
  bool ok = false;
  uintptr_t handle = ToHandle(env, info.Length() > 0 ? info[0] : env.Undefined(), &ok);
  if (!ok) return env.Undefined();
  std::string text = (info.Length() > 1 && info[1].IsString()) ? info[1].As<Napi::String>().Utf8Value() : "";

  auto deferred = Napi::Promise::Deferred::New(env);
  auto* worker = new PendingCallReplyWorker(env, deferred, handle, isError, std::move(text));
  worker->Queue();
  return deferred.Promise();
}

Napi::Value PendingCallReplyResult(const Napi::CallbackInfo& info) { return PendingCallReply(info, false); }
Napi::Value PendingCallReplyErrorFn(const Napi::CallbackInfo& info) { return PendingCallReply(info, true); }

// ---------------------------------------------------------------------
// DHT records (cabi/dht.go): PutRecord/FindRecord/FindRecords/
// FindRecordsByType. All four are real network I/O (a signed CALL under
// the hood, connection.Session.Call) -- like SessionCall, each runs off
// Node's main thread via Napi::AsyncWorker.
// ---------------------------------------------------------------------

// Reads a MANDATORY 32-byte Uint8Array DHT storage key into out -- a
// DHT key, unlike a realm (ReadOptionalRealm above), has no meaningful
// "use the default" reading, so there's no nil-tolerant counterpart
// here.
void ReadKey32(const Napi::Env& env, const Napi::Value& v, uint8_t* out, bool* ok) {
  *ok = true;
  if (!v.IsTypedArray()) {
    *ok = false;
    Napi::TypeError::New(env, "expected a 32-byte Uint8Array key").ThrowAsJavaScriptException();
    return;
  }
  Napi::Uint8Array arr = v.As<Napi::Uint8Array>();
  if (arr.ByteLength() != 32) {
    *ok = false;
    Napi::RangeError::New(env, "key must be exactly 32 bytes").ThrowAsJavaScriptException();
    return;
  }
  std::memcpy(out, arr.Data(), 32);
}

class DhtFindRecordsByTypeWorker : public Napi::AsyncWorker {
 public:
  DhtFindRecordsByTypeWorker(Napi::Env env, Napi::Promise::Deferred deferred, uintptr_t sessionHandle,
                              uintptr_t identityHandle, uint8_t recordType)
      : Napi::AsyncWorker(env),
        deferred_(deferred),
        sessionHandle_(sessionHandle),
        identityHandle_(identityHandle),
        recordType_(recordType) {}

  void Execute() override {
    char* errOut = nullptr;
    char* json = macula_dht_find_records_by_type(sessionHandle_, identityHandle_, recordType_, &errOut);
    if (errOut != nullptr) {
      std::string msg(errOut);
      macula_free_string(errOut);
      SetError(msg);
      return;
    }
    recordsJson_.assign(json);
    macula_free_string(json);
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    deferred_.Resolve(Napi::String::New(Env(), recordsJson_));
  }

  void OnError(const Napi::Error& e) override {
    Napi::HandleScope scope(Env());
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  uintptr_t sessionHandle_;
  uintptr_t identityHandle_;
  uint8_t recordType_;
  std::string recordsJson_;
};

Napi::Value DhtFindRecordsByType(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[2].IsNumber()) {
    Napi::TypeError::New(env, "expected (sessionHandle, identityHandle, recordType: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  bool ok = false;
  uintptr_t sessionHandle = ToHandle(env, info[0], &ok);
  if (!ok) return env.Undefined();
  uintptr_t identityHandle = ToHandle(env, info[1], &ok);
  if (!ok) return env.Undefined();
  int32_t recordType = info[2].As<Napi::Number>().Int32Value();
  if (recordType < 0 || recordType > 255) {
    Napi::RangeError::New(env, "recordType must be 0-255").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  auto deferred = Napi::Promise::Deferred::New(env);
  auto* worker =
      new DhtFindRecordsByTypeWorker(env, deferred, sessionHandle, identityHandle, static_cast<uint8_t>(recordType));
  worker->Queue();
  return deferred.Promise();
}

class DhtFindRecordsWorker : public Napi::AsyncWorker {
 public:
  DhtFindRecordsWorker(Napi::Env env, Napi::Promise::Deferred deferred, uintptr_t sessionHandle,
                        uintptr_t identityHandle, uint8_t key[32])
      : Napi::AsyncWorker(env), deferred_(deferred), sessionHandle_(sessionHandle), identityHandle_(identityHandle) {
    std::memcpy(key_, key, 32);
  }

  void Execute() override {
    char* errOut = nullptr;
    char* json = macula_dht_find_records(sessionHandle_, identityHandle_, key_, &errOut);
    if (errOut != nullptr) {
      std::string msg(errOut);
      macula_free_string(errOut);
      SetError(msg);
      return;
    }
    recordsJson_.assign(json);
    macula_free_string(json);
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    deferred_.Resolve(Napi::String::New(Env(), recordsJson_));
  }

  void OnError(const Napi::Error& e) override {
    Napi::HandleScope scope(Env());
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  uintptr_t sessionHandle_;
  uintptr_t identityHandle_;
  uint8_t key_[32] = {0};
  std::string recordsJson_;
};

Napi::Value DhtFindRecords(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  uintptr_t sessionHandle = ToHandle(env, info.Length() > 0 ? info[0] : env.Undefined(), &ok);
  if (!ok) return env.Undefined();
  uintptr_t identityHandle = ToHandle(env, info.Length() > 1 ? info[1] : env.Undefined(), &ok);
  if (!ok) return env.Undefined();
  uint8_t key[32];
  ReadKey32(env, info.Length() > 2 ? info[2] : env.Undefined(), key, &ok);
  if (!ok) return env.Undefined();

  auto deferred = Napi::Promise::Deferred::New(env);
  auto* worker = new DhtFindRecordsWorker(env, deferred, sessionHandle, identityHandle, key);
  worker->Queue();
  return deferred.Promise();
}

// DhtFindRecordWorker resolves with `null` (not a rejection) for
// dht.ErrNotFound -- an expected, common outcome, distinguished from a
// real transport-level failure exactly the way ServeWaitForCallWorker's
// noCall_ distinguishes "nothing this tick" from an actual error above.
class DhtFindRecordWorker : public Napi::AsyncWorker {
 public:
  DhtFindRecordWorker(Napi::Env env, Napi::Promise::Deferred deferred, uintptr_t sessionHandle,
                       uintptr_t identityHandle, uint8_t key[32])
      : Napi::AsyncWorker(env), deferred_(deferred), sessionHandle_(sessionHandle), identityHandle_(identityHandle) {
    std::memcpy(key_, key, 32);
  }

  void Execute() override {
    char* errOut = nullptr;
    int notFound = 0;
    char* json = macula_dht_find_record(sessionHandle_, identityHandle_, key_, &notFound, &errOut);
    if (errOut != nullptr) {
      std::string msg(errOut);
      macula_free_string(errOut);
      SetError(msg);
      return;
    }
    notFound_ = notFound != 0;
    if (!notFound_) {
      recordJson_.assign(json);
      macula_free_string(json);
    }
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    if (notFound_) {
      deferred_.Resolve(Env().Null());
      return;
    }
    deferred_.Resolve(Napi::String::New(Env(), recordJson_));
  }

  void OnError(const Napi::Error& e) override {
    Napi::HandleScope scope(Env());
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  uintptr_t sessionHandle_;
  uintptr_t identityHandle_;
  uint8_t key_[32] = {0};
  bool notFound_ = false;
  std::string recordJson_;
};

Napi::Value DhtFindRecord(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  uintptr_t sessionHandle = ToHandle(env, info.Length() > 0 ? info[0] : env.Undefined(), &ok);
  if (!ok) return env.Undefined();
  uintptr_t identityHandle = ToHandle(env, info.Length() > 1 ? info[1] : env.Undefined(), &ok);
  if (!ok) return env.Undefined();
  uint8_t key[32];
  ReadKey32(env, info.Length() > 2 ? info[2] : env.Undefined(), key, &ok);
  if (!ok) return env.Undefined();

  auto deferred = Napi::Promise::Deferred::New(env);
  auto* worker = new DhtFindRecordWorker(env, deferred, sessionHandle, identityHandle, key);
  worker->Queue();
  return deferred.Promise();
}

// macula_dht_put_procedure_advertisement/_content_announcement both
// build via macula-go's REAL constructors (dht.NewProcedureAdvertisement/
// NewContentAnnouncement), not a generic JSON-payload path -- see
// cabi/dht.go's own doc on why a generic put would silently mis-encode
// these types' raw-byte fields. Both are real network I/O (dht.PutRecord
// is a signed CALL under the hood), same threading requirement as
// SessionCall.

class DhtPutProcedureAdvertisementWorker : public Napi::AsyncWorker {
 public:
  DhtPutProcedureAdvertisementWorker(Napi::Env env, Napi::Promise::Deferred deferred, uintptr_t sessionHandle,
                                      uintptr_t identityHandle, bool hasRealm, uint8_t realm[32],
                                      std::string procedure, uint8_t servingStation[32], int64_t ttlMs)
      : Napi::AsyncWorker(env),
        deferred_(deferred),
        sessionHandle_(sessionHandle),
        identityHandle_(identityHandle),
        hasRealm_(hasRealm),
        procedure_(std::move(procedure)),
        ttlMs_(ttlMs) {
    if (hasRealm_) std::memcpy(realm_, realm, 32);
    std::memcpy(servingStation_, servingStation, 32);
  }

  void Execute() override {
    char* errOut = nullptr;
    char* json = macula_dht_put_procedure_advertisement(sessionHandle_, identityHandle_, hasRealm_ ? realm_ : nullptr,
                                                          const_cast<char*>(procedure_.c_str()), servingStation_,
                                                          ttlMs_, &errOut);
    if (errOut != nullptr) {
      std::string msg(errOut);
      macula_free_string(errOut);
      SetError(msg);
      return;
    }
    recordJson_.assign(json);
    macula_free_string(json);
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    deferred_.Resolve(Napi::String::New(Env(), recordJson_));
  }

  void OnError(const Napi::Error& e) override {
    Napi::HandleScope scope(Env());
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  uintptr_t sessionHandle_;
  uintptr_t identityHandle_;
  bool hasRealm_;
  uint8_t realm_[32] = {0};
  std::string procedure_;
  uint8_t servingStation_[32] = {0};
  int64_t ttlMs_;
  std::string recordJson_;
};

Napi::Value DhtPutProcedureAdvertisement(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 6 || !info[3].IsString() || !info[5].IsNumber()) {
    Napi::TypeError::New(env, "expected (sessionHandle, identityHandle, realm: Uint8Array|undefined, procedure: "
                               "string, servingStation: Uint8Array, ttlMs: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  bool ok = false;
  uintptr_t sessionHandle = ToHandle(env, info[0], &ok);
  if (!ok) return env.Undefined();
  uintptr_t identityHandle = ToHandle(env, info[1], &ok);
  if (!ok) return env.Undefined();
  uint8_t realmBuf[32];
  unsigned char* realmPtr = ReadOptionalRealm(env, info[2], realmBuf, &ok);
  if (!ok) return env.Undefined();
  std::string procedure = info[3].As<Napi::String>().Utf8Value();
  uint8_t servingStation[32];
  ReadKey32(env, info[4], servingStation, &ok);
  if (!ok) return env.Undefined();
  int64_t ttlMs = info[5].As<Napi::Number>().Int64Value();

  auto deferred = Napi::Promise::Deferred::New(env);
  auto* worker = new DhtPutProcedureAdvertisementWorker(env, deferred, sessionHandle, identityHandle,
                                                          realmPtr != nullptr, realmBuf, std::move(procedure),
                                                          servingStation, ttlMs);
  worker->Queue();
  return deferred.Promise();
}

class DhtPutContentAnnouncementWorker : public Napi::AsyncWorker {
 public:
  DhtPutContentAnnouncementWorker(Napi::Env env, Napi::Promise::Deferred deferred, uintptr_t sessionHandle,
                                   uintptr_t identityHandle, uint8_t mcid[34], std::string endpoint, int64_t ttlMs)
      : Napi::AsyncWorker(env),
        deferred_(deferred),
        sessionHandle_(sessionHandle),
        identityHandle_(identityHandle),
        endpoint_(std::move(endpoint)),
        ttlMs_(ttlMs) {
    std::memcpy(mcid_, mcid, 34);
  }

  void Execute() override {
    char* errOut = nullptr;
    char* json = macula_dht_put_content_announcement(sessionHandle_, identityHandle_, mcid_,
                                                       const_cast<char*>(endpoint_.c_str()), ttlMs_, &errOut);
    if (errOut != nullptr) {
      std::string msg(errOut);
      macula_free_string(errOut);
      SetError(msg);
      return;
    }
    recordJson_.assign(json);
    macula_free_string(json);
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    deferred_.Resolve(Napi::String::New(Env(), recordJson_));
  }

  void OnError(const Napi::Error& e) override {
    Napi::HandleScope scope(Env());
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  uintptr_t sessionHandle_;
  uintptr_t identityHandle_;
  uint8_t mcid_[34] = {0};
  std::string endpoint_;
  int64_t ttlMs_;
  std::string recordJson_;
};

Napi::Value DhtPutContentAnnouncement(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4 || !info[3].IsString()) {
    Napi::TypeError::New(env, "expected (sessionHandle, identityHandle, mcid: 34-byte Uint8Array, endpoint: "
                               "string, ttlMs: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  bool ok = false;
  uintptr_t sessionHandle = ToHandle(env, info[0], &ok);
  if (!ok) return env.Undefined();
  uintptr_t identityHandle = ToHandle(env, info[1], &ok);
  if (!ok) return env.Undefined();
  if (!info[2].IsTypedArray() || info[2].As<Napi::Uint8Array>().ByteLength() != 34) {
    Napi::RangeError::New(env, "mcid must be exactly 34 bytes").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  uint8_t mcid[34];
  std::memcpy(mcid, info[2].As<Napi::Uint8Array>().Data(), 34);
  std::string endpoint = info[3].As<Napi::String>().Utf8Value();
  int64_t ttlMs = info.Length() > 4 && info[4].IsNumber() ? info[4].As<Napi::Number>().Int64Value() : 0;

  auto deferred = Napi::Promise::Deferred::New(env);
  auto* worker =
      new DhtPutContentAnnouncementWorker(env, deferred, sessionHandle, identityHandle, mcid, std::move(endpoint), ttlMs);
  worker->Queue();
  return deferred.Promise();
}

// ---------------------------------------------------------------------
// Pubsub (cabi/pubsub.go): publish (fire-and-forget, same worker shape
// as SessionAdvertiseWorker above) and a subscribe/stop pair -- the
// first place in this addon where Go calls back INTO JS on its own
// schedule rather than only ever answering a JS-initiated request (see
// cabi/pubsub.go's own doc for why: events arrive whenever a publisher
// publishes, not in response to anything this session did).
// ---------------------------------------------------------------------

class SessionPublishWorker : public Napi::AsyncWorker {
 public:
  SessionPublishWorker(Napi::Env env, Napi::Promise::Deferred deferred, uintptr_t sessionHandle,
                        uintptr_t identityHandle, bool hasRealm, uint8_t realm[32], std::string topic,
                        std::string payloadJson, int64_t ttlMs)
      : Napi::AsyncWorker(env),
        deferred_(deferred),
        sessionHandle_(sessionHandle),
        identityHandle_(identityHandle),
        hasRealm_(hasRealm),
        topic_(std::move(topic)),
        payloadJson_(std::move(payloadJson)),
        ttlMs_(ttlMs) {
    if (hasRealm_) std::memcpy(realm_, realm, 32);
  }

  void Execute() override {
    char* errOut = nullptr;
    macula_session_publish(sessionHandle_, identityHandle_, hasRealm_ ? realm_ : nullptr,
                            const_cast<char*>(topic_.c_str()), const_cast<char*>(payloadJson_.c_str()), ttlMs_,
                            &errOut);
    if (errOut != nullptr) {
      std::string msg(errOut);
      macula_free_string(errOut);
      SetError(msg);
    }
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    deferred_.Resolve(Env().Undefined());
  }

  void OnError(const Napi::Error& e) override {
    Napi::HandleScope scope(Env());
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  uintptr_t sessionHandle_;
  uintptr_t identityHandle_;
  bool hasRealm_;
  uint8_t realm_[32] = {0};
  std::string topic_;
  std::string payloadJson_;
  int64_t ttlMs_;
};

Napi::Value SessionPublish(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 6 || !info[3].IsString() || !info[4].IsString() || !info[5].IsNumber()) {
    Napi::TypeError::New(env, "expected (sessionHandle, identityHandle, realm: Uint8Array|undefined, topic: "
                               "string, payloadJson: string, ttlMs: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  bool ok = false;
  uintptr_t sessionHandle = ToHandle(env, info[0], &ok);
  if (!ok) return env.Undefined();
  uintptr_t identityHandle = ToHandle(env, info[1], &ok);
  if (!ok) return env.Undefined();
  uint8_t realmBuf[32];
  unsigned char* realmPtr = ReadOptionalRealm(env, info[2], realmBuf, &ok);
  if (!ok) return env.Undefined();
  std::string topic = info[3].As<Napi::String>().Utf8Value();
  std::string payloadJson = info[4].As<Napi::String>().Utf8Value();
  int64_t ttlMs = info[5].As<Napi::Number>().Int64Value();

  auto deferred = Napi::Promise::Deferred::New(env);
  auto* worker = new SessionPublishWorker(env, deferred, sessionHandle, identityHandle, realmPtr != nullptr, realmBuf,
                                           std::move(topic), std::move(payloadJson), ttlMs);
  worker->Queue();
  return deferred.Promise();
}

// SubscriptionContext bridges one Go-side subscription (keyed by its own
// Go subscriptionHandle in g_subscriptions below) to one JS handler
// function, via a ThreadSafeFunction the Go-side background reader
// goroutine calls into from its own OS thread -- the cross-thread call
// TSFN exists for. Owns the TSFN for exactly this subscription's
// lifetime: created just before macula_session_subscribe_start is
// invoked, released only once macula_session_subscribe_stop confirms
// the Go-side goroutine has actually exited (SessionSubscribeStopWorker)
// -- releasing any earlier would risk OnMaculaEvent firing into a TSFN
// that's already gone.
struct SubscriptionContext {
  Napi::ThreadSafeFunction tsfn;
};

// g_subscriptions maps a Go subscriptionHandle to the SubscriptionContext
// created for it, so SessionSubscribeStop (given only the handle JS
// holds) can find the TSFN to release. Only ever touched from Node's
// main thread (SessionSubscribeStartWorker::OnOK inserts,
// SessionSubscribeStop's setup function erases before queuing its own
// worker) -- never from the background goroutine's OS thread, which
// only ever reaches OnMaculaEvent below -- so this needs no locking.
std::unordered_map<uintptr_t, SubscriptionContext*> g_subscriptions;

// EventCallbackData is heap-allocated per delivered event and freed by
// the TSFN's own JS-thread callback below -- the node-addon-api
// convention for NonBlockingCall's per-call data argument.
struct EventCallbackData {
  std::string topic;
  uint8_t publisher[32];
  uint64_t seq;
  std::string payloadJson;
};

// OnMaculaEvent is the raw C function cabi/pubsub.go's
// callEventCallback trampoline calls, from the background reader
// goroutine's own OS thread -- extern "C" linkage so it matches
// macula_event_callback's typedef exactly (see libmacula.h, generated
// from that file's cgo preamble). Must never touch a Napi::Env or V8
// handle directly (unsafe off the main thread, see every AsyncWorker
// above for the same rule) -- it only copies the event's data and hands
// it to NonBlockingCall, which is the one thing a foreign thread may
// safely do with a ThreadSafeFunction. The actual JS call happens in the
// lambda below, on the main thread, once libuv gets to it.
extern "C" void OnMaculaEvent(void* user_data, const char* topic, const unsigned char* publisher32,
                               unsigned long long seq, const char* payload_json) {
  auto* ctx = static_cast<SubscriptionContext*>(user_data);
  auto* data = new EventCallbackData();
  data->topic.assign(topic);
  std::memcpy(data->publisher, publisher32, 32);
  data->seq = static_cast<uint64_t>(seq);
  data->payloadJson.assign(payload_json);

  napi_status status = ctx->tsfn.NonBlockingCall(
      data, [](Napi::Env env, Napi::Function jsCallback, EventCallbackData* d) {
        Napi::Object evt = Napi::Object::New(env);
        evt.Set("kind", Napi::String::New(env, "event"));
        evt.Set("topic", Napi::String::New(env, d->topic));
        evt.Set("publisher", Napi::Buffer<uint8_t>::Copy(env, d->publisher, 32));
        evt.Set("seq", Napi::Number::New(env, static_cast<double>(d->seq)));
        evt.Set("payloadJson", Napi::String::New(env, d->payloadJson));
        jsCallback.Call({evt});
        delete d;
      });
  if (status != napi_ok) {
    // The subscription is mid-teardown (TSFN already released/closing)
    // or its queue is full -- either way this one event is dropped, not
    // fatal; NonBlockingCall did not take ownership of data on a
    // non-ok status, so this side must free it.
    delete data;
  }
}

// ClosedCallbackData/OnMaculaSubscriptionClosed mirror EventCallbackData/
// OnMaculaEvent immediately above exactly, for the "this subscription's
// background reader exited on its own" signal cabi/pubsub.go's
// macula_subscription_closed_callback delivers (see that file's own doc
// for why this exists at all -- without it, a subscription whose
// connection died left the JS side silently waiting forever). Delivered
// through the SAME ThreadSafeFunction as ordinary events, distinguished
// on the JS side by the `kind` field (see session.ts's subscribe()) --
// deliberately not a second TSFN: it is the identical JS handler
// function underneath either way, and reusing the one TSFN needs no new
// lifetime reasoning beyond what SubscriptionContext already has.
struct ClosedCallbackData {
  std::string errorMessage;
};

extern "C" void OnMaculaSubscriptionClosed(void* user_data, const char* err_message) {
  auto* ctx = static_cast<SubscriptionContext*>(user_data);
  auto* data = new ClosedCallbackData();
  // err_message is never NULL from the one Go-side call site (see
  // cabi/pubsub.go's deliverClosed), but guard anyway rather than
  // assume a C string invariant across the FFI boundary.
  data->errorMessage.assign(err_message != nullptr ? err_message : "subscription closed");

  napi_status status = ctx->tsfn.NonBlockingCall(
      data, [](Napi::Env env, Napi::Function jsCallback, ClosedCallbackData* d) {
        Napi::Object evt = Napi::Object::New(env);
        evt.Set("kind", Napi::String::New(env, "closed"));
        evt.Set("error", Napi::String::New(env, d->errorMessage));
        jsCallback.Call({evt});
        delete d;
      });
  if (status != napi_ok) {
    delete data;
  }
}

class SessionSubscribeStartWorker : public Napi::AsyncWorker {
 public:
  SessionSubscribeStartWorker(Napi::Env env, Napi::Promise::Deferred deferred, uintptr_t sessionHandle,
                               uintptr_t identityHandle, bool hasRealm, uint8_t realm[32], std::string topic,
                               SubscriptionContext* ctx)
      : Napi::AsyncWorker(env),
        deferred_(deferred),
        sessionHandle_(sessionHandle),
        identityHandle_(identityHandle),
        hasRealm_(hasRealm),
        topic_(std::move(topic)),
        ctx_(ctx) {
    if (hasRealm_) std::memcpy(realm_, realm, 32);
  }

  void Execute() override {
    char* errOut = nullptr;
    uintptr_t handle = macula_session_subscribe_start(sessionHandle_, identityHandle_, hasRealm_ ? realm_ : nullptr,
                                                        const_cast<char*>(topic_.c_str()), OnMaculaEvent,
                                                        OnMaculaSubscriptionClosed, static_cast<void*>(ctx_), &errOut);
    if (errOut != nullptr) {
      std::string msg(errOut);
      macula_free_string(errOut);
      SetError(msg);
      return;
    }
    subscriptionHandle_ = handle;
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    g_subscriptions[subscriptionHandle_] = ctx_;
    deferred_.Resolve(Napi::BigInt::New(Env(), static_cast<uint64_t>(subscriptionHandle_)));
  }

  void OnError(const Napi::Error& e) override {
    Napi::HandleScope scope(Env());
    // Startup itself failed (a garbage handle, most likely) -- this
    // subscription never started on the Go side and never will, so its
    // TSFN would otherwise leak: nothing ever reaches
    // SessionSubscribeStop for a subscribe() call that itself threw.
    ctx_->tsfn.Release();
    delete ctx_;
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  uintptr_t sessionHandle_;
  uintptr_t identityHandle_;
  bool hasRealm_;
  uint8_t realm_[32] = {0};
  std::string topic_;
  SubscriptionContext* ctx_;
  uintptr_t subscriptionHandle_ = 0;
};

Napi::Value SessionSubscribeStart(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 5 || !info[3].IsString() || !info[4].IsFunction()) {
    Napi::TypeError::New(env, "expected (sessionHandle, identityHandle, realm: Uint8Array|undefined, topic: "
                               "string, onEvent: Function)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  bool ok = false;
  uintptr_t sessionHandle = ToHandle(env, info[0], &ok);
  if (!ok) return env.Undefined();
  uintptr_t identityHandle = ToHandle(env, info[1], &ok);
  if (!ok) return env.Undefined();
  uint8_t realmBuf[32];
  unsigned char* realmPtr = ReadOptionalRealm(env, info[2], realmBuf, &ok);
  if (!ok) return env.Undefined();
  std::string topic = info[3].As<Napi::String>().Utf8Value();

  auto* ctx = new SubscriptionContext();
  ctx->tsfn = Napi::ThreadSafeFunction::New(env, info[4].As<Napi::Function>(), "macula_event_callback",
                                             0 /* unlimited queue */, 1 /* one initial thread reference */);

  auto deferred = Napi::Promise::Deferred::New(env);
  auto* worker = new SessionSubscribeStartWorker(env, deferred, sessionHandle, identityHandle, realmPtr != nullptr,
                                                  realmBuf, std::move(topic), ctx);
  worker->Queue();
  return deferred.Promise();
}

class SessionSubscribeStopWorker : public Napi::AsyncWorker {
 public:
  SessionSubscribeStopWorker(Napi::Env env, Napi::Promise::Deferred deferred, uintptr_t subscriptionHandle,
                              SubscriptionContext* ctx)
      : Napi::AsyncWorker(env), deferred_(deferred), subscriptionHandle_(subscriptionHandle), ctx_(ctx) {}

  void Execute() override {
    char* errOut = nullptr;
    macula_session_subscribe_stop(subscriptionHandle_, &errOut);
    if (errOut != nullptr) {
      std::string msg(errOut);
      macula_free_string(errOut);
      SetError(msg);
    }
  }

  // macula_session_subscribe_stop (Execute, above) only returns once the
  // Go-side background goroutine has actually exited -- see its own doc
  // -- so no further OnMaculaEvent call for ctx_ can be in flight past
  // this point; only now is it safe to release the TSFN and free ctx_.
  // Both OnOK and OnError reach this same state (stopped, one way or
  // another) so both release identically.

  void OnOK() override {
    Napi::HandleScope scope(Env());
    ctx_->tsfn.Release();
    delete ctx_;
    deferred_.Resolve(Env().Undefined());
  }

  void OnError(const Napi::Error& e) override {
    Napi::HandleScope scope(Env());
    ctx_->tsfn.Release();
    delete ctx_;
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  uintptr_t subscriptionHandle_;
  SubscriptionContext* ctx_;
};

Napi::Value SessionSubscribeStop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  uintptr_t subscriptionHandle = ToHandle(env, info.Length() > 0 ? info[0] : env.Undefined(), &ok);
  if (!ok) return env.Undefined();

  auto it = g_subscriptions.find(subscriptionHandle);
  if (it == g_subscriptions.end()) {
    Napi::Error::New(env, "macula-ts: unknown or already-stopped subscription handle").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  SubscriptionContext* ctx = it->second;
  g_subscriptions.erase(it);

  auto deferred = Napi::Promise::Deferred::New(env);
  auto* worker = new SessionSubscribeStopWorker(env, deferred, subscriptionHandle, ctx);
  worker->Queue();
  return deferred.Promise();
}

// ---------------------------------------------------------------------
// Content transfer (cabi/content.go): putContent/getContent. Each opens
// its OWN dedicated QUIC stream on the Go side (content.Put/Get ->
// Session.OpenDedicatedStream) -- separate from the shared control
// stream every worker above reads from -- so, unlike SessionCall/
// ServeWaitForCall/the DHT methods/subscribe, these never need a
// same-Session exclusivity guard on the TypeScript side, and two
// concurrent calls here don't race each other either. Real network I/O
// either way (one or more signed CALLs on the new stream) -- still off
// Node's main thread via Napi::AsyncWorker, same as everything else.
// ---------------------------------------------------------------------

class ContentPutWorker : public Napi::AsyncWorker {
 public:
  ContentPutWorker(Napi::Env env, Napi::Promise::Deferred deferred, uintptr_t sessionHandle,
                    uintptr_t identityHandle, std::string data, std::string name)
      : Napi::AsyncWorker(env),
        deferred_(deferred),
        sessionHandle_(sessionHandle),
        identityHandle_(identityHandle),
        data_(std::move(data)),
        name_(std::move(name)) {}

  void Execute() override {
    char* errOut = nullptr;
    char* mcidHex = macula_content_put(sessionHandle_, identityHandle_,
                                        reinterpret_cast<unsigned char*>(const_cast<char*>(data_.data())),
                                        static_cast<int>(data_.size()), const_cast<char*>(name_.c_str()), &errOut);
    if (errOut != nullptr) {
      std::string msg(errOut);
      macula_free_string(errOut);
      SetError(msg);
      return;
    }
    mcidHex_.assign(mcidHex);
    macula_free_string(mcidHex);
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    deferred_.Resolve(Napi::String::New(Env(), mcidHex_));
  }

  void OnError(const Napi::Error& e) override {
    Napi::HandleScope scope(Env());
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  uintptr_t sessionHandle_;
  uintptr_t identityHandle_;
  std::string data_;
  std::string name_;
  std::string mcidHex_;
};

Napi::Value ContentPut(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[2].IsTypedArray()) {
    Napi::TypeError::New(env, "expected (sessionHandle, identityHandle, data: Uint8Array, name?: string)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  bool ok = false;
  uintptr_t sessionHandle = ToHandle(env, info[0], &ok);
  if (!ok) return env.Undefined();
  uintptr_t identityHandle = ToHandle(env, info[1], &ok);
  if (!ok) return env.Undefined();
  Napi::Uint8Array arr = info[2].As<Napi::Uint8Array>();
  // Copied into a std::string (binary-safe: std::string tolerates
  // embedded NULs and arbitrary bytes) on the main thread -- Execute()
  // runs on a libuv threadpool thread and must never touch the original
  // JS TypedArray, same rule ReadOptionalRealm's own doc states above.
  std::string data(reinterpret_cast<const char*>(arr.Data()), arr.ByteLength());
  std::string name = (info.Length() > 3 && info[3].IsString()) ? info[3].As<Napi::String>().Utf8Value() : "";

  auto deferred = Napi::Promise::Deferred::New(env);
  auto* worker = new ContentPutWorker(env, deferred, sessionHandle, identityHandle, std::move(data), std::move(name));
  worker->Queue();
  return deferred.Promise();
}

// ContentGetWorker resolves with `null` (not a rejection) for
// content.ErrNotFound -- an expected, routine outcome for a transfer
// mechanism with no durability guarantee -- exactly the way
// DhtFindRecordWorker's own notFound_ distinguishes "not found" from a
// real transport-level failure above.
class ContentGetWorker : public Napi::AsyncWorker {
 public:
  ContentGetWorker(Napi::Env env, Napi::Promise::Deferred deferred, uintptr_t sessionHandle,
                    uintptr_t identityHandle, std::string mcidHex)
      : Napi::AsyncWorker(env),
        deferred_(deferred),
        sessionHandle_(sessionHandle),
        identityHandle_(identityHandle),
        mcidHex_(std::move(mcidHex)) {}

  void Execute() override {
    char* errOut = nullptr;
    int outLen = 0;
    int notFound = 0;
    unsigned char* data = macula_content_get(sessionHandle_, identityHandle_, const_cast<char*>(mcidHex_.c_str()),
                                              &outLen, &notFound, &errOut);
    if (errOut != nullptr) {
      std::string msg(errOut);
      macula_free_string(errOut);
      SetError(msg);
      return;
    }
    notFound_ = notFound != 0;
    if (!notFound_) {
      data_.assign(reinterpret_cast<char*>(data), static_cast<size_t>(outLen));
      macula_free_bytes(data);
    }
  }

  void OnOK() override {
    Napi::HandleScope scope(Env());
    if (notFound_) {
      deferred_.Resolve(Env().Null());
      return;
    }
    deferred_.Resolve(
        Napi::Buffer<uint8_t>::Copy(Env(), reinterpret_cast<const uint8_t*>(data_.data()), data_.size()));
  }

  void OnError(const Napi::Error& e) override {
    Napi::HandleScope scope(Env());
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  uintptr_t sessionHandle_;
  uintptr_t identityHandle_;
  std::string mcidHex_;
  bool notFound_ = false;
  std::string data_;
};

Napi::Value ContentGet(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[2].IsString()) {
    Napi::TypeError::New(env, "expected (sessionHandle, identityHandle, mcidHex: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  bool ok = false;
  uintptr_t sessionHandle = ToHandle(env, info[0], &ok);
  if (!ok) return env.Undefined();
  uintptr_t identityHandle = ToHandle(env, info[1], &ok);
  if (!ok) return env.Undefined();
  std::string mcidHex = info[2].As<Napi::String>().Utf8Value();

  auto deferred = Napi::Promise::Deferred::New(env);
  auto* worker = new ContentGetWorker(env, deferred, sessionHandle, identityHandle, std::move(mcidHex));
  worker->Queue();
  return deferred.Promise();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("identityGenerate", Napi::Function::New(env, IdentityGenerate));
  exports.Set("identityFromSeedBytes", Napi::Function::New(env, IdentityFromSeedBytes));
  exports.Set("identityNodeId", Napi::Function::New(env, IdentityNodeId));
  exports.Set("identityPrivateBytes", Napi::Function::New(env, IdentityPrivateBytes));
  exports.Set("identityFree", Napi::Function::New(env, IdentityFree));
  exports.Set("identitySign", Napi::Function::New(env, IdentitySign));
  exports.Set("sessionConnect", Napi::Function::New(env, SessionConnect));
  exports.Set("sessionRemoteAddr", Napi::Function::New(env, SessionRemoteAddr));
  exports.Set("sessionStationNodeId", Napi::Function::New(env, SessionStationNodeId));
  exports.Set("sessionClose", Napi::Function::New(env, SessionClose));
  exports.Set("sessionCall", Napi::Function::New(env, SessionCall));
  exports.Set("ucanMint", Napi::Function::New(env, UcanMint));
  exports.Set("ucanDecode", Napi::Function::New(env, UcanDecode));
  exports.Set("sessionCallWithUcan", Napi::Function::New(env, SessionCallWithUcan));
  exports.Set("sessionAdvertise", Napi::Function::New(env, SessionAdvertise));
  exports.Set("sessionUnadvertise", Napi::Function::New(env, SessionUnadvertise));
  exports.Set("serveWaitForCall", Napi::Function::New(env, ServeWaitForCall));
  exports.Set("pendingCallProcedure", Napi::Function::New(env, PendingCallProcedure));
  exports.Set("pendingCallPayloadJson", Napi::Function::New(env, PendingCallPayloadJson));
  exports.Set("pendingCallReplyResult", Napi::Function::New(env, PendingCallReplyResult));
  exports.Set("pendingCallReplyError", Napi::Function::New(env, PendingCallReplyErrorFn));
  exports.Set("dhtFindRecordsByType", Napi::Function::New(env, DhtFindRecordsByType));
  exports.Set("dhtFindRecords", Napi::Function::New(env, DhtFindRecords));
  exports.Set("dhtFindRecord", Napi::Function::New(env, DhtFindRecord));
  exports.Set("dhtPutProcedureAdvertisement", Napi::Function::New(env, DhtPutProcedureAdvertisement));
  exports.Set("dhtPutContentAnnouncement", Napi::Function::New(env, DhtPutContentAnnouncement));
  exports.Set("sessionPublish", Napi::Function::New(env, SessionPublish));
  exports.Set("sessionSubscribeStart", Napi::Function::New(env, SessionSubscribeStart));
  exports.Set("sessionSubscribeStop", Napi::Function::New(env, SessionSubscribeStop));
  exports.Set("contentPut", Napi::Function::New(env, ContentPut));
  exports.Set("contentGet", Napi::Function::New(env, ContentGet));
  return exports;
}

}  // namespace

NODE_API_MODULE(macula_native, Init)
