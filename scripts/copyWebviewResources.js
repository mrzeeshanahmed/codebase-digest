"use strict";
const fs = require('fs');
const path = require('path');

function copyDir(src, dest) {
  // Return true on success, false on failure. Failures are logged but do not
  // abort the whole process — callers may choose to react to the boolean.
  try {
    // If source doesn't exist, nothing to copy.
    let srcExists = false;
    try { srcExists = fs.existsSync(src); } catch (e) { console.error(`copyDir: failed to access source '${src}':`, e); return false; }
    if (!srcExists) { return true; }

    // Ensure destination exists
    try {
      if (!fs.existsSync(dest)) { fs.mkdirSync(dest, { recursive: true }); }
    } catch (e) {
      console.error(`copyDir: failed to create destination '${dest}':`, e);
      return false;
    }

    let entries = [];
    try { entries = fs.readdirSync(src); } catch (e) { console.error(`copyDir: failed to read directory '${src}':`, e); return false; }

    for (const name of entries) {
      const s = path.join(src, name);
      const d = path.join(dest, name);
      try {
        const stat = fs.statSync(s);
        if (stat.isDirectory()) {
          try {
            const ok = copyDir(s, d);
            if (!ok) { console.error(`copyDir: recursive copy reported failure for '${s}' -> '${d}'`); }
          } catch (e) {
            console.error(`copyDir: exception while copying directory '${s}' -> '${d}':`, e);
            // continue with other entries
          }
        } else {
          try {
            fs.copyFileSync(s, d);
          } catch (e) {
            console.error(`copyDir: failed to copy file '${s}' -> '${d}':`, e);
            // continue copying other files
          }
        }
      } catch (e) {
        console.error(`copyDir: failed to stat '${s}':`, e);
        // continue with other entries
      }
    }
    return true;
  } catch (e) {
    // Catch-all should not normally be reached, but guard and log just in case
    console.error(`copyDir: unexpected error while copying '${src}' -> '${dest}':`, e);
    return false;
  }
}

const repoRoot = path.resolve(__dirname, '..');
const src = path.join(repoRoot, 'resources', 'webview');
const dest = path.join(repoRoot, 'dist', 'resources', 'webview');
console.log('Copying webview resources from', src, 'to', dest);
copyDir(src, dest);
console.log('Done.');
