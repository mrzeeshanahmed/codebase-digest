const fs = require('fs');
const path = require('path');

// configurable threshold in bytes (default ~400 KB)
const THRESHOLD = process.env.BUNDLE_SIZE_THRESHOLD ? Number(process.env.BUNDLE_SIZE_THRESHOLD) : 400 * 1024;
const bundlePath = path.resolve(__dirname, '..', 'dist', 'extension.js');

function check() {
  if (!fs.existsSync(bundlePath)) {
    console.error('Bundle not found at', bundlePath);
    process.exit(2);
  }
  const stat = fs.statSync(bundlePath);
  const size = stat.size;
  console.log('Bundle size:', size, 'bytes');
  if (size > THRESHOLD) {
    console.warn(`Warning: bundle size ${size} exceeds threshold ${THRESHOLD}`);
    // exit code non-zero to surface in CI; use a warning-only mode via env
    if (!process.env.BUNDLE_WARN_ONLY) {
      process.exit(3);
    }
  }
  process.exit(0);
}

check();
