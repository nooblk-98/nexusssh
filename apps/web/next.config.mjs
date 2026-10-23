export default {
  transpilePackages: [],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      // Settings pages are rendered client-side by app/page.tsx (lib/router.ts).
      { source: "/settings", destination: "/" },
      { source: "/settings/:page", destination: "/" },
      {
        source: "/api/:path*",
        destination: `${process.env.API_URL || "http://127.0.0.1:3001"}/api/:path*`,
      },
    ];
  },
};
