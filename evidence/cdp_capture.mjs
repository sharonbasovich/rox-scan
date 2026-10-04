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
// Capture may contain live auth headers -> create owner-only (0600) so other
// local users can't read it. Still git-ignored; never commit this file.
const out = fs.createWriteStream('/home/ubuntu/net_capture.jsonl', {flags:'a', mode:0o600});
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
};
ws.onerror = (e)=>console.error('ws err', e.message);
// Keep the process alive while capturing; exit cleanly when the page/socket closes.
const keepAlive = setInterval(()=>{}, 1<<30);
ws.onclose = () => { clearInterval(keepAlive); reqs.clear(); out.end(() => process.exit(0)); };
