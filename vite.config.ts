import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// base: "./" keeps asset URLs relative so the built site works whether it is
// served from the domain root or a GitHub Pages project subpath (/repo-name/).
export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("index.html", import.meta.url)),
        // standalone sound-audition page; not linked from the app
        debug: fileURLToPath(new URL("debug.html", import.meta.url)),
      },
    },
  },
});
