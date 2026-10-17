"""SQL transforms on loaded tables.

A table's transform is a single SELECT query. It can refer to any loaded table by name (so it
can join tables) and always sees their original, untransformed data. The result is written as
Parquet to <data_dir>/model/<table>/, which the app then uses in place of the original.

Queries run in the locked-down DuckDB from engine.py; see docs/security.md.
"""

import shutil
from pathlib import Path

import pyarrow.parquet as pq

import engine

BATCH_ROWS = 100_000


def preview_transform(params):
    """Run a transform's query and return its first rows, without saving anything."""
    con = engine.connect(Path(params["data_dir"]), layer="raw")
    try:
        query = engine.select(con, params["sql"])
        return engine.preview(con, query, int(params.get("limit", 200)))
    finally:
        con.close()


def apply_transform(params):
    """Run a transform's query and save the result as the table's transformed copy."""
    data_dir = Path(params["data_dir"])
    table = params["table"]
    if table not in engine.table_names(data_dir):
        raise ValueError(f"No table named {table!r}")

    model_dir = data_dir / engine.MODEL_DATASET
    model_dir.mkdir(parents=True, exist_ok=True)
    staging = model_dir / f".{table}.tmp"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir()

    con = engine.connect(data_dir, layer="raw")
    try:
        reader = con.sql(engine.select(con, params["sql"])).to_arrow_reader(BATCH_ROWS)
        rows = 0
        with pq.ParquetWriter(staging / "data.parquet", reader.schema) as writer:
            for batch in reader:
                writer.write_batch(batch)
                rows += batch.num_rows
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    finally:
        con.close()

    # Swap in the new result only once it's complete.
    target = model_dir / table
    shutil.rmtree(target, ignore_errors=True)
    staging.rename(target)
    return {"rows": rows}


def remove_transform(params):
    shutil.rmtree(Path(params["data_dir"]) / engine.MODEL_DATASET / params["table"], ignore_errors=True)


def delete_table(params):
    """Delete a table's data: the original and any transformed copy."""
    data_dir = Path(params["data_dir"])
    table = params["table"]
    if table not in engine.table_names(data_dir):
        raise ValueError(f"No table named {table!r}")
    for dataset in (engine.RAW_DATASET, engine.MODEL_DATASET):
        shutil.rmtree(data_dir / dataset / table, ignore_errors=True)
