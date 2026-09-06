"""Portable policy regressions; live tree transport is exercised in Docker."""
import importlib.machinery
from pathlib import Path
import types
import unittest
import sys

sys.dont_write_bytecode = True

path = Path(__file__).parents[1] / 'rootfs/usr/local/bin/fable-desktop-privacy'
privacy = types.ModuleType('privacy')
importlib.machinery.SourceFileLoader('privacy', str(path)).exec_module(privacy)


class Api:
    ROLE_APPLICATION = 1
    ROLE_PASSWORD_TEXT = 2
    ROLE_DIALOG = 3
    ROLE_ALERT = 4
    STATE_SHOWING = 5
    STATE_MODAL = 6


class Node:
    def __init__(self, role=0, states=(), children=(), name=''):
        self.role, self.states, self.children, self.name = role, states, children, name
        self.childCount = len(children)

    def getRole(self): return self.role
    def getState(self): return self
    def contains(self, state): return state in self.states
    def getChildAtIndex(self, index): return self.children[index]


class PrivacyTests(unittest.TestCase):
    def test_browser_file_chooser_and_unknown_modal_are_private(self):
        self.assertTrue(privacy.private_window('Open File', 'chromium', True, 1000))
        self.assertTrue(privacy.private_window('Continue', 'chromium', True, 1000))
        self.assertTrue(privacy.private_window('Save As', 'soffice', True, 1000))
        self.assertFalse(privacy.private_window('Save As', 'soffice', True, 1002))
        self.assertTrue(privacy.private_window('Password required', 'soffice', True, 1002))

    def test_visible_password_role_is_private_without_reading_text(self):
        for states, expected in [((Api.STATE_SHOWING,), True), ((), False)]:
            root = Node(Api.ROLE_APPLICATION, children=[Node(Api.ROLE_PASSWORD_TEXT, states)], name='Chromium')
            self.assertEqual(privacy.private_accessibility(Api, root), (expected, True))

    def test_unknown_accessibility_modal_and_missing_nodes_fail_closed(self):
        root = Node(children=[Node(states=(Api.STATE_SHOWING, Api.STATE_MODAL))])
        self.assertTrue(privacy.private_accessibility(Api, root)[0])
        with self.assertRaises(ValueError):
            privacy.private_accessibility(Api, Node(children=[None]))


if __name__ == '__main__':
    unittest.main()
