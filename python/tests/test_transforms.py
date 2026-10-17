"""SQL transforms (python/sidecar/transforms.py): running, saving and removing them, and the
lockdown that stops a transform from reaching anything outside the project's data folder."""

import sys
from pathlib import Path

import pytest

import datasets
import transforms


def preview(data_dir: Path, sql: str, **extra):
    return transforms.preview_transform({"data_dir": str(data_dir), "sql": sql, **extra})


def describe(data_dir: Path) -> dict:
    return {t["name"]: t for t in datasets.describe_tables({"data_dir": str(data_dir)})}


CLEAN_SALES = (
    "SELECT order_id, CAST(order_date AS DATE) AS order_date, upper(region) AS region, "
    "coalesce(revenue, 0) AS revenue, revenue > 1000 AS big FROM monthly_sales"
)


# Running and saving transforms ------------------------------------------------------------------


def test_preview_aggregates_a_table(data_dir):
    result = preview(
        data_dir, "SELECT region, sum(revenue) AS revenue FROM monthly_sales GROUP BY region ORDER BY region;"
    )
    assert [c["name"] for c in result["columns"]] == ["region", "revenue"]
    assert result["rows"] == [["North", 3351.25], ["South", 890.0], ["West", None]]
    assert result["row_count"] == 3


def test_preview_reads_every_parquet_file_of_a_table(data_dir):
    assert len(list((data_dir / "raw" / "monthly_sales").glob("*.parquet"))) == 2
    assert preview(data_dir, "SELECT count(*) AS n FROM monthly_sales")["rows"] == [[4]]


def test_preview_hides_dlt_columns(data_dir):
    columns = [c["name"] for c in preview(data_dir, "SELECT * FROM monthly_sales")["columns"]]
    assert columns == ["order_id", "order_date", "region", "revenue"]


def test_preview_limit_caps_rows_but_not_row_count(data_dir):
    result = preview(data_dir, "SELECT * FROM monthly_sales", limit=2)
    assert len(result["rows"]) == 2
    assert result["row_count"] == 4


def test_preview_joins_tables(data_dir):
    result = preview(
        data_dir,
        """SELECT s.order_id, s.region, t.budget, s.revenue / t.budget AS pct
           FROM monthly_sales s LEFT JOIN budget_targets t USING (region) ORDER BY s.order_id""",
    )
    assert result["rows"] == [
        [1001, "North", 5000, 0.2501],
        [1002, "South", 4000, 0.2225],
        [1003, "North", 5000, 0.42015],
        [1004, "West", None, None],
    ]


def test_preview_makes_dates_json_safe(data_dir):
    result = preview(data_dir, "SELECT CAST(order_date AS DATE) AS d FROM monthly_sales ORDER BY d LIMIT 1")
    assert result["rows"][0][0].startswith("2026-07-03")


def test_apply_saves_transformed_copy_and_describe_shows_it(data_dir):
    assert transforms.apply_transform({"data_dir": str(data_dir), "table": "monthly_sales", "sql": CLEAN_SALES}) == {
        "rows": 4
    }
    assert (data_dir / "model" / "monthly_sales" / "data.parquet").is_file()
    assert not list((data_dir / "model").glob(".*.tmp")), "staging folder cleaned up"

    sales = describe(data_dir)["monthly_sales"]
    assert sales["transformed"] is True
    assert sales["rows"] == 4
    assert [(c["name"], c["kind"]) for c in sales["columns"]] == [
        ("order_id", "integer"),
        ("order_date", "date"),
        ("region", "text"),
        ("revenue", "decimal"),
        ("big", "boolean"),
    ]
    assert describe(data_dir)["budget_targets"]["transformed"] is False


def test_preview_table_uses_transformed_copy(data_dir):
    transforms.apply_transform({"data_dir": str(data_dir), "table": "monthly_sales", "sql": CLEAN_SALES})
    result = datasets.preview_table({"data_dir": str(data_dir), "table": "monthly_sales", "limit": 2})
    assert [c["name"] for c in result["columns"]] == ["order_id", "order_date", "region", "revenue", "big"]
    assert [row[2] for row in result["rows"]] == ["NORTH", "SOUTH"]
    assert result["row_count"] == 4


def test_transform_reads_original_data_after_apply(data_dir):
    transforms.apply_transform({"data_dir": str(data_dir), "table": "monthly_sales", "sql": CLEAN_SALES})
    assert preview(data_dir, "SELECT region FROM monthly_sales ORDER BY order_id LIMIT 1")["rows"] == [["North"]]


def test_apply_again_replaces_previous_result(data_dir):
    params = {"data_dir": str(data_dir), "table": "monthly_sales"}
    transforms.apply_transform({**params, "sql": CLEAN_SALES})
    assert transforms.apply_transform({**params, "sql": "SELECT region FROM monthly_sales LIMIT 1"}) == {"rows": 1}
    assert describe(data_dir)["monthly_sales"]["rows"] == 1


def test_failed_apply_keeps_previous_result(data_dir):
    params = {"data_dir": str(data_dir), "table": "monthly_sales"}
    transforms.apply_transform({**params, "sql": CLEAN_SALES})
    with pytest.raises(Exception):
        transforms.apply_transform({**params, "sql": "SELECT nope FROM monthly_sales"})
    assert describe(data_dir)["monthly_sales"]["rows"] == 4
    assert not list((data_dir / "model").glob(".*.tmp"))


def test_apply_to_unknown_table_is_rejected(data_dir):
    with pytest.raises(ValueError, match="No table named 'nope'"):
        transforms.apply_transform({"data_dir": str(data_dir), "table": "nope", "sql": "SELECT 1"})


def test_remove_transform_goes_back_to_original(data_dir):
    transforms.apply_transform({"data_dir": str(data_dir), "table": "monthly_sales", "sql": CLEAN_SALES})
    transforms.remove_transform({"data_dir": str(data_dir), "table": "monthly_sales"})
    sales = describe(data_dir)["monthly_sales"]
    assert sales["transformed"] is False
    assert [c["name"] for c in sales["columns"]] == ["order_id", "order_date", "region", "revenue"]
    # Removing a transform that doesn't exist is fine.
    transforms.remove_transform({"data_dir": str(data_dir), "table": "monthly_sales"})


def test_delete_table_removes_original_and_transformed_copy(data_dir):
    transforms.apply_transform(
        {"data_dir": str(data_dir), "table": "budget_staff", "sql": "SELECT * FROM budget_staff"}
    )
    transforms.delete_table({"data_dir": str(data_dir), "table": "budget_staff"})
    assert datasets.list_tables({"data_dir": str(data_dir)}) == ["budget_targets", "monthly_sales"]
    assert not (data_dir / "raw" / "budget_staff").exists()
    assert not (data_dir / "model" / "budget_staff").exists()
    with pytest.raises(ValueError, match="No table named"):
        transforms.delete_table({"data_dir": str(data_dir), "table": "budget_staff"})


def test_table_named_like_a_sql_keyword(data_dir):
    from conftest import _write_raw

    _write_raw(data_dir, "order", {"x": [1]})
    assert preview(data_dir, 'SELECT x FROM "order"')["rows"] == [[1]]


# Sandbox: a transform can only read the project's data folder -------------------------------------


SYSTEM_FILE = "C:/Windows/win.ini" if sys.platform == "win32" else "/etc/hosts"

# (test id, SQL, where {outside} is the secret file and {data} the data folder)
ESCAPES = [
    ("read_system_file", f"SELECT * FROM read_csv('{SYSTEM_FILE}')"),
    ("read_text_outside_data_dir", "SELECT * FROM read_text('{outside}')"),
    ("read_csv_outside_data_dir", "SELECT * FROM read_csv('{outside}')"),
    ("read_blob_outside_data_dir", "SELECT * FROM read_blob('{outside}')"),
    ("from_first_syntax_outside_data_dir", "FROM read_csv('{outside}')"),
    ("dotdot_out_of_data_dir", "SELECT * FROM read_text('{data}/../secret.txt')"),
    ("sibling_folder_with_same_prefix", "SELECT * FROM read_text('{data}2/secret.txt')"),
    ("file_url_outside_data_dir", "SELECT * FROM read_text('file:///{outside}')"),
    ("glob_lists_files_outside", "SELECT * FROM glob('{outside_dir}/*')"),
    ("hidden_in_union", "SELECT 'x' AS a UNION ALL SELECT content FROM read_text('{outside}')"),
    ("hidden_in_cte", "WITH s AS (SELECT * FROM read_text('{outside}')) SELECT * FROM s"),
    ("web_request", "SELECT * FROM read_csv('https://jsonplaceholder.typicode.com/comments')"),
    ("set_external_access", "SET enable_external_access = true"),
    ("reset_setting", "RESET enable_external_access"),
    ("pragma_setting", "PRAGMA enable_external_access=true"),
    ("query_function_runs_set", "SELECT * FROM query('SET enable_external_access = true')"),
    ("copy_to_file", "COPY (SELECT 1) TO '{outside_dir}/x.csv'"),
    ("export_database", "EXPORT DATABASE '{outside_dir}/export'"),
    ("attach_database", "ATTACH '{outside_dir}/x.db'"),
    ("create_table", "CREATE TABLE x AS SELECT 1"),
    ("drop_view", "DROP VIEW monthly_sales"),
    ("two_statements", "SELECT 1; SELECT 2"),
    ("install_extension", "INSTALL httpfs"),
    ("load_extension", "LOAD httpfs"),
    ("call_procedure", "CALL pragma_version()"),
    ("syntax_error", "SELEC * FROM monthly_sales"),
    ("unknown_table", "SELECT * FROM nope"),
    ("empty_query", "   "),
]


@pytest.mark.parametrize("sql", [sql for _, sql in ESCAPES], ids=[name for name, _ in ESCAPES])
def test_sandbox_blocks(data_dir, outside, sql):
    sql = sql.format(outside=outside.as_posix(), outside_dir=outside.parent.as_posix(), data=data_dir.as_posix())
    # A sibling folder whose name starts with the data folder's name.
    sibling = data_dir.parent / f"{data_dir.name}2"
    sibling.mkdir()
    (sibling / "secret.txt").write_text("secret\nhunter2\n", encoding="utf-8")

    with pytest.raises(Exception) as caught:
        preview(data_dir, sql)
    assert "hunter2" not in str(caught.value)

    # Nothing was written or changed.
    assert not (outside.parent / "x.csv").exists()
    assert not (outside.parent / "x.db").exists()
    assert not (outside.parent / "export").exists()
    assert preview(data_dir, "SELECT count(*) FROM monthly_sales")["rows"] == [[4]]


def test_sandbox_blocks_apply_too(data_dir, outside):
    with pytest.raises(Exception):
        transforms.apply_transform(
            {"data_dir": str(data_dir), "table": "monthly_sales", "sql": f"SELECT * FROM read_text('{outside.as_posix()}')"}
        )
    assert describe(data_dir)["monthly_sales"]["transformed"] is False


def test_sandbox_rejects_non_select_with_friendly_message(data_dir):
    with pytest.raises(ValueError, match="Only SELECT queries are allowed"):
        preview(data_dir, "DROP VIEW monthly_sales")
    with pytest.raises(ValueError, match="Enter just one query"):
        preview(data_dir, "SELECT 1; SELECT 2")
    with pytest.raises(ValueError, match="Enter one SELECT query"):
        preview(data_dir, "")


def test_sandbox_settings_are_locked(data_dir):
    rows = preview(
        data_dir,
        "SELECT name, value FROM duckdb_settings() WHERE name IN "
        "('enable_external_access', 'lock_configuration', 'autoinstall_known_extensions', "
        "'autoload_known_extensions') ORDER BY name",
    )["rows"]
    assert rows == [
        ["autoinstall_known_extensions", "false"],
        ["autoload_known_extensions", "false"],
        ["enable_external_access", "false"],
        ["lock_configuration", "true"],
    ]


def test_sandbox_still_allows_reading_inside_data_dir(data_dir):
    (data_dir / "notes.csv").write_text("a\n1\n", encoding="utf-8")
    assert preview(data_dir, f"SELECT * FROM read_csv('{data_dir.as_posix()}/notes.csv')")["rows"] == [[1]]


# Regression test: DuckDB adds its temp directory (<working dir>/.tmp/) to allowed_directories
# unless temp_directory is cleared, which let a transform read files there.
def test_sandbox_blocks_duckdb_temp_directory_in_working_dir(data_dir, tmp_path, monkeypatch):
    cwd = tmp_path / "cwd"
    (cwd / ".tmp").mkdir(parents=True)
    (cwd / ".tmp" / "secret.csv").write_text("secret\nhunter2\n", encoding="utf-8")
    monkeypatch.chdir(cwd)
    with pytest.raises(Exception):
        preview(data_dir, "SELECT * FROM read_csv('.tmp/secret.csv')")
