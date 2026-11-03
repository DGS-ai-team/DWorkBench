"""Read-only Linux follower, sent over SSH; requires Python 3, no install step.

Every path component and every replacement is opened with O_NOFOLLOW. Keep the
opened descriptor for reads, so a later path substitution cannot redirect it.
Output is original bytes; the server only admits LF-compatible encodings.
"""
import os
import select
import stat
import sys
import time


def open_regular(path):
    parts = path.split("/")
    if not path.startswith("/") or any(p in (".", "..") for p in parts):
        raise ValueError("invalid absolute path")
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for component in [p for p in parts[1:-1] if p]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            raise ValueError("not a regular file")
        return fd
    finally:
        os.close(directory)


def snapshot(fd):
    end = os.fstat(fd).st_size
    start = max(0, end - 131072)
    os.lseek(fd, start, os.SEEK_SET)
    data = b""
    while len(data) < end - start:
        chunk = os.read(fd, min(8192, end - start - len(data)))
        if not chunk:
            break
        data += chunk
    if start:
        boundary = data.find(b"\n")
        data = data[boundary + 1:] if boundary >= 0 else b""
    lines = 201 if data.endswith(b"\n") else 200
    return b"\n".join(data.split(b"\n")[-lines:])


def follow(path):
    disconnected = select.poll()
    disconnected.register(sys.stdout.fileno(), select.POLLERR | select.POLLHUP)
    fd = open_regular(path)
    try:
        sys.stdout.buffer.write(snapshot(fd))
        sys.stdout.buffer.flush()
        check_at = 0
        while True:
            # Detect a closed SSH output pipe even when the log stays idle and
            # no write would otherwise raise BrokenPipeError.
            if disconnected.poll(0):
                raise BrokenPipeError()
            if time.monotonic() >= check_at:
                try:
                    candidate = open_regular(path)
                except FileNotFoundError:
                    candidate = None
                if candidate is not None:
                    current = os.fstat(fd)
                    replacement = os.fstat(candidate)
                    if (current.st_dev, current.st_ino) != (replacement.st_dev, replacement.st_ino):
                        try:
                            # Preserve the old inode's unread suffix. Bound the
                            # drain by its observed size so a writer continuing
                            # on the old inode cannot starve the replacement.
                            remaining = max(0, current.st_size - os.lseek(fd, 0, os.SEEK_CUR))
                            while remaining:
                                suffix = os.read(fd, min(8192, remaining))
                                if not suffix:
                                    break
                                sys.stdout.buffer.write(suffix)
                                sys.stdout.buffer.flush()
                                remaining -= len(suffix)
                        finally:
                            os.close(fd)
                            fd = candidate  # Read a replacement from its beginning.
                    else:
                        os.close(candidate)
                check_at = time.monotonic() + 0.2
            if os.fstat(fd).st_size < os.lseek(fd, 0, os.SEEK_CUR):
                os.lseek(fd, 0, os.SEEK_SET)
            chunk = os.read(fd, 8192)
            if chunk:
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
            else:
                time.sleep(0.02)
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        follow(sys.argv[1])
    except BrokenPipeError:
        os._exit(0)
    except (OSError, ValueError):
        # Never include paths, file data or exception details in SSH diagnostics.
        sys.stderr.write("LogDesk requires a readable regular file with no symlink path components.\n")
        sys.exit(78)
