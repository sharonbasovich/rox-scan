const r = await (await fetch('http://localhost:29229/json')).json();
const page = r.find(t=>t.type==='page' && t.url.includes('run.rox.com'));
if(!page){console.log('no rox page; pages:', r.filter(t=>t.type==='page').map(t=>t.url)); process.exit(0);}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const pend=new Map();
const call=(m,p={})=>new Promise(res=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m.result);pend.delete(m.id);}};
await new Promise(res=>ws.onopen=res);
await call('Runtime.enable');
const expr=`(()=>{
  const q=(s)=>[...document.querySelectorAll(s)].map(e=>({tag:e.tagName,ph:e.getAttribute('placeholder')||e.getAttribute('aria-label')||'',role:e.getAttribute('role')||'',ce:e.getAttribute('contenteditable')||'',id:e.id||'',cls:(e.className||'').toString().slice(0,60)}));
  return JSON.stringify({url:location.href,
    textareas:q('textarea'),
    editables:q('[contenteditable="true"],[contenteditable=""]'),
    textboxes:q('[role="textbox"]'),
    sendBtns:[...document.querySelectorAll('button')].filter(b=>/send|submit|arrow|ask/i.test((b.getAttribute('aria-label')||'')+b.textContent+b.className)).map(b=>({al:b.getAttribute('aria-label')||'',txt:b.textContent.slice(0,20),cls:(b.className||'').toString().slice(0,50)})).slice(0,6)
  },null,1);
})()`;
const res=await call('Runtime.evaluate',{expression:expr,returnByValue:true});
console.log(res.result.value||JSON.stringify(res));
process.exit(0);
