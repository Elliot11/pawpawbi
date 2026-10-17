"""SQL transforms on loaded tables, using DuckDB as a query engine only: nothing is stored in it.

A table's transform is a single SELECT query. It can refer to any loaded table by name (so it
can join tables) and always sees their original, untransformed data. The result is written as
Parquet to <data_dir>/model/<table>/, which the app then uses in place of the original.

Queries run in an in-memory DuckDB that can only read the project's data folder: no other
files, no network, no extensions. Projects can come from other people, so a transform must
never be able to reach anything else on the computer.
"""

import json
import shutil
from pathlib import Path

import duckdb
import pyarrow.parquet as pq

from datasets import MODEL_DATASET, RAW_DATASET, _table_names

BATCH_ROWS = 100_000


def _identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _literal(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def _connect(data_dir: Path) -> duckdb.DuckDBPyConnection:
    """An in-memory DuckDB with one view per loaded table, locked to the data folder."""
    data_dir = data_dir.resolve()
    con = duckdb.connect(":memory:")
    for table in _table_names(data_dir):
        folder = data_dir / RAW_DATASET / table
        first_file = next(folder.glob("*.parquet"), None)
        if first_file is None:
            continue
        # Leave out dlt's own bookkeeping columns.
        columns = [f.name for f in pq.read_schema(first_file) if not f.name.startswith("_dlt")]
        pattern = (folder / "*.parquet").as_posix()
        con.execute(
            f"CREATE VIEW {_identifier(table)} AS "
            f"SELECT {', '.join(map(_identifier, columns))} "
            f"FROM read_parquet({_literal(pattern)}, union_by_name = true)"
        )
    # DuckDB quietly adds its temp directory (<working dir>/.tmp) to the allowed directories,
    # which would let a query read files there. Turning it off closes that; the cost is that
    # queries can't spill to disk, so a very large one fails rather than using a temp file.
    con.execute("SET temp_directory = ''")
    con.execute(f"SET allowed_directories = [{_literal(data_dir.as_posix())}]")
    con.execute("SET enable_external_access = false")
    con.execute("SET autoinstall_known_extensions = false")
    con.execute("SET autoload_known_extensions = false")
    con.execute("SET lock_configuration = true")
    return con


def _select(con: duckdb.DuckDBPyConnection, sql: str) -> str:
    """The query, checked to be exactly one read-only SELECT statement."""
    statements = con.extract_statements(sql)
    if len(statements) != 1:
        raise ValueError("Enter one SELECT query." if not statements else "Enter just one query.")
    if statements[0].type != duckdb.StatementType.SELECT:
        raise ValueError("Only SELECT queries are allowed: a transform reads data, it can't change it.")
    return statements[0].query.strip().rstrip(";")


def preview_transform(params):
    """Run a transform's query and return its first rows, without saving anything."""
    con = _connect(Path(params["data_dir"]))
    try:
        query = _select(con, params["sql"])
        relation = con.sql(query)
        head = relation.limit(int(params.get("limit", 200))).df()
        row_count = con.sql(f"SELECT count(*) FROM ({query})").fetchone()[0]
        return {
            "columns": [{"name": n, "dtype": str(t)} for n, t in zip(relation.columns, relation.types)],
            # Round-trip through pandas' JSON writer so dates, NaN, etc. become JSON-safe values.
            "rows": json.loads(head.to_json(orient="values", date_format="iso")),
            "row_count": row_count,
        }
    finally:
        con.close()


def apply_transform(params):
    """Run a transform's query and save the result as the table's transformed copy."""
    data_dir = Path(params["data_dir"])
    table = params["table"]
    if table not in _table_names(data_dir):
        raise ValueError(f"No table named {table!r}")

    model_dir = data_dir / MODEL_DATASET
    model_dir.mkdir(parents=True, exist_ok=True)
    staging = model_dir / f".{table}.tmp"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir()

    con = _connect(data_dir)
    try:
        reader = con.sql(_select(con, params["sql"])).to_arrow_reader(BATCH_ROWS)
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
    shutil.rmtree(Path(params["data_dir"]) / MODEL_DATASET / params["table"], ignore_errors=True)


def delete_table(params):
    """Delete a table's data: the original and any transformed copy."""
    data_dir = Path(params["data_dir"])
    table = params["table"]
    if table not in _table_names(data_dir):
        raise ValueError(f"No table named {table!r}")
    for dataset in (RAW_DATASET, MODEL_DATASET):
        shutil.rmtree(data_dir / dataset / table, ignore_errors=True)
