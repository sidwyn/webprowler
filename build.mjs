import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, existsSync, writeFileSync } from 'fs';

const isWatch = process.argv.includes('--watch');

const commonOptions = {
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  sourcemap: true,
  minify: !isWatch,
};

async function build() {
  // Ensure dist exists
  mkdirSync('dist', { recursive: true });

  // 1. Build content script
  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/content/index.ts'],
    outfile: 'dist/content/index.js',
    format: 'iife', // Content scripts can't use ES modules
  });

  // 2. Build service worker
  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/background/service-worker.ts'],
    outfile: 'dist/background/service-worker.js',
  });

  // 3. Build side panel app
  await esbuild.build({
    ...commonOptions,
    entryPoints: ['src/sidepanel/app.ts'],
    outfile: 'dist/sidepanel/app.js',
  });

  // 4. Copy static files
  cpSync('manifest.json', 'dist/manifest.json');
  cpSync('src/sidepanel/index.html', 'dist/sidepanel/index.html');
  cpSync('src/sidepanel/styles.css', 'dist/sidepanel/styles.css');

  if (existsSync('public/icons')) {
    cpSync('public/icons', 'dist/icons', { recursive: true });
  }

  // In watch mode, write a reload token so the service worker can detect changes
  if (isWatch) {
    writeFileSync('dist/dev-reload.json', JSON.stringify({ t: Date.now() }));
  }

  console.log('✓ Build complete → dist/');
}

if (isWatch) {
  // Simple watch: rebuild on change
  const { watch } = await import('fs');

  build();

  watch('src', { recursive: true }, (eventType, filename) => {
    if (filename?.endsWith('.ts') || filename?.endsWith('.css') || filename?.endsWith('.html')) {
      console.log(`Changed: ${filename}`);
      build().catch(console.error);
    }
  });

  console.log('👀 Watching for changes...');
} else {
  build();
}
