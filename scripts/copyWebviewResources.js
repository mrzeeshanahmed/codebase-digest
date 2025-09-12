"use strict";
const fs = require('fs');
const path = require('path');

function copyDir(src, dest) {
  // Return true on success, false on failure. Collect errors and report them so
  // calling processes (CI) can fail when resource copying is incomplete.
  const errors = [];
  // If source doesn't exist, treat as success (nothing to copy)
  let srcExists = false;
  try { srcExists = fs.existsSync(src); } catch (e) { errors.push(new Error(`access source '${src}': ${String(e)}`)); }
  if (!srcExists) {
    if (errors.length > 0) { errors.forEach(err => console.error('copyDir:', err)); return false; }
    return true;
  }

  // Ensure destination exists
  try {
    if (!fs.existsSync(dest)) { fs.mkdirSync(dest, { recursive: true }); }
  } catch (e) {
    console.error(`copyDir: failed to create destination '${dest}':`, e);
    return false;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(src);
  } catch (e) {
    // Record the error so the caller can see a consistent list of failures
    errors.push(new Error(`failed to read directory '${src}': ${String(e)}`));
    // Report collected errors consistently and fail
    errors.forEach(err => console.error('copyDir:', err));
    return false;
  }

  for (const name of entries) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    try {
      const stat = fs.statSync(s);
      if (stat.isDirectory()) {
        const ok = copyDir(s, d);
        if (!ok) { errors.push(new Error(`recursive copy failed for '${s}' -> '${d}'`)); }
      } else {
        try {
          // Use copyFileSync; then restore timestamps and mode to preserve
          // metadata that some pipelines rely on for caching or cache-busting.
          fs.copyFileSync(s, d);
          try {
            // Restore mode/permissions
            fs.chmodSync(d, stat.mode);
          } catch (ex) { /* best-effort; continue */ }
          try {
            // Restore timestamps (atime, mtime)
            fs.utimesSync(d, stat.atime, stat.mtime);
          } catch (ex) { /* best-effort; continue */ }
        } catch (e) {
          errors.push(new Error(`failed to copy file '${s}' -> '${d}': ${String(e)}`));
        }
      }
    } catch (e) {
      errors.push(new Error(`failed to stat '${s}': ${String(e)}`));
    }
  }

  if (errors.length > 0) {
    errors.forEach(err => console.error('copyDir:', err));
    return false;
  }
  return true;
}

const repoRoot = path.resolve(__dirname, '..');
const src = path.join(repoRoot, 'resources', 'webview');
const dest = path.join(repoRoot, 'dist', 'resources', 'webview');
console.log('Copying webview resources from', src, 'to', dest);
const ok = copyDir(src, dest);
if (!ok) {
  console.error('Failed to copy webview resources — one or more errors occurred.');
  process.exit(2);
}
console.log('Done.');
