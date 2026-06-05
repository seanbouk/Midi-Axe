import { defineConfig } from "vite";

// base: "./" keeps asset URLs relative so the built site works whether it is
// served from the domain root or a GitHub Pages project subpath (/repo-name/).
export default defineConfig({
  base: "./",
});
