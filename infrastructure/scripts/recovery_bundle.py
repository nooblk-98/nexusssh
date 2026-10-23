"""Create and rehearse a SQLite, persisted-secrets and immutable-image recovery bundle."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import tempfile


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_database(path):
    with closing(sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)) as db:
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise SystemExit("Database integrity check failed")


def check_secrets(path):
    data = json.loads(path.read_text())
    key = data.get("ENCRYPTION_KEY") if isinstance(data, dict) else None
    if not isinstance(key, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", key):
        raise SystemExit("Bundle needs a persisted 32-byte ENCRYPTION_KEY")


def image_id(value):
    if not value or not re.fullmatch(r"sha256:[0-9a-f]{64}", value):
        raise SystemExit("An immutable Docker image ID (sha256:...) is required")
    return value


def docker(*args, **kwargs):
    return subprocess.run(["docker", *args], check=True, **kwargs)


def rehearse_app(root, image):
    # A read-only bind mount ensures the disposable app cannot change the bundle.
    # The app receives its own network, with no published port or production volumes.
    docker("image", "inspect", image, stdout=subprocess.DEVNULL)
    result = docker(
        "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,nosuid,nodev",
        "--mount", f"type=bind,src={root / 'nexusssh.db'},dst=/app/data/nexusssh.db,readonly",
        "--mount", f"type=bind,src={root / 'secrets.json'},dst=/app/secrets/secrets.json,readonly",
        "--entrypoint", "node", image, "infrastructure/scripts/recovery_probe.mjs",
        capture_output=True, text=True,
    )
    if result.stdout.strip() != "Recovery probe passed":
        raise SystemExit("Isolated restore probe did not complete")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["create", "rehearse"])
    parser.add_argument("--database", default="/app/data/nexusssh.db")
    parser.add_argument("--secrets", default="/app/secrets/secrets.json")
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--image-id", help="Immutable Docker image ID of the deployed image; required for create")
    args = parser.parse_args()
    bundle = Path(args.bundle).resolve()
    if args.action == "create":
        image = image_id(args.image_id)
        database, secrets = Path(args.database).resolve(), Path(args.secrets).resolve()
        if bundle.exists():
            raise SystemExit("Choose a new bundle directory")
        if not database.is_file() or not secrets.is_file():
            raise SystemExit("Database and persisted secrets file must both exist")
        check_secrets(secrets)
        bundle.mkdir(mode=0o700, parents=True)
        try:
            saved_db, saved_secrets = bundle / "nexusssh.db", bundle / "secrets.json"
            with closing(sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)) as source:
                with closing(sqlite3.connect(saved_db)) as target:
                    source.backup(target)
            check_database(saved_db)
            saved_secrets.write_bytes(secrets.read_bytes())
            os.chmod(saved_db, 0o600)
            os.chmod(saved_secrets, 0o600)
            (bundle / "manifest.json").write_text(json.dumps({
                "format": 2, "image_id": image,
                "database_sha256": digest(saved_db), "secrets_sha256": digest(saved_secrets),
            }, indent=2) + "\n")
            os.chmod(bundle / "manifest.json", 0o600)
        except Exception:
            raise SystemExit("Bundle creation failed; discard the incomplete directory")
        print("Recovery bundle created:", bundle)
    else:
        manifest = json.loads((bundle / "manifest.json").read_text())
        if manifest.get("format") != 2:
            raise SystemExit("Unknown bundle format")
        image = image_id(manifest.get("image_id"))
        if args.image_id and image_id(args.image_id) != image:
            raise SystemExit("Supplied image ID differs from bundle manifest")
        saved_db, saved_secrets = bundle / "nexusssh.db", bundle / "secrets.json"
        if digest(saved_db) != manifest.get("database_sha256") or digest(saved_secrets) != manifest.get("secrets_sha256"):
            raise SystemExit("Bundle checksum mismatch")
        with tempfile.TemporaryDirectory() as staging:
            root = Path(staging)
            staged_db, staged_secrets = root / "nexusssh.db", root / "secrets.json"
            shutil.copyfile(saved_db, staged_db)
            shutil.copyfile(saved_secrets, staged_secrets)
            check_database(staged_db)
            check_secrets(staged_secrets)
            rehearse_app(root, image)
        print("Offline restore rehearsal passed:", bundle)


if __name__ == "__main__":
    main()
