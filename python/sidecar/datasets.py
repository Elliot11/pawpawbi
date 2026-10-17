"""Loading data to disk with dlt and reading it back with pandas.

Each project has a data folder. dlt writes loaded data into its "raw" dataset as Parquet,
one sub-folder per table:

    <data_dir>/raw/<table>/<load_id>.<file_id>.parquet

A table with a SQL transform (see transforms.py) also has a transformed copy, which is used
in its place everywhere:

    <data_dir>/model/<table>/data.parquet
"""

import hashlib
import json
from pathlib import Path

import dlt
import pandas as pd

RAW_DATASET = "raw"
MODEL_DATASET = "model"

READERS = {
    ".csv": pd.read_csv,
    ".json": pd.read_json,
    ".parquet": pd.read_parquet,
}


def _pipeline(data_dir: Path) -> dlt.Pipeline:
    # dlt keeps per-pipeline state, so give each data folder its own pipeline.
    key = hashlib.sha1(str(data_dir.resolve()).encode()).hexdigest()[:12]
    return dlt.pipeline(
        pipeline_name=f"pawpaw_{key}",
        destination=dlt.destinations.filesystem(bucket_url=data_dir.resolve().as_uri()),
        dataset_name=RAW_DATASET,
    )


def _table_names(data_dir: Path) -> list[str]:
    raw = data_dir / RAW_DATASET
    if not raw.is_dir():
        return []
    return sorted(p.name for p in raw.iterdir() if p.is_dir() and not p.name.startswith("_dlt"))


def _table_dir(data_dir: Path, table: str) -> tuple[Path, bool]:
    """The folder holding a table's current data, and whether that's the transformed copy."""
    if table not in _table_names(data_dir):
        raise ValueError(f"No table named {table!r}")
    transformed = data_dir / MODEL_DATASET / table
    if transformed.is_dir():
        return transformed, True
    return data_dir / RAW_DATASET / table, False


def read_table(data_dir: Path, table: str) -> pd.DataFrame:
    """Read a loaded table (its transformed version, if it has one) into a DataFrame."""
    return pd.read_parquet(_table_dir(data_dir, table)[0])


def load_file(params):
    """Load a CSV, JSON or Parquet file as one table, replacing any previous load of it."""
    path = Path(params["path"])
    data_dir = Path(params["data_dir"])
    reader = READERS.get(path.suffix.lower())
    if reader is None:
        raise ValueError(f"Unsupported file type: {path.suffix or path.name}")

    df = reader(path)
    pipeline = _pipeline(data_dir)
    table = params.get("table") or path.stem
    pipeline.run(df, table_name=table, write_disposition="replace", loader_file_format="parquet")
    return {
        "table": pipeline.default_schema.naming.normalize_table_identifier(table),
        "rows": len(df),
    }


def list_tables(params):
    return _table_names(Path(params["data_dir"]))


def _column_kind(data_type) -> str:
    """A broad kind for a column's Arrow type, for display."""
    import pyarrow.types as pt

    if pt.is_boolean(data_type):
        return "boolean"
    if pt.is_integer(data_type):
        return "integer"
    if pt.is_floating(data_type) or pt.is_decimal(data_type):
        return "decimal"
    if pt.is_timestamp(data_type):
        return "datetime"
    if pt.is_date(data_type):
        return "date"
    if pt.is_time(data_type):
        return "time"
    if pt.is_string(data_type) or pt.is_large_string(data_type) or pt.is_string_view(data_type):
        return "text"
    if pt.is_nested(data_type):
        return "nested"
    return "other"


def describe_tables(params):
    """Every loaded table's columns and row count, read from Parquet metadata (not the data)."""
    import pyarrow.dataset as ds

    data_dir = Path(params["data_dir"])
    tables = []
    for name in _table_names(data_dir):
        folder, transformed = _table_dir(data_dir, name)
        dataset = ds.dataset(folder, format="parquet")
        columns = [
            {"name": field.name, "type": str(field.type), "kind": _column_kind(field.type)}
            for field in dataset.schema
            if not field.name.startswith("_dlt")  # dlt's own bookkeeping columns
        ]
        tables.append(
            {"name": name, "rows": dataset.count_rows(), "columns": columns, "transformed": transformed}
        )
    return tables


def preview_table(params):
    """Column types, the first rows and the total row count of a loaded table."""
    df = read_table(Path(params["data_dir"]), params["table"])
    head = df.head(int(params.get("limit", 50)))
    return {
        "columns": [{"name": str(name), "dtype": str(dtype)} for name, dtype in df.dtypes.items()],
        # Round-trip through pandas' JSON writer so dates, NaN, etc. become JSON-safe values.
        "rows": json.loads(head.to_json(orient="values", date_format="iso")),
        "row_count": len(df),
    }
