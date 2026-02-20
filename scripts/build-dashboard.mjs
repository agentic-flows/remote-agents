/**
 * Build script for the dashboard React app.
 *
 * Bundles src/dashboard/index.tsx and produces:
 *   dist/dashboard.js  — the JS bundle
 *   dist/dashboard.html — HTML with inlined JS (served by the Worker)
 *
 * The Worker reads dist/dashboard.html at build time via an import,
 * embedding it as a string literal in the Worker bundle.
 *
 * Usage:
 *   node scripts/build-dashboard.mjs          # production
 *   node scripts/build-dashboard.mjs --dev    # dev (sourcemap, no minify)
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const isDev = process.argv.includes('--dev');

// Output to public/ (not gitignored, committed alongside src)
const outDir = join(root, 'public');

async function buildDashboard() {
  mkdirSync(outDir, { recursive: true });

  // Step 1: Bundle the React app to JS
  await build({
    entryPoints: [join(root, 'src/dashboard/index.tsx')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome100', 'safari15'],
    outfile: join(outDir, 'dashboard.js'),
    minify: !isDev,
    sourcemap: false, // inline sourcemap would inflate HTML too much
    jsx: 'automatic',
    define: {
      'process.env.NODE_ENV': isDev ? '"development"' : '"production"',
    },
  });

  // Step 2: Read the HTML shell and the compiled JS
  const htmlShell = readFileSync(join(root, 'src/dashboard/index.html'), 'utf8');
  const js = readFileSync(join(outDir, 'dashboard.js'), 'utf8');

  // Step 3: Inline the JS into the HTML (replace the external script tag)
  const inlinedHtml = htmlShell.replace(
    '<script type="module" src="/dashboard.js"></script>',
    `<script type="module">\n${js}\n</script>`,
  );

  // Step 4: Write the final HTML
  writeFileSync(join(outDir, 'dashboard.html'), inlinedHtml, 'utf8');

  const jsSize = Buffer.byteLength(js, 'utf8');
  const htmlSize = Buffer.byteLength(inlinedHtml, 'utf8');
  console.log(
    `Dashboard built:\n` +
    `  public/dashboard.js   ${(jsSize / 1024).toFixed(1)} KB\n` +
    `  public/dashboard.html ${(htmlSize / 1024).toFixed(1)} KB`,
  );
}

buildDashboard().catch((err) => {
  console.error('Dashboard build failed:', err);
  process.exit(1);
});
