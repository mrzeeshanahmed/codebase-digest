import * as fs from 'fs';
import * as path from 'path';

describe('Webview HTML security checks', () => {
  it('has no inline event handlers or javascript: URIs in index.html', () => {
    const repoRoot = path.join(__dirname, '..', '..');
    const htmlPath = path.join(repoRoot, 'resources', 'webview', 'index.html');
    const raw = fs.readFileSync(htmlPath, 'utf8');

    // Detect attributes like onclick=, onsubmit=, onmouseover= etc. only when inside an HTML tag
    // e.g. <button onclick="...">. This avoids accidental matches inside words like "content" or "icon".
    const inlineHandlerRe = /<[^>]+\s(on\w+)\s*=\s*['"`]/i;
    // Detect javascript: URIs specifically in href/src attributes (e.g. href="javascript:...")
    const jsUriRe = /<[^>]+\s(?:href|src)\s*=\s*['"`]\s*javascript\s*:/i;

  const foundHandler = inlineHandlerRe.exec(raw);
  const foundJsUri = jsUriRe.exec(raw);

  if (foundHandler) {
    // include a short snippet to help locate the offending tag
    const snippet = foundHandler[0].slice(0, 200);
    throw new Error('Inline event handler attribute found in index.html: ' + snippet + '\nUse addEventListener and postMessage instead');
  }
  if (foundJsUri) {
    const snippet = foundJsUri[0].slice(0, 200);
    throw new Error('Found javascript: URI in index.html: ' + snippet + '\nAvoid javascript: links and use event listeners with postMessage instead');
  }
  });
});
