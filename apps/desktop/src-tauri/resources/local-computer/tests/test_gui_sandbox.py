"""Real image regression: run as root in a disposable Fable test container."""
import json
import os
from pathlib import Path
import subprocess
import unittest


@unittest.skipUnless(os.environ.get('FABLE_GUI_SANDBOX_TEST') == '1',
                     'Requires an explicitly selected disposable Linux computer.')
class GuiSandboxTests(unittest.TestCase):
    def test_display_authentication_uses_peer_uid_without_a_copyable_cookie(self):
        self.assertFalse(Path('/run/fable-gui/Xauthority').exists())
        for uid, expected in ((1002, 0), (1001, 1)):
            result = subprocess.run([
                'setpriv', '--reuid=' + str(uid), '--regid=' + str(uid),
                '--clear-groups', '--no-new-privs', '--bounding-set=-all', 'xdpyinfo',
            ], env={'PATH': '/usr/bin:/bin', 'DISPLAY': ':99', 'XAUTHORITY': '/dev/null'},
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
            self.assertEqual(result.returncode, expected)
        # Even an accidentally created GUI-readable cookie file would remain
        # outside the GUI filesystem read policy and could not be saved out.
        path = Path('/run/fable-gui/cookie-regression')
        path.write_bytes(b'synthetic-cookie-fixture')
        path.chmod(0o644)
        try:
            self.assertTrue(self.inside_gui("""
import json
try:
    data=open('/run/fable-gui/cookie-regression','rb').read()
except PermissionError: print(json.dumps(True))
else: raise AssertionError('A GUI application could copy an authentication file')
"""))
        finally:
            path.unlink(missing_ok=True)

    def inside_gui(self, code):
        bootstrap = """import os,runpy
worker=runpy.run_path('/usr/local/bin/fable-gui-worker')
worker['restrict_filesystem']('/usr/bin/python3')
os.execve('/usr/bin/python3',['/usr/bin/python3','-c',CODE], {
 'PATH':'/usr/bin:/bin','HOME':'/home/fable/.app-home',
 'LD_PRELOAD':'/usr/local/lib/fable-gui-exec-guard.so'})
""".replace('CODE', repr(code))
        result = subprocess.run([
            'setpriv', '--reuid=1002', '--regid=1002', '--groups=1001',
            '--no-new-privs', '--inh-caps=-all', '--ambient-caps=-all',
            '--bounding-set=-all', '/usr/bin/python3', '-c', bootstrap,
        ], capture_output=True, text=True, timeout=15,
            env={'PATH': '/usr/bin:/bin'}, cwd='/home/fable/Workspace')
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_shell_loader_and_memfd_execution_are_denied(self):
        result = self.inside_gui("""
import errno,json,os,subprocess
denied=[]
for args in (['/bin/sh','-c','true'], ['/usr/bin/python3','-c','pass'],
             ['/lib64/ld-linux-x86-64.so.2','/usr/bin/true']):
    try: subprocess.run(args,check=True)
    except PermissionError: denied.append(args[0])
    else: raise AssertionError('A GUI application launched another executable')
descriptor=os.memfd_create('test-executable',0)
with open('/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2','rb') as source:
    os.write(descriptor,source.read())
try: os.execve(descriptor,['loader'],{})
except PermissionError: denied.append('memfd')
else: raise AssertionError('A GUI application executed a memory file')
status=open('/proc/self/status').read()
assert 'NoNewPrivs:\\t1' in status
for key in ('CapInh','CapPrm','CapEff','CapBnd','CapAmb'):
    assert key+':\\t0000000000000000' in status
print(json.dumps(denied))
""")
        self.assertEqual(len(result), 4)

    def test_profile_gateway_and_proc_handles_are_inaccessible(self):
        result = self.inside_gui("""
import json,os,pathlib
denied=[]
link=pathlib.Path('/home/fable/Workspace/.gui-profile-regression')
try:
    link.symlink_to('/home/fable/.config/chromium-fable')
    for path in ('/home/fable/.config/chromium-fable','/home/fable/.downloads',
                 '/run/fable-private','/run/fable-desktop/Xauthority',
                 '/proc/1/root',str(link)):
        try: fd=os.open(path,os.O_RDONLY)
        except PermissionError: denied.append(path)
        else:
            os.close(fd)
            raise AssertionError('A private path could be read')
finally: link.unlink(missing_ok=True)
print(json.dumps(denied))
""")
        self.assertEqual(len(result), 6)

    def test_writable_files_cannot_load_native_code(self):
        result = self.inside_gui("""
import ctypes,json,pathlib
library=pathlib.Path('/usr/local/lib/fable-gui-exec-guard.so').read_bytes()
denied=[]
for directory in ('/home/fable/Workspace','/home/fable/.app-home','/tmp/fable-apps'):
    path=pathlib.Path(directory)/'.gui-code-regression.so'
    try:
        path.write_bytes(library)
        try: ctypes.CDLL(str(path))
        except OSError: denied.append(directory)
        else: raise AssertionError('Writable storage loaded native code')
    finally: path.unlink(missing_ok=True)
print(json.dumps(denied))
""")
        self.assertEqual(len(result), 3)


if __name__ == '__main__':
    unittest.main()
