// N-API glue for macula-ts over macula-go's shared C ABI (cabi/macula.h, ABI
// 1). libmacula.a, built from macula-go's cabi/ at the release in
// native/MACULA_GO (go build -buildmode=c-archive), is linked statically into
// this addon, so the published .node file is self-contained.
//
// Handles: a Go value crosses as a macula_handle (uintptr_t), surfaced to JS
// as a BigInt so no precision is lost; ToHandle also accepts a Number.
//
// Threads: every call that does network I/O, or may wait on QUIC flow
// control, runs on a worker thread through Job, a single Napi::AsyncWorker
// that returns a Promise; nothing blocks the event loop. The ABI never calls
// back into the host: a subscription's events, and a served procedure's calls
// and sessions, wait in an inbox. Each listener gets a thread of its own that
// takes from the inbox (macula_*_next, waiting with a cancel token of its own)
// and hands every item to JS through a ThreadSafeFunction.
//
// Errors: the ABI's err_out is JSON with a fixed kind (CONTRACT.md "Errors").
// It is freed here and becomes the message of a rejected Promise (or a thrown
// error for the few synchronous calls), which src/binding.ts turns into the
// matching TypeScript error.
#include <napi.h>

#include <atomic>
#include <cstdint>
#include <cstring>
#include <functional>
#include <memory>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

extern "C" {
#include "macula.h"
}

static_assert(MACULA_ABI_VERSION == 1, "this addon is written against macula C ABI 1");

namespace {

std::string TakeString(char* s) {
  if (s == nullptr) return std::string();
  std::string out(s);
  macula_free_string(s);
  return out;
}

bool ThrowIfErr(Napi::Env env, char* errOut) {
  std::string msg = TakeString(errOut);
  if (msg.empty()) return false;
  Napi::Error::New(env, msg).ThrowAsJavaScriptException();
  return true;
}

macula_handle ToHandle(const Napi::Env& env, const Napi::Value& v, bool* ok) {
  *ok = true;
  if (v.IsBigInt()) {
    bool lossless = false;
    return static_cast<macula_handle>(v.As<Napi::BigInt>().Uint64Value(&lossless));
  }
  if (v.IsNumber()) return static_cast<macula_handle>(v.As<Napi::Number>().Int64Value());
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

// ArgFixed reads an argument of exactly n bytes; absent (null or undefined) is
// allowed when optional, and anything else of the wrong size is an error.
bool ArgFixed(const Napi::CallbackInfo& info, size_t i, size_t n, bool optional, std::vector<uint8_t>* out) {
  Napi::Env env = info.Env();
  if (info.Length() <= i || info[i].IsNull() || info[i].IsUndefined()) {
    if (optional) return true;
    Napi::TypeError::New(env, "expected " + std::to_string(n) + " bytes").ThrowAsJavaScriptException();
    return false;
  }
  if (!info[i].IsTypedArray() || info[i].As<Napi::Uint8Array>().ByteLength() != n) {
    Napi::TypeError::New(env, "expected " + std::to_string(n) + " bytes").ThrowAsJavaScriptException();
    return false;
  }
  auto a = info[i].As<Napi::Uint8Array>();
  out->assign(a.Data(), a.Data() + n);
  return true;
}

bool Arg32(const Napi::CallbackInfo& info, size_t i, bool optional, std::vector<uint8_t>* out) {
  return ArgFixed(info, i, 32, optional, out);
}

uint8_t* Ptr(std::vector<uint8_t>& v) { return v.empty() ? nullptr : v.data(); }
const char* C(const std::string& s) { return s.c_str(); }

// Job runs one ABI call on a worker thread and settles a Promise with what it
// produced.
class Job : public Napi::AsyncWorker {
 public:
  enum class Result { kVoid, kString, kHandle, kBytes };

  Job(Napi::Env env, Result result, std::function<void(Job&)> run)
      : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)), result_(result), run_(std::move(run)) {}

  Napi::Promise Promise() { return deferred_.Promise(); }

  void Fail(char* errOut) {
    std::string msg = TakeString(errOut);
    if (!msg.empty()) SetError(msg);
  }

  std::string text;
  macula_handle handle = 0;
  std::vector<uint8_t> bytes;
  std::function<void()> onOK;
  std::function<void()> onFail;

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
    if (onFail) onFail();
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

// --- listeners: an inbox drained on a thread of its own ------------------

// Delivery is what a listener hands to JS: an event, a request with the
// pending call's or stream's handle, or the closing notice (last).
struct Delivery {
  std::string kind;
  std::string json;
  uint64_t handle = 0;
  // last is the closing notice; source is then the ended listener's handle,
  // which leaves the registry.
  bool last = false;
  macula_handle source = 0;
};

// Poller drains one inbox: a subscription's (events) or a served procedure's
// (requests). It is shared by its thread and the registry, so stop can reach
// it while the thread lives, and nothing frees it under either.
struct Poller {
  enum class Kind { kSubscription, kServed };

  Kind kind;
  macula_handle source = 0;
  macula_handle cancel = 0;
  Napi::ThreadSafeFunction tsfn;
  std::atomic<bool> stopping{false};
};

// g_pollers maps a subscription's or served procedure's handle to its poller,
// touched only on the main thread, so stop can find it.
std::unordered_map<macula_handle, std::shared_ptr<Poller>> g_pollers;

void Deliver(const std::shared_ptr<Poller>& poller, Delivery* d) {
  napi_status status = poller->tsfn.BlockingCall(d, [](Napi::Env env, Napi::Function fn, Delivery* data) {
    Napi::Object msg = Napi::Object::New(env);
    msg.Set("kind", Napi::String::New(env, data->kind));
    msg.Set("json", Napi::String::New(env, data->json));
    msg.Set("handle", Napi::BigInt::New(env, data->handle));
    fn.Call({msg});
    if (data->last) g_pollers.erase(data->source);
    delete data;
  });
  if (status != napi_ok) delete d;
}

// errKind is the "kind" of the ABI's error JSON, read by its fixed prefix
// `{"kind":"...`, without a JSON parser.
std::string ErrKind(const std::string& err) {
  const std::string prefix = "{\"kind\":\"";
  if (err.compare(0, prefix.size(), prefix) != 0) return std::string();
  size_t end = err.find('"', prefix.size());
  return end == std::string::npos ? std::string() : err.substr(prefix.size(), end - prefix.size());
}

// Poll takes from the poller's inbox until its source ends, then delivers the
// closing notice: empty when it ended as asked (stopped, or its pool closed),
// the error's JSON when it failed. Every item is handed on in order.
void Poll(std::shared_ptr<Poller> poller) {
  std::string why;
  for (;;) {
    int32_t closed = 0;
    char* errOut = nullptr;
    macula_handle item = 0;
    char* json = poller->kind == Poller::Kind::kSubscription
                     ? macula_subscription_next(poller->source, 0, poller->cancel, &closed, &errOut)
                     : macula_served_next(poller->source, 0, poller->cancel, &item, &closed, &errOut);
    std::string err = TakeString(errOut);
    if (!err.empty()) {
      // Stopping cancels the wait, and then frees the source under it: both
      // end the poll as asked, not as a failure.
      std::string kind = ErrKind(err);
      if (!(poller->stopping.load() && (kind == "cancelled" || kind == "invalid_handle"))) why = err;
      break;
    }
    if (json == nullptr) {
      if (closed == 1) break;
      continue;
    }
    auto* d = new Delivery();
    d->kind = poller->kind == Poller::Kind::kSubscription ? "event" : "request";
    d->json = TakeString(json);
    d->handle = static_cast<uint64_t>(item);
    Deliver(poller, d);
  }
  auto* d = new Delivery();
  d->kind = "closed";
  d->json = why;
  d->last = true;
  d->source = poller->source;
  Deliver(poller, d);
  poller->tsfn.Release();
  macula_cancel_free(poller->cancel);
}

bool RequireFunction(const Napi::CallbackInfo& info, size_t i) {
  if (info.Length() > i && info[i].IsFunction()) return true;
  Napi::TypeError::New(info.Env(), "expected a callback function").ThrowAsJavaScriptException();
  return false;
}

// StartListener queues open (which returns the source's handle) on a worker,
// then, on the main thread, registers the poller and starts its thread.
Napi::Value StartListener(const Napi::CallbackInfo& info, size_t callbackArg, Poller::Kind kind, const char* name,
                          std::function<macula_handle(char**)> open) {
  Napi::Env env = info.Env();
  auto poller = std::make_shared<Poller>();
  poller->kind = kind;
  poller->cancel = macula_cancel_new();
  poller->tsfn = Napi::ThreadSafeFunction::New(env, info[callbackArg].As<Napi::Function>(), name, 0, 1);
  auto* job = new Job(env, Job::Result::kHandle, [open](Job& j) {
    char* errOut = nullptr;
    j.handle = open(&errOut);
    j.Fail(errOut);
  });
  job->onOK = [job, poller]() {
    poller->source = job->handle;
    g_pollers[job->handle] = poller;
    std::thread(Poll, poller).detach();
  };
  // A source that failed to open never polls: release what was made for it.
  job->onFail = [poller]() {
    poller->tsfn.Release();
    macula_cancel_free(poller->cancel);
  };
  Napi::Promise promise = job->Promise();
  job->Queue();
  return promise;
}

// StopListener ends a listener: it cancels the poll's wait, then runs stop (on
// a worker), which ends the source; the poll delivers the closing notice.
Napi::Value StopListener(const Napi::CallbackInfo& info, std::function<void(macula_handle, char**)> stop) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  auto it = g_pollers.find(h);
  if (it != g_pollers.end()) {
    it->second->stopping.store(true);
    macula_cancel(it->second->cancel);
    g_pollers.erase(it);
  }
  return Queue(info.Env(), Job::Result::kVoid, [h, stop](Job& job) {
    char* errOut = nullptr;
    stop(h, &errOut);
    job.Fail(errOut);
  });
}

// --- keys ---------------------------------------------------------------

Napi::Value KeyGenerate(const Napi::CallbackInfo& info) {
  std::string profile = ArgString(info, 0);
  return Queue(info.Env(), Job::Result::kHandle, [profile](Job& job) {
    char* errOut = nullptr;
    job.handle = macula_key_generate(C(profile), 0, &errOut);
    job.Fail(errOut);
  });
}

Napi::Value KeyLoad(const Napi::CallbackInfo& info) {
  std::string path = ArgString(info, 0), profile = ArgString(info, 1);
  return Queue(info.Env(), Job::Result::kHandle, [path, profile](Job& job) {
    char* errOut = nullptr;
    job.handle = macula_key_load(C(path), C(profile), &errOut);
    job.Fail(errOut);
  });
}

Napi::Value KeySave(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  std::string path = ArgString(info, 1);
  return Queue(info.Env(), Job::Result::kVoid, [h, path](Job& job) {
    char* errOut = nullptr;
    macula_key_save(h, C(path), &errOut);
    job.Fail(errOut);
  });
}

Napi::Value KeyNodeId(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  macula_handle h = ToHandle(env, info[0], &ok);
  if (!ok) return env.Null();
  auto out = Napi::Buffer<uint8_t>::New(env, 32);
  char* errOut = nullptr;
  macula_key_node_id(h, out.Data(), &errOut);
  if (ThrowIfErr(env, errOut)) return env.Null();
  return out;
}

Napi::Value BytesResult(Napi::Env env, uint8_t* data, size_t len, char* errOut) {
  if (ThrowIfErr(env, errOut)) return env.Null();
  auto out = Napi::Buffer<uint8_t>::Copy(env, data, len);
  if (data != nullptr) macula_free_bytes(data);
  return out;
}

Napi::Value KeyPublicKey(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  macula_handle h = ToHandle(env, info[0], &ok);
  if (!ok) return env.Null();
  size_t len = 0;
  char* errOut = nullptr;
  uint8_t* data = macula_key_public_key(h, &len, &errOut);
  return BytesResult(env, data, len, errOut);
}

Napi::Value KeyProfile(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  macula_handle h = ToHandle(env, info[0], &ok);
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
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  std::vector<uint8_t> data = ArgBytes(info, 1);
  return Queue(info.Env(), Job::Result::kBytes, [=](Job& job) mutable {
    size_t len = 0;
    char* errOut = nullptr;
    uint8_t* out = macula_key_sign(h, Ptr(data), data.size(), &len, &errOut);
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
  int32_t valid = macula_verify(Ptr(data), data.size(), Ptr(signature), signature.size(), Ptr(publicKey),
                                publicKey.size(), C(profile), &errOut);
  if (ThrowIfErr(env, errOut)) return env.Null();
  return Napi::Boolean::New(env, valid == 1);
}

// keyDeviceRequestProof(key, realm, procedure, requestJson, rule) ->
// Promise<string>: a realm proof v2 (macula-realm#29), signed off the event
// loop like keySign.
Napi::Value KeyDeviceRequestProof(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> realm;
  if (!ok || !Arg32(info, 1, false, &realm)) return info.Env().Null();
  std::string procedure = ArgString(info, 2);
  std::string request = ArgString(info, 3);
  int32_t rule = static_cast<int32_t>(ArgInt(info, 4));
  return Queue(info.Env(), Job::Result::kString, [=](Job& job) mutable {
    char* errOut = nullptr;
    char* proof = macula_key_device_request_proof(h, Ptr(realm), C(procedure), C(request), rule, &errOut);
    job.text = TakeString(proof);
    job.Fail(errOut);
  });
}

// deviceRequestMessage(publicKey, realm, procedure, timestampMs, nonce,
// requestJson, rule) -> Buffer: the bytes such a proof signs.
Napi::Value DeviceRequestMessage(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<uint8_t> publicKey = ArgBytes(info, 0);
  std::vector<uint8_t> realm, nonce;
  if (!Arg32(info, 1, false, &realm) || !ArgFixed(info, 4, 16, false, &nonce)) return env.Null();
  std::string procedure = ArgString(info, 2);
  int64_t timestamp = ArgInt(info, 3);
  std::string request = ArgString(info, 5);
  int32_t rule = static_cast<int32_t>(ArgInt(info, 6));
  size_t len = 0;
  char* errOut = nullptr;
  uint8_t* out = macula_device_request_message(Ptr(publicKey), publicKey.size(), Ptr(realm), C(procedure), timestamp,
                                               Ptr(nonce), C(request), rule, &len, &errOut);
  return BytesResult(env, out, len, errOut);
}

Napi::Value KeyFree(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  if (ok) macula_key_free(h);
  return info.Env().Undefined();
}

// --- pool ---------------------------------------------------------------

Napi::Value PoolConnect(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle key = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  std::string seeds = ArgString(info, 1), opts = ArgString(info, 2);
  return Queue(info.Env(), Job::Result::kHandle, [key, seeds, opts](Job& job) {
    char* errOut = nullptr;
    job.handle = macula_pool_connect(key, C(seeds), C(opts), 0, &errOut);
    job.Fail(errOut);
  });
}

// poolClose(pool): its subscriptions and served procedures end, and their
// polls deliver their closing notices.
Napi::Value PoolClose(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  return Queue(info.Env(), Job::Result::kVoid, [h](Job&) { macula_pool_close(h); });
}

Napi::Value PoolNodeId(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  macula_handle h = ToHandle(env, info[0], &ok);
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
  macula_handle h = ToHandle(env, info[0], &ok);
  if (!ok) return env.Null();
  char* errOut = nullptr;
  char* json = macula_pool_status(h, &errOut);
  if (ThrowIfErr(env, errOut)) return env.Null();
  return Napi::String::New(env, TakeString(json));
}

// poolCall(pool, realm, procedure, payloadJson, provider|null, timeoutMs)
Napi::Value PoolCall(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> realm, provider;
  if (!ok || !Arg32(info, 1, false, &realm) || !Arg32(info, 4, true, &provider)) return info.Env().Null();
  std::string procedure = ArgString(info, 2), payload = ArgString(info, 3);
  int64_t timeout = ArgInt(info, 5);
  return Queue(info.Env(), Job::Result::kString, [=](Job& job) mutable {
    char* errOut = nullptr;
    job.text = TakeString(macula_pool_call(h, Ptr(realm), C(procedure), C(payload), Ptr(provider), timeout, 0, &errOut));
    job.Fail(errOut);
  });
}

// poolProviders(pool, realm, procedure, timeoutMs)
Napi::Value PoolProviders(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> realm;
  if (!ok || !Arg32(info, 1, false, &realm)) return info.Env().Null();
  std::string procedure = ArgString(info, 2);
  int64_t timeout = ArgInt(info, 3);
  return Queue(info.Env(), Job::Result::kString, [=](Job& job) mutable {
    char* errOut = nullptr;
    job.text = TakeString(macula_pool_providers(h, Ptr(realm), C(procedure), timeout, 0, &errOut));
    job.Fail(errOut);
  });
}

// poolPublish(pool, realm, topic, payloadJson, ttlMs)
Napi::Value PoolPublish(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> realm;
  if (!ok || !Arg32(info, 1, false, &realm)) return info.Env().Null();
  std::string topic = ArgString(info, 2), payload = ArgString(info, 3);
  int64_t ttl = ArgInt(info, 4);
  return Queue(info.Env(), Job::Result::kVoid, [=](Job& job) mutable {
    char* errOut = nullptr;
    macula_pool_publish(h, Ptr(realm), C(topic), C(payload), ttl, &errOut);
    job.Fail(errOut);
  });
}

// poolSubscribe(pool, realm, topic, callback) -> Promise<handle>; the callback
// gets {kind: "event", json} per event and, last, {kind: "closed", json: why,
// or "" when it ended as asked}.
Napi::Value PoolSubscribe(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> realm;
  if (!ok || !Arg32(info, 1, false, &realm) || !RequireFunction(info, 3)) return info.Env().Null();
  std::string topic = ArgString(info, 2);
  return StartListener(info, 3, Poller::Kind::kSubscription, "macula-subscription", [=](char** errOut) mutable {
    return macula_pool_subscribe(h, Ptr(realm), C(topic), errOut);
  });
}

Napi::Value SubscriptionStop(const Napi::CallbackInfo& info) {
  return StopListener(info, [](macula_handle h, char**) { macula_subscription_stop(h); });
}

// poolFindRecord(pool, key, timeoutMs)
Napi::Value PoolFindRecord(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> key;
  if (!ok || !Arg32(info, 1, false, &key)) return info.Env().Null();
  int64_t timeout = ArgInt(info, 2);
  return Queue(info.Env(), Job::Result::kString, [=](Job& job) mutable {
    char* errOut = nullptr;
    job.text = TakeString(macula_pool_find_record(h, Ptr(key), timeout, 0, &errOut));
    job.Fail(errOut);
  });
}

Napi::Value PoolFindRecords(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> key;
  if (!ok || !Arg32(info, 1, false, &key)) return info.Env().Null();
  int64_t timeout = ArgInt(info, 2);
  return Queue(info.Env(), Job::Result::kString, [=](Job& job) mutable {
    char* errOut = nullptr;
    job.text = TakeString(macula_pool_find_records(h, Ptr(key), timeout, 0, &errOut));
    job.Fail(errOut);
  });
}

// poolFindRecordsByType(pool, type, timeoutMs)
Napi::Value PoolFindRecordsByType(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  int32_t type = static_cast<int32_t>(ArgInt(info, 1));
  int64_t timeout = ArgInt(info, 2);
  return Queue(info.Env(), Job::Result::kString, [=](Job& job) {
    char* errOut = nullptr;
    job.text = TakeString(macula_pool_find_records_by_type(h, type, timeout, 0, &errOut));
    job.Fail(errOut);
  });
}

// poolPutRecord(pool, wire, timeoutMs)
Napi::Value PoolPutRecord(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  std::vector<uint8_t> wire = ArgBytes(info, 1);
  int64_t timeout = ArgInt(info, 2);
  return Queue(info.Env(), Job::Result::kVoid, [=](Job& job) mutable {
    char* errOut = nullptr;
    macula_pool_put_record(h, Ptr(wire), wire.size(), timeout, 0, &errOut);
    job.Fail(errOut);
  });
}

// --- content ------------------------------------------------------------

// poolShareContent(pool, realm, data, name, timeoutMs) -> Promise<Buffer> (the
// content id, 50 bytes).
Napi::Value PoolShareContent(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> realm;
  if (!ok || !Arg32(info, 1, false, &realm)) return info.Env().Null();
  std::vector<uint8_t> data = ArgBytes(info, 2);
  std::string name = ArgString(info, 3);
  int64_t timeout = ArgInt(info, 4);
  return Queue(info.Env(), Job::Result::kBytes, [=](Job& job) mutable {
    char* errOut = nullptr;
    uint8_t mcid[50];
    macula_pool_share_content(h, Ptr(realm), Ptr(data), data.size(), C(name), timeout, 0, mcid, &errOut);
    job.bytes.assign(mcid, mcid + 50);
    job.Fail(errOut);
  });
}

// poolUnshareContent(pool, realm, mcid, timeoutMs)
Napi::Value PoolUnshareContent(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> realm, mcid;
  if (!ok || !Arg32(info, 1, false, &realm) || !ArgFixed(info, 2, 50, false, &mcid)) return info.Env().Null();
  int64_t timeout = ArgInt(info, 3);
  return Queue(info.Env(), Job::Result::kVoid, [=](Job& job) mutable {
    char* errOut = nullptr;
    macula_pool_unshare_content(h, Ptr(realm), Ptr(mcid), timeout, 0, &errOut);
    job.Fail(errOut);
  });
}

// poolGetContent(pool, realm, mcid, optionsJson, timeoutMs) -> Promise<Buffer>
Napi::Value PoolGetContent(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> realm, mcid;
  if (!ok || !Arg32(info, 1, false, &realm) || !ArgFixed(info, 2, 50, false, &mcid)) return info.Env().Null();
  std::string options = ArgString(info, 3);
  int64_t timeout = ArgInt(info, 4);
  return Queue(info.Env(), Job::Result::kBytes, [=](Job& job) mutable {
    size_t len = 0;
    char* errOut = nullptr;
    uint8_t* out = macula_pool_get_content(h, Ptr(realm), Ptr(mcid), options.empty() ? nullptr : C(options), timeout,
                                           0, &len, &errOut);
    if (out != nullptr) {
      job.bytes.assign(out, out + len);
      macula_free_bytes(out);
    }
    job.Fail(errOut);
  });
}

// --- serving ------------------------------------------------------------

// poolServe(pool, realm, procedure, callback) -> Promise<handle>; the callback
// gets {kind: "request", handle, json} per CALL, handle the pending call.
Napi::Value PoolServe(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> realm;
  if (!ok || !Arg32(info, 1, false, &realm) || !RequireFunction(info, 3)) return info.Env().Null();
  std::string procedure = ArgString(info, 2);
  return StartListener(info, 3, Poller::Kind::kServed, "macula-serve", [=](char** errOut) mutable {
    return macula_pool_serve(h, Ptr(realm), C(procedure), errOut);
  });
}

// poolServeStream(pool, realm, procedure, mode, callback) -> Promise<handle>;
// the callback gets {kind: "request", handle, json} per session, handle a
// stream.
Napi::Value PoolServeStream(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> realm;
  if (!ok || !Arg32(info, 1, false, &realm) || !RequireFunction(info, 4)) return info.Env().Null();
  std::string procedure = ArgString(info, 2);
  int32_t mode = static_cast<int32_t>(ArgInt(info, 3));
  return StartListener(info, 4, Poller::Kind::kServed, "macula-serve-stream", [=](char** errOut) mutable {
    return macula_pool_serve_stream(h, Ptr(realm), C(procedure), mode, errOut);
  });
}

Napi::Value PendingReply(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  macula_handle h = ToHandle(env, info[0], &ok);
  if (!ok) return env.Null();
  std::string json = ArgString(info, 1);
  char* errOut = nullptr;
  macula_pending_reply(h, C(json), &errOut);
  ThrowIfErr(env, errOut);
  return env.Undefined();
}

Napi::Value PendingError(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  macula_handle h = ToHandle(env, info[0], &ok);
  if (!ok) return env.Null();
  std::string message = ArgString(info, 1);
  char* errOut = nullptr;
  macula_pending_error(h, C(message), &errOut);
  ThrowIfErr(env, errOut);
  return env.Undefined();
}

Napi::Value ServedStop(const Napi::CallbackInfo& info) {
  return StopListener(info, [](macula_handle h, char** errOut) { macula_served_stop(h, errOut); });
}

// --- streams ------------------------------------------------------------

// poolOpenStream(pool, realm, procedure, mode, payloadJson, provider|null, deadlineMs, timeoutMs)
Napi::Value PoolOpenStream(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  std::vector<uint8_t> realm, provider;
  if (!ok || !Arg32(info, 1, false, &realm) || !Arg32(info, 5, true, &provider)) return info.Env().Null();
  std::string procedure = ArgString(info, 2), payload = ArgString(info, 4);
  int32_t mode = static_cast<int32_t>(ArgInt(info, 3));
  int64_t deadline = ArgInt(info, 6), timeout = ArgInt(info, 7);
  return Queue(info.Env(), Job::Result::kHandle, [=](Job& job) mutable {
    char* errOut = nullptr;
    job.handle = macula_pool_open_stream(h, Ptr(realm), C(procedure), mode, C(payload), Ptr(provider), deadline,
                                         timeout, 0, &errOut);
    job.Fail(errOut);
  });
}

Napi::Value StreamSendBytes(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
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
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  std::string json = ArgString(info, 1);
  return Queue(info.Env(), Job::Result::kVoid, [=](Job& job) {
    char* errOut = nullptr;
    macula_stream_send_json(h, C(json), &errOut);
    job.Fail(errOut);
  });
}

Napi::Value StreamCloseSend(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  return Queue(info.Env(), Job::Result::kVoid, [h](Job& job) {
    char* errOut = nullptr;
    macula_stream_close_send(h, &errOut);
    job.Fail(errOut);
  });
}

Napi::Value StreamClose(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  return Queue(info.Env(), Job::Result::kVoid, [h](Job& job) {
    char* errOut = nullptr;
    macula_stream_close(h, &errOut);
    job.Fail(errOut);
  });
}

Napi::Value StreamReply(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  std::string json = ArgString(info, 1);
  return Queue(info.Env(), Job::Result::kVoid, [=](Job& job) {
    char* errOut = nullptr;
    macula_stream_reply(h, C(json), &errOut);
    job.Fail(errOut);
  });
}

Napi::Value StreamAbort(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  std::string code = ArgString(info, 1), message = ArgString(info, 2);
  return Queue(info.Env(), Job::Result::kVoid, [=](Job& job) {
    char* errOut = nullptr;
    macula_stream_abort(h, C(code), C(message), &errOut);
    job.Fail(errOut);
  });
}

// streamRecv(stream, timeoutMs) -> Promise<json>
Napi::Value StreamRecv(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  int64_t timeout = ArgInt(info, 1);
  return Queue(info.Env(), Job::Result::kString, [=](Job& job) {
    char* errOut = nullptr;
    job.text = TakeString(macula_stream_recv(h, timeout, 0, &errOut));
    job.Fail(errOut);
  });
}

Napi::Value StreamRequest(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  bool ok = false;
  macula_handle h = ToHandle(env, info[0], &ok);
  if (!ok) return env.Null();
  char* errOut = nullptr;
  char* json = macula_stream_request(h, &errOut);
  if (ThrowIfErr(env, errOut)) return env.Null();
  return Napi::String::New(env, TakeString(json));
}

Napi::Value StreamFree(const Napi::CallbackInfo& info) {
  bool ok = false;
  macula_handle h = ToHandle(info.Env(), info[0], &ok);
  if (!ok) return info.Env().Null();
  return Queue(info.Env(), Job::Result::kVoid, [h](Job&) { macula_stream_free(h); });
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  // A library built for another ABI is refused before anything uses it.
  int32_t abi = macula_abi_version();
  if (abi != MACULA_ABI_VERSION) {
    Napi::Error::New(env, "macula-ts: libmacula is ABI " + std::to_string(abi) + ", this addon binds ABI " +
                              std::to_string(MACULA_ABI_VERSION))
        .ThrowAsJavaScriptException();
    return exports;
  }
  exports.Set("abiVersion", Napi::Number::New(env, abi));
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
