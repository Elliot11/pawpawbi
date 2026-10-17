"""Reading loaded tables: their names, columns and rows. Queries run through engine.py (DuckDB).

A table with a SQL transform is read from its transformed copy (see transforms.py).
"""

from pathlib import Path

import engine

# Re-exported for older imports.
RAW_DATASET = engine.RAW_DATASET
MODEL_DATASET = engine.MODEL_DATASET


def list_tables(params):
    return engine.table_names(Path(params["data_dir"]))


def describe_tables(params):
    """Every loaded table's columns (dlt's _dlt_* columns left out) and row count."""
    data_dir = Path(params["data_dir"])
    folders = engine.table_folders(data_dir)
    if not folders:
        return []
    con = engine.connect(data_dir)
    try:
        tables = []
        for name in folders:
            relation = con.sql(f"SELECT * FROM {engine.quote(name)}")
            columns = [
                {"name": column, "type": str(type_), "kind": engine.column_kind(str(type_))}
                for column, type_ in zip(relation.columns, relation.types)
            ]
            # count(*) over Parquet comes from file metadata, so it's quick.
            rows = con.sql(f"SELECT count(*) FROM {engine.quote(name)}").fetchone()[0]
            tables.append(
                {"name": name, "rows": rows, "columns": columns, "transformed": engine.is_transformed(data_dir, name)}
            )
        return tables
    finally:
        con.close()


def preview_table(params):
    """A table's columns, first rows and total row count, reading only the rows shown."""
    data_dir = Path(params["data_dir"])
    table = params["table"]
    if table not in engine.table_folders(data_dir):
        raise ValueError(f"No table named {table!r}")
    con = engine.connect(data_dir)
    try:
        return engine.preview(con, f"SELECT * FROM {engine.quote(table)}", int(params.get("limit", 50)))
    finally:
        con.close()
