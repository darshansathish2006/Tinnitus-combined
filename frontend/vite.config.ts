import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    open: false,
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
});
