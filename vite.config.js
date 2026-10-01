import { defineConfig, loadEnv } from 'vite';

// Client lives in /client, builds to /dist (served by the express server).
// `npm run dev:client` starts vite with a proxy to the express server for /api and /ws.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const port = env.PORT || 3100;
  return {
    root: 'client',
    envDir: '..',
    build: { outDir: '../dist', emptyOutDir: true, sourcemap: false },
    server: {
      port: 5173,
      host: true,
      allowedHosts: true,
      proxy: {
        '/api': { target: `http://localhost:${port}`, changeOrigin: true },
        '/ws': { target: `ws://localhost:${port}`, ws: true },
      },
      // discord serves the activity through its own proxy; hmr over that proxy is flaky
      hmr: { clientPort: 443 },
    },
  };
});
