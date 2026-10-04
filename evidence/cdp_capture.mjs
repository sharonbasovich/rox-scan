// Attach to Rox page via CDP, capture network requests/responses to a log file.
const TARGET_URL_SUBSTR = process.env.TARGET || 'run.rox.com';
const listRes = await fetch('http://localhost:29229/json');
const targets = await listRes.json();
const page = targets.find(t => t.type === 'page' && t.url.includes(TARGET_URL_SUBSTR));
if (!page) { console.error('no page target found'); process.exit(1); }
console.error('attaching to', page.url);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const send = (method, params={}) => ws.send(JSON.stringify({id: ++id, method, params}));
const reqs = new Map();
import fs from 'fs';
// Capture may contain live auth headers -> owner-only (0600) so other local
// users can't read it. chmod enforces this even if the file already exists
// with looser permissions (mode on createWriteStream only applies at creation).
// Still git-ignored; never commit this file.
const CAP = '/home/ubuntu/net_capture.jsonl';
// Open the fd ourselves, then fchmod that fd (not the path) so we enforce 0600
// on a pre-existing file with no path/symlink race. If we can't secure it, abort
// rather than append live auth headers to a world-readable file.
let fd;
try {
  fd = fs.openSync(CAP, 'a', 0o600);
  fs.fchmodSync(fd, 0o600);
} catch (e) {
  console.error('cannot secure capture file, refusing to write:', e.message);
  process.exit(1);
}
const out = fs.createWriteStream(CAP, {fd});
ws.onopen = () => { send('Network.enable'); console.error('Network.enable sent'); };
ws.onmessage = (ev) => {
  let msg; try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.method === 'Network.requestWillBeSent') {
    const r = msg.params;
    reqs.set(r.requestId, {url:r.request.url, method:r.request.method, headers:r.request.headers, postData:r.request.postData});
  }
  if (msg.method === 'Network.responseReceived') {
    const r = msg.params; const req = reqs.get(r.requestId) || {};
    const rec = {ts:Date.now(), url:r.response.url, method:req.method, status:r.response.status,
      reqHeaders:req.headers, postData:req.postData, respHeaders:r.response.headers, mime:r.response.mimeType};
    out.write(JSON.stringify(rec)+'\n');
    reqs.delete(r.requestId); // drop completed request so memory doesn't grow with traffic
  }
  // requests that error out never get a response -> drop them too, else they leak
  if (msg.method === 'Network.loadingFailed') { reqs.delete(msg.params.requestId); }
};
ws.onerror = (e)=>console.error('ws err', e.message);
// Keep the process alive while capturing; exit when the page/socket closes.
// Non-zero exit on an unclean close so interrupted captures aren't reported as success.
const keepAlive = setInterval(()=>{}, 1<<30);
ws.onclose = (ev) => { clearInterval(keepAlive); reqs.clear(); out.end(() => process.exit(ev && ev.wasClean ? 0 : 1)); };
