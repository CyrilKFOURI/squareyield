"""Download change detection: by ETag when the server sends one, by content hash otherwise."""
from pathlib import Path

import httpx

from rea_pipeline.ingest import download


def _client(body: bytes, etag: str | None) -> tuple[httpx.Client, list[str]]:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.method)
        headers = {"etag": etag} if etag else {}
        return httpx.Response(200, headers=headers, content=b"" if request.method == "HEAD" else body)

    return httpx.Client(transport=httpx.MockTransport(handler)), calls


def test_same_etag_skips_without_downloading(tmp_path: Path):
    dest = tmp_path / "file.csv"
    client, calls = _client(b"a,b\n1,2\n", etag='"v1"')
    assert download("https://x/file.csv", dest, client)["skipped"] is False
    calls.clear()
    assert download("https://x/file.csv", dest, client)["skipped"] is True
    assert calls == ["HEAD"]


def test_no_etag_same_content_is_unchanged(tmp_path: Path):
    dest = tmp_path / "file.csv"
    client, _ = _client(b"a,b\n1,2\n", etag=None)
    download("https://x/file.csv", dest, client)
    assert download("https://x/file.csv", dest, client)["skipped"] is True
    assert not dest.with_name("file.csv.part").exists()


def test_no_etag_new_content_is_a_change(tmp_path: Path):
    dest = tmp_path / "file.csv"
    download("https://x/file.csv", dest, _client(b"old\n", etag=None)[0])
    assert download("https://x/file.csv", dest, _client(b"new\n", etag=None)[0])["skipped"] is False
    assert dest.read_bytes() == b"new\n"
