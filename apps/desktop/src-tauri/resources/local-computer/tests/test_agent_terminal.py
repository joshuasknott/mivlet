"""Portable launch policy; actual PTY/input/cancellation is Docker-tested."""
import importlib.machinery
import os
from pathlib import Path
import sys
import types
import unittest

sys.dont_write_bytecode = True
path = Path(__file__).parents[1] / 'rootfs/usr/local/bin/fable-agent-terminal'
terminal = types.ModuleType('terminal')
importlib.machinery.SourceFileLoader('terminal', str(path)).exec_module(terminal)


class TerminalTests(unittest.TestCase):
    def test_shell_never_inherits_display_provider_or_sudo_environment(self):
        os.environ['DISPLAY'] = ':99'
        os.environ['XAUTHORITY'] = '/private'
        os.environ['PROVIDER_TOKEN'] = 'test-only-marker'
        environment = terminal.shell_environment()
        self.assertFalse(set(environment) & {'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'PROVIDER_TOKEN', 'SUDO_COMMAND'})
        self.assertEqual(environment['HOME'], '/home/agent')

    def test_uid_boundaries_drop_groups_capabilities_and_privilege_gain(self):
        command = terminal.drop_command(1001, 1001, '')
        self.assertIn('--reuid=1001', command)
        self.assertIn('--clear-groups', command)
        self.assertIn('--bounding-set=-all', command)
        self.assertIn('--no-new-privs', command)
        gui = terminal.drop_command(1002, 1002, '1001')
        self.assertIn('--groups=1001', gui)
        self.assertIn('--reuid=1002', gui)

    def test_xterm_handshake_cannot_be_interpreted_as_a_command(self):
        self.assertTrue(terminal.valid_window_id(b'400001\n'))
        for value in (b'400001\nsh\n', b'$(id)\n', b'400001', b'f' * 80 + b'\n'):
            self.assertFalse(terminal.valid_window_id(value))


if __name__ == '__main__':
    unittest.main()
