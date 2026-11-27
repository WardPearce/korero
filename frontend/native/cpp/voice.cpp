#include "korero-native/src/media.rs.h"

#include "mediasoupclient.hpp"
#include "api/audio/create_audio_device_module.h"
#include "api/audio/builtin_audio_processing_builder.h"
#include "modules/audio_processing/audio_buffer.h"
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
#include <mutex>
#include <thread>
#include <unordered_map>


namespace korero {
namespace {
using nlohmann::json;
using namespace std::chrono_literals;

std::string as_string(rust::Str text) {
  return {text.data(), text.size()};
}

std::mutex profile_mutex;
json profile = json::object();
std::atomic<int64_t> talk_until{0};
std::atomic<int64_t> whisper_until{0};

int64_t monotonic_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count();
}

json audio_profile() {
  const std::lock_guard lock(profile_mutex);
  return profile;
}

auto system_audio(const webrtc::Environment& environment) {
  return webrtc::CreateAudioDeviceModule(environment, webrtc::AudioDeviceModule::kPlatformDefaultAudio);
}

json list_devices(webrtc::AudioDeviceModule& adm, bool input) {
  auto devices = json::array();
  const int count = input ? adm.RecordingDevices() : adm.PlayoutDevices();
  for (int index = 0; index < count; ++index) {
    char name[webrtc::kAdmMaxDeviceNameSize]{};
    char guid[webrtc::kAdmMaxGuidSize]{};
    const int result = input ? adm.RecordingDeviceName(index, name, guid) : adm.PlayoutDeviceName(index, name, guid);
    if (result != 0 || !name[0]) continue;
    const std::string label(name);
    if (label == "default" || label == "Default") continue;
    const std::string id = guid[0] ? guid : label;
    if (std::any_of(devices.begin(), devices.end(), [&](const auto& device) { return device["id"] == id; })) continue;
    devices.push_back({{"id", id}, {"label", label}, {"index", index}});
  }
  return devices;
}

void select_device(webrtc::AudioDeviceModule& adm, bool input, const std::string& id) {
  if (id.empty()) return;
  for (const auto& device : list_devices(adm, input)) {
    if (device["id"] != id) continue;
    const auto index = device["index"].get<uint16_t>();
    const auto result = input ? adm.SetRecordingDevice(index) : adm.SetPlayoutDevice(index);
    if (result != 0) throw std::runtime_error(input ? "Could not select microphone" : "Could not select playback device");
    return;
  }
  // A disconnected device falls back to the system default and can be selected again when it returns.
}

constexpr int kCaptureBlockMs = 10;
constexpr float kFullScale = 32768.0f;

float db_to_gain(float db) { return std::pow(10.0f, db / 20.0f); }

class CaptureControls final : public webrtc::CustomProcessing {
public:
  explicit CaptureControls(const json& settings, const std::atomic<bool>* whisper_route = nullptr)
      : mode_(settings.value("transmitMode", "open")),
        gain_(settings.value("inputLevel", 100) / 100.0f),
        activity_threshold_(settings.value("activityThreshold", 8) * kFullScale / 100.0f),
        activity_hold_(hold_frames(settings.value("activityHoldMs", 250))),
        gate_enabled_(settings.value("noiseGate", false)),
        gate_threshold_(db_to_gain(settings.value("gateThresholdDb", -45)) * kFullScale),
        gate_close_threshold_(gate_threshold_ * db_to_gain(-3)),
        closed_gain_(db_to_gain(-settings.value("gateAttenuationDb", 30))),
        gate_hold_(hold_frames(settings.value("gateHoldMs", 150))),
        whisper_route_(whisper_route), gate_gain_(closed_gain_) {}

  void Initialize(int, int) override {
    activity_frames_ = 0;
    gate_frames_ = 0;
    gate_open_ = false;
    gate_gain_ = closed_gain_;
  }
  std::string ToString() const override { return "Kōrero capture controls"; }
  double input_peak() const { return std::min(1.0f, input_peak_ / kFullScale); }

  void Process(webrtc::AudioBuffer* audio) override {
    const auto frames = audio->num_frames();
    auto* const* samples = audio->channels();
    float peak = 0;
    if (gate_enabled_ || mode_ == "activity" || !whisper_route_) {
      for (size_t channel = 0; channel < audio->num_channels(); ++channel)
        for (size_t frame = 0; frame < frames; ++frame)
          peak = std::max(peak, std::abs(samples[channel][frame]));
      peak *= gain_;
    }
    if (!whisper_route_) input_peak_ = std::max(input_peak_, peak);

    if (!transmitting(peak)) {
      gate_frames_ = 0;
      gate_open_ = false;
      gate_gain_ = closed_gain_;
      for (size_t channel = 0; channel < audio->num_channels(); ++channel)
        std::fill_n(samples[channel], frames, 0.0f);
      return;
    }

    float target = 1;
    float start = 1;
    if (gate_enabled_) {
      // A slightly lower closing threshold prevents rapid toggling near the boundary.
      const float threshold = gate_open_ ? gate_close_threshold_ : gate_threshold_;
      if (peak >= threshold) {
        gate_open_ = true;
        gate_frames_ = gate_hold_;
      } else {
        gate_open_ = gate_frames_ > 0;
        if (gate_open_) --gate_frames_;
      }
      target = gate_open_ ? 1.0f : closed_gain_;
      start = gate_gain_;
      gate_gain_ = target;
    }
    const float step = (target - start) / frames;
    for (size_t channel = 0; channel < audio->num_channels(); ++channel)
      for (size_t frame = 0; frame < frames; ++frame)
        samples[channel][frame] *= gain_ * (start + step * (frame + 1));
  }

private:
  static int hold_frames(int ms) {
    return (ms + kCaptureBlockMs - 1) / kCaptureBlockMs;
  }

  bool transmitting(float peak) {
    if (whisper_route_) {
      const auto now = monotonic_ms();
      const bool whispering = now < whisper_until.load();
      const bool routed_to_whisper = whisper_route_->load();
      if (whispering || routed_to_whisper) {
        activity_frames_ = 0;
        return whispering && routed_to_whisper;
      }
      if (mode_ == "pushToTalk") return now < talk_until.load();
    }
    if (mode_ != "activity") return true;
    if (peak >= activity_threshold_) {
      activity_frames_ = activity_hold_;
      return true;
    }
    if (activity_frames_ == 0) return false;
    --activity_frames_;
    return true;
  }

  std::string mode_;
  float gain_, activity_threshold_;
  int activity_hold_;
  bool gate_enabled_;
  float gate_threshold_, gate_close_threshold_, closed_gain_;
  int gate_hold_;
  const std::atomic<bool>* whisper_route_;
  float gate_gain_;
  float input_peak_ = 0;
  bool gate_open_ = false;
  int activity_frames_ = 0;
  int gate_frames_ = 0;
};

#ifndef __ANDROID__
class MicrophoneRecorder final : public webrtc::AudioTransport {
public:
  MicrophoneRecorder(const webrtc::Environment& environment, const json& settings) {
    webrtc::AudioProcessing::Config config;
    config.high_pass_filter.enabled = true;
    config.noise_suppression.enabled = settings.value("noiseSuppression", true);
    config.noise_suppression.level = webrtc::AudioProcessing::Config::NoiseSuppression::kHigh;
    config.gain_controller1.enabled = settings.value("automaticGain", true);
    config.gain_controller1.mode = webrtc::AudioProcessing::Config::GainController1::kAdaptiveDigital;

    auto builder = webrtc::BuiltinAudioProcessingBuilder(config);
    auto controls = std::make_unique<CaptureControls>(settings);
    controls_ = controls.get();
    builder.SetCapturePostProcessing(std::move(controls));
    processing_ = builder.Build(environment);
    if (!processing_) throw std::runtime_error("Could not initialize microphone processing");
    sample_.pcm.reserve(kSampleRate * 3);
  }

  int32_t RecordedDataIsAvailable(const void* data, size_t frames, size_t,
      size_t channels, uint32_t rate, uint32_t, int32_t, uint32_t current, bool, uint32_t& next) override {
    next = current;
    if (sample_.pcm.size() >= kSampleRate * 3 || frames != rate / 100) return 0;
    std::array<int16_t, kSampleRate / 100> block{};
    const int status = processing_->ProcessStream(static_cast<const int16_t*>(data),
        webrtc::StreamConfig(rate, channels), webrtc::StreamConfig(kSampleRate, 1), block.data());
    if (status != 0) return status;
    for (const auto value : block) sample_.pcm.push_back(value);
    return 0;
  }
  int32_t NeedMorePlayData(size_t frames, size_t bytes, size_t, uint32_t, void* data,
      size_t& out, int64_t*, int64_t*) override {
    std::fill_n(static_cast<uint8_t*>(data), frames * bytes, 0);
    out = frames;
    return 0;
  }
  void PullRenderData(int, int, size_t, size_t, void*, int64_t*, int64_t*) override {}

  MicrophoneSample finish() {
    if (sample_.pcm.empty()) throw std::runtime_error("No microphone samples were captured");
    sample_.gate_peak = controls_->input_peak();
    sample_.sample_rate = kSampleRate;
    return std::move(sample_);
  }

private:
  static constexpr uint32_t kSampleRate = 48000;
  CaptureControls* controls_;
  webrtc::scoped_refptr<webrtc::AudioProcessing> processing_;
  MicrophoneSample sample_{};
};
#endif

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
        signaling(webrtc::Thread::Create()), settings(synthetic ? json::object() : audio_profile()), listeners(std::move(rpc)) {
    static const Runtime runtime;
    if (!network->Start() || !worker->Start() || !signaling->Start()) {
      throw std::runtime_error("Could not start WebRTC threads");
    }

    adm = worker->BlockingCall([&]() -> webrtc::scoped_refptr<webrtc::AudioDeviceModule> {
      if (synthetic) {
        probe = webrtc::make_ref_counted<ProbeAudio>();
        return probe;
      }
      return system_audio(environment);
    });
    if (!adm) throw std::runtime_error("Could not initialize system audio");
    webrtc::scoped_refptr<webrtc::AudioProcessing> processing;
    if (!synthetic) {
      auto builder = webrtc::BuiltinAudioProcessingBuilder();
      builder.SetCapturePostProcessing(std::make_unique<CaptureControls>(settings, &whisper_route));
      processing = builder.Build(environment);
    }
    factory = webrtc::CreatePeerConnectionFactory(network.get(), worker.get(), signaling.get(), adm,
        webrtc::CreateBuiltinAudioEncoderFactory(), webrtc::CreateBuiltinAudioDecoderFactory(),
        webrtc::CreateBuiltinVideoEncoderFactory(), webrtc::CreateBuiltinVideoDecoderFactory(),
        nullptr, processing);
#ifndef __ANDROID__
    if (!synthetic) worker->BlockingCall([&] {
      select_device(*adm, true, settings.value("input", ""));
      select_device(*adm, false, settings.value("output", ""));
    });
#endif
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
    whisper_route.store(false);
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
  std::atomic<bool> whisper_route{false};
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory;
  mediasoupclient::PeerConnection::Options options;
  json settings;
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
  impl_->whisper_route.store(p.value("whisper", false));
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
  } else {
    capture_options.echo_cancellation = impl_->settings.value("echoCancellation", true);
    capture_options.auto_gain_control = impl_->settings.value("automaticGain", true);
    capture_options.noise_suppression = impl_->settings.value("noiseSuppression", true);
  }
  const auto source = impl_->factory->CreateAudioSource(capture_options);
  impl_->track = impl_->factory->CreateAudioTrack("korero-microphone", source.get());
  if (!impl_->track) throw std::runtime_error("Could not create the microphone track");
  const json codec = {{"opusDtx", true}, {"opusFec", true}, {"opusStereo", false},
                      {"opusMaxAverageBitrate", uint32_t{128000}}, {"opusPtime", uint32_t{20}}};
  impl_->producer.reset(impl_->send->Produce(&impl_->listeners, impl_->track.get(), nullptr, &codec, nullptr));
  set_bitrate(p.at("bitrate").get<uint32_t>());
}

void Voice::set_bitrate(uint32_t bitrate) {
  auto* sender = impl_->producer->GetRtpSender();
  auto parameters = sender->GetParameters();
  parameters.encodings.at(0).max_bitrate_bps = bitrate;
  const auto result = sender->SetParameters(parameters);
  if (!result.ok()) throw std::runtime_error(result.message());
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
  set_consumer_volume(rust::Str(id.data(), id.size()), p.value("volumeLevel", uint16_t{100}));
}

void Voice::set_consumer_volume(rust::Str producer_id, uint16_t level) {
  if (impl_->probe) return;
  const auto found = impl_->consumers.find(as_string(producer_id));
  if (found != impl_->consumers.end()) {
    auto* track = static_cast<webrtc::AudioTrackInterface*>(found->second->GetTrack());
    const double output = impl_->settings.value("outputLevel", 100) / 100.0;
    track->GetSource()->SetVolume(output * (level / 100.0));
  }
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
void set_audio_profile(rust::Str settings) {
  const std::lock_guard lock(profile_mutex);
  auto next = json::parse(as_string(settings));
  if (profile != next) talk_until.store(0);
  profile = std::move(next);
}

void set_push_to_talk(bool pressed) noexcept {
  talk_until.store(pressed ? monotonic_ms() + 650 : 0);
}

void set_whisper_to_talk(bool pressed) noexcept {
  whisper_until.store(pressed ? monotonic_ms() + 650 : 0);
}

rust::String audio_devices() {
  auto environment = webrtc::CreateEnvironment();
  auto adm = system_audio(environment);
  if (!adm || adm->Init() != 0) throw std::runtime_error("System audio is unavailable");
  auto input = list_devices(*adm, true);
  auto output = list_devices(*adm, false);
  bool recording = !input.empty() || adm->RecordingDevices() > 0;
  adm->Terminate();
  const auto text = json({{"input", input}, {"output", output}, {"micTest", recording}}).dump();
  return rust::String(text.data(), text.size());
}

MicrophoneSample test_microphone() {
  const auto settings = audio_profile();
  auto environment = webrtc::CreateEnvironment();
  MicrophoneRecorder recorder(environment, settings);
  auto adm = system_audio(environment);
  if (!adm || adm->Init() != 0) throw std::runtime_error("System audio is unavailable");
  try {
    if (adm->SetRecordingDevice(uint16_t{0}) != 0) throw std::runtime_error("No microphone is available");
    select_device(*adm, true, settings.value("input", ""));
    if (adm->RegisterAudioCallback(&recorder) != 0 || adm->InitRecording() != 0 || adm->StartRecording() != 0)
      throw std::runtime_error("Could not open the microphone");
    std::this_thread::sleep_for(3s);
    adm->StopRecording();
    adm->Terminate();
  } catch (...) {
    adm->Terminate();
    throw;
  }
  return recorder.finish();
}

}  // namespace korero
