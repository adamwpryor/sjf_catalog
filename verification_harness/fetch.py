"""Materialize the ground-truth catalog pages from GCS into the local page cache.

Tier 0 reads pages from ``artifacts/page-cache/<version>/pages/page_NNNN.md``. Populating that
cache used to be an out-of-band ``gcloud storage cp`` the operator had to remember; when the cache
was cleared, the sweep silently had nothing to audit. This module makes the fetch part of the
harness so a run is reproducible from a clean checkout.

Design notes:

- **Read-only, least-privilege.** Credentials come from Application Default Credentials
  (``GOOGLE_APPLICATION_CREDENTIALS`` / ``gcloud auth application-default login``). No key material
  is read or stored by the harness. The narrow ``devstorage.read_only`` scope is requested first and
  only falls back to ``cloud-platform`` when the credential type cannot mint it (gcloud user ADC).
- **Incremental.** An object whose local copy already matches the remote byte size is skipped, so
  re-syncing 3,954 pages costs one listing round-trip per catalog.
- **Never silently partial.** A page that fails to download is retried, then raises. A truncated
  page cache would read downstream as "the page has no courses" — a coverage false positive, which
  is the harness's worst failure mode (P5).
"""

from __future__ import annotations

import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

import google.auth
import google.auth.transport.requests
import requests

from . import config

logger = logging.getLogger(__name__)

#: GCS JSON API root. Object listing and media download both hang off this.
_API_ROOT = "https://storage.googleapis.com/storage/v1/b"

#: Preferred scope (least privilege), then the fallback gcloud user ADC actually grants.
_SCOPES: tuple[tuple[str, ...], ...] = (
    ("https://www.googleapis.com/auth/devstorage.read_only",),
    ("https://www.googleapis.com/auth/cloud-platform",),
)

#: Concurrent downloads. The pages are small (a few KB); this is latency-bound, not bandwidth-bound.
_DEFAULT_WORKERS = 16

#: Per-request timeout and retry budget for a single object download.
_TIMEOUT_S = 60
_MAX_ATTEMPTS = 3


class GcsFetchError(RuntimeError):
    """Raised when the page cache cannot be populated (auth, listing, or download failure)."""


@dataclass(frozen=True)
class SyncResult:
    """Outcome of syncing one catalog version's pages.

    Attributes:
        version: The catalog key that was synced.
        remote: Number of ``page_NNNN.md`` objects listed in GCS.
        downloaded: Number of pages actually fetched this run.
        skipped: Number of pages already present locally at the right size.
        bytes_downloaded: Total bytes transferred.
        seconds: Wall-clock duration of the sync.
    """

    version: str
    remote: int
    downloaded: int
    skipped: int
    bytes_downloaded: int
    seconds: float

    @property
    def local(self) -> int:
        """Total pages present locally after the sync."""
        return self.downloaded + self.skipped


class _Token:
    """Thread-safe bearer-token provider backed by Application Default Credentials.

    ``google.auth`` credential objects are not safe to refresh concurrently, so refreshes are
    serialized behind a lock and the resulting token string is handed to plain request sessions.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._creds: google.auth.credentials.Credentials | None = None

    def _load(self) -> google.auth.credentials.Credentials:
        """Obtain ADC, preferring the read-only storage scope.

        Returns:
            Refreshed credentials.

        Raises:
            GcsFetchError: If no usable credentials can be minted under any candidate scope.
        """
        request = google.auth.transport.requests.Request()
        errors: list[str] = []
        for scopes in _SCOPES:
            try:
                creds, _ = google.auth.default(scopes=list(scopes))
                creds.refresh(request)
                logger.debug("GCS credentials minted with scope %s", scopes[0])
                return creds
            except Exception as exc:  # noqa: BLE001 — try the next scope, report all on failure
                errors.append(f"{scopes[0]}: {type(exc).__name__}: {exc}")
        raise GcsFetchError(
            "could not obtain Google credentials for GCS. Set GOOGLE_APPLICATION_CREDENTIALS or "
            "run `gcloud auth application-default login`. Attempts:\n  " + "\n  ".join(errors)
        )

    def value(self, *, force_refresh: bool = False) -> str:
        """Return a valid bearer token, refreshing it if expired.

        Args:
            force_refresh: Refresh even if the cached token still looks valid (used after a 401).

        Returns:
            The access-token string.
        """
        with self._lock:
            if self._creds is None:
                self._creds = self._load()
            elif force_refresh or not self._creds.valid:
                self._creds.refresh(google.auth.transport.requests.Request())
            token = self._creds.token
        if not token:
            raise GcsFetchError("Google credentials refreshed but yielded no access token")
        return str(token)


_TOKEN = _Token()
_THREAD_LOCAL = threading.local()


def _session() -> requests.Session:
    """Return this thread's HTTP session (``requests.Session`` is not shared across threads)."""
    session = getattr(_THREAD_LOCAL, "session", None)
    if session is None:
        session = requests.Session()
        _THREAD_LOCAL.session = session
    return session


def _get(url: str, params: dict[str, object] | None = None, *, stream: bool = False) -> requests.Response:
    """Issue an authorized GET, retrying transient failures and re-minting on a 401.

    Args:
        url: Absolute request URL.
        params: Query parameters.
        stream: Whether to stream the response body.

    Returns:
        A successful response.

    Raises:
        GcsFetchError: If the request still fails after :data:`_MAX_ATTEMPTS`.
    """
    last: str = ""
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            response = _session().get(
                url,
                params=params,
                stream=stream,
                timeout=_TIMEOUT_S,
                headers={"Authorization": f"Bearer {_TOKEN.value(force_refresh=attempt > 1)}"},
            )
        except requests.RequestException as exc:
            last = f"{type(exc).__name__}: {exc}"
        else:
            if response.status_code == 200:
                return response
            last = f"HTTP {response.status_code}: {response.text[:200]}"
            if response.status_code in (401, 403, 404) and attempt == _MAX_ATTEMPTS:
                break
        if attempt < _MAX_ATTEMPTS:
            time.sleep(0.5 * attempt)
    raise GcsFetchError(f"GET {url} failed after {_MAX_ATTEMPTS} attempts — {last}")


def list_remote_versions() -> list[str]:
    """List the catalog versions present in the GCS bucket.

    A mismatch against :func:`verification_harness.db.list_versions` is itself finding ``X5``
    (``DOUBLE_CHECK.md`` §3): a catalog in the bucket with no database rows, or vice versa.

    Returns:
        Sorted catalog keys, e.g. ``["2022-2023-graduate", ...]``.
    """
    body = _get(
        f"{_API_ROOT}/{config.GCS_BUCKET}/o",
        {"prefix": f"{config.GCS_PAGES_PREFIX}/", "delimiter": "/", "maxResults": 1000},
    ).json()
    prefixes: list[str] = body.get("prefixes", [])
    return sorted(p.rstrip("/").rsplit("/", 1)[-1] for p in prefixes)


def list_page_objects(version: str) -> list[tuple[str, int]]:
    """List every ``page_NNNN.md`` object for one catalog version.

    Args:
        version: Full catalog key.

    Returns:
        ``(object_name, size_bytes)`` pairs, sorted by name.

    Raises:
        GcsFetchError: If the version has no page objects (guards a silently empty sync).
    """
    prefix = f"{config.GCS_PAGES_PREFIX}/{version}/pages/"
    items: list[tuple[str, int]] = []
    token: str | None = None
    while True:
        params: dict[str, object] = {
            "prefix": prefix,
            "maxResults": 1000,
            "fields": "items(name,size),nextPageToken",
        }
        if token:
            params["pageToken"] = token
        body = _get(f"{_API_ROOT}/{config.GCS_BUCKET}/o", params).json()
        for item in body.get("items", []):
            name = item["name"]
            if name.endswith(".md"):
                items.append((name, int(item.get("size", 0))))
        token = body.get("nextPageToken")
        if not token:
            break
    if not items:
        raise GcsFetchError(
            f"no page objects under gs://{config.GCS_BUCKET}/{prefix} — wrong version key or "
            f"insufficient read access"
        )
    return sorted(items)


def _download(name: str, size: int, dest: Path) -> int:
    """Download one object to ``dest`` unless an identically-sized local copy already exists.

    Args:
        name: Full GCS object name.
        size: Expected size in bytes (from the listing).
        dest: Local destination path.

    Returns:
        Bytes written (0 when the local copy was reused).

    Raises:
        GcsFetchError: If the downloaded body does not match the listed size.
    """
    if dest.exists() and dest.stat().st_size == size:
        return 0
    url = f"{_API_ROOT}/{config.GCS_BUCKET}/o/{quote(name, safe='')}"
    body = _get(url, {"alt": "media"}).content
    if size and len(body) != size:
        raise GcsFetchError(f"{name}: expected {size} bytes, got {len(body)}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(body)
    os.replace(tmp, dest)  # atomic: a killed sync never leaves a half-written page
    return len(body)


def sync_version(
    version: str,
    pages_dir: Path | None = None,
    *,
    workers: int = _DEFAULT_WORKERS,
) -> SyncResult:
    """Materialize one catalog version's pages into the local cache.

    Args:
        version: Full catalog key, e.g. ``"2025-2026-undergraduate"``.
        pages_dir: Page-cache root; defaults to :data:`config.PAGE_CACHE_DIR`.
        workers: Concurrent downloads.

    Returns:
        A :class:`SyncResult` describing what was transferred.

    Raises:
        GcsFetchError: On auth failure, an empty listing, or any page that will not download.
    """
    root = (pages_dir or config.PAGE_CACHE_DIR) / version / "pages"
    root.mkdir(parents=True, exist_ok=True)
    started = time.time()
    objects = list_page_objects(version)

    downloaded = skipped = transferred = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(_download, name, size, root / name.rsplit("/", 1)[-1]): name
            for name, size in objects
        }
        for future in as_completed(futures):
            written = future.result()  # re-raises GcsFetchError; a partial cache is never accepted
            if written:
                downloaded += 1
                transferred += written
            else:
                skipped += 1

    result = SyncResult(
        version=version,
        remote=len(objects),
        downloaded=downloaded,
        skipped=skipped,
        bytes_downloaded=transferred,
        seconds=time.time() - started,
    )
    logger.info(
        "sync %s: %d pages (%d downloaded, %d cached) in %.1fs",
        version,
        result.local,
        downloaded,
        skipped,
        result.seconds,
    )
    return result


def sync_versions(
    versions: list[str],
    pages_dir: Path | None = None,
    *,
    workers: int = _DEFAULT_WORKERS,
) -> list[SyncResult]:
    """Sync several catalog versions.

    Args:
        versions: Catalog keys to sync.
        pages_dir: Page-cache root; defaults to :data:`config.PAGE_CACHE_DIR`.
        workers: Concurrent downloads per version.

    Returns:
        One :class:`SyncResult` per version, in input order.
    """
    return [sync_version(v, pages_dir, workers=workers) for v in versions]
