"""Run inside Linux: python3 tests/test_downloads.py."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'rootfs/usr/local/bin'))
from fable_downloads import MAX_DOWNLOAD_BYTES, publish_download, safe_filename


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.private = self.root / 'private'
        self.workspace = self.root / 'workspace'
        self.private.mkdir()
        self.workspace.mkdir()
        self.guid = str(uuid.uuid4())
        self.source = self.private / self.guid
        self.source.write_bytes(b'public downloaded content')

    def tearDown(self):
        self.temporary.cleanup()

    def publish(self, filename='report.csv'):
        return publish_download(self.guid, filename, str(self.private), str(self.workspace),
                                os.getuid(), os.getgid())

    def test_completed_download_is_bounded_and_named_without_overwrite(self):
        result = self.publish()
        target = self.workspace / result['relativePath']
        self.assertEqual(target.read_bytes(), b'public downloaded content')
        self.assertEqual(result['sizeBytes'], 25)
        self.assertFalse(self.source.exists())
        self.source.write_bytes(b'replacement')
        with self.assertRaises(FileExistsError):
            self.publish()
        self.assertEqual(target.read_bytes(), b'public downloaded content')
        self.assertFalse(any(p.name.startswith('.fable-download-') for p in target.parent.iterdir()))

    def test_workspace_download_symlink_cannot_write_private_profile(self):
        (self.workspace / 'Downloads').symlink_to(self.private, target_is_directory=True)
        with self.assertRaises(OSError):
            self.publish()
        self.assertEqual(list(self.private.iterdir()), [self.source])

    def test_source_symlink_or_hardlink_is_refused(self):
        secret = self.private / 'private-cookie-test'
        secret.write_bytes(b'private profile fixture')
        self.source.unlink()
        self.source.symlink_to(secret)
        with self.assertRaises(OSError):
            self.publish()
        self.source.unlink()
        os.link(secret, self.source)
        with self.assertRaises(ValueError):
            self.publish()
        self.assertFalse((self.workspace / 'Downloads').exists())

    def test_oversized_download_never_exposes_partial(self):
        with self.source.open('wb') as stream:
            stream.truncate(MAX_DOWNLOAD_BYTES + 1)
        with self.assertRaisesRegex(ValueError, '25 MiB'):
            self.publish()
        self.assertFalse((self.workspace / 'Downloads').exists())

    def test_untrusted_names_are_safe_on_linux_and_windows(self):
        self.assertEqual(safe_filename('../CON:stream.csv'), '_CON_stream.csv')
        self.assertEqual(safe_filename('CON.txt'), '_CON.txt')
        self.assertLessEqual(len(safe_filename('a' * 200 + '.xlsx')), 120)
        result = self.publish('../../nested\\report.csv')
        self.assertEqual(len(Path(result['relativePath']).parts), 2)
        with self.assertRaises(ValueError):
            publish_download('../profile', 'x', str(self.private), str(self.workspace))


if __name__ == '__main__':
    unittest.main()
