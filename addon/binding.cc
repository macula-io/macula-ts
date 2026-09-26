// N-API glue for macula-ts, purpose-built for exactly the functions cabi/
// exports over macula-go's macula 12 API. libmacula.a (go build
// -buildmode=c-archive) is linked statically into this addon, so the published
// .node file is self-contained.
//
// Handles: a Go value crosses as a uintptr_t from runtime/cgo.Handle, surfaced
// to JS as a BigInt so no precision is lost; ToHandle also accepts a Number.
//
// Threads: every call that does network I/O, or may wait on QUIC flow control,
// runs on a worker thread through Job, a single Napi::AsyncWorker that returns
// a Promise; nothing blocks the event loop. Events, served calls and served
// streams arrive on Go threads and reach JS through a ThreadSafeFunction per
// listener; the C trampolines below only copy data and queue it.
//
// Errors: cabi's err_out strings are freed here and become rejected Promises
// (or thrown errors for the few synchronous calls).
#include <napi.h>

#include <cstdint>
#include <cstring>
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "libmacula.h"

namespace {

// TakeErr moves a cabi error string into a std::string and frees it; empty
// when there was none.
std::string TakeErr(char* errOut) {
  if (errOut == nullptr) return std::string();
  std::string msg(errOut);
  macula_free_string(errOut);
  return msg;
}

std::string TakeString(char* s) {
  if (s == nullptr) return std::string();
  std::string out(s);
  macula_free_string(s);
  return out;
}

bool ThrowIfErr(Napi::Env env, char* errOut) {
  std::string msg = TakeErr(errOut);
  if (msg.empty()) return false;
  Napi::Error::New(env, msg).ThrowAsJavaScriptException();
  return true;
}

uintptr_t ToHandle(const Napi::Env& env, const Napi::Value& v, bool* ok) {
  *ok = true;
  if (v.IsBigInt()) {
    bool lossless = false;
    return static_cast<uintptr_t>(v.As<Napi::BigInt>().Uint64Value(&lossless));
  }
  if (v.IsNumber()) return static_cast<uintptr_t>(v.As<Napi::Number>().Int64Value());
  *ok = false;
  Napi::TypeError::New(env, "expected a BigInt or Number handle").ThrowAsJavaScriptException();
  return 0;
}

std::string ArgString(const Napi::CallbackInfo& info, size_t i) {
  if (info.Length() <= i || !info[i].IsString()) return std::string();
  return info[i].As<Napi::String>().Utf8Value();
}

int64_t ArgInt(const Napi::CallbackInfo& info, size_t i) {
  if (info.Length() <= i || !info[i].IsNumber()) return 0;
  return info[i].As<Napi::Number>().Int64Value();
}

std::vector<uint8_t> ArgBytes(const Napi::CallbackInfo& info, size_t i) {
  if (info.Length() <= i || !info[i].IsTypedArray()) return std::vector<uint8_t>();
  auto a = info[i].As<Napi::Uint8Array>();
  return std::vector<uint8_t>(a.Data(), a.Data() + a.ByteLength());
}

// Arg32 reads a 32-byte id argument; absent (null or undefined) is allowed
// when optional, and anything else of the wrong size is an error.
bool Arg32(const Napi::CallbackInfo& info, size_t i, bool optional, std::vector<uint8_t>* out) {
  Napi::Env env = info.Env();
  if (info.Length() <= i || info[i].IsNull() || info[i].IsUndefined()) {
    if (optional) return true;
    Napi::TypeError::New(env, "expected a 32-byte id").ThrowAsJavaScriptException();
    return false;
  }
  if (!info[i].IsTypedArray() || info[i].As<Napi::Uint8Array>().ByteLength() != 32) {
    Napi::TypeError::New(env, "expected a 32-byte id").ThrowAsJavaScriptException();
    return false;
  }
  auto a = info[i].As<Napi::Uint8Array>();
  out->assign(a.Data(), a.Data() + 32);
  return true;
}

unsigned char* Ptr(std::vector<uint8_t>& v) { return v.empty() ? nullptr : v.data(); }

// Job runs one cabi call on a worker thread and settles a Promise with what it
// produced.
class Job : public Napi::AsyncWorker {
 public:
  enum class Result { kVoid, kString, kHandle, kBytes };

  Job(Napi::Env env, Result result, std::function<void(Job&)> run)
      : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)), result_(result), run_(std::move(run)) {}

  Napi::Promise Promise() { return deferred_.Promise(); }

  void Fail(char* errOut) {
    std::string msg = TakeErr(errOut);
    if (!msg.empty()) SetError(msg);
  }

  void Refuse(const std::string& msg) { SetError(msg); }

  std::string text;
  uintptr_t handle = 0;
  std::vector<uint8_t> bytes;
  std::function<void()> onOK;

 protected:
  void Execute() override { run_(*this); }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    if (onOK) onOK();
    switch (result_) {
      case Result::kVoid:
        deferred_.Resolve(env.Undefined());
        break;
      case Result::kString:
        deferred_.Resolve(Napi::String::New(env, text));
        break;
      case Result::kHandle:
        deferred_.Resolve(Napi::BigInt::New(env, static_cast<uint64_t>(handle)));
        break;
      case Result::kBytes:
        deferred_.Resolve(Napi::Buffer<uint8_t>::Copy(env, bytes.data(), bytes.size()));
        break;
    }
  }

  void OnError(const Napi::Error& e) override {
    Napi::HandleScope scope(Env());
    deferred_.Reject(e.Value());
  }

 private:
  Napi::Promise::Deferred deferred_;
  Result result_;
  std::function<void(Job&)> run_;
};

Napi::Value Queue(Napi::Env env, Job::Result result, std::function<void(Job&)> run) {
  auto* job = new Job(env, result, std::move(run));
  Napi::Promise promise = job->Promise();
  job->Queue();
  return promise;
}

// Listener is one JS callback that Go threads deliver to: a subscription's
// events, a served procedure's calls, or a served stream procedure's
// sessions. It lives as long as the process may still deliver to it; its
// ThreadSafeFunction is released when JS stops the listener.
struct Listener {
  Napi::ThreadSafeFunction tsfn;
};

struct Delivery {
  std::string kind;
  std::string json;
  uint64_t handle = 0;
  // last marks a subscription's final delivery, after which its listener is
  // released: the Go side delivers nothing to it after "closed".
  bool last = false;
  Listener* listener = nullptr;
};

void Deliver(void* user_data, Delivery* d) {
  auto* listener = static_cast<Listener*>(user_data);
  d->listener = listener;
  napi_status status = listener->tsfn.NonBlockingCall(d, [](Napi::Env env, Napi::Function fn, Delivery* data) {
    Napi::Object msg = Napi::Object::New(env);
    msg.Set("kind", Napi::String::New(env, data->kind));
    msg.Set("json", Napi::String::New(env, data->json));
    msg.Set("handle", Napi::BigInt::New(env, data->handle));
    fn.Call({msg});
    if (data->last) {
      data->listener->tsfn.Release();
      delete data->listener;
    }
    delete data;
  });
  if (status != napi_ok) delete d;
}

// g_served maps a served procedure's handle to its listener, touched only on
// the main thread (a Job's OnOK), so servedStop can release it. A listener is
// released, not deleted, at stop: a call already in flight on a Go thread may
// still deliver to it, and NonBlockingCall on a released ThreadSafeFunction
// refuses safely only while the Listener itself is alive.
std::unordered_map<uintptr_t, Listener*> g_served;

}  // namespace

extern "C" void OnMaculaEvent(void* user_data, const char* event_json) {
  auto* d = new Delivery();
  d->kind = "event";
  d->json.assign(event_json != nullptr ? event_json : "");
  Deliver(user_data, d);
}

extern "C" void OnMaculaClosed(void* user_data, const char* err_message) {
  auto* d = new Delivery();
  d->kind = "closed";
  d->last = true;
  d->json.assign(err_message != nullptr ? err_message : "");
  Deliver(user_data, d);
}

extern "C" void OnMaculaRequest(void* user_data, uintptr_t handle, const char* request_json) {
  auto* d = new Delivery();
  d->kind = "request";
  d->handle = static_cast<uint64_t>(handle);
  d->json.assign(request_json != nullptr ? request_json : "");
  Deliver(user_data, d);
}

namespace {

Listener* NewListener(Napi::Env env, const Napi::Value& callback, const char* name) {
  auto* listener = new Listener();
  listener->tsfn = Napi::ThreadSafeFunction::New(env, callback.As<Napi::Function>(), name, 0, 1);
  return listener;
}

bool RequireFunction(const Napi::CallbackInfo& info, size_t i) {
  if (info.Length() > i && info[i].IsFunction()) return true;
  Napi::TypeError::New(info.Env(), "expected a callback function").ThrowAsJavaScriptException();
  return false;
}

// --- keys ---------------------------------------------------------------

Napi::Value KeyGenerate(const Napi::CallbackInfo& info) {
  std::string profile = ArgString(info, 0);
  return Queue(info.Env(), Job::Result::kHandle, [profile](Job& job) {
    char* errOut = nullptr;
    job.handle = macula_key_generate(const_cast<char*>(profile.c_str()), &errOut);
    job.Fail(errOut);
  });
}

Napi::Value KeyLoad(const Napi::CallbackInfo& info) {
  std::string path = ArgString(info, 0), profile = ArgString(info, 1);
  return Queue(info.Env(), Job::Result::kHandle, [path, profile](Job& job) {
    char* errOut = nullptr;
    job.handle = macula_key_load(const_cast<char*>(path.c_str()), const_cast<char*>(profile.c_str()), &errOut);
    job.Fail(errOut);
  });
}

Napi::Value KeySave(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  std::string path = ArgString(info, 1);
  return Queue(info.Env(), Job::Result::kVoid, [h, path](Job& job) {
    char* errOut = nullptr;
    macula_key_save(h, const_cast<char*>(path.c_str()), &errOut);
    job.Fail(errOut);
  });
}

Napi::Value KeyNodeId(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  uintptr_t h = ToHandle(env, info[0], &ok);
  if (!ok) return env.Null();
  auto out = Napi::Buffer<uint8_t>::New(env, 32);
  char* errOut = nullptr;
  macula_key_node_id(h, out.Data(), &errOut);
  if (ThrowIfErr(env, errOut)) return env.Null();
  return out;
}

Napi::Value BytesResult(Napi::Env env, unsigned char* data, size_t len, char* errOut) {
  if (ThrowIfErr(env, errOut)) return env.Null();
  auto out = Napi::Buffer<uint8_t>::Copy(env, data, len);
  if (data != nullptr) macula_free_bytes(data);
  return out;
}

Napi::Value KeyPublicKey(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  uintptr_t h = ToHandle(env, info[0], &ok);
  if (!ok) return env.Null();
  size_t len = 0;
  char* errOut = nullptr;
  unsigned char* data = macula_key_public_key(h, &len, &errOut);
  return BytesResult(env, data, len, errOut);
}

Napi::Value KeyProfile(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  uintptr_t h = ToHandle(env, info[0], &ok);
  if (!ok) return env.Null();
  char* errOut = nullptr;
  char* name = macula_key_profile(h, &errOut);
  if (ThrowIfErr(env, errOut)) return env.Null();
  return Napi::String::New(env, TakeString(name));
}

// keySign(key, data) -> Promise<Buffer>: signing with an RSA-4096 half takes
// long enough to keep off the event loop.
Napi::Value KeySign(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  std::vector<uint8_t> data = ArgBytes(info, 1);
  return Queue(info.Env(), Job::Result::kBytes, [=](Job& job) mutable {
    size_t len = 0;
    char* errOut = nullptr;
    unsigned char* out = macula_key_sign(h, Ptr(data), data.size(), &len, &errOut);
    if (out != nullptr) {
      job.bytes.assign(out, out + len);
      macula_free_bytes(out);
    }
    job.Fail(errOut);
  });
}

// verify(data, signature, publicKey, profile) -> boolean: a verification is a
// public-key operation, quick enough to run on the calling thread.
Napi::Value Verify(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<uint8_t> data = ArgBytes(info, 0);
  std::vector<uint8_t> signature = ArgBytes(info, 1);
  std::vector<uint8_t> publicKey = ArgBytes(info, 2);
  std::string profile = ArgString(info, 3);
  char* errOut = nullptr;
  int valid = macula_verify(Ptr(data), data.size(), Ptr(signature), signature.size(), Ptr(publicKey),
                            publicKey.size(), const_cast<char*>(profile.c_str()), &errOut);
  if (ThrowIfErr(env, errOut)) return env.Null();
  return Napi::Boolean::New(env, valid == 1);
}

// keyDeviceRequestProof(key, realm, procedure, requestJson, rule) ->
// Promise<string>: a realm proof v2 (macula-realm#29), signed off the event
// loop like keySign.
Napi::Value KeyDeviceRequestProof(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  std::vector<uint8_t> realm = ArgBytes(info, 1);
  std::string procedure = ArgString(info, 2);
  std::string request = ArgString(info, 3);
  int rule = static_cast<int>(ArgInt(info, 4));
  return Queue(info.Env(), Job::Result::kString, [=](Job& job) mutable {
    char* errOut = nullptr;
    char* proof = macula_key_device_request_proof(h, Ptr(realm), const_cast<char*>(procedure.c_str()),
                                                  const_cast<char*>(request.c_str()), rule, &errOut);
    if (proof != nullptr) job.text = TakeString(proof);
    job.Fail(errOut);
  });
}

// deviceRequestMessage(publicKey, realm, procedure, timestampMs, nonce,
// requestJson, rule) -> Buffer: the bytes such a proof signs.
Napi::Value DeviceRequestMessage(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<uint8_t> publicKey = ArgBytes(info, 0);
  std::vector<uint8_t> realm = ArgBytes(info, 1);
  std::string procedure = ArgString(info, 2);
  int64_t timestamp = ArgInt(info, 3);
  std::vector<uint8_t> nonce = ArgBytes(info, 4);
  std::string request = ArgString(info, 5);
  int rule = static_cast<int>(ArgInt(info, 6));
  size_t len = 0;
  char* errOut = nullptr;
  unsigned char* out = macula_device_request_message(Ptr(publicKey), publicKey.size(), Ptr(realm),
                                                     const_cast<char*>(procedure.c_str()), timestamp, Ptr(nonce),
                                                     const_cast<char*>(request.c_str()), rule, &len, &errOut);
  if (ThrowIfErr(env, errOut)) return env.Null();
  Napi::Buffer<uint8_t> result = Napi::Buffer<uint8_t>::Copy(env, out, len);
  macula_free_bytes(out);
  return result;
}

Napi::Value KeyFree(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  if (ok) macula_key_free(h);
  return info.Env().Undefined();
}

// --- pool ---------------------------------------------------------------

Napi::Value PoolConnect(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t key = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  std::string seeds = ArgString(info, 1), opts = ArgString(info, 2);
  return Queue(info.Env(), Job::Result::kHandle, [key, seeds, opts](Job& job) {
    char* errOut = nullptr;
    job.handle = macula_pool_connect(key, const_cast<char*>(seeds.c_str()), const_cast<char*>(opts.c_str()), &errOut);
    job.Fail(errOut);
  });
}

Napi::Value PoolClose(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  return Queue(info.Env(), Job::Result::kVoid, [h](Job&) { macula_pool_close(h); });
}

Napi::Value PoolNodeId(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  uintptr_t h = ToHandle(env, info[0], &ok);
  if (!ok) return env.Null();
  auto out = Napi::Buffer<uint8_t>::New(env, 32);
  char* errOut = nullptr;
  macula_pool_node_id(h, out.Data(), &errOut);
  if (ThrowIfErr(env, errOut)) return env.Null();
  return out;
}

Napi::Value PoolStatus(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  uintptr_t h = ToHandle(env, info[0], &ok);
  if (!ok) return env.Null();
  char* errOut = nullptr;
  char* json = macula_pool_status(h, &errOut);
  if (ThrowIfErr(env, errOut)) return env.Null();
  return Napi::String::New(env, TakeString(json));
}

// poolCall(pool, realm, procedure, payloadJson, provider|null, timeoutMs, bytesMode)
Napi::Value PoolCall(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> realm, provider;
  if (!ok || !Arg32(info, 1, false, &realm) || !Arg32(info, 4, true, &provider)) return info.Env().Null();
  std::string procedure = ArgString(info, 2), payload = ArgString(info, 3);
  int64_t timeout = ArgInt(info, 5);
  int mode = static_cast<int>(ArgInt(info, 6));
  return Queue(info.Env(), Job::Result::kString, [=](Job& job) mutable {
    char* errOut = nullptr;
    char* out = macula_pool_call(h, Ptr(realm), const_cast<char*>(procedure.c_str()), const_cast<char*>(payload.c_str()),
                                 Ptr(provider), timeout, mode, &errOut);
    job.text = TakeString(out);
    job.Fail(errOut);
  });
}

// poolProviders(pool, realm, procedure, timeoutMs)
Napi::Value PoolProviders(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> realm;
  if (!ok || !Arg32(info, 1, false, &realm)) return info.Env().Null();
  std::string procedure = ArgString(info, 2);
  int64_t timeout = ArgInt(info, 3);
  return Queue(info.Env(), Job::Result::kString, [=](Job& job) mutable {
    char* errOut = nullptr;
    job.text = TakeString(macula_pool_providers(h, Ptr(realm), const_cast<char*>(procedure.c_str()), timeout, &errOut));
    job.Fail(errOut);
  });
}

// poolPublish(pool, realm, topic, payloadJson, ttlMs)
Napi::Value PoolPublish(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> realm;
  if (!ok || !Arg32(info, 1, false, &realm)) return info.Env().Null();
  std::string topic = ArgString(info, 2), payload = ArgString(info, 3);
  int64_t ttl = ArgInt(info, 4);
  return Queue(info.Env(), Job::Result::kVoid, [=](Job& job) mutable {
    char* errOut = nullptr;
    macula_pool_publish(h, Ptr(realm), const_cast<char*>(topic.c_str()), const_cast<char*>(payload.c_str()), ttl, &errOut);
    job.Fail(errOut);
  });
}

// poolSubscribe(pool, realm, topic, bytesMode, callback) -> Promise<handle>; the
// callback gets {kind: "event"|"closed", json}.
Napi::Value PoolSubscribe(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> realm;
  if (!ok || !Arg32(info, 1, false, &realm) || !RequireFunction(info, 4)) return info.Env().Null();
  std::string topic = ArgString(info, 2);
  int mode = static_cast<int>(ArgInt(info, 3));
  Listener* listener = NewListener(info.Env(), info[4], "macula-subscription");
  return Queue(info.Env(), Job::Result::kHandle, [=](Job& job) mutable {
    char* errOut = nullptr;
    job.handle = macula_pool_subscribe(h, Ptr(realm), const_cast<char*>(topic.c_str()), OnMaculaEvent, OnMaculaClosed,
                                       listener, mode, &errOut);
    std::string msg = TakeErr(errOut);
    if (!msg.empty()) {
      listener->tsfn.Release();
      job.Refuse(msg);
    }
  });
}

// subscriptionStop(handle): the subscription's own "closed" delivery follows;
// the JS side releases nothing.
Napi::Value SubscriptionStop(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  return Queue(info.Env(), Job::Result::kVoid, [h](Job&) { macula_subscription_stop(h); });
}

// poolFindRecord(pool, key, timeoutMs, bytesMode)
Napi::Value PoolFindRecord(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> key;
  if (!ok || !Arg32(info, 1, false, &key)) return info.Env().Null();
  int64_t timeout = ArgInt(info, 2);
  int mode = static_cast<int>(ArgInt(info, 3));
  return Queue(info.Env(), Job::Result::kString, [=](Job& job) mutable {
    char* errOut = nullptr;
    job.text = TakeString(macula_pool_find_record(h, Ptr(key), timeout, mode, &errOut));
    job.Fail(errOut);
  });
}

Napi::Value PoolFindRecords(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> key;
  if (!ok || !Arg32(info, 1, false, &key)) return info.Env().Null();
  int64_t timeout = ArgInt(info, 2);
  int mode = static_cast<int>(ArgInt(info, 3));
  return Queue(info.Env(), Job::Result::kString, [=](Job& job) mutable {
    char* errOut = nullptr;
    job.text = TakeString(macula_pool_find_records(h, Ptr(key), timeout, mode, &errOut));
    job.Fail(errOut);
  });
}

// poolFindRecordsByType(pool, type, timeoutMs, bytesMode)
Napi::Value PoolFindRecordsByType(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  int type = static_cast<int>(ArgInt(info, 1));
  int64_t timeout = ArgInt(info, 2);
  int mode = static_cast<int>(ArgInt(info, 3));
  return Queue(info.Env(), Job::Result::kString, [=](Job& job) {
    char* errOut = nullptr;
    job.text = TakeString(macula_pool_find_records_by_type(h, type, timeout, mode, &errOut));
    job.Fail(errOut);
  });
}

// poolPutRecord(pool, wire, timeoutMs)
Napi::Value PoolPutRecord(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  std::vector<uint8_t> wire = ArgBytes(info, 1);
  int64_t timeout = ArgInt(info, 2);
  return Queue(info.Env(), Job::Result::kVoid, [=](Job& job) mutable {
    char* errOut = nullptr;
    macula_pool_put_record(h, Ptr(wire), wire.size(), timeout, &errOut);
    job.Fail(errOut);
  });
}

// --- content ------------------------------------------------------------

// poolShareContent(pool, realm, data, name, timeoutMs) -> Promise<Buffer> (the
// content id, 50 bytes).
Napi::Value PoolShareContent(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> realm;
  if (!ok || !Arg32(info, 1, false, &realm)) return info.Env().Null();
  std::vector<uint8_t> data = ArgBytes(info, 2);
  std::string name = ArgString(info, 3);
  int64_t timeout = ArgInt(info, 4);
  return Queue(info.Env(), Job::Result::kBytes, [=](Job& job) mutable {
    size_t len = 0;
    char* errOut = nullptr;
    unsigned char* out = macula_pool_share_content(h, Ptr(realm), Ptr(data), data.size(),
                                                   const_cast<char*>(name.c_str()), timeout, &len, &errOut);
    if (out != nullptr) {
      job.bytes.assign(out, out + len);
      macula_free_bytes(out);
    }
    job.Fail(errOut);
  });
}

// poolUnshareContent(pool, realm, mcid, timeoutMs)
Napi::Value PoolUnshareContent(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> realm;
  if (!ok || !Arg32(info, 1, false, &realm)) return info.Env().Null();
  std::vector<uint8_t> mcid = ArgBytes(info, 2);
  int64_t timeout = ArgInt(info, 3);
  return Queue(info.Env(), Job::Result::kVoid, [=](Job& job) mutable {
    char* errOut = nullptr;
    macula_pool_unshare_content(h, Ptr(realm), Ptr(mcid), mcid.size(), timeout, &errOut);
    job.Fail(errOut);
  });
}

// poolGetContent(pool, realm, mcid, maxBytes, maxChunks, parallel,
// chunkTimeoutMs, timeoutMs) -> Promise<Buffer>
Napi::Value PoolGetContent(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> realm;
  if (!ok || !Arg32(info, 1, false, &realm)) return info.Env().Null();
  std::vector<uint8_t> mcid = ArgBytes(info, 2);
  uint64_t maxBytes = static_cast<uint64_t>(ArgInt(info, 3));
  int maxChunks = static_cast<int>(ArgInt(info, 4));
  int parallel = static_cast<int>(ArgInt(info, 5));
  int64_t chunkTimeout = ArgInt(info, 6);
  int64_t timeout = ArgInt(info, 7);
  return Queue(info.Env(), Job::Result::kBytes, [=](Job& job) mutable {
    size_t len = 0;
    char* errOut = nullptr;
    unsigned char* out = macula_pool_get_content(h, Ptr(realm), Ptr(mcid), mcid.size(), maxBytes, maxChunks,
                                                 parallel, chunkTimeout, timeout, &len, &errOut);
    if (out != nullptr) {
      job.bytes.assign(out, out + len);
      macula_free_bytes(out);
    }
    job.Fail(errOut);
  });
}

// --- serving ------------------------------------------------------------

// poolServe(pool, realm, procedure, bytesMode, callback) -> Promise<handle>; the
// callback gets {kind: "request", handle, json} per CALL.
Napi::Value PoolServe(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> realm;
  if (!ok || !Arg32(info, 1, false, &realm) || !RequireFunction(info, 4)) return info.Env().Null();
  std::string procedure = ArgString(info, 2);
  int mode = static_cast<int>(ArgInt(info, 3));
  Listener* listener = NewListener(info.Env(), info[4], "macula-serve");
  auto* job = new Job(info.Env(), Job::Result::kHandle, [=](Job& j) mutable {
    char* errOut = nullptr;
    j.handle = macula_pool_serve(h, Ptr(realm), const_cast<char*>(procedure.c_str()), OnMaculaRequest, listener, mode,
                                 &errOut);
    std::string msg = TakeErr(errOut);
    if (!msg.empty()) {
      listener->tsfn.Release();
      j.Refuse(msg);
    }
  });
  job->onOK = [job, listener]() { g_served[job->handle] = listener; };
  Napi::Promise promise = job->Promise();
  job->Queue();
  return promise;
}

// poolServeStream(pool, realm, procedure, mode, bytesMode, callback) -> Promise<handle>;
// the callback gets {kind: "request", handle, json} per session, handle a stream.
Napi::Value PoolServeStream(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> realm;
  if (!ok || !Arg32(info, 1, false, &realm) || !RequireFunction(info, 5)) return info.Env().Null();
  std::string procedure = ArgString(info, 2);
  int streamMode = static_cast<int>(ArgInt(info, 3));
  int mode = static_cast<int>(ArgInt(info, 4));
  Listener* listener = NewListener(info.Env(), info[5], "macula-serve-stream");
  auto* job = new Job(info.Env(), Job::Result::kHandle, [=](Job& j) mutable {
    char* errOut = nullptr;
    j.handle = macula_pool_serve_stream(h, Ptr(realm), const_cast<char*>(procedure.c_str()), streamMode,
                                        OnMaculaRequest, listener, mode, &errOut);
    std::string msg = TakeErr(errOut);
    if (!msg.empty()) {
      listener->tsfn.Release();
      j.Refuse(msg);
    }
  });
  job->onOK = [job, listener]() { g_served[job->handle] = listener; };
  Napi::Promise promise = job->Promise();
  job->Queue();
  return promise;
}

Napi::Value PendingReply(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  uintptr_t h = ToHandle(env, info[0], &ok);
  if (!ok) return env.Null();
  std::string json = ArgString(info, 1);
  char* errOut = nullptr;
  macula_pending_reply(h, const_cast<char*>(json.c_str()), &errOut);
  ThrowIfErr(env, errOut);
  return env.Undefined();
}

Napi::Value PendingError(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  uintptr_t h = ToHandle(env, info[0], &ok);
  if (!ok) return env.Null();
  std::string message = ArgString(info, 1);
  char* errOut = nullptr;
  macula_pending_error(h, const_cast<char*>(message.c_str()), &errOut);
  ThrowIfErr(env, errOut);
  return env.Undefined();
}

Napi::Value ServedStop(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  auto* job = new Job(info.Env(), Job::Result::kVoid, [h](Job& j) {
    char* errOut = nullptr;
    macula_served_stop(h, &errOut);
    j.Fail(errOut);
  });
  job->onOK = [h]() {
    auto it = g_served.find(h);
    if (it == g_served.end()) return;
    it->second->tsfn.Release();
    g_served.erase(it);
  };
  Napi::Promise promise = job->Promise();
  job->Queue();
  return promise;
}

// --- streams ------------------------------------------------------------

// poolOpenStream(pool, realm, procedure, mode, payloadJson, provider|null, deadlineMs, timeoutMs)
Napi::Value PoolOpenStream(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> realm, provider;
  if (!ok || !Arg32(info, 1, false, &realm) || !Arg32(info, 5, true, &provider)) return info.Env().Null();
  std::string procedure = ArgString(info, 2), payload = ArgString(info, 4);
  int streamMode = static_cast<int>(ArgInt(info, 3));
  int64_t deadline = ArgInt(info, 6), timeout = ArgInt(info, 7);
  return Queue(info.Env(), Job::Result::kHandle, [=](Job& job) mutable {
    char* errOut = nullptr;
    job.handle = macula_pool_open_stream(h, Ptr(realm), const_cast<char*>(procedure.c_str()), streamMode,
                                         const_cast<char*>(payload.c_str()), Ptr(provider), deadline, timeout, &errOut);
    job.Fail(errOut);
  });
}

Napi::Value StreamSendBytes(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  std::vector<uint8_t> data = ArgBytes(info, 1);
  return Queue(info.Env(), Job::Result::kVoid, [=](Job& job) mutable {
    char* errOut = nullptr;
    macula_stream_send_bytes(h, Ptr(data), data.size(), &errOut);
    job.Fail(errOut);
  });
}

Napi::Value StreamSendJson(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  std::string json = ArgString(info, 1);
  return Queue(info.Env(), Job::Result::kVoid, [=](Job& job) {
    char* errOut = nullptr;
    macula_stream_send_json(h, const_cast<char*>(json.c_str()), &errOut);
    job.Fail(errOut);
  });
}

Napi::Value StreamCloseSend(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  return Queue(info.Env(), Job::Result::kVoid, [h](Job& job) {
    char* errOut = nullptr;
    macula_stream_close_send(h, &errOut);
    job.Fail(errOut);
  });
}

Napi::Value StreamClose(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  return Queue(info.Env(), Job::Result::kVoid, [h](Job& job) {
    char* errOut = nullptr;
    macula_stream_close(h, &errOut);
    job.Fail(errOut);
  });
}

Napi::Value StreamReply(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  std::string json = ArgString(info, 1);
  return Queue(info.Env(), Job::Result::kVoid, [=](Job& job) {
    char* errOut = nullptr;
    macula_stream_reply(h, const_cast<char*>(json.c_str()), &errOut);
    job.Fail(errOut);
  });
}

Napi::Value StreamAbort(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  std::string code = ArgString(info, 1), message = ArgString(info, 2);
  return Queue(info.Env(), Job::Result::kVoid, [=](Job& job) {
    char* errOut = nullptr;
    macula_stream_abort(h, const_cast<char*>(code.c_str()), const_cast<char*>(message.c_str()), &errOut);
    job.Fail(errOut);
  });
}

// streamRecv(stream, timeoutMs, bytesMode) -> Promise<json>
Napi::Value StreamRecv(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  int64_t timeout = ArgInt(info, 1);
  int mode = static_cast<int>(ArgInt(info, 2));
  return Queue(info.Env(), Job::Result::kString, [=](Job& job) {
    char* errOut = nullptr;
    job.text = TakeString(macula_stream_recv(h, timeout, mode, &errOut));
    job.Fail(errOut);
  });
}

Napi::Value StreamRequest(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  uintptr_t h = ToHandle(env, info[0], &ok);
  if (!ok) return env.Null();
  char* errOut = nullptr;
  char* json = macula_stream_request(h, static_cast<int>(ArgInt(info, 1)), &errOut);
  if (ThrowIfErr(env, errOut)) return env.Null();
  return Napi::String::New(env, TakeString(json));
}

Napi::Value StreamFree(const Napi::CallbackInfo& info) {
  bool ok = false;
  uintptr_t h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  return Queue(info.Env(), Job::Result::kVoid, [h](Job&) { macula_stream_free(h); });
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("keyGenerate", Napi::Function::New(env, KeyGenerate));
  exports.Set("keyLoad", Napi::Function::New(env, KeyLoad));
  exports.Set("keySave", Napi::Function::New(env, KeySave));
  exports.Set("keyNodeId", Napi::Function::New(env, KeyNodeId));
  exports.Set("keyPublicKey", Napi::Function::New(env, KeyPublicKey));
  exports.Set("keyProfile", Napi::Function::New(env, KeyProfile));
  exports.Set("keySign", Napi::Function::New(env, KeySign));
  exports.Set("keyDeviceRequestProof", Napi::Function::New(env, KeyDeviceRequestProof));
  exports.Set("deviceRequestMessage", Napi::Function::New(env, DeviceRequestMessage));
  exports.Set("verify", Napi::Function::New(env, Verify));
  exports.Set("keyFree", Napi::Function::New(env, KeyFree));
  exports.Set("poolConnect", Napi::Function::New(env, PoolConnect));
  exports.Set("poolClose", Napi::Function::New(env, PoolClose));
  exports.Set("poolNodeId", Napi::Function::New(env, PoolNodeId));
  exports.Set("poolStatus", Napi::Function::New(env, PoolStatus));
  exports.Set("poolCall", Napi::Function::New(env, PoolCall));
  exports.Set("poolProviders", Napi::Function::New(env, PoolProviders));
  exports.Set("poolPublish", Napi::Function::New(env, PoolPublish));
  exports.Set("poolSubscribe", Napi::Function::New(env, PoolSubscribe));
  exports.Set("subscriptionStop", Napi::Function::New(env, SubscriptionStop));
  exports.Set("poolFindRecord", Napi::Function::New(env, PoolFindRecord));
  exports.Set("poolFindRecords", Napi::Function::New(env, PoolFindRecords));
  exports.Set("poolFindRecordsByType", Napi::Function::New(env, PoolFindRecordsByType));
  exports.Set("poolPutRecord", Napi::Function::New(env, PoolPutRecord));
  exports.Set("poolShareContent", Napi::Function::New(env, PoolShareContent));
  exports.Set("poolUnshareContent", Napi::Function::New(env, PoolUnshareContent));
  exports.Set("poolGetContent", Napi::Function::New(env, PoolGetContent));
  exports.Set("poolServe", Napi::Function::New(env, PoolServe));
  exports.Set("poolServeStream", Napi::Function::New(env, PoolServeStream));
  exports.Set("pendingReply", Napi::Function::New(env, PendingReply));
  exports.Set("pendingError", Napi::Function::New(env, PendingError));
  exports.Set("servedStop", Napi::Function::New(env, ServedStop));
  exports.Set("poolOpenStream", Napi::Function::New(env, PoolOpenStream));
  exports.Set("streamSendBytes", Napi::Function::New(env, StreamSendBytes));
  exports.Set("streamSendJson", Napi::Function::New(env, StreamSendJson));
  exports.Set("streamCloseSend", Napi::Function::New(env, StreamCloseSend));
  exports.Set("streamClose", Napi::Function::New(env, StreamClose));
  exports.Set("streamReply", Napi::Function::New(env, StreamReply));
  exports.Set("streamAbort", Napi::Function::New(env, StreamAbort));
  exports.Set("streamRecv", Napi::Function::New(env, StreamRecv));
  exports.Set("streamRequest", Napi::Function::New(env, StreamRequest));
  exports.Set("streamFree", Napi::Function::New(env, StreamFree));
  return exports;
}

}  // namespace

NODE_API_MODULE(macula_native, Init)
