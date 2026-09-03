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

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("identityGenerate", Napi::Function::New(env, IdentityGenerate));
  exports.Set("identityFromSeedBytes", Napi::Function::New(env, IdentityFromSeedBytes));
  exports.Set("identityNodeId", Napi::Function::New(env, IdentityNodeId));
  exports.Set("identityPrivateBytes", Napi::Function::New(env, IdentityPrivateBytes));
  exports.Set("identityFree", Napi::Function::New(env, IdentityFree));
  exports.Set("sessionConnect", Napi::Function::New(env, SessionConnect));
  exports.Set("sessionRemoteAddr", Napi::Function::New(env, SessionRemoteAddr));
  exports.Set("sessionStationNodeId", Napi::Function::New(env, SessionStationNodeId));
  exports.Set("sessionClose", Napi::Function::New(env, SessionClose));
  exports.Set("sessionCall", Napi::Function::New(env, SessionCall));
  exports.Set("sessionAdvertise", Napi::Function::New(env, SessionAdvertise));
  exports.Set("sessionUnadvertise", Napi::Function::New(env, SessionUnadvertise));
  exports.Set("serveWaitForCall", Napi::Function::New(env, ServeWaitForCall));
  exports.Set("pendingCallProcedure", Napi::Function::New(env, PendingCallProcedure));
  exports.Set("pendingCallPayloadJson", Napi::Function::New(env, PendingCallPayloadJson));
  exports.Set("pendingCallReplyResult", Napi::Function::New(env, PendingCallReplyResult));
  exports.Set("pendingCallReplyError", Napi::Function::New(env, PendingCallReplyErrorFn));
  return exports;
}

}  // namespace

NODE_API_MODULE(macula_native, Init)
