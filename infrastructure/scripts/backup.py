"""Consistent online SQLite backup. Restore only while the API is stopped."""
import argparse,sqlite3,os,pathlib,shutil
p=argparse.ArgumentParser();p.add_argument('action',choices=['backup','restore','check']);p.add_argument('--database',default='/app/data/nexusssh.db');p.add_argument('--backup',required=True);p.add_argument('--api-stopped',action='store_true');a=p.parse_args()
database=pathlib.Path(a.database).resolve();backup=pathlib.Path(a.backup).resolve()
if database==backup:raise SystemExit('Database and backup must be different files')
def check(path):
 with sqlite3.connect(f'file:{path.as_posix()}?mode=ro',uri=True) as c:
  if c.execute('pragma integrity_check').fetchone()[0]!='ok':raise SystemExit('Integrity check failed')
if a.action=='backup':
 if backup.exists():raise SystemExit('Choose a new backup destination')
 backup.parent.mkdir(parents=True,exist_ok=True)
 with sqlite3.connect(f'file:{database.as_posix()}?mode=ro',uri=True) as source,sqlite3.connect(backup) as target:source.backup(target)
 os.chmod(backup,0o600);check(backup);print('Consistent backup created:',backup)
elif a.action=='restore':
 if not a.api_stopped:raise SystemExit('Stop the API first, then supply --api-stopped')
 check(backup)
 if any(pathlib.Path(str(database)+s).exists() for s in ['-wal','-shm']):raise SystemExit('WAL/SHM present. Cleanly stop the API and checkpoint before restoring; do not delete live WAL files.')
 temp=database.with_suffix('.restore');shutil.copyfile(backup,temp);os.chmod(temp,0o600);os.replace(temp,database);print('Restored verified backup')
else:check(backup);print('Integrity check passed')
