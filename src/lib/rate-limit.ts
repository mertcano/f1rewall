/**
 * Simple in-memory rate limiter for serverless API routes.
 *
 * This module provides a lightweight, per-instance token bucket used to
 * protect the Discord invite endpoint from abuse. For multi-instance
 * production deployments, replace this with a shared store such as
 * Upstash Redis or Vercel KV so limits are enforced globally.
 */

interface Bucket {
  /** Number of requests seen in the current window. */
  count: number
  /** Unix timestamp (ms) when the current window started. */
  windowStart: number
}

const buckets = new Map<string, Bucket>()

/**
 * Check whether a request from the given key is within the allowed rate.
 *
 * @param key - Client identifier (for example a hashed IP address).
 * @param limit - Maximum number of requests allowed per window.
 * @param windowMs - Window duration in milliseconds.
 * @returns True when the request is allowed, false when rate limited.
 */
export function isRateLimited(key: string, limit = 5, windowMs = 60_000): boolean {
  const now = Date.now()
  const entry = buckets.get(key)

  // Start a new window when none exists or the previous window expired.
  if (!entry || now - entry.windowStart > windowMs) {
    buckets.set(key, { count: 1, windowStart: now })
    return false
  }

  // Reject the request once the limit is reached.
  if (entry.count >= limit) {
    return true
  }

  entry.count += 1
  return false
}
