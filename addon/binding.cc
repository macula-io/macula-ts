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

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("identityGenerate", Napi::Function::New(env, IdentityGenerate));
  exports.Set("identityFromSeedBytes", Napi::Function::New(env, IdentityFromSeedBytes));
  exports.Set("identityNodeId", Napi::Function::New(env, IdentityNodeId));
  exports.Set("identityPrivateBytes", Napi::Function::New(env, IdentityPrivateBytes));
  exports.Set("identityFree", Napi::Function::New(env, IdentityFree));
  return exports;
}

}  // namespace

NODE_API_MODULE(macula_native, Init)
