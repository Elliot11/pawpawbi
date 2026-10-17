"""Report datasets (python/sidecar/report_data.py): query results written as JSON for the
report. Dataset queries come from project files, so they get the same sandbox checks as
transforms."""

import json
from pathlib import Path

import pytest

import report_data
import transforms
from test_transforms import ESCAPES


def write(data_dir: Path, sql: str, **extra) -> dict:
    out = data_dir.parent / "report" / "data" / "sales.json"
    result = report_data.write_dataset(
        {"data_dir": str(data_dir), "name": "sales", "sql": sql, "path": str(out), **extra}
    )
    return {**result, "file": json.loads(out.read_text(encoding="utf-8")) if out.exists() else None}


def test_writes_columns_and_rows(data_dir):
    result = write(data_dir, "SELECT region, sum(revenue) AS revenue FROM monthly_sales GROUP BY 1 ORDER BY 1")
    doc = result["file"]
    assert doc["name"] == "sales"
    assert doc["columns"] == [{"name": "region", "type": "VARCHAR"}, {"name": "revenue", "type": "DOUBLE"}]
    assert doc["rows"] == [["North", 3351.25], ["South", 890.0], ["West", None]]
    assert doc["truncated"] is False
    assert doc["generatedAt"].endswith("Z")
    assert result["rows"] == 3


def test_dates_are_iso_text(data_dir):
    doc = write(data_dir, "SELECT DATE '2024-03-01' AS d, TIMESTAMP '2024-03-01 06:30:00' AS t")["file"]
    assert doc["rows"] == [["2024-03-01", "2024-03-01T06:30:00"]]


def test_reads_tables_as_shown(data_dir):
    transforms.apply_transform(
        {"data_dir": str(data_dir), "table": "budget_targets", "sql": "SELECT region FROM budget_targets"}
    )
    doc = write(data_dir, "SELECT * FROM budget_targets")["file"]
    assert [c["name"] for c in doc["columns"]] == ["region"]


def test_rows_are_capped(data_dir):
    result = write(data_dir, "SELECT * FROM range(10)", max_rows=4)
    assert len(result["file"]["rows"]) == 4
    assert result["truncated"] is True


def test_the_cap_cannot_be_raised(data_dir):
    result = write(data_dir, f"SELECT * FROM range({report_data.MAX_ROWS + 5})", max_rows=10**9)
    assert result["rows"] == report_data.MAX_ROWS


def test_oversized_results_are_refused_and_the_old_file_kept(data_dir, monkeypatch):
    write(data_dir, "SELECT 1 AS one")
    monkeypatch.setattr(report_data, "MAX_BYTES", 100)
    with pytest.raises(ValueError, match="over the"):
        write(data_dir, "SELECT repeat('x', 500) AS big")
    out = data_dir.parent / "report" / "data" / "sales.json"
    assert json.loads(out.read_text(encoding="utf-8"))["rows"] == [[1]]


def test_slow_queries_are_stopped(data_dir):
    with pytest.raises(TimeoutError, match="longer than 0.5 seconds"):
        write(data_dir, "SELECT count(*) FROM range(1000000000000) a", time_limit=0.5)


@pytest.mark.parametrize("sql", [sql for _, sql in ESCAPES], ids=[name for name, _ in ESCAPES])
def test_sandbox_blocks(data_dir, outside, sql):
    sql = sql.format(outside=outside.as_posix(), outside_dir=outside.parent.as_posix(), data=data_dir.as_posix())
    sibling = data_dir.parent / f"{data_dir.name}2"
    sibling.mkdir()
    (sibling / "secret.txt").write_text("secret\nhunter2\n", encoding="utf-8")

    with pytest.raises(Exception) as caught:
        write(data_dir, sql)
    assert "hunter2" not in str(caught.value)
    assert not (data_dir.parent / "report" / "data" / "sales.json").exists()
    assert not (outside.parent / "x.csv").exists()
    assert not (outside.parent / "x.db").exists()
    assert not (outside.parent / "export").exists()
