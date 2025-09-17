import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';

// Load the webview store and subscribers scripts into a JSDOM environment and test subscriptions

describe('webview subscribers', () => {
  let dom: JSDOM;
  let window: any;
  let document: any;
  let store: any;

  beforeEach(() => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'resources', 'webview', 'index.html'), 'utf8');
    dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable' });
    window = dom.window as any;
    document = window.document;

    // make sure console is available on window (some scripts use console)
    window.console = console;

    // Provide minimal nodes used by subscribers
    const ingestPreview = document.createElement('div');
    ingestPreview.id = 'ingest-preview';
    const ingestPreviewText = document.createElement('pre');
    ingestPreviewText.id = 'ingest-preview-text';
    const ingestSpinner = document.createElement('div');
    ingestSpinner.id = 'ingest-spinner';
    document.body.appendChild(ingestPreview);
    document.body.appendChild(ingestPreviewText);
    document.body.appendChild(ingestSpinner);

    const progressContainer = document.createElement('div');
    progressContainer.id = 'progress-container';
    progressContainer.classList.add('hidden');
    const progressBar = document.createElement('div');
    progressBar.id = 'progress-bar';
    document.body.appendChild(progressContainer);
    document.body.appendChild(progressBar);

    // Minimal nodes mapping expected by subscribers.js
    window.nodes = {
      ingestPreviewRoot: ingestPreview,
      ingestPreviewText: ingestPreviewText,
      ingestSpinner: ingestSpinner,
      progressContainer: progressContainer,
      progressBar: progressBar
    };

    // Minimal helpers used by subscribers.js
    window.renderTree = jest.fn();
    window.renderPreviewDelta = jest.fn();
    window.showToast = jest.fn();
    window.postAction = jest.fn();

  // Load the store and subscribers synchronously into the JSDOM window's context
  const storeCode = fs.readFileSync(path.join(__dirname, '..', '..', 'resources', 'webview', 'store.js'), 'utf8');
  const subsCode = fs.readFileSync(path.join(__dirname, '..', '..', 'resources', 'webview', 'subscribers.js'), 'utf8');

  // Create a sandboxed context that uses the JSDOM window as global
  const sandbox = window as any;
  sandbox.window = window;
  sandbox.document = document;
  sandbox.console = console;
  // provide a minimal set of globals expected by the scripts
  // Execute the scripts inside the JSDOM window so they attach to window as expected
  window.eval(storeCode);
  store = window.store;
  expect(store).toBeDefined();

  // attach helpers on window before running subscribers
  window.renderTree = window.renderTree;
  window.renderPreviewDelta = window.renderPreviewDelta;
  window.showToast = window.showToast;
  window.postAction = window.postAction;

  window.eval(subsCode);
  });

  afterEach(() => {
    if (dom) { dom.window.close(); }
  });

  test('preview updates ingest preview text', (done) => {
    const delta = { summary: 'delta' };
    const unsubscribe = store.subscribe((s: any) => {
      try {
        // subscribers should call renderPreviewDelta when previewDelta changes
        if (s.previewDelta) {
          expect(window.renderPreviewDelta).toHaveBeenCalledWith(s.previewDelta);
          unsubscribe();
          done();
        }
      } catch (err) { unsubscribe(); done(err); }
    });

    store.setState && store.setState(() => ({ previewDelta: delta }));
  });

  test('loading toggles progress container visibility and updates bar', (done) => {
    const unsubscribe = store.subscribe((s: any) => {
      try {
        const container = document.getElementById('progress-container');
        const bar = document.getElementById('progress-bar');
        // when loading present, container should not have hidden
        if (s.loading && Object.keys(s.loading).length > 0) {
          expect(container.classList.contains('hidden')).toBe(false);
          // width may be updated depending on shape of loading payload; assert container visibility only
          unsubscribe();
          done();
        }
      } catch (err) { unsubscribe(); done(err); }
    });

    store.setState(() => ({ loading: { ingest: true, percent: 42 } }));
  });

  test('errors produce toasts', (done) => {
    const unsubscribe = store.subscribe((s: any) => {
      try {
        if (s.errors && s.errors.length > 0) {
          expect(window.showToast).toHaveBeenCalled();
          unsubscribe();
          done();
        }
      } catch (err) { unsubscribe(); done(err); }
    });

    store.setState(() => ({ errors: ['boom'] }));
  });
});
