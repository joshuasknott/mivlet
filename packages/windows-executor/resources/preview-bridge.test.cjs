"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const vm=require("node:vm");
const fs=require("node:fs");
const source=fs.readFileSync(require("node:path").join(__dirname,"preview-bridge.cjs"),"utf8");
function fixture(env={}) {
  const calls=[];
  class Server {
    listen(...args){calls.push(args);this.bound=true;return this;}
    address(){return this.bound?"actual-private-pipe":null;}
    emit(){return true;}
  }
  class Http extends Server {}
  vm.runInNewContext(source,{Buffer,require:name=>name==="node:net"?{Server}:{Server:Http},process:{env:{MIVLET_PREVIEW_PORT:"3000",MIVLET_PREVIEW_PIPE:"\\\\.\\pipe\\LOCAL\\MivletPreview-"+"a".repeat(48),...env}}});
  return {Server,Http,calls};
}
test("only the exact approved HTTP port is redirected, without public pipe rights or fallback",()=>{
  const {Server,Http,calls}=fixture();const app=new Http();const callback=()=>{};
  assert.equal(app.listen({port:3000,host:"0.0.0.0"},callback),app);
  assert.equal(calls[0][0].path,"\\\\.\\pipe\\LOCAL\\MivletPreview-"+"a".repeat(48));
  assert.equal(calls[0][0].readableAll,false);assert.equal(calls[0][0].writableAll,false);assert.equal(calls[0][1],callback);
  assert.deepEqual(JSON.parse(JSON.stringify(app.address())),{address:"127.0.0.1",family:"IPv4",port:3000});
  new Http().listen(3001);new Server().listen(3000);new Http().listen("unrelated-pipe");
  assert.equal(calls[1][0],3001);assert.equal(calls[2][0],3000);assert.equal(calls[3][0],"unrelated-pipe");
  assert.equal(new Http().address(),null);
});
test("native transport requires the exact private pipe namespace and bounded configured port",()=>{
  for(const env of [{MIVLET_PREVIEW_PORT:"0"},{MIVLET_PREVIEW_PORT:"65536"},{MIVLET_PREVIEW_PORT:"3000;evil"},{MIVLET_PREVIEW_PIPE:"\\\\.\\pipe\\host"},{MIVLET_PREVIEW_PIPE:"\\\\server\\pipe\\LOCAL\\MivletPreview-"+"a".repeat(48)}]) assert.throws(()=>fixture(env),/native preview transport/);
});
test("picker bootstrap preserves CSP, avoids compressed streams, and only adjusts a bounded first HTML chunk",()=>{
  const {Http}=fixture();const app=new Http();app.listen(3000);
  function response(headers) {
    return {headersSent:false,getHeader:key=>headers[key],removeHeader:key=>delete headers[key],write(chunk){this.chunk=chunk;},end(chunk){this.chunk=chunk;}};
  }
  const headers={"content-type":"text/html","content-length":"42","content-security-policy":"script-src 'none'"};
  const html=response(headers);app.emit("request",{},html);html.end("<!doctype html><html><head><title>Actual</title></head><body>App</body></html>");
  assert.match(html.chunk.toString(),/__mivlet_preview\/picker.js/);assert.equal(headers["content-length"],undefined);assert.equal(headers["content-security-policy"],"script-src 'none'");
  const compressed=response({"content-type":"text/html","content-encoding":"gzip"});app.emit("request",{},compressed);compressed.end("<html><head></head></html>");assert.equal(compressed.chunk,"<html><head></head></html>");
  const large=response({"content-type":"text/html"});app.emit("request",{},large);large.write("<head>"+"x".repeat(65536));assert.equal(typeof large.chunk,"string");
});
