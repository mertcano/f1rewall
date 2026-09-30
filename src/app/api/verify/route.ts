import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { getConfig } from '@/lib/config'
import { isRateLimited } from '@/lib/rate-limit'
import { isTokenReplay } from '@/lib/captcha-replay'

/** Maximum accepted reCAPTCHA token length (tokens are typically ~500-1000 chars). */
const MAX_TOKEN_LENGTH = 2048
/** Minimum accepted reCAPTCHA token length. */
const MIN_TOKEN_LENGTH = 20
/** Upstream request timeout in milliseconds. */
const UPSTREAM_TIMEOUT_MS = 8000
/** Discord invite code format returned by the Discord API. */
const INVITE_CODE_PATTERN = /^[A-Za-z0-9-]{2,32}$/

/**
 * Hash a client identifier before using it as a rate-limit key.
 * This avoids persisting raw IP addresses in memory longer than needed.
 */
function hashClientKey(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Perform a fetch with a bounded timeout so a slow upstream cannot hold
 * the serverless function open indefinitely.
 */
async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function POST(request: NextRequest) {
  try {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      // Malformed JSON is a client error, not an internal failure.
      return NextResponse.json(
        { success: false, error: 'Invalid JSON body' },
        { status: 400 }
      )
    }

    const recaptchaToken =
      typeof body === 'object' && body !== null
        ? (body as { recaptchaToken?: unknown }).recaptchaToken
        : undefined

    // Validate token type and length before any upstream call.
    if (
      typeof recaptchaToken !== 'string' ||
      recaptchaToken.length < MIN_TOKEN_LENGTH ||
      recaptchaToken.length > MAX_TOKEN_LENGTH
    ) {
      return NextResponse.json(
        { success: false, error: 'Invalid reCAPTCHA token' },
        { status: 400 }
      )
    }

    const config = getConfig()

    // Derive a privacy-preserving rate-limit key from the client IP.
    // Note: X-Forwarded-For is spoofable, so it is used only for abuse
    // throttling here and is never forwarded to Google as remoteip.
    const rawIp =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'unknown'
    const rateLimitKey = hashClientKey(rawIp)
    if (isRateLimited(rateLimitKey)) {
      return NextResponse.json(
        { success: false, error: 'Too many requests. Please try again later.' },
        { status: 429 }
      )
    }

    // Reject reCAPTCHA token reuse (one solve must yield at most one invite).
    if (isTokenReplay(recaptchaToken)) {
      return NextResponse.json(
        { success: false, error: 'reCAPTCHA token already used' },
        { status: 400 }
      )
    }

    // Verify reCAPTCHA with Google using a bounded timeout.
    // The client IP is intentionally not forwarded because
    // X-Forwarded-For can be spoofed by the caller.
    let recaptchaResponse: Response
    try {
      recaptchaResponse = await fetchWithTimeout(
        'https://www.google.com/recaptcha/api/siteverify',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            secret: config.recaptcha.secretKey,
            response: recaptchaToken,
          }),
        }
      )
    } catch {
      return NextResponse.json(
        { success: false, error: 'Verification service unavailable' },
        { status: 502 }
      )
    }

    if (!recaptchaResponse.ok) {
      return NextResponse.json(
        { success: false, error: 'Verification service unavailable' },
        { status: 502 }
      )
    }

    const recaptchaResult = (await recaptchaResponse.json()) as {
      success?: boolean
      hostname?: string
      'error-codes'?: string[]
    }

    // Optionally enforce that the token was issued for our hostname.
    const expectedHostname = process.env.EXPECTED_HOSTNAME
    if (
      !recaptchaResult.success ||
      (expectedHostname &&
        recaptchaResult.hostname !== undefined &&
        recaptchaResult.hostname !== expectedHostname)
    ) {
      return NextResponse.json(
        { success: false, error: 'reCAPTCHA verification failed' },
        { status: 400 }
      )
    }

    // Generate a single-use Discord invite with a 5-minute expiration.
    let inviteResponse: Response
    try {
      inviteResponse = await fetchWithTimeout(
        `https://discord.com/api/channels/${config.discord.welcomeRoom}/invites`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bot ${config.discord.botToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            max_uses: 1,
            unique: true,
            max_age: 300, // 5 minutes
          }),
        }
      )
    } catch {
      return NextResponse.json(
        { success: false, error: 'Failed to generate Discord invite' },
        { status: 502 }
      )
    }

    if (!inviteResponse.ok) {
      return NextResponse.json(
        { success: false, error: 'Failed to generate Discord invite' },
        { status: 502 }
      )
    }

    const inviteData = (await inviteResponse.json()) as { code?: unknown }

    // Validate the invite code format before constructing a redirect URL.
    if (typeof inviteData.code !== 'string' || !INVITE_CODE_PATTERN.test(inviteData.code)) {
      return NextResponse.json(
        { success: false, error: 'Invalid invite response from Discord' },
        { status: 502 }
      )
    }

    return NextResponse.json({
      success: true,
      inviteUrl: `https://discord.gg/${inviteData.code}`,
    })
  } catch {
    // Generic fallback without leaking internal details or user input.
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
