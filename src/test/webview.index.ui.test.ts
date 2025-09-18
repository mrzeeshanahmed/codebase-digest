import { setupTestLifecycle } from '../../test/support/webviewTestHarness';

// Use shared harness lifecycle to provide JSDOM and globals per test
setupTestLifecycle();

describe('webview index UI (snapshot-free)', () => {
  test('treeData update renders file list (no snapshot)', (done) => {

    // prepare a simple treeData with one file leaf (no __isFile on parent nodes)
    const treeData = {
      src: {
        utils: {
          'a.js': { __isFile: true, relPath: 'src/utils/a.js' }
        }
      }
    };

    // wait for subscribers to react via store.subscribe
    // Force subscribers to use the fallback renderer (not the host-provided renderTree)
    (global as any).window.renderTree = undefined;

    const unsub = (global as any).store.subscribe((s: any) => {
      try {
        if (s.treeData === treeData) {
          const fileList = (global as any).document.getElementById('file-list');
          expect(fileList).toBeTruthy();
          const fileRows = fileList!.querySelectorAll('.file-row');
          expect(fileRows.length).toBeGreaterThanOrEqual(1);
          const found = Array.from(fileRows as any).some((el: any) => el.textContent === 'src/utils/a.js');
          expect(found).toBe(true);
          unsub();
          done();
        }
      } catch (err) { unsub(); done(err); }
    });

    (global as any).store.setState(() => ({ treeData }));
  });

  test('loading state toggles progress container visibility and sets percent', (done) => {
    const unsub = (global as any).store.subscribe((s: any) => {
      try {
        if (s.loading && Object.keys(s.loading).length > 0) {
          const bar = document.getElementById('progress-bar')!;
          // progress bar style updated by subscribers
          expect(bar.style.width).toBe('42%');
          unsub();
          done();
        }
      } catch (err) { unsub(); done(err); }
    });

    (global as any).store.setState(() => ({ loading: { ingest: true, percent: 42 } }));
  });

  test('preview update fills ingest preview text', (done) => {
    const previewPayload = { preview: { summary: 'Summary', tree: 'a/b/c' } };

    const unsub = (global as any).store.subscribe((s: any) => {
      try {
        if (s.preview !== undefined && s.preview !== null) {
          const textEl = document.getElementById('ingest-preview-text')!;
          expect(textEl.textContent).toContain('Summary');
          expect(textEl.textContent).toContain('a/b/c');
          unsub();
          done();
        }
      } catch (err) { unsub(); done(err); }
    });

    (global as any).store.setState(() => ({ preview: previewPayload }));
  });
});
