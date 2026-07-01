import os
import sys
import json
import shutil
import subprocess
import argparse
from pathlib import Path
import hashlib

def get_git_commit(repo_path: Path) -> str:
    """Get the current git commit SHA for a repository."""
    try:
        result = subprocess.run(
            ['git', 'rev-parse', 'HEAD'],
            cwd=str(repo_path),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
            text=True
        )
        return result.stdout.strip()
    except subprocess.CalledProcessError as e:
        print(f"Error getting git commit for {repo_path}: {e.stderr}", file=sys.stderr)
        return "unknown"

def hash_file(file_path: Path) -> str:
    """Calculate SHA256 hash of a file."""
    h = hashlib.sha256()
    with open(file_path, 'rb') as f:
        while chunk := f.read(8192):
            h.update(chunk)
    return h.hexdigest()

def sync_upstream(upstream_path: Path, source_rel_paths: list, target_dir: Path, lock_file: Path, report_only: bool = False):
    """Sync files from upstream and update lock file."""
    upstream_commit = get_git_commit(upstream_path)

    # Load existing lock file if it exists
    lock_data = {}
    if lock_file.exists():
        with open(lock_file, 'r') as f:
            lock_data = json.load(f)

    if report_only:
        print(f"--- Upstream Drift Report ---")
        print(f"Upstream HEAD: {upstream_commit}\n")
        drift_found = False

        for file_info in lock_data.get('files', []):
            upstream_file = upstream_path / file_info['upstream_path']
            if not upstream_file.exists():
                print(f"[DELETED UPSTREAM] {file_info['upstream_path']}")
                drift_found = True
                continue

            current_hash = hash_file(upstream_file)
            if current_hash != file_info['hash']:
                print(f"[CHANGED UPSTREAM] {file_info['upstream_path']}")
                print(f"  Vendored from commit: {file_info['commit']}")
                print(f"  Current upstream HEAD: {upstream_commit}")
                drift_found = True
        
        if not drift_found:
            print("No upstream drift detected. Vendored files are up-to-date with upstream HEAD.")
        return

    # Perform Sync
    for rel_path in source_rel_paths:
        dest_dir = target_dir / rel_path
        if dest_dir.exists() and dest_dir.resolve() != target_dir.resolve():
            shutil.rmtree(dest_dir, ignore_errors=True)
            os.makedirs(dest_dir, exist_ok=True)

    new_lock_data = {
        "source_repo": "ccsj-catalog",
        "last_sync_commit": upstream_commit,
        "files": []
    }

    print(f"Vendoring from {upstream_path} at commit {upstream_commit}...")

    for source_rel_path in source_rel_paths:
        source_dir = upstream_path / source_rel_path
        if not source_dir.exists():
            print(f"Warning: Upstream source {source_dir} does not exist.", file=sys.stderr)
            continue

        # Copy files
        for root, dirs, files in os.walk(source_dir):
            # Skip pycache
            if '__pycache__' in dirs:
                dirs.remove('__pycache__')
                
            for file in files:
                if file.endswith('.pyc') or file.endswith('.lock') or file == '.DS_Store':
                    continue
                    
                src_file = Path(root) / file
                rel_path = src_file.relative_to(upstream_path)
                
                # Destination path inside vendor dir
                dest_rel_path = src_file.relative_to(upstream_path)
                dest_file = target_dir / dest_rel_path
                
                os.makedirs(dest_file.parent, exist_ok=True)
                shutil.copy2(src_file, dest_file)
                
                new_lock_data['files'].append({
                    "upstream_path": str(rel_path).replace("\\", "/"),
                    "vendored_path": str(dest_rel_path).replace("\\", "/"),
                    "commit": upstream_commit,
                    "hash": hash_file(src_file)
                })
                print(f"  Vendored: {rel_path}")

    with open(lock_file, 'w') as f:
        json.dump(new_lock_data, f, indent=2)
    
    print(f"\nSuccess. UPSTREAM.lock updated with {len(new_lock_data['files'])} files.")

def main():
    parser = argparse.ArgumentParser(description="Vendor upstream modules with lockfile tracking.")
    parser.add_argument("--report", action="store_true", help="Report drift against upstream without syncing.")
    parser.add_argument("--upstream", type=str, default=r"C:\Users\adamw\coding_workspaces\ccsj-catalog", help="Path to upstream ccsj-catalog repo.")
    
    args = parser.parse_args()
    
    workspace_root = Path(r"C:\Users\adamw\coding_workspaces\sjf_catalog\sjf_catalog")
    target_dir = workspace_root / "services" / "swarm" / "vendor"
    # 1. Backend (Python) vendored into services/swarm/vendor
    sync_upstream(
        upstream_path=Path(args.upstream),
        source_rel_paths=["src/server", "src/utils"],
        target_dir=workspace_root / "services" / "swarm" / "vendor",
        lock_file=workspace_root / "services" / "swarm" / "UPSTREAM.lock",
        report_only=args.report
    )
    
    # 2. Frontend (Next.js) vendored into src/
    # We omit src/server and src/utils from the frontend payload to avoid duplicates,
    # as those belong to the Python backend swarm now.
    sync_upstream(
        upstream_path=Path(args.upstream),
        source_rel_paths=["src/app", "src/components", "src/lib"],
        target_dir=workspace_root,
        lock_file=workspace_root / "src" / "UPSTREAM_FRONTEND.lock",
        report_only=args.report
    )

if __name__ == "__main__":
    main()
