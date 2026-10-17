"""Connectors for files on this computer or on the web. Bundled with the app: no downloads needed."""

import io
from pathlib import Path

import dlt

from .base import FILES, Connector, Field, Option, lines, required, text

DATA_FILE_FILTERS = [
    ("Data files", ["csv", "tsv", "txt", "json", "jsonl", "ndjson", "parquet", "xlsx", "xlsm"]),
    ("All files", ["*"]),
]
FORMAT_OPTIONS = [
    Option("csv", "CSV"),
    Option("jsonl", "JSON Lines"),
    Option("parquet", "Parquet"),
]
CSV_CHUNK_ROWS = 50_000


def _read_csv(source, sep=None):
    import pandas as pd

    # sep=None lets pandas detect commas, semicolons, tabs, etc.
    yield from pd.read_csv(source, sep=sep, engine="python" if sep is None else "c", chunksize=CSV_CHUNK_ROWS)


def _read_json(source, json_lines: bool):
    import pandas as pd

    if json_lines:
        yield from pd.read_json(source, lines=True, chunksize=CSV_CHUNK_ROWS)
    else:
        yield pd.read_json(source)


def _read_parquet(path: Path):
    import pyarrow.parquet as pq

    yield from pq.ParquetFile(path).iter_batches(batch_size=CSV_CHUNK_ROWS)


def _frames(name: str, read):
    """A resource that yields DataFrames/Arrow batches from `read()` when loading, not before."""

    @dlt.resource(name=name)
    def frames():
        yield from read()

    return frames


def _file_resources(path: Path, used_names: set[str]) -> list:
    if not path.is_file():
        raise ValueError(f"File not found: {path}")
    ext = path.suffix.lower()

    def unique(name: str) -> str:
        candidate, n = name, 2
        while candidate in used_names:
            candidate, n = f"{name}_{n}", n + 1
        used_names.add(candidate)
        return candidate

    if ext in (".xlsx", ".xlsm"):
        import pandas as pd

        sheets = pd.ExcelFile(path, engine="openpyxl").sheet_names
        resources = []
        for sheet in sheets:
            name = unique(path.stem if len(sheets) == 1 else f"{path.stem} {sheet}")
            resources.append(
                _frames(name, lambda sheet=sheet: iter([pd.read_excel(path, sheet_name=sheet, engine="openpyxl")]))
            )
        return resources
    if ext in (".csv", ".tsv", ".txt"):
        return [_frames(unique(path.stem), lambda: _read_csv(path, "\t" if ext == ".tsv" else None))]
    if ext in (".jsonl", ".ndjson"):
        return [_frames(unique(path.stem), lambda: _read_json(path, json_lines=True))]
    if ext == ".json":
        return [_frames(unique(path.stem), lambda: _read_json(path, json_lines=False))]
    if ext == ".parquet":
        return [_frames(unique(path.stem), lambda: _read_parquet(path))]
    raise ValueError(f"Unsupported file type: {path.name}")


def _build_local_files(settings: dict):
    paths = lines(settings, "files")
    if not paths:
        raise ValueError("Choose at least one file.")
    used: set[str] = set()
    return [r for p in paths for r in _file_resources(Path(p), used)]


def _build_folder(settings: dict):
    from dlt.sources.filesystem import filesystem, read_csv, read_jsonl, read_parquet

    folder = Path(required(settings, "folder", "Folder"))
    if not folder.is_dir():
        raise ValueError(f"Folder not found: {folder}")
    fmt = text(settings, "format", "csv")
    reader = {"csv": read_csv, "jsonl": read_jsonl, "parquet": read_parquet}[fmt]
    files = filesystem(bucket_url=folder.resolve().as_uri(), file_glob=text(settings, "pattern", f"**/*.{fmt}"))
    return (files | reader()).with_name(text(settings, "table", folder.name))


def _build_url(settings: dict):
    from dlt.sources.helpers import requests

    url = required(settings, "url", "Web address")
    fmt = text(settings, "format") or _format_from_url(url)
    table = text(settings, "table") or Path(url.split("?")[0]).stem or "download"

    def read():
        response = requests.get(url, timeout=120)
        response.raise_for_status()
        content = io.BytesIO(response.content)
        if fmt == "csv":
            yield from _read_csv(content)
        elif fmt in ("jsonl", "json"):
            yield from _read_json(content, json_lines=fmt == "jsonl")
        elif fmt == "parquet":
            import pyarrow.parquet as pq

            yield pq.read_table(content)
        elif fmt == "xlsx":
            import pandas as pd

            yield pd.read_excel(content, engine="openpyxl")
        else:
            raise ValueError(f"Unsupported format: {fmt}")

    return _frames(table, read)


def _format_from_url(url: str) -> str:
    ext = Path(url.split("?")[0]).suffix.lower().lstrip(".")
    return {"ndjson": "jsonl", "xlsm": "xlsx", "tsv": "csv", "txt": "csv"}.get(ext, ext or "csv")


CONNECTORS: list[Connector] = [
    Connector(
        id="local_files",
        name="Files on this computer",
        category=FILES,
        description="CSV, Excel, JSON and Parquet files. Each file (or Excel sheet) becomes a table.",
        keywords=["csv", "excel", "xlsx", "spreadsheet", "json", "parquet", "upload"],
        fields=[
            Field("files", "Files", type="files", required=True, file_filters=DATA_FILE_FILTERS),
        ],
        build=_build_local_files,
    ),
    Connector(
        id="folder",
        name="Folder of files",
        category=FILES,
        description="Combine every matching file in a folder, such as monthly exports, into one table.",
        docs_url="https://dlthub.com/docs/dlt-ecosystem/verified-sources/filesystem",
        keywords=["directory", "csv", "exports", "combine"],
        fields=[
            Field("folder", "Folder", type="folder", required=True),
            Field("format", "File format", type="select", default="csv", options=FORMAT_OPTIONS),
            Field("table", "Table name", help="Defaults to the folder name."),
            Field(
                "pattern",
                "Files to include",
                placeholder="**/*.csv",
                advanced=True,
                help="A pattern such as sales_*.csv. ** includes subfolders. Defaults to every file of the chosen format.",
            ),
        ],
        build=_build_folder,
    ),
    Connector(
        id="url",
        name="File from a web address",
        category=FILES,
        description="Download a CSV, Excel, JSON or Parquet file from a URL.",
        keywords=["http", "https", "download", "link", "csv"],
        fields=[
            Field("url", "Web address", required=True, placeholder="https://example.com/data.csv"),
            Field("table", "Table name", help="Defaults to the file name in the address."),
            Field(
                "format",
                "File format",
                type="select",
                advanced=True,
                help="Detected from the address when left blank.",
                options=[Option("", "Detect automatically"), *FORMAT_OPTIONS, Option("json", "JSON"), Option("xlsx", "Excel")],
            ),
        ],
        build=_build_url,
    ),
]
