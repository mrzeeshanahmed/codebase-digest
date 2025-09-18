"use strict";
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const src = path.join(repoRoot, 'resources', 'webview');
const dest = path.join(repoRoot, 'dist', 'resources', 'webview');

console.log('Copying webview resources from', src, 'to', dest);

try {
    fs.cpSync(src, dest, { recursive: true });
    console.log('Done.');
} catch (e) {
    console.error('Failed to copy webview resources:', e);
    process.exit(2);
}
