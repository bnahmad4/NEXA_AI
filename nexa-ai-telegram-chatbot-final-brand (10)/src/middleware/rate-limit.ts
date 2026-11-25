import { getEnv } from "@/config/env";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  limit: number;
}

interface UserBucket {
  timestamps: number[];
  blockedUntil?: number;
}

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, UserBucket>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly burstLimit: number;
  private readonly burstWindowMs: number;
  private lastCleanup = Date.now();

  constructor(options?: {
    maxRequests?: number;
    windowMs?: number;
    burstLimit?: number;
    burstWindowMs?: number;
  }) {
    const env = getEnv();
    this.maxRequests = options?.maxRequests ?? env.RATE_LIMIT_MAX_REQUESTS;
    this.windowMs = options?.windowMs ?? env.RATE_LIMIT_WINDOW_MS;
    this.burstLimit = options?.burstLimit ?? Math.min(5, this.maxRequests);
    this.burstWindowMs = options?.burstWindowMs ?? 5000;
  }

  check(key: string, now = Date.now()): RateLimitResult {
    this.cleanupIfNeeded(now);

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      this.buckets.set(key, bucket);
    }

    if (bucket.blockedUntil && now < bucket.blockedUntil) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.blockedUntil - now) / 1000)),
        limit: this.maxRequests,
      };
    }

    const windowStart = now - this.windowMs;
    bucket.timestamps = bucket.timestamps.filter((ts) => ts > windowStart);

    // Burst protection (prevent rapid-fire spam within 5 seconds)
    const burstStart = now - this.burstWindowMs;
    const recentBurstCount = bucket.timestamps.filter((ts) => ts > burstStart).length;
    if (recentBurstCount >= this.burstLimit) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((this.burstWindowMs - (now - bucket.timestamps[bucket.timestamps.length - this.burstLimit])) / 1000)
      );
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds,
        limit: this.maxRequests,
      };
    }

    if (bucket.timestamps.length >= this.maxRequests) {
      const oldestInWindow = bucket.timestamps[0] ?? now;
      const retryAfterMs = Math.max(1000, this.windowMs - (now - oldestInWindow));
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        limit: this.maxRequests,
      };
    }

    bucket.timestamps.push(now);
    return {
      allowed: true,
      remaining: Math.max(0, this.maxRequests - bucket.timestamps.length),
      retryAfterSeconds: 0,
      limit: this.maxRequests,
    };
  }

  reset(key?: string) {
    if (key) {
      this.buckets.delete(key);
    } else {
      this.buckets.clear();
    }
  }

  private cleanupIfNeeded(now: number) {
    if (now - this.lastCleanup < this.windowMs * 2) return;
    this.lastCleanup = now;
    const cutoff = now - this.windowMs;
    for (const [key, bucket] of this.buckets.entries()) {
      bucket.timestamps = bucket.timestamps.filter((ts) => ts > cutoff);
      if (bucket.timestamps.length === 0 && (!bucket.blockedUntil || bucket.blockedUntil <= now)) {
        this.buckets.delete(key);
      }
    }
  }
}

const globalForLimiter = globalThis as typeof globalThis & {
  __nexaTelegramRateLimiter?: SlidingWindowRateLimiter;
};

export function getTelegramRateLimiter(): SlidingWindowRateLimiter {
  if (!globalForLimiter.__nexaTelegramRateLimiter) {
    globalForLimiter.__nexaTelegramRateLimiter = new SlidingWindowRateLimiter();
  }
  return globalForLimiter.__nexaTelegramRateLimiter;
}
