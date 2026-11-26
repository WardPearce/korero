#pragma once

#include "rust/cxx.h"
#include <cstddef>
#include <cstdint>
#include <memory>

namespace korero {
struct Rpc;

class Voice {
public:
  struct Impl;

  explicit Voice(std::unique_ptr<Impl> impl);
  ~Voice();

  rust::String capabilities() const;
  void set_send(rust::Str transport);
  void set_receive(rust::Str transport);
  void consume(rust::Str parameters);
  void set_consumer_volume(rust::Str producer_id, uint8_t level);
  void close_consumer(rust::Str producer_id);
  double peak() const;

private:
  std::unique_ptr<Impl> impl_;
};

std::unique_ptr<Voice> make_voice(rust::Box<Rpc> rpc, rust::Str capabilities,
                                 rust::Str ice_servers, bool synthetic);
void set_audio_profile(rust::Str settings);
void set_push_to_talk(bool pressed) noexcept;
void set_whisper_to_talk(bool pressed) noexcept;
rust::String audio_devices();
double test_microphone();
bool initialize_android(size_t env, size_t context) noexcept;
}  // namespace korero
