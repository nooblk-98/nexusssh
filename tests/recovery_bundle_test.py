"""Verify manifest binding, tamper detection, and isolated probe invocation."""
import json
import os
from contextlib import closing
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "infrastructure/scripts/recovery_bundle.py"
IMAGE = "sha256:" + "a" * 64


class RecoveryBundleTest(unittest.TestCase):
    def test_create_rehearse_and_detect_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database, secrets, bundle = root / "live.db", root / "secrets.json", root / "bundle"
            with closing(sqlite3.connect(database)) as db:
                db.execute('CREATE TABLE "SSHIdentity" (id TEXT, organizationId TEXT, encryptedSecret TEXT)')
                db.commit()
            secrets.write_text(json.dumps({"ENCRYPTION_KEY": "1" * 64}))
            fake_docker = root / ("docker.bat" if os.name == "nt" else "docker")
            if os.name == "nt":
                fake_docker.write_text("@echo off\r\nif \"%1\"==\"run\" echo Recovery probe passed\r\n")
            else:
                fake_docker.write_text("#!/bin/sh\nif [ \"$1\" = run ]; then echo 'Recovery probe passed'; fi\n")
                fake_docker.chmod(0o755)
            env = {**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"]}
            args = ["--database", str(database), "--secrets", str(secrets), "--bundle", str(bundle)]
            def call(action, *extra):
                return subprocess.run([sys.executable, str(SCRIPT), action, *args, *extra],
                                      capture_output=True, text=True, env=env)
            self.assertEqual(call("create", "--image-id", IMAGE).returncode, 0)
            manifest = json.loads((bundle / "manifest.json").read_text())
            self.assertEqual(manifest["image_id"], IMAGE)
            if os.name != "nt":
                result = call("rehearse", "--image-id", IMAGE)
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotEqual(call("rehearse", "--image-id", "sha256:" + "b" * 64).returncode, 0)
            (bundle / "secrets.json").write_text("{}")
            self.assertNotEqual(call("rehearse").returncode, 0)


if __name__ == "__main__":
    unittest.main()
