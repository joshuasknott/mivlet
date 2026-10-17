/** Fixed trusted probe. No project file, URL, command or credential is input.
 * Positive controls must work before an all-denied result can be accepted. */
export const NETWORK_PROBE = String.raw`
import json, socket, struct, threading
results={}
def attempt(name, fn):
    try: results[name]=bool(fn())
    except Exception: results[name]=False
def tcp(host,port):
    s=socket.create_connection((host,port),2); s.close(); return True
def dns_udp():
    q=struct.pack('!HHHHHH',0x4d56,0x0100,1,0,0,0)+b'\x07example\x03com\x00'+struct.pack('!HH',1,1)
    s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(2)
    try:
        s.sendto(q,('1.1.1.1',53)); answer,peer=s.recvfrom(1024)
        return peer[0]=='1.1.1.1' and len(answer)>=12 and answer[:2]==q[:2] and bool(answer[2]&128)
    finally: s.close()
jobs=[('https',lambda:tcp('1.1.1.1',443)),('http',lambda:tcp('1.1.1.1',80)),('udpDns',dns_udp),('resolverDns',lambda:len(socket.getaddrinfo('example.com',443))>0),('privateTcp',lambda:tcp('10.255.255.1',443))]
threads=[threading.Thread(target=attempt,args=job,daemon=True) for job in jobs]
for thread in threads: thread.start()
for thread in threads: thread.join(2.2)
for name,_ in jobs: results.setdefault(name,False)
print(json.dumps(results,sort_keys=True))
`;

/** Runs one reviewed argv directly. The process receives an empty/sanitized
 * environment and fresh disposable project copy. stdout is drained with a hard
 * bound; the project never controls the wrapper or its JSON receipt. */
export const RUN_CHECK = String.raw`
import json, os, resource, selectors, signal, stat, subprocess, sys, time
with open('/workspace/.mivlet-check.json','r',encoding='utf-8') as handle: spec=json.load(handle)
argv=spec['argv']; duration=float(spec['seconds']); root='/workspace/task'
if not isinstance(argv,list) or not argv or not all(isinstance(a,str) and '\x00' not in a for a in argv): raise ValueError('argv')
for directory,dirs,files in os.walk(root,followlinks=False):
    for name in dirs+files:
        path=os.path.join(directory,name); info=os.lstat(path)
        if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)) or info.st_nlink!=1 and stat.S_ISREG(info.st_mode): raise ValueError('source-kind')
        os.chown(path,65534,65534); os.chmod(path,0o700 if stat.S_ISDIR(info.st_mode) else 0o600)
os.chown(root,65534,65534); os.chmod(root,0o700)
def restrict():
    os.setsid(); os.setgroups([]); os.setgid(65534); os.setuid(65534)
    resource.setrlimit(resource.RLIMIT_CORE,(0,0)); resource.setrlimit(resource.RLIMIT_NOFILE,(128,128))
    resource.setrlimit(resource.RLIMIT_FSIZE,(32*1024*1024,32*1024*1024))
    resource.setrlimit(resource.RLIMIT_AS,(384*1024*1024,384*1024*1024))
    resource.setrlimit(resource.RLIMIT_NPROC,(64,64)); resource.setrlimit(resource.RLIMIT_CPU,(30,30))
env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/tmp','TMPDIR':'/tmp','LANG':'C.UTF-8','CI':'1','NODE_OPTIONS':'--max-old-space-size=128'}
p=subprocess.Popen(argv,cwd=root,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,preexec_fn=restrict)
sel=selectors.DefaultSelector(); sel.register(p.stdout,selectors.EVENT_READ,'stdout'); sel.register(p.stderr,selectors.EVENT_READ,'stderr')
parts={'stdout':bytearray(),'stderr':bytearray()}; deadline=time.monotonic()+duration; truncated=False; timed_out=False; count=0
while sel.get_map():
    if time.monotonic()>=deadline or count>=32768:
        timed_out=time.monotonic()>=deadline; truncated=count>=32768
        try: os.killpg(p.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        break
    for key,_ in sel.select(min(0.1,max(0,deadline-time.monotonic()))):
        chunk=os.read(key.fileobj.fileno(),min(4096,32768-count))
        if not chunk: sel.unregister(key.fileobj)
        else: parts[key.data].extend(chunk); count+=len(chunk)
try: p.wait(timeout=1)
except subprocess.TimeoutExpired:
    try: os.killpg(p.pid,signal.SIGKILL)
    except ProcessLookupError: pass
    p.wait(timeout=1); timed_out=True
print(json.dumps({'exitCode':p.returncode,'stdout':parts['stdout'].decode('utf-8','replace'),'stderr':parts['stderr'].decode('utf-8','replace'),'truncated':truncated,'timedOut':timed_out}))
`;
