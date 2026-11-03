"""Run on Linux: verify the exact reader embedded and sent by the server."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "src/LogDesk.Server/Infrastructure/follow_log.py"
spec = importlib.util.spec_from_file_location("follower", SCRIPT)
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


class FollowChecks(unittest.TestCase):
    def test_idle_reader_exits_when_output_pipe_closes(self):
        with tempfile.TemporaryDirectory() as root:
            log = Path(root) / "empty.log"
            log.touch()
            process = subprocess.Popen([sys.executable, "-u", str(SCRIPT), str(log)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                time.sleep(0.2)
                process.stdout.close()
                self.assertEqual(process.wait(timeout=5), 0)
            finally:
                if process.poll() is None:
                    process.terminate()
                process.wait(timeout=5)
                process.stderr.close()

    def test_snapshot_and_nofollow(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            log = directory / "quoted '日志.log"
            lines = [f"INFO {i} 中文\n".encode() for i in range(250)]
            log.write_bytes(b"".join(lines))
            fd = reader.open_regular(str(log))
            try:
                self.assertEqual(reader.snapshot(fd), b"".join(lines[-200:]))
            finally:
                os.close(fd)
            link = directory / "link.log"
            link.symlink_to(log)
            with self.assertRaises(OSError):
                reader.open_regular(str(link))
            alias = directory / "alias"
            alias.symlink_to(directory, target_is_directory=True)
            with self.assertRaises(OSError):
                reader.open_regular(str(alias / log.name))
            fifo = directory / "fifo.log"
            os.mkfifo(fifo)
            with self.assertRaises(ValueError):
                reader.open_regular(str(fifo))

    def test_rotation_recreation_and_symlink_replacement(self):
        with tempfile.TemporaryDirectory() as root:
            log = Path(root) / "app.log"
            log.write_bytes(b"initial\n")
            process = subprocess.Popen([sys.executable, "-u", str(SCRIPT), str(log)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            output = bytearray()
            pump = threading.Thread(target=lambda: [output.extend(chunk) for chunk in iter(lambda: process.stdout.read(1), b"")], daemon=True)
            pump.start()

            def wait_for(marker):
                deadline = time.monotonic() + 5
                while marker not in output and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertIn(marker, output)

            try:
                wait_for(b"initial")
                with log.open("ab") as file:
                    file.write(b"appended\n")
                wait_for(b"appended")
                log.write_bytes(b"cut\n")
                wait_for(b"cut")
                log.rename(str(log) + ".1")
                log.write_bytes(b"rotated\n")
                wait_for(b"rotated")
                log.unlink()
                time.sleep(0.3)
                log.write_bytes(b"recreated\n")
                wait_for(b"recreated")
                secret = Path(root) / "outside.txt"
                secret.write_bytes(b"MUST_NOT_LEAK\n")
                log.unlink()
                log.symlink_to(secret)
                self.assertEqual(process.wait(timeout=5), 78)
                pump.join(timeout=2)
                self.assertNotIn(b"MUST_NOT_LEAK", output)
            finally:
                if process.poll() is None:
                    process.terminate()
                process.wait(timeout=5)
                pump.join(timeout=2)
                process.stdout.close()
                process.stderr.close()


if __name__ == "__main__":
    unittest.main()
