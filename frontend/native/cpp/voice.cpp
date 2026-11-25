#include "korero-native/src/media.rs.h"

#include "mediasoupclient.hpp"
#include "api/audio/create_audio_device_module.h"
#include "api/audio_codecs/builtin_audio_decoder_factory.h"
#include "api/audio_codecs/builtin_audio_encoder_factory.h"
#include "api/create_peerconnection_factory.h"
#include "api/environment/environment_factory.h"
#include "api/make_ref_counted.h"
#include "api/video_codecs/builtin_video_decoder_factory.h"
#include "api/video_codecs/builtin_video_encoder_factory.h"
#include "modules/audio_device/include/audio_device_default.h"
#include "api/audio_options.h"
#include "rtc_base/thread.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <stdexcept>
#include <thread>
#include <unordered_map>

#ifdef __ANDROID__
#include "sdk/android/native_api/audio_device_module/audio_device_android.h"
#include "sdk/android/native_api/jni/class_loader.h"
#include "sdk/android/native_api/jni/jvm.h"
#include "sdk/android/src/jni/jvm.h"
#include <mutex>
#endif

namespace korero {
namespace {
using nlohmann::json;
using namespace std::chrono_literals;
#ifdef __ANDROID__
std::atomic<jobject> application_context{nullptr};
std::mutex jni_setup;
#endif

std::string as_string(rust::Str text) {
  return {text.data(), text.size()};
}

class ProbeAudio : public webrtc::webrtc_impl::AudioDeviceModuleDefault<webrtc::AudioDeviceModule> {
public:
  ~ProbeAudio() override { Terminate(); }

  int32_t RegisterAudioCallback(webrtc::AudioTransport* callback) override {
    callback_.store(callback);
    return 0;
  }

  int32_t Init() override {
    if (!pump_.joinable()) {
      pump_ = std::jthread([this](std::stop_token stop) { pump(stop); });
    }
    return 0;
  }
  int32_t Terminate() override {
    if (pump_.joinable()) {
      pump_.request_stop();
      pump_.join();
    }
    return 0;
  }
  int16_t PlayoutDevices() override { return 1; }
  int16_t RecordingDevices() override { return 1; }
  int32_t PlayoutIsAvailable(bool* available) override { *available = true; return 0; }
  int32_t RecordingIsAvailable(bool* available) override { *available = true; return 0; }
  int32_t StartPlayout() override { playing_.store(true); return 0; }
  int32_t StartRecording() override { recording_.store(true); return 0; }
  int32_t StopPlayout() override { playing_.store(false); return 0; }
  int32_t StopRecording() override { recording_.store(false); return 0; }
  bool Playing() const override { return playing_.load(); }
  bool Recording() const override { return recording_.load(); }
  double peak() const { return peak_.load() / 32768.0; }

private:
  void pump(std::stop_token stop) {
    constexpr uint32_t rate = 48000;
    std::array<int16_t, rate / 100> input{}, output{};
    double phase = 0;
    auto tick = std::chrono::steady_clock::now();
    while (!stop.stop_requested()) {
      if (auto* callback = callback_.load()) {
        if (recording_.load()) {
          for (auto& sample : input) {
            sample = static_cast<int16_t>(9000 * std::sin(phase));
            phase = std::fmod(phase + 2 * 3.141592653589793 * 440 / rate, 2 * 3.141592653589793);
          }
          uint32_t level = 0;
          callback->RecordedDataIsAvailable(input.data(), input.size(), sizeof(int16_t),
                                           1, rate, 0, 0, 0, false, level);
        }
        if (playing_.load()) {
          size_t count = 0;
          int64_t time = 0, ntp = 0;
          callback->NeedMorePlayData(output.size(), sizeof(int16_t), 1, rate,
                                     output.data(), count, &time, &ntp);
          for (size_t i = 0; i < std::min(count, output.size()); ++i) {
            const int sample = std::abs(static_cast<int>(output[i]));
            if (sample > peak_.load()) peak_.store(sample);
          }
        }
      }
      tick += 10ms;
      std::this_thread::sleep_until(tick);
    }
  }

  std::atomic<webrtc::AudioTransport*> callback_{nullptr};
  std::atomic<bool> recording_{false}, playing_{false};
  std::atomic<int> peak_{0};
  std::jthread pump_;
};

class Listeners : public mediasoupclient::SendTransport::Listener,
                  public mediasoupclient::RecvTransport::Listener,
                  public mediasoupclient::Producer::Listener,
                  public mediasoupclient::Consumer::Listener {
public:
  explicit Listeners(rust::Box<Rpc> rpc) : rpc_(std::move(rpc)) {}

  json call(rust::Str method, const json& body) {
    const auto text = body.dump();
    const auto reply = rpc_call(*rpc_, method, rust::Str(text.data(), text.size()));
    return json::parse(reply.data(), reply.data() + reply.size());
  }

  std::future<void> OnConnect(mediasoupclient::Transport* transport, const json& dtls) override {
    std::promise<void> result;
    try {
      call("media.transport.connect", {{"transportId", transport->GetId()}, {"dtlsParameters", dtls}});
      result.set_value();
    } catch (...) {
      result.set_exception(std::current_exception());
    }
    return result.get_future();
  }

  std::future<std::string> OnProduce(mediasoupclient::SendTransport* transport,
      const std::string& kind, json rtp, const json&) override {
    std::promise<std::string> result;
    try {
      const auto response = call("media.producer.create", {
        {"transportId", transport->GetId()}, {"kind", kind}, {"rtpParameters", std::move(rtp)}
      });
      result.set_value(response.at("id").get<std::string>());
    } catch (...) {
      result.set_exception(std::current_exception());
    }
    return result.get_future();
  }

  std::future<std::string> OnProduceData(mediasoupclient::SendTransport*, const json&,
      const std::string&, const std::string&, const json&) override {
    std::promise<std::string> result;
    result.set_exception(std::make_exception_ptr(std::runtime_error("Data channels are disabled")));
    return result.get_future();
  }

  void OnConnectionStateChange(mediasoupclient::Transport*, const std::string&) override {}
  void OnTransportClose(mediasoupclient::Producer*) override {}
  void OnTransportClose(mediasoupclient::Consumer*) override {}

private:
  rust::Box<Rpc> rpc_;
};

struct Runtime {
  Runtime() { mediasoupclient::Initialize(); }
  ~Runtime() { mediasoupclient::Cleanup(); }
};

webrtc::PeerConnectionInterface::IceServers parse_ice_servers(const json& servers) {
  webrtc::PeerConnectionInterface::IceServers out;
  if (!servers.is_array()) return out;
  for (const auto& item : servers) {
    webrtc::PeerConnectionInterface::IceServer server;
    const auto& urls = item.at("urls");
    if (urls.is_array()) server.urls = urls.get<std::vector<std::string>>();
    else server.urls = {urls.get<std::string>()};
    server.username = item.value("username", "");
    server.password = item.value("credential", "");
    out.push_back(std::move(server));
  }
  return out;
}
}  // namespace

struct Voice::Impl {
  Impl(rust::Box<Rpc> rpc, const json& capabilities, const json& ice, bool synthetic)
      : network(webrtc::Thread::CreateWithSocketServer()), worker(webrtc::Thread::Create()),
        signaling(webrtc::Thread::Create()), listeners(std::move(rpc)) {
    static const Runtime runtime;
    if (!network->Start() || !worker->Start() || !signaling->Start()) {
      throw std::runtime_error("Could not start WebRTC threads");
    }

    adm = worker->BlockingCall([&]() -> webrtc::scoped_refptr<webrtc::AudioDeviceModule> {
      if (synthetic) {
        probe = webrtc::make_ref_counted<ProbeAudio>();
        return probe;
      }
#ifdef __ANDROID__
      const auto context = application_context.load();
      if (!context) throw std::runtime_error("Android microphone service has not started");
      return webrtc::CreateJavaAudioDeviceModule(webrtc::AttachCurrentThreadIfNeeded(), environment, context);
#else
      return webrtc::CreateAudioDeviceModule(environment, webrtc::AudioDeviceModule::kPlatformDefaultAudio);
#endif
    });
    if (!adm) throw std::runtime_error("Could not initialize system audio");
    factory = webrtc::CreatePeerConnectionFactory(network.get(), worker.get(), signaling.get(), adm,
        webrtc::CreateBuiltinAudioEncoderFactory(), webrtc::CreateBuiltinAudioDecoderFactory(),
        webrtc::CreateBuiltinVideoEncoderFactory(), webrtc::CreateBuiltinVideoDecoderFactory(),
        nullptr, nullptr);
    if (!factory) throw std::runtime_error("Could not initialize the WebRTC factory");
    options.factory = factory.get();
    options.config.servers = parse_ice_servers(ice);
    device.Load(capabilities, &options);
  }

  void stop_send() {
    if (!send) return;
    if (producer) {
      producer->Close();
      producer.reset();
    }
    send->Close();
    send.reset();
    track = nullptr;
  }

  void stop_receive() {
    for (auto& [id, consumer] : consumers) consumer->Close();
    consumers.clear();
    if (!receive) return;
    receive->Close();
    receive.reset();
  }

  ~Impl() {
    stop_send();
    stop_receive();
  }

  std::unique_ptr<webrtc::Thread> network, worker, signaling;
  webrtc::Environment environment = webrtc::CreateEnvironment();
  webrtc::scoped_refptr<ProbeAudio> probe;
  webrtc::scoped_refptr<webrtc::AudioDeviceModule> adm;
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory;
  mediasoupclient::PeerConnection::Options options;
  Listeners listeners;
  mediasoupclient::Device device;
  webrtc::scoped_refptr<webrtc::AudioTrackInterface> track;
  std::unique_ptr<mediasoupclient::SendTransport> send;
  std::unique_ptr<mediasoupclient::RecvTransport> receive;
  std::unique_ptr<mediasoupclient::Producer> producer;
  std::unordered_map<std::string, std::unique_ptr<mediasoupclient::Consumer>> consumers;
};

Voice::Voice(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
Voice::~Voice() = default;

rust::String Voice::capabilities() const {
  auto rtp = impl_->device.GetRtpCapabilities();
  // The server accepts an audio-only capabilities document.
  for (const auto* key : {"codecs", "headerExtensions"}) {
    auto entries = json::array();
    for (const auto& item : rtp[key]) {
      if (item.value("kind", "") == "audio") entries.push_back(item);
    }
    rtp[key] = std::move(entries);
  }
  const auto text = rtp.dump();
  return rust::String(text.data(), text.size());
}

void Voice::set_send(rust::Str transport) {
  impl_->stop_send();
  if (transport.empty()) return;
  const auto p = json::parse(as_string(transport));
  impl_->send.reset(impl_->device.CreateSendTransport(&impl_->listeners, p.at("id"),
      p.at("iceParameters"), p.at("iceCandidates"), p.at("dtlsParameters"), &impl_->options));
  const bool recording = impl_->worker->BlockingCall([&] {
    bool available = false;
    return impl_->adm->RecordingIsAvailable(&available) == 0 && available;
  });
  if (!recording) throw std::runtime_error("No microphone is available");
  webrtc::AudioOptions capture_options;
  if (impl_->probe) {
    capture_options.echo_cancellation = false;
    capture_options.auto_gain_control = false;
    capture_options.noise_suppression = false;
  }
  const auto source = impl_->factory->CreateAudioSource(capture_options);
  impl_->track = impl_->factory->CreateAudioTrack("korero-microphone", source.get());
  if (!impl_->track) throw std::runtime_error("Could not create the microphone track");
  const json codec = {{"opusDtx", true}, {"opusFec", true}, {"opusStereo", false},
                      {"opusMaxAverageBitrate", p.value("bitrate", uint32_t{48000})}, {"opusPtime", uint32_t{20}}};
  impl_->producer.reset(impl_->send->Produce(&impl_->listeners, impl_->track.get(), nullptr, &codec, nullptr));
}

void Voice::set_receive(rust::Str transport) {
  impl_->stop_receive();
  if (transport.empty()) return;
  const auto p = json::parse(as_string(transport));
  impl_->receive.reset(impl_->device.CreateRecvTransport(&impl_->listeners, p.at("id"),
      p.at("iceParameters"), p.at("iceCandidates"), p.at("dtlsParameters"), &impl_->options));
}

void Voice::consume(rust::Str parameters) {
  if (!impl_->receive) throw std::runtime_error("Receive transport is closed");
  const auto p = json::parse(as_string(parameters));
  const auto id = p.at("producerId").get<std::string>();
  auto rtp = p.at("rtpParameters");
  std::unique_ptr<mediasoupclient::Consumer> consumer(impl_->receive->Consume(
      &impl_->listeners, p.at("id"), id, p.at("kind"), &rtp));
  impl_->consumers.emplace(id, std::move(consumer));
}

void Voice::close_consumer(rust::Str producer_id) {
  const auto found = impl_->consumers.find(as_string(producer_id));
  if (found != impl_->consumers.end()) {
    found->second->Close();
    impl_->consumers.erase(found);
  }
}

double Voice::peak() const { return impl_->probe ? impl_->probe->peak() : 0.0; }

std::unique_ptr<Voice> make_voice(rust::Box<Rpc> rpc, rust::Str capabilities,
                                 rust::Str ice_servers, bool synthetic) {
  return std::make_unique<Voice>(std::make_unique<Voice::Impl>(std::move(rpc),
      json::parse(as_string(capabilities)), json::parse(as_string(ice_servers)), synthetic));
}
bool initialize_android(size_t env_handle, size_t context_handle) noexcept {
#ifdef __ANDROID__
  std::lock_guard lock(jni_setup);
  if (application_context.load()) return true;
  auto* env = reinterpret_cast<JNIEnv*>(env_handle);
  JavaVM* vm = nullptr;
  if (!env || !context_handle || env->GetJavaVM(&vm) != JNI_OK) return false;
  if (webrtc::jni::InitGlobalJniVariables(vm) < 0) return false;
  webrtc::InitClassLoader(env);
  application_context.store(env->NewGlobalRef(reinterpret_cast<jobject>(context_handle)));
  return application_context.load() != nullptr;
#else
  (void)env_handle;
  (void)context_handle;
  return false;
#endif
}
}  // namespace korero
