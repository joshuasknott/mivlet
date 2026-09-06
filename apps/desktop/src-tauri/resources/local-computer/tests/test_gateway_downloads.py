import asyncio
import importlib.machinery
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, patch
import uuid

root = Path(__file__).resolve().parents[1] / 'rootfs/usr/local/bin'
sys.path.insert(0, str(root))
loader = importlib.machinery.SourceFileLoader('gateway', str(root / 'fable-gateway'))
spec = importlib.util.spec_from_loader(loader.name, loader)
gateway = importlib.util.module_from_spec(spec)
loader.exec_module(gateway)


class GatewayDownloads(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.browser = gateway.BrowserPipe()
        self.browser.command = AsyncMock(return_value={'result': {}})
        self.guid = str(uuid.uuid4())

    def event(self, method, **params):
        self.browser.download_event({'method': 'Browser.' + method,
                                     'params': {'guid': self.guid, **params}})

    async def test_cancelled_download_cannot_later_publish(self):
        self.event('downloadWillBegin', suggestedFilename='file.csv')
        with patch.object(gateway, 'discard_download') as discard, \
                patch.object(gateway, 'publish_download') as publish:
            await self.browser.cancel_downloads()
            self.event('downloadProgress', state='completed', receivedBytes=42)
            await asyncio.sleep(0)
            publish.assert_not_called()
            discard.assert_called_once_with(self.guid)
        self.browser.command.assert_awaited_once_with({
            'method': 'Browser.cancelDownload', 'params': {'guid': self.guid}})

    async def test_revoke_drains_copy_already_in_progress(self):
        release = asyncio.Event()
        task = asyncio.create_task(release.wait())
        self.browser.download_tasks.add(task)
        cancellation = asyncio.create_task(self.browser.cancel_downloads())
        await asyncio.sleep(0)
        self.assertFalse(cancellation.done())
        release.set()
        await cancellation

    async def test_oversized_transfer_is_cancelled_before_publication(self):
        self.event('downloadWillBegin', suggestedFilename='file.csv')
        with patch.object(gateway, 'discard_download'), \
                patch.object(gateway, 'publish_download') as publish:
            self.event('downloadProgress', state='inProgress',
                       receivedBytes=gateway.MAX_DOWNLOAD_BYTES + 1)
            await asyncio.gather(*tuple(self.browser.download_tasks))
            publish.assert_not_called()
        self.assertEqual(self.browser.download_results[0]['state'], 'failed')
        self.assertFalse(self.browser.downloads)

    async def test_completed_transfer_reports_safe_artifact_path(self):
        self.event('downloadWillBegin', suggestedFilename='file.csv')
        result = {'state': 'completed', 'relativePath': 'Downloads/file.csv', 'sizeBytes': 42}
        with patch.object(gateway, 'publish_download', return_value=result):
            self.event('downloadProgress', state='completed', receivedBytes=42)
            await asyncio.gather(*tuple(self.browser.download_tasks))
        self.assertEqual(self.browser.download_results, [result])


if __name__ == '__main__':
    unittest.main()
