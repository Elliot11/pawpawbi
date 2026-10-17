"""Shared fixtures for the sidecar tests. Run with `npm run test:python`."""

import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

ROOT = Path(__file__).resolve().parents[2]
SIDECAR = ROOT / "python" / "sidecar"
RUNTIME = ROOT / "python" / "runtime"
# The bundled runtime, as the app runs it (not the test venv's interpreter).
RUNTIME_PYTHON = RUNTIME / "python.exe" if sys.platform == "win32" else RUNTIME / "bin" / "python3"
# Same flags as PYTHON_FLAGS in src/data.ts.
PYTHON_FLAGS = ["-E", "-s", "-B", "-u", "-X", "utf8"]

sys.path.insert(0, str(SIDECAR))
os.environ.setdefault("RUNTIME__DLTHUB_TELEMETRY", "false")

SALES = {
    "order_id": [1001, 1002, 1003, 1004],
    "order_date": ["2026-07-03", "2026-07-11", "2026-08-02", "2026-08-19"],
    "region": ["North", "South", "North", "West"],
    "revenue": [1250.5, 890.0, 2100.75, None],
}


def pytest_collection_modifyitems(config, items):
    if os.environ.get("PAWPAW_NETWORK_TESTS") == "1":
        return
    skip = pytest.mark.skip(reason="network test; set PAWPAW_NETWORK_TESTS=1 to run")
    for item in items:
        if "network" in item.keywords:
            item.add_marker(skip)


# Sample source files ----------------------------------------------------------------------------


@pytest.fixture
def sales_df():
    import pandas as pd

    return pd.DataFrame(SALES)


@pytest.fixture
def sales_csv(tmp_path, sales_df) -> Path:
    path = tmp_path / "Monthly Sales.csv"
    sales_df.to_csv(path, index=False)
    return path


@pytest.fixture
def budget_xlsx(tmp_path) -> Path:
    """An Excel workbook with two sheets, Targets and Staff."""
    import pandas as pd

    path = tmp_path / "Budget.xlsx"
    with pd.ExcelWriter(path, engine="openpyxl") as writer:
        pd.DataFrame({"region": ["North", "South"], "budget": [5000, 4000]}).to_excel(
            writer, sheet_name="Targets", index=False
        )
        pd.DataFrame({"month": ["Jul", "Aug", "Sep"], "headcount": [12, 14, 15]}).to_excel(
            writer, sheet_name="Staff", index=False
        )
    return path


@pytest.fixture
def csv_folder(tmp_path, sales_df) -> Path:
    """A folder of monthly CSV exports with the same columns."""
    folder = tmp_path / "monthly"
    folder.mkdir()
    for month in ("2026-07", "2026-08"):
        sales_df[sales_df.order_date.str.startswith(month)].to_csv(folder / f"sales_{month}.csv", index=False)
    return folder


@pytest.fixture
def sqlite_db(tmp_path) -> Path:
    path = tmp_path / "shop.db"
    db = sqlite3.connect(path)
    db.executescript(
        """
        CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, city TEXT);
        INSERT INTO customers VALUES (1, 'Acme Pty Ltd', 'Brisbane'), (2, 'Bluegum Co', 'Hobart'),
                                     (3, 'Wattle & Sons', 'Perth');
        CREATE TABLE products (sku TEXT PRIMARY KEY, price REAL);
        INSERT INTO products VALUES ('A1', 9.5), ('B2', 12.0);
        """
    )
    db.commit()
    db.close()
    return path


PEOPLE = [{"id": 1, "name": "Ada"}, {"id": 2, "name": "Grace"}, {"id": 3, "name": "Linus"}]


@pytest.fixture
def json_array(tmp_path) -> Path:
    path = tmp_path / "people.json"
    path.write_text(json.dumps(PEOPLE), encoding="utf-8")
    return path


@pytest.fixture
def json_wrapper(tmp_path) -> Path:
    """An API-style response: the records are the one list inside a wrapper object."""
    path = tmp_path / "wrapped.json"
    path.write_text(json.dumps({"data": PEOPLE, "page": 1, "total": 3}), encoding="utf-8")
    return path


@pytest.fixture
def json_lines(tmp_path) -> Path:
    path = tmp_path / "events.jsonl"
    path.write_text("".join(json.dumps(p) + "\n" for p in PEOPLE) + "\n", encoding="utf-8")
    return path


@pytest.fixture
def json_nested(tmp_path) -> Path:
    """Records with a nested object (flattened into columns) and a list (a child table)."""
    orders = [
        {"id": 1, "customer": {"name": "Ada", "city": "Hobart"}, "items": [{"sku": "A1"}, {"sku": "B2"}]},
        {"id": 2, "customer": {"name": "Grace", "city": "Perth"}, "items": [{"sku": "A1"}]},
    ]
    path = tmp_path / "orders.json"
    path.write_text(json.dumps(orders), encoding="utf-8")
    return path


# A project data folder, as dlt would have written it ----------------------------------------------


def _write_raw(data_dir: Path, table: str, columns: dict, files: int = 1):
    """Write a table into <data_dir>/raw/<table>/ like dlt does, with dlt's bookkeeping columns."""
    folder = data_dir / "raw" / table
    folder.mkdir(parents=True, exist_ok=True)
    rows = len(next(iter(columns.values())))
    full = pa.table(
        {**columns, "_dlt_load_id": ["1792192294.07"] * rows, "_dlt_id": [f"id{i}" for i in range(rows)]}
    )
    step = -(-rows // files)
    for i in range(files):
        pq.write_table(full.slice(i * step, step), folder / f"1792192294.07.{i}.parquet")


@pytest.fixture
def data_dir(tmp_path) -> Path:
    """A project data folder with three loaded tables and dlt's own bookkeeping table.
    monthly_sales is split over two Parquet files, as dlt does for larger tables."""
    data = tmp_path / "project" / "data"
    _write_raw(data, "monthly_sales", SALES, files=2)
    _write_raw(data, "budget_targets", {"region": ["North", "South"], "budget": [5000, 4000]})
    _write_raw(data, "budget_staff", {"month": ["Jul", "Aug", "Sep"], "headcount": [12, 14, 15]})
    loads = data / "raw" / "_dlt_loads"
    loads.mkdir()
    pq.write_table(pa.table({"load_id": ["1792192294.07"], "status": [0]}), loads / "loads.parquet")
    return data


# Running runner.py like the app does ----------------------------------------------------------------


@pytest.fixture
def run_job(tmp_path):
    """Runs one job through python/sidecar/runner.py in the bundled runtime, the same way
    src/data.ts does, and returns its parsed events. dlt's state lives in a folder per test."""
    env = {
        **os.environ,
        "RUNTIME__DLTHUB_TELEMETRY": "false",
        "DLT_DATA_DIR": str(tmp_path / "dlt-state"),
    }

    def run(job: dict | str, timeout: float = 300) -> list[dict]:
        line = job if isinstance(job, str) else json.dumps(job)
        result = subprocess.run(
            [str(RUNTIME_PYTHON), *PYTHON_FLAGS, str(SIDECAR / "runner.py")],
            input=(line + "\n").encode("utf-8"),
            capture_output=True,
            env=env,
            timeout=timeout,
        )
        events = [json.loads(line) for line in result.stdout.decode("utf-8").splitlines() if line.strip()]
        assert events, f"runner.py wrote no events. stderr:\n{result.stderr.decode('utf-8', 'replace')}"
        # Exit status matches the outcome.
        assert (result.returncode == 0) == (events[-1]["event"] == "result"), events[-1]
        return events

    return run


def result_of(events: list[dict]):
    """The result of a successful job, with a helpful failure message otherwise."""
    last = events[-1]
    assert last["event"] == "result", f"{last.get('message')}\n{last.get('detail', '')}"
    return last["result"]


def error_of(events: list[dict]) -> str:
    last = events[-1]
    assert last["event"] == "error", f"expected an error, got {last}"
    return last["message"]
