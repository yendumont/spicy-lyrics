const targets:any[] = await (await fetch("http://127.0.0.1:8088/json")).json();
const t = targets.find(x => /^https:\/\/xpui\.app\.spotify\.com\//.test(x.url ?? ""));
const ws = new WebSocket(t.webSocketDebuggerUrl);
const expr = await Bun.file(process.argv[2]).text();
await new Promise(r => ws.onopen = r);
ws.send(JSON.stringify({id:1,method:"Runtime.evaluate",params:{expression:expr,awaitPromise:true,returnByValue:true}}));
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id===1){ console.log(JSON.stringify(m.result?.exceptionDetails ? m.result.exceptionDetails.exception?.description : (m.result?.result?.value ?? m.result), null, 1)); process.exit(0);} };
setTimeout(()=>{console.log("timeout");process.exit(1)},60000);

