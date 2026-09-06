"""Copy completed browser downloads across the private-profile boundary."""
import os
from pathlib import Path
import re
import secrets
import stat
import uuid

MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024


def discard_download(guid, private='/home/fable/.downloads'):
    if str(uuid.UUID(guid)) != guid:
        raise ValueError('Invalid download identifier.')
    descriptor = os.open(private, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for name in (guid, guid + '.crdownload'):
            try:
                os.unlink(name, dir_fd=descriptor)
            except FileNotFoundError:
                pass
    finally:
        os.close(descriptor)


def safe_filename(value):
    value = re.sub(r'[\x00-\x1f\x7f<>:"/\\|?*]', '_', str(value))
    value = value.strip(' .') or 'download'
    if value.split('.')[0].upper() in {'CON', 'PRN', 'AUX', 'NUL',
                                      *(f'COM{i}' for i in range(10)),
                                      *(f'LPT{i}' for i in range(10))}:
        value = '_' + value
    suffix = Path(value).suffix[:20]
    return value[:120 - len(suffix)] + suffix if len(value) > 120 else value


def publish_download(guid, suggested_filename, private='/home/fable/.downloads',
                     workspace='/home/fable/Workspace', owner=1000, group=1001):
    """Never let Chromium write into an agent-controlled directory or link.

    The source must be a completed, ordinary GUID-named file. Every destination
    operation uses an opened directory descriptor, refuses symlinks, and never
    replaces an existing file. Failed or oversized downloads expose no partial.
    """
    if str(uuid.UUID(guid)) != guid:
        raise ValueError('Invalid download identifier.')
    opened = []
    temporary = None
    destination = None
    try:
        private_fd = os.open(private, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        opened.append(private_fd)
        source = os.open(guid, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=private_fd)
        opened.append(source)
        metadata = os.fstat(source)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise ValueError('Download is not an ordinary file.')
        if metadata.st_size > MAX_DOWNLOAD_BYTES:
            raise ValueError('Downloads must be 25 MiB or smaller.')
        workspace_fd = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        opened.append(workspace_fd)
        try:
            os.mkdir('Downloads', 0o2770, dir_fd=workspace_fd)
        except FileExistsError:
            pass
        destination = os.open('Downloads', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                              dir_fd=workspace_fd)
        opened.append(destination)
        os.fchown(destination, owner, group)
        os.fchmod(destination, 0o2770)
        temporary = '.fable-download-' + secrets.token_hex(16)
        output = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=destination)
        opened.append(output)
        count = 0
        while True:
            data = os.read(source, 64 * 1024)
            if not data:
                break
            count += len(data)
            if count > MAX_DOWNLOAD_BYTES:
                raise ValueError('Downloads must be 25 MiB or smaller.')
            offset = 0
            while offset < len(data):
                offset += os.write(output, data[offset:])
        os.fsync(output)
        os.fchown(output, owner, group)
        os.fchmod(output, 0o660)
        name = guid[:8] + '-' + safe_filename(suggested_filename)
        os.link(temporary, name, src_dir_fd=destination, dst_dir_fd=destination,
                follow_symlinks=False)
        os.unlink(temporary, dir_fd=destination)
        temporary = None
        os.unlink(guid, dir_fd=private_fd)
        return {'state': 'completed', 'relativePath': 'Downloads/' + name, 'sizeBytes': count}
    finally:
        if temporary is not None and destination is not None:
            try:
                os.unlink(temporary, dir_fd=destination)
            except FileNotFoundError:
                pass
        for descriptor in reversed(opened):
            os.close(descriptor)
