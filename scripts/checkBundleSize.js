const fs = require('fs');
const path = require('path');

// configurable threshold in bytes (default 400 KiB == 409600 bytes)
// Parse using base-10 integer parsing and fall back to default when input is invalid.
const THRESHOLD = (() => {
  const raw = process.env.BUNDLE_SIZE_THRESHOLD;
  if (!raw) { return 400 * 1024; }
  // strip whitespace and allow simple numeric strings; use parseInt with base 10 to avoid octal parsing
  const n = parseInt(String(raw).trim().replace(/[, ]+/g, ''), 10);
  return Number.isNaN(n) ? 400 * 1024 : n;
})();
// Allow specifying which artifact to measure via env var BUNDLE_ARTIFACT.
// Supported values:
// - unset (default): measure `dist/extension.js`
// - 'vsix': attempt to find a .vsix file in the repo root or dist/ directory
// - any other string: treated as a relative path to measure (relative to repo root)
const artifactSpec = process.env.BUNDLE_ARTIFACT;
let bundlePath;
if (!artifactSpec) {
  bundlePath = path.resolve(__dirname, '..', 'dist', 'extension.js');
} else if (String(artifactSpec).toLowerCase() === 'vsix') {
  // Look for a .vsix produced by packaging step in common locations. Some CI
  // pipelines place artifacts in `out`, `artifacts`, `build` or `release` dirs;
  // scan these as well as repo root and dist. If multiple .vsix files are
  // present, pick the most recently modified one.
  const repoRoot = path.resolve(__dirname, '..');
  const candidateDirs = [repoRoot, path.resolve(repoRoot, 'dist'), path.resolve(repoRoot, 'out'), path.resolve(repoRoot, 'artifacts'), path.resolve(repoRoot, 'build'), path.resolve(repoRoot, 'release'), path.resolve(repoRoot, 'releases')];

  function findVsixInDir(dir, maxDepth = 2) {
    const results = [];
    function walk(d, depth) {
      if (depth < 0) { return; }
      let files = [];
      try { files = fs.readdirSync(d); } catch (e) { return; }
      for (const f of files) {
        const fp = path.join(d, f);
        let st;
        try { st = fs.statSync(fp); } catch (e) { continue; }
        if (st.isFile() && f.toLowerCase().endsWith('.vsix')) { results.push({ path: fp, mtime: st.mtimeMs }); }
        else if (st.isDirectory()) { walk(fp, depth - 1); }
      }
    }
    walk(dir, maxDepth);
    return results;
  }

  let foundCandidates = [];
  for (const d of candidateDirs) {
    try {
      const r = findVsixInDir(d, 2);
      if (r && r.length) { foundCandidates = foundCandidates.concat(r); }
    } catch (e) { /* ignore */ }
  }
  // pick the newest vsix by mtime
  let found = null;
  if (foundCandidates.length > 0) {
    foundCandidates.sort((a, b) => b.mtime - a.mtime);
    found = foundCandidates[0].path;
  }
  // Fallback: if no .vsix found, try common bundle locations for the JS bundle
  if (found) {
    bundlePath = found;
  } else if (fs.existsSync(path.resolve(repoRoot, 'dist', 'extension.js'))) {
    bundlePath = path.resolve(repoRoot, 'dist', 'extension.js');
  } else if (fs.existsSync(path.resolve(repoRoot, 'out', 'extension.js'))) {
    bundlePath = path.resolve(repoRoot, 'out', 'extension.js');
  } else {
    bundlePath = path.resolve(repoRoot, 'dist', 'extension.js');
  }
} else {
  bundlePath = path.resolve(__dirname, '..', String(artifactSpec));
}

// Decide warn-only behavior:
// - If BUNDLE_WARN_ONLY is explicitly set (truthy), use that.
// - If BUNDLE_FAIL_ON_EXCEED is explicitly set (truthy), force failing behavior.
// - Otherwise, default to warning-only for GitHub pull_request events so PRs don't fail CI by default.
function envTruthy(v) {
  if (v === undefined || v === null) { return false; }
  const s = String(v).toLowerCase().trim();
  return ['1','true','yes','y','on'].includes(s);
}

// Read and normalize control flags
const explicitWarnOnly = envTruthy(process.env.BUNDLE_WARN_ONLY);
const explicitFail = envTruthy(process.env.BUNDLE_FAIL_ON_EXCEED);
// Normalize CI event name sources: some workflows set GITHUB_EVENT_NAME, others
// may expose github.event_name (lowercase) via normalization steps. Check common
// variants to robustly detect PR events.
const githubEventName = String(process.env.GITHUB_EVENT_NAME || process.env.GITHUB_EVENT || process.env.github_event_name || process.env.github_event || '').toLowerCase().trim();
const isPullRequest = ['pull_request', 'pull_request_target', 'pull-request', 'pr'].includes(githubEventName);
const WARN_ONLY = explicitFail ? false : (explicitWarnOnly ? true : (isPullRequest ? true : false));

function human(n) {
  if (n < 1024) { return `${n} B`; }
  if (n < 1024 * 1024) { return `${(n / 1024).toFixed(2)} KiB`; }
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

console.log('Bundle check: artifact=', bundlePath);
console.log('Bundle check: THRESHOLD=', THRESHOLD, `(${human(THRESHOLD)})`, 'BUNDLE_FAIL_ON_EXCEED=', process.env.BUNDLE_FAIL_ON_EXCEED, 'BUNDLE_WARN_ONLY=', process.env.BUNDLE_WARN_ONLY, 'WARN_ONLY=', WARN_ONLY, 'GITHUB_EVENT_NAME=', githubEventName);

function check() {
  if (!fs.existsSync(bundlePath)) {
    console.error('Bundle not found at', bundlePath);
    process.exit(2);
  }
  const stat = fs.statSync(bundlePath);
  const size = stat.size;
  console.log('Bundle size:', size, 'bytes', `(${human(size)})`);
  console.log('Threshold:', THRESHOLD, 'bytes', `(${human(THRESHOLD)})`);
  if (size > THRESHOLD) {
    console.warn(`Warning: bundle size ${size} (${human(size)}) exceeds threshold ${THRESHOLD} (${human(THRESHOLD)})`);
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
