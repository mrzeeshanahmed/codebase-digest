import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';

/**
 * Simple test harness for webview JSDOM-based tests.
 * - Creates a fresh JSDOM per test
 * - Loads `store.js` and `commandRegistry.js` into the window
 * - Exposes `mount()` and `teardown()` helpers
 */

export type Mounted = {
  dom: JSDOM;
  window: any;
  document: Document;
  store: any;
  commandRegistry: any;
};

export function mountIndexHtml(): Mounted {
  let html = fs.readFileSync(path.join(__dirname, '..', '..', 'resources', 'webview', 'index.html'), 'utf8');
  // Prevent automatic execution of subscribers/main which rely on globals we want to set first
  html = html.replace(/<script src="\.\/subscribers\.js"><\/script>/g, '');
  html = html.replace(/<script src="\.\/main\.js"><\/script>/g, '');

  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable' });
  const window = dom.window as any;
  const document = window.document;

  // ensure console present
  window.console = console;

  // Load store and commandRegistry into the window context synchronously.
  const storeCode = fs.readFileSync(path.join(__dirname, '..', '..', 'resources', 'webview', 'store.js'), 'utf8');
  const registryCode = fs.readFileSync(path.join(__dirname, '..', '..', 'resources', 'webview', 'commandRegistry.js'), 'utf8');
  const subsCode = fs.readFileSync(path.join(__dirname, '..', '..', 'resources', 'webview', 'subscribers.js'), 'utf8');

  // Evaluate store first so window.store is present for subscribers/helpers
  // Prepare minimal globals and mocks before evaluating subscribers
  window.renderTree = jest.fn();
  window.renderPreviewDelta = jest.fn();
  window.showToast = jest.fn();
  window.postAction = jest.fn();

  // Ensure DOM nodes subscribers expect exist
  if (!document.getElementById('ingest-preview')) {
    const ingestPreview = document.createElement('div'); ingestPreview.id = 'ingest-preview'; document.body.appendChild(ingestPreview);
  }
  if (!document.getElementById('ingest-preview-text')) {
    const ingestPreviewText = document.createElement('pre'); ingestPreviewText.id = 'ingest-preview-text'; document.body.appendChild(ingestPreviewText);
  }
  if (!document.getElementById('ingest-spinner')) {
    const ingestSpinner = document.createElement('div'); ingestSpinner.id = 'ingest-spinner'; document.body.appendChild(ingestSpinner);
  }
  if (!document.getElementById('progress-container')) {
    const progressContainer = document.createElement('div'); progressContainer.id = 'progress-container'; progressContainer.classList.add('hidden'); document.body.appendChild(progressContainer);
  }
  if (!document.getElementById('progress-bar')) {
    const progressBar = document.createElement('div'); progressBar.id = 'progress-bar'; document.body.appendChild(progressBar);
  }
  if (!document.getElementById('file-list')) {
    const fileList = document.createElement('div'); fileList.id = 'file-list'; document.body.appendChild(fileList);
  }

  window.eval(storeCode);
  // Provide a no-op commandRegistry if script uses it before we evaluate actual file
  window.commandRegistry = window.commandRegistry || {};
  // Evaluate command registry
  try { window.eval(registryCode); } catch (e) { /* best-effort */ }
  // Now evaluate subscribers so they subscribe with our mocks present
  try { window.eval(subsCode); } catch (e) { /* best-effort */ }

  const store = window.store;
  const commandRegistry = window.commandRegistry;

  // attach a nodes map placeholder to avoid subscriber errors
  window.nodes = window.nodes || {};

  return { dom, window, document, store, commandRegistry };
}

export function teardownMounted(m: Mounted) {
  try {
    if (m && m.dom && m.dom.window) {
      m.dom.window.close();
    }
  } catch (e) { /* ignore */ }
}

// Global helpers for tests that prefer implicit setup/cleanup via import
export function setupTestLifecycle() {
  let mounted: Mounted | null = null;
  beforeEach(() => {
    mounted = mountIndexHtml();
    // expose to global for convenience inside tests
    (global as any).window = mounted!.window;
    (global as any).document = mounted!.document;
    (global as any).store = mounted!.store;
    (global as any).commandRegistry = mounted!.commandRegistry;
  });
  afterEach(() => {
    if (mounted) {
      teardownMounted(mounted);
      mounted = null;
    }
    // cleanup globals
    try { delete (global as any).window; } catch {}
    try { delete (global as any).document; } catch {}
    try { delete (global as any).store; } catch {}
    try { delete (global as any).commandRegistry; } catch {}
  });
}
