import { defineConfig } from '@solidjs/start/config';

export default defineConfig({
  server: {
    // Use bun preset for standalone dev/preview; the main OmniClaw
    // process serves the built output by forwarding requests to
    // nitro's localFetch.
    preset: 'bun',
  },
  vite: {
    css: {
      postcss: './postcss.config.js',
    },
  },
});
