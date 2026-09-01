import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' so the same build works at money.tsamayaapp.co.za and at the
// GitHub Pages project URL (…github.io/tsamaya-money/). Routing is hash-based
// for the same reason.
export default defineConfig({
  base: './',
  plugins: [react()],
});
