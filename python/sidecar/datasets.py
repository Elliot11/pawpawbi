"""Loading data to disk with dlt and reading it back with pandas.

Each project has a data folder. dlt writes loaded data into its "raw" dataset as Parquet,
one sub-folder per table:

    <data_dir>/raw/<table>/<load_id>.<file_id>.parquet
"""

import hashlib
import json
from pathlib import Path

import dlt
import pandas as pd

RAW_DATASET = "raw"

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


def read_table(data_dir: Path, table: str) -> pd.DataFrame:
    """Read a loaded table into a DataFrame."""
    if table not in _table_names(data_dir):
        raise ValueError(f"No table named {table!r}")
    return pd.read_parquet(data_dir / RAW_DATASET / table)


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
