const fs = require('fs');
const path = require('path');

// configurable threshold in bytes (default ~400 KB)
const THRESHOLD = process.env.BUNDLE_SIZE_THRESHOLD ? Number(process.env.BUNDLE_SIZE_THRESHOLD) : 400 * 1024;
const bundlePath = path.resolve(__dirname, '..', 'dist', 'extension.js');

// Decide warn-only behavior:
// - If BUNDLE_WARN_ONLY is explicitly set (truthy), use that.
// - If BUNDLE_FAIL_ON_EXCEED is explicitly set (truthy), force failing behavior.
// - Otherwise, default to warning-only for GitHub pull_request events so PRs don't fail CI by default.
function envTruthy(v) {
  if (v === undefined || v === null) { return false; }
  const s = String(v).toLowerCase().trim();
  return ['1','true','yes','y','on'].includes(s);
}
const explicitWarnOnly = envTruthy(process.env.BUNDLE_WARN_ONLY);
const explicitFail = envTruthy(process.env.BUNDLE_FAIL_ON_EXCEED);
const isPullRequest = (process.env.GITHUB_EVENT_NAME === 'pull_request' || process.env.GITHUB_EVENT_NAME === 'pull_request_target');
const WARN_ONLY = explicitFail ? false : (explicitWarnOnly ? true : (isPullRequest ? true : false));

console.log('Bundle check: THRESHOLD=', THRESHOLD, 'WARN_ONLY=', WARN_ONLY, 'GITHUB_EVENT_NAME=', process.env.GITHUB_EVENT_NAME);

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
    if (!WARN_ONLY) {
      console.error('Bundle size exceeded threshold and WARN_ONLY is false — failing CI.');
      process.exit(3);
    } else {
      console.log('Bundle size exceeded threshold but WARN_ONLY is true — emitting warning only.');
    }
  }
  process.exit(0);
}

check();
