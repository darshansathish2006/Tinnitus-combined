import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Where the Django API is listening during development.
 *
 * One place, one variable. The port used to be written into three files —
 * `src/api/client.ts`, `scripts/dev.mjs` and the README — so moving the backend
 * off 9000 left the client still calling the old port and every request failed
 * with no message on screen. Set `VITE_API_TARGET` in `frontend/.env.local` (or
 * in the environment) and both the proxy below and the client follow it.
 */
function apiTarget(mode: string): string {
  // `loadEnv`, not `process.env`: Vite does not put `.env.local` into the
  // process environment before the config is evaluated, so reading
  // `process.env.VITE_API_TARGET` here would silently miss the file the comment
  // above tells people to edit — and fall back to 9000 while claiming to be
  // configurable. The third argument is the prefix filter; "" loads every key
  // so a plain `ECHOSENSE_API_PORT` would work too if that is what is set.
  const env = loadEnv(mode, process.cwd(), "");
  const explicit = (env.VITE_API_TARGET || "").trim();
  if (explicit) return explicit;
  const port = (env.ECHOSENSE_API_PORT || "9000").trim();
  return `http://127.0.0.1:${port}`;
}

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: 3000,
    strictPort: false,
    open: false,
    /**
     * Forward `/api` to Django so the browser only ever talks to one origin.
     *
     * This is worth more than saving a variable. Same-origin requests are not
     * subject to CORS at all, so the dev setup no longer depends on Django's
     * allow-list matching whichever port Vite happened to take; and because the
     * client now calls a relative path, the frontend does not need to know the
     * backend's port at all — only this proxy does.
     */
    proxy: {
      "/api": {
        target: apiTarget(mode),
        changeOrigin: true,
      },
    },
    // Vite's default host is the string "localhost". Since Node 17 stopped
    // reordering DNS results, that resolves to ::1 on Windows and the dev server
    // binds to IPv6 only — so http://127.0.0.1:5173 refuses the connection while
    // http://localhost:5173 works, which reads as "the app is broken".
    //
    // `host: true` binds every interface, which is the only way to serve both
    // loopback families (Vite takes a single host, not a list). That also makes
    // the dev server reachable from the local network; it prints those URLs on
    // startup so it is visible rather than silent. Set `--host 127.0.0.1` if you
    // need it restricted.
    host: true,
  },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          // Three.js is only needed on the education screen; keeping it in its
          // own chunk means the assessment flow is not waiting on it.
          three: ["three"],
          react: ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
}));
