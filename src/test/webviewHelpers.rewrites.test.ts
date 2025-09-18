import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { setWebviewHtml } from '../providers/webviewHelpers';

describe('webviewHelpers asset rewrite', () => {
  const tmpRoot = path.join(os.tmpdir(), `cbd-test-${Date.now()}`);
  const resourcesWebview = path.join(tmpRoot, 'resources', 'webview');
  const resourcesIcons = path.join(tmpRoot, 'resources', 'icons');

  beforeAll(async () => {
    await fsp.mkdir(resourcesWebview, { recursive: true });
    await fsp.mkdir(resourcesIcons, { recursive: true });
    // Write minimal assets that the rewrite expects to find
    await fsp.writeFile(path.join(resourcesWebview, 'styles.css'), '/* css */');
    await fsp.writeFile(path.join(resourcesWebview, 'main.js'), '// js');
    await fsp.writeFile(path.join(resourcesIcons, 'icon.png'), 'PNG');

    // index.html uses single-quoted href/src and an ../icons reference
    const html = `<!doctype html>
<html>
  <head>
    <link rel='stylesheet' href='resources/webview/styles.css'>
    <script src='resources/webview/main.js'></script>
  </head>
  <body>
    <img src='../icons/icon.png' alt='icon'>
  </body>
</html>`;
    await fsp.writeFile(path.join(resourcesWebview, 'index.html'), html);
  });

  afterAll(async () => {
    // Best-effort cleanup
    try { await fsp.rm(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  });

  it('rewrites single-quoted link/script and ../icons img to webview URIs', () => {
    let assignedHtml = '';
    const fakeWebview: any = {
      asWebviewUri: (u: vscode.Uri) => vscode.Uri.parse('https://mock' + u.path.replace(/\\/g, '/')),
      cspSource: 'https://mock',
      set html(v: string) { assignedHtml = v; },
      get html() { return assignedHtml; }
    };

    setWebviewHtml(fakeWebview as any, vscode.Uri.file(tmpRoot));

    expect(typeof assignedHtml).toBe('string');
  // styles.css and main.js should be rewritten using webview.asWebviewUri
  expect(assignedHtml).toMatch(/https:\/\/mock.*resources[\\\/]webview[\\\/]styles\.css/);
  expect(assignedHtml).toMatch(/https:\/\/mock.*resources[\\\/]webview[\\\/]main\.js/);
  // icon.png referenced via ../icons should be rewritten to resources/icons
  expect(assignedHtml).toMatch(/https:\/\/mock.*resources[\\\/]icons[\\\/]icon\.png/);
  // CSP meta should include the webview.cspSource somewhere in the HTML
  expect(assignedHtml.indexOf(fakeWebview.cspSource) !== -1).toBe(true);
  });
});
