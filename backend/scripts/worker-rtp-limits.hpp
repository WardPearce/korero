#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstdlib>

class KoreroRtpBudget
{
public:
  bool Allow(uint64_t bitsPerSecond, int64_t nowUs, size_t bytes)
  {
    // Store fractional bits as bit-microseconds. Allow a one-second burst.
    constexpr uint64_t secondUs = 1000000;
    const auto capacity = bitsPerSecond * secondUs;
    const auto elapsed = static_cast<uint64_t>(std::clamp<int64_t>(nowUs - this->lastUs, 0, secondUs));
    this->credit = this->lastUs < 0 ? capacity : std::min(capacity, this->credit + elapsed * bitsPerSecond);
    this->lastUs = std::max(nowUs, this->lastUs);
    const auto cost = bytes * uint64_t{8} * secondUs;
    if (cost > this->credit)
      return false;
    this->credit -= cost;
    return true;
  }

private:
  uint64_t credit{ 0 };
  int64_t lastUs{ -1 };
};

inline uint64_t KoreroRtpEgressBitrate()
{
  const auto* value = std::getenv("KORERO_WORKER_RTP_EGRESS_BITRATE");
  if (value)
  {
    char* end = nullptr;
    const auto bitrate = std::strtoull(value, &end, 10);
    if (*end == '\0' && bitrate >= 312500 && bitrate <= 10000000000ULL)
      return bitrate;
  }
  return 250000000;
}
