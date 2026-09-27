const r = await (await fetch('http://localhost:29229/json')).json();
const page = r.find(t=>t.type==='page' && t.url.includes('run.rox.com'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const pend=new Map();
const call=(method,params={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method,params}));});
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id);}};
await new Promise(r=>ws.onopen=r);
await call('Runtime.enable');
const expr = `(()=>{
  const summarize=(store)=>Object.keys(store).map(k=>{
    const v=store.getItem(k)||'';
    const looksJWT=/eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\./.test(v);
    const looksToken=/token|auth|secret|refresh|access/i.test(k)||looksJWT;
    return {key:k, len:v.length, jwt:looksJWT, sensitive:looksToken};
  });
  return JSON.stringify({localStorage:summarize(localStorage), sessionStorage:summarize(sessionStorage)});
})()`;
const res = await call('Runtime.evaluate',{expression:expr,returnByValue:true});
console.log(res.result.value);
// also check cookie httpOnly via document.cookie visibility
const ck = await call('Runtime.evaluate',{expression:'document.cookie',returnByValue:true});
console.log('document.cookie (JS-visible):', JSON.stringify(ck.result.value));
process.exit(0);
