"""Helpers of the file connectors (python/sidecar/connectors/files.py)."""

import io
import json

import pytest

from connectors.files import _detect_format, _json_records, _read_json


@pytest.mark.parametrize(
    ("url", "content_type", "content", "expected"),
    [
        # The URL's extension wins.
        ("https://x.test/data.csv", "application/json", b"[1]", "csv"),
        ("https://x.test/data.TSV", "", b"", "csv"),
        ("https://x.test/data.txt", "", b"", "csv"),
        ("https://x.test/data.json?token=abc", "text/csv", b"", "json"),
        ("https://x.test/data.jsonl", "", b"", "jsonl"),
        ("https://x.test/data.ndjson", "", b"", "jsonl"),
        ("https://x.test/data.parquet", "", b"", "parquet"),
        ("https://x.test/data.xlsx", "", b"", "xlsx"),
        ("https://x.test/data.xlsm", "", b"", "xlsx"),
        # Then the Content-Type.
        ("https://x.test/api/items", "application/json; charset=utf-8", b"", "json"),
        ("https://x.test/api/items", "application/x-ndjson", b"", "jsonl"),
        ("https://x.test/api/items", "application/jsonl", b"", "jsonl"),
        ("https://x.test/export", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", b"", "xlsx"),
        ("https://x.test/export", "application/vnd.ms-excel", b"", "xlsx"),
        ("https://x.test/export", "application/vnd.apache.parquet", b"", "parquet"),
        # Then the content itself.
        ("https://x.test/download", "application/octet-stream", b"PAR1\x00\x01", "parquet"),
        ("https://x.test/download", "application/octet-stream", b"PK\x03\x04", "xlsx"),
        ("https://x.test/download", "text/plain", b'[{"a": 1}]', "json"),
        ("https://x.test/download", "text/plain", b'{"data": []}', "json"),
        ("https://x.test/download", "text/plain", b'\xef\xbb\xbf \r\n\t[{"a": 1}]', "json"),
        # Otherwise CSV.
        ("https://x.test/download", "text/plain", b"a,b\n1,2\n", "csv"),
        ("https://x.test/download", "", b"", "csv"),
        ("https://x.test/file.unknown", "", b"a;b\n", "csv"),
    ],
)
def test_detect_format(url, content_type, content, expected):
    assert _detect_format(url, content_type, content) == expected


def test_json_records_from_list():
    assert _json_records([{"a": 1}, {"a": 2}]) == [{"a": 1}, {"a": 2}]


def test_json_records_from_wrapper_object():
    assert _json_records({"data": [{"a": 1}], "page": 1, "next": None}) == [{"a": 1}]


def test_json_records_from_single_object():
    assert _json_records({"a": 1, "b": {"c": 2}}) == [{"a": 1, "b": {"c": 2}}]


def test_json_records_object_with_several_lists_is_one_record():
    data = {"users": [{"a": 1}], "groups": [{"b": 2}]}
    assert _json_records(data) == [data]


def test_json_records_from_scalar():
    assert _json_records(42) == [{"value": 42}]


def _all(chunks) -> list:
    return [record for chunk in chunks for record in chunk]


def test_read_json_array_from_path(json_array):
    assert _all(_read_json(json_array)) == json.loads(json_array.read_text(encoding="utf-8"))


def test_read_json_wrapper_from_path(json_wrapper):
    assert [r["name"] for r in _all(_read_json(json_wrapper))] == ["Ada", "Grace", "Linus"]


def test_read_json_lines(json_lines):
    assert [r["id"] for r in _all(_read_json(json_lines))] == [1, 2, 3]


def test_read_json_from_bytes_with_bom():
    content = io.BytesIO('﻿[{"name": "Zoë"}]'.encode("utf-8"))
    assert _all(_read_json(content)) == [{"name": "Zoë"}]


def test_read_json_lines_from_bytes():
    content = io.BytesIO(b'{"a": 1}\r\n\r\n{"a": 2}\r\n')
    assert _all(_read_json(content)) == [{"a": 1}, {"a": 2}]


def test_read_json_chunks_large_files(monkeypatch):
    import connectors.files as files

    monkeypatch.setattr(files, "CSV_CHUNK_ROWS", 2)
    content = io.BytesIO(json.dumps([{"i": i} for i in range(5)]).encode())
    assert [len(chunk) for chunk in _read_json(content)] == [2, 2, 1]


def test_read_json_rejects_invalid_json():
    with pytest.raises(json.JSONDecodeError):
        _all(_read_json(io.BytesIO(b"{not json")))
