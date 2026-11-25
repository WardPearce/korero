export const errors = {
  INVALID_REQUEST: [400, "Invalid request"],
  VERSION_UNSUPPORTED: [400, "Unsupported protocol version"],
  AUTH_FAILED: [401, "Authentication failed"],
  FORBIDDEN: [403, "Operation not permitted"],
  NOT_FOUND: [404, "Resource not found"],
  CONFLICT: [409, "Resource state conflicts with the request"],
  REFRESH_RETRY: [409, "Refresh already advanced; use the newest credentials"],
  LIMIT: [429, "Resource limit reached"],
  RATE_LIMITED: [429, "Too many requests"],
  UNAVAILABLE: [503, "Service unavailable"],
  INTERNAL: [500, "Internal server error"],
} as const;
export type ErrorCode = keyof typeof errors;
export class ProtocolError extends Error {
  constructor(readonly code: ErrorCode, message: string = errors[code][1]) { super(message); }
}
export function fail(code: ErrorCode): never { throw new ProtocolError(code); }
export function errorResponse(error: unknown) {
  const code = error instanceof ProtocolError ? error.code : "INTERNAL";
  return { status: errors[code][0], error: { code, message: error instanceof ProtocolError ? error.message : errors[code][1] } };
}

export class RateLimit {
  private readonly buckets = new Map<string, { available: number; updated: number }>();
  constructor(private readonly capacity: number, private readonly maxBuckets = 8192) {}
  take(key: string) {
    const now = performance.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxBuckets) {
        for (const [name, entry] of this.buckets) {
          if (now - entry.updated >= 60000) this.buckets.delete(name);
          else break;
        }
        if (this.buckets.size >= this.maxBuckets) fail("RATE_LIMITED");
      }
      bucket = { available: this.capacity, updated: now };
    }
    bucket.available = Math.min(this.capacity, bucket.available + (now - bucket.updated) * this.capacity / 60000);
    bucket.updated = now;
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (bucket.available < 1) fail("RATE_LIMITED");
    bucket.available--;
  }
}
