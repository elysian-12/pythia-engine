/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const api = process.env.PYTHIA_API || process.env.POLYEDGE_API || "http://localhost:8080";
    return [
      { source: "/api/:path*", destination: `${api}/api/:path*` },
      { source: "/reports/:path*", destination: `${api}/reports/:path*` },
      { source: "/health", destination: `${api}/health` },
    ];
  },
};
export default nextConfig;
