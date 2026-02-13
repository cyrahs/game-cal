import { execSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function resolveBuildCommit(): string {
  const envCommit = process.env.VITE_BUILD_COMMIT?.trim() || process.env.BUILD_COMMIT?.trim();
  if (envCommit) {
    // If a full sha is provided (e.g. in CI without .git), normalize it to a short sha-like string.
    const hex = /^[0-9a-f]{7,64}$/i.test(envCommit) ? envCommit : null;
    if (!hex) return envCommit;
    try {
      return execSync(`git rev-parse --short ${hex}`, {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      return hex.slice(0, 7);
    }
  }

  try {
    return execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

const buildCommit = resolveBuildCommit();

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_COMMIT__: JSON.stringify(buildCommit),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
