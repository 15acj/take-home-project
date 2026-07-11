/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/data/:version/manifest.json",
        headers: [
          { key: "Cache-Control", value: "public, max-age=60, must-revalidate" },
        ],
      },
      {
        // everything else under /data is content-hashed via ?v= from the manifest
        source: "/data/:version/:path((?!manifest\\.json$).*)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
