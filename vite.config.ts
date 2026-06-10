import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [inspectAttr(), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            return undefined;
          }

          if (id.includes('node_modules/@radix-ui') || id.includes('node_modules/cmdk') || id.includes('node_modules/vaul')) {
            return 'vendor-radix';
          }

          if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-') || id.includes('node_modules/victory-vendor')) {
            return 'vendor-charts';
          }

          if (id.includes('node_modules/react-hook-form') || id.includes('node_modules/@hookform') || id.includes('node_modules/zod')) {
            return 'vendor-forms';
          }

          if (id.includes('node_modules/@tanstack/react-table')) {
            return 'vendor-table';
          }

          if (id.includes('node_modules/lucide-react')) {
            return 'vendor-icons';
          }

          if (id.includes('node_modules/date-fns') || id.includes('node_modules/react-day-picker')) {
            return 'vendor-date';
          }

          return undefined;
        },
      },
    },
  },
});
