import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Content Security Policy for the console, injected as a <meta> tag at build time so it is identical on
 * Vercel, nginx (Docker) and S3/CloudFront, and can name the API origin (VITE_API_URL, known only at build).
 * Header-only directives (frame-ancestors) are set by each host: vercel.json, infra/console/nginx.conf.
 *
 * Why each source is allowed:
 *  - script-src: our bundle + Google Identity Services (sign in with Google). No inline scripts, no eval.
 *  - connect-src: the ARC Cloud API (REST + live updates) and Google Identity Services.
 *  - style-src 'unsafe-inline': custom boards render user CSS in a sandboxed srcdoc iframe, which inherits
 *    this policy. Scripts stay blocked there (the iframe has sandbox="" and its own script-free CSP).
 *  - img-src https: data: blob:: map tiles and images in custom boards.
 *  - frame-src: Google sign-in. Custom boards are srcdoc iframes and need no frame-src entry.
 */
export function consoleCsp(apiUrl: string | undefined): string {
  const api = apiUrl ? new URL(apiUrl).origin : '';
  const gis = 'https://accounts.google.com/gsi/';
  return [
    "default-src 'self'",
    `script-src 'self' ${gis}client`,
    `connect-src 'self' ${api} ${gis}`.replace(/\s+/g, ' ').trim(),
    `style-src 'self' 'unsafe-inline' ${gis}style`,
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    "media-src 'self'",
    `frame-src ${gis}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

function cspPlugin(apiUrl: string | undefined): Plugin {
  return {
    name: 'arc-console-csp',
    apply: 'build', // the dev server needs inline HMR scripts; the policy is for built bundles
    transformIndexHtml(html) {
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${consoleCsp(apiUrl)}" />`);
    },
  };
}

// In development the console runs on :3002 and forwards /api to the backend on :3000.
// In Docker, nginx does the same forwarding (infra/console/nginx.conf).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [react(), cspPlugin(env.VITE_API_URL || process.env.VITE_API_URL)],
    server: {
      port: 3002,
      proxy: { '/api': process.env.ARC_API_ORIGIN ?? 'http://localhost:3000' },
    },
  };
});
