import type { NextConfig } from "next";

function getImageHosts(): string[] {
  const hosts = new Set<string>();

  // Parse background image URL
  if (process.env.IMAGE_BACKGROUND) {
    try {
      const url = new URL(process.env.IMAGE_BACKGROUND);
      hosts.add(url.hostname);
    } catch {
      console.warn('Invalid IMAGE_BACKGROUND URL:', process.env.IMAGE_BACKGROUND);
    }
  }

  // Parse wordmark image URL
  if (process.env.IMAGE_WORDMARK) {
    try {
      const url = new URL(process.env.IMAGE_WORDMARK);
      hosts.add(url.hostname);
    } catch {
      console.warn('Invalid IMAGE_WORDMARK URL:', process.env.IMAGE_WORDMARK);
    }
  }

  return Array.from(hosts);
}

const nextConfig: NextConfig = {
  images: {
    remotePatterns: getImageHosts().map(hostname => ({
      protocol: 'https' as const,
      hostname,
    })),
  },
  turbopack: {
    root: __dirname,
  },
  // Security headers applied to every route. Content-Security-Policy is kept
  // permissive enough for reCAPTCHA and configured branding images; tighten
  // script-src/style-src further when no inline styles are required.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.google.com https://www.gstatic.com; frame-src https://www.google.com; connect-src 'self' https://www.google.com; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'",
          },
        ],
      },
    ]
  },
};

export default nextConfig;
