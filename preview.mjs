import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const worker=(await import(pathToFileURL(resolve('dist/server/index.js')))).default;
console.log('Ready for preview JSON on stdin (input is hidden).');
process.stdin.setRawMode(true);process.stdin.resume();
const config=await new Promise(resolve=>{
 let input='';
 const onData=chunk=>{
  input+=chunk.toString();
  if(input.includes('\u0003')) process.exit(0);
  if(/[\r\n]/.test(input)) {
   process.stdin.off('data',onData);process.stdin.setRawMode(false);process.stdin.pause();
   console.log('');resolve(JSON.parse(input.trim()));
  }
 };
 process.stdin.on('data',onData);
});
http.createServer(async(req,res)=>{
  try {
    const url=`http://127.0.0.1:8766${req.url}`;
    const request=new Request(url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body:'{}'}:{})});
    const response=await worker.fetch(request,{BRIDGE_URL:'http://127.0.0.1:8765',BRIDGE_TOKEN:config.token});
    res.writeHead(response.status,Object.fromEntries(response.headers));
    if(response.body) for await(const chunk of response.body) {if(!res.write(chunk)) await new Promise(r=>res.once('drain',r));}
    res.end();
  } catch {res.writeHead(500);res.end('Error');}
}).listen(8766,'127.0.0.1',()=>console.log('Local preview: http://127.0.0.1:8766'));
