//! Fork 专用：按 Haiku 5.5 分档规则修正库中既有明细的成本，一次性执行。
//!
//! 挂在 `Database::init` 末尾，schema 迁移与定价种子同步之后、任何记账或会话导入之前执行。
//! 标记存在即整体跳过，回填与写标记在同一个事务里提交。

use super::{
    cost_string, historical_billable_input_tokens, row_to_request_log_detail, RequestLogDetail,
};
use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::proxy::usage::long_prompt_tier;
use crate::services::sql_helpers::fresh_input_sql;
use rusqlite::{params, Connection, OptionalExtension};
use rust_decimal::Decimal;
use std::collections::HashMap;
use std::str::FromStr;

/// 回填完成标记在 `settings` 表中的键。
const MARKER_KEY: &str = "fork_haiku55_long_prompt_backfill_v1";

impl Database {
    /// 标记缺失时回填一次，返回改写的行数；标记已存在时返回 0。
    pub(crate) fn backfill_haiku55_long_prompt_once(&self) -> Result<u64, AppError> {
        let conn = lock_conn!(self.conn);
        Self::backfill_haiku55_long_prompt_once_on_conn(&conn)
    }

    fn backfill_haiku55_long_prompt_once_on_conn(conn: &Connection) -> Result<u64, AppError> {
        let marked: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                [MARKER_KEY],
                |row| row.get(0),
            )
            .optional()?;
        if marked.is_some() {
            return Ok(0);
        }

        let tx = conn
            .unchecked_transaction()
            .map_err(|e| AppError::Database(format!("启动 Haiku 5.5 分档回填事务失败: {e}")))?;
        let updates = Self::collect_haiku55_long_prompt_updates(&tx)?;
        for (request_id, costs) in &updates {
            tx.execute(
                "UPDATE proxy_request_logs
                 SET input_cost_usd = ?1,
                     output_cost_usd = ?2,
                     cache_read_cost_usd = ?3,
                     cache_creation_cost_usd = ?4,
                     total_cost_usd = ?5
                 WHERE request_id = ?6",
                params![costs[0], costs[1], costs[2], costs[3], costs[4], request_id],
            )
            .map_err(|e| AppError::Database(format!("回填 Haiku 5.5 分档成本失败: {e}")))?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, '1')",
            [MARKER_KEY],
        )
        .map_err(|e| AppError::Database(format!("写入 Haiku 5.5 分档回填标记失败: {e}")))?;
        tx.commit()
            .map_err(|e| AppError::Database(format!("提交 Haiku 5.5 分档回填事务失败: {e}")))?;

        let updated = updates.len() as u64;
        if updated > 0 {
            log::info!("Haiku 5.5 分档历史回填：已改写 {updated} 条用量成本");
        }
        Ok(updated)
    }

    /// 扫描全部历史明细，返回需要改写的行及其改写后的五栏成本字串。
    /// 查价与分档判定都走与零成本回填相同的 `get_log_model_pricing_cached` 与 `price_multiplier`。
    fn collect_haiku55_long_prompt_updates(
        conn: &Connection,
    ) -> Result<Vec<(String, [String; 5])>, AppError> {
        let sql = format!(
            "SELECT request_id, provider_id, NULL AS provider_name, app_type, model, request_model,
                    cost_multiplier, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                    input_cost_usd, output_cost_usd, cache_read_cost_usd, cache_creation_cost_usd,
                    total_cost_usd, is_streaming, latency_ms, first_token_ms, duration_ms, status_code,
                    error_message, created_at, data_source, pricing_model, input_token_semantics,
                    {fresh_input} AS fresh_input_tokens
             FROM proxy_request_logs",
            fresh_input = fresh_input_sql("")
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], row_to_request_log_detail)?;
        let mut pricing_cache = HashMap::new();
        let mut updates = Vec::new();
        for row in rows {
            let row = row?;
            let Some(pricing) = Self::get_log_model_pricing_cached(conn, &mut pricing_cache, &row)?
            else {
                continue;
            };
            let tier = long_prompt_tier::price_multiplier(
                Some(pricing.row_model_id.as_str()),
                long_prompt_tier::prompt_tokens(
                    historical_billable_input_tokens(&row),
                    u64::from(row.cache_read_tokens),
                    u64::from(row.cache_creation_tokens),
                ),
            );
            if tier == Decimal::ONE {
                continue;
            }
            match scaled_cost_columns(&row, tier) {
                Ok(costs) => updates.push((row.request_id, costs)),
                Err(e) => log::warn!(
                    "Haiku 5.5 分档回填跳过无法解析的成本 request_id={}: {e}",
                    row.request_id
                ),
            }
        }
        Ok(updates)
    }
}

/// 五栏成本乘以分档倍数，按零成本回填的字串格式输出；任一栏无法解析时返回错误。
fn scaled_cost_columns(
    row: &RequestLogDetail,
    tier: Decimal,
) -> Result<[String; 5], rust_decimal::Error> {
    let scale = |raw: &str| Decimal::from_str(raw).map(|value| cost_string(value * tier));
    Ok([
        scale(&row.input_cost_usd)?,
        scale(&row.output_cost_usd)?,
        scale(&row.cache_read_cost_usd)?,
        scale(&row.cache_creation_cost_usd)?,
        scale(&row.total_cost_usd)?,
    ])
}

#[cfg(test)]
mod tests {
    use crate::database::{lock_conn, Database};
    use crate::error::AppError;
    use rusqlite::{params, Connection, OptionalExtension};
    use rust_decimal::Decimal;
    use std::str::FromStr;

    const MARKER_KEY: &str = "fork_haiku55_long_prompt_backfill_v1";

    /// 写入一笔历史明细。`tokens` 依次为 input、output、cache read、cache write；
    /// `costs` 依次为 input、output、cache read、cache write、total 五栏，按字串原样落库。
    #[allow(clippy::too_many_arguments)]
    fn insert_log(
        conn: &Connection,
        request_id: &str,
        app_type: &str,
        model: &str,
        pricing_model: Option<&str>,
        input_token_semantics: i64,
        tokens: [i64; 4],
        costs: [&str; 5],
    ) -> Result<(), AppError> {
        conn.execute(
            "INSERT INTO proxy_request_logs (
                request_id, provider_id, app_type, model, request_model, pricing_model,
                input_token_semantics, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, input_cost_usd, output_cost_usd, cache_read_cost_usd,
                cache_creation_cost_usd, total_cost_usd, latency_ms, status_code, created_at,
                data_source
            ) VALUES (?1, '_session', ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                      100, 200, 1000, 'session_log')",
            params![
                request_id,
                app_type,
                model,
                pricing_model,
                input_token_semantics,
                tokens[0],
                tokens[1],
                tokens[2],
                tokens[3],
                costs[0],
                costs[1],
                costs[2],
                costs[3],
                costs[4],
            ],
        )?;
        Ok(())
    }

    fn stored_costs(conn: &Connection, request_id: &str) -> [Decimal; 5] {
        let raw: [String; 5] = conn
            .query_row(
                "SELECT input_cost_usd, output_cost_usd, cache_read_cost_usd,
                        cache_creation_cost_usd, total_cost_usd
                 FROM proxy_request_logs WHERE request_id = ?1",
                [request_id],
                |row| {
                    Ok([
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ])
                },
            )
            .unwrap();
        raw.map(|value| Decimal::from_str(&value).unwrap())
    }

    fn decimals(values: [&str; 5]) -> [Decimal; 5] {
        values.map(|value| Decimal::from_str(value).unwrap())
    }

    fn marker_value(conn: &Connection) -> Option<String> {
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [MARKER_KEY],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
    }

    fn seed_haiku_55_row(conn: &Connection) {
        conn.execute(
            "INSERT OR REPLACE INTO model_pricing (
                model_id, display_name, input_cost_per_million, output_cost_per_million,
                cache_read_cost_per_million, cache_creation_cost_per_million
             ) VALUES ('claude-haiku-5-5', 'Claude Haiku 5.5', '0.10', '0.50', '0.01', '0.125')",
            [],
        )
        .unwrap();
    }

    #[test]
    fn long_haiku_rows_scale_five_times_and_other_rows_stay() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            seed_haiku_55_row(&conn);
            // 100_001 输入、1_000 输出：提示词超门槛
            insert_log(
                &conn,
                "haiku-long",
                "claude",
                "claude-haiku-5-5",
                None,
                2,
                [100_001, 1_000, 0, 0],
                ["0.0100001", "0.0005", "0", "0", "0.0105001"],
            )?;
            // 恰好 100_000：标准档
            insert_log(
                &conn,
                "haiku-standard",
                "claude",
                "claude-haiku-5-5",
                None,
                2,
                [100_000, 0, 0, 0],
                ["0.01", "0", "0", "0", "0.01"],
            )?;
            // 超门槛但不是 Haiku 5.5
            insert_log(
                &conn,
                "opus-long",
                "claude",
                "claude-opus-5-5",
                None,
                2,
                [100_001, 0, 0, 0],
                ["0.400004", "0", "0", "0", "0.400004"],
            )?;
            // 缓存读与缓存写撑过门槛：1_000 + 99_500 + 1_000 = 101_500
            insert_log(
                &conn,
                "haiku-cache-long",
                "claude",
                "claude-haiku-5-5",
                None,
                2,
                [1_000, 0, 99_500, 1_000],
                ["0.0001", "0", "0.000995", "0.000125", "0.00122"],
            )?;
            // codex 的 input 含缓存：billable = 100_000 - 50_000 = 50_000，提示词长度 100_000，标准档
            insert_log(
                &conn,
                "codex-haiku-standard",
                "codex",
                "claude-haiku-5-5",
                None,
                1,
                [100_000, 0, 50_000, 0],
                ["0.005", "0", "0.0005", "0", "0.0055"],
            )?;
        }

        assert_eq!(db.backfill_haiku55_long_prompt_once()?, 2);

        let conn = lock_conn!(db.conn);
        assert_eq!(
            stored_costs(&conn, "haiku-long"),
            decimals(["0.0500005", "0.0025", "0", "0", "0.0525005"])
        );
        assert_eq!(
            stored_costs(&conn, "haiku-standard"),
            decimals(["0.01", "0", "0", "0", "0.01"])
        );
        assert_eq!(
            stored_costs(&conn, "opus-long"),
            decimals(["0.400004", "0", "0", "0", "0.400004"])
        );
        assert_eq!(
            stored_costs(&conn, "haiku-cache-long"),
            decimals(["0.0005", "0", "0.004975", "0.000625", "0.0061"])
        );
        assert_eq!(
            stored_costs(&conn, "codex-haiku-standard"),
            decimals(["0.005", "0", "0.0005", "0", "0.0055"])
        );
        // 其他栏位不动
        let input_tokens: i64 = conn.query_row(
            "SELECT input_tokens FROM proxy_request_logs WHERE request_id = 'haiku-long'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(input_tokens, 100_001);
        Ok(())
    }

    #[test]
    fn second_run_does_not_multiply_again() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            seed_haiku_55_row(&conn);
            insert_log(
                &conn,
                "haiku-long",
                "claude",
                "claude-haiku-5-5",
                None,
                2,
                [100_001, 1_000, 0, 0],
                ["0.0100001", "0.0005", "0", "0", "0.0105001"],
            )?;
        }

        assert_eq!(db.backfill_haiku55_long_prompt_once()?, 1);
        assert_eq!(db.backfill_haiku55_long_prompt_once()?, 0);

        let conn = lock_conn!(db.conn);
        assert_eq!(
            stored_costs(&conn, "haiku-long"),
            decimals(["0.0500005", "0.0025", "0", "0", "0.0525005"])
        );
        Ok(())
    }

    #[test]
    fn existing_marker_leaves_every_row_untouched() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            seed_haiku_55_row(&conn);
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, '1')",
                [MARKER_KEY],
            )?;
            insert_log(
                &conn,
                "haiku-long",
                "claude",
                "claude-haiku-5-5",
                None,
                2,
                [100_001, 1_000, 0, 0],
                ["0.0100001", "0.0005", "0", "0", "0.0105001"],
            )?;
        }

        assert_eq!(db.backfill_haiku55_long_prompt_once()?, 0);

        let conn = lock_conn!(db.conn);
        assert_eq!(
            stored_costs(&conn, "haiku-long"),
            decimals(["0.0100001", "0.0005", "0", "0", "0.0105001"])
        );
        Ok(())
    }

    #[test]
    fn empty_database_still_writes_the_marker() -> Result<(), AppError> {
        let db = Database::memory()?;

        assert_eq!(db.backfill_haiku55_long_prompt_once()?, 0);

        let conn = lock_conn!(db.conn);
        assert!(marker_value(&conn).is_some());
        Ok(())
    }

    #[test]
    fn pricing_model_column_decides_over_model_column() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            seed_haiku_55_row(&conn);
            // model 是 opus，但计价基准 pricing_model 是 haiku 5.5：按 pricing_model 分档
            insert_log(
                &conn,
                "opus-model-haiku-pricing",
                "claude",
                "claude-opus-5-5",
                Some("claude-haiku-5-5"),
                2,
                [100_001, 0, 0, 0],
                ["0.0100001", "0", "0", "0", "0.0100001"],
            )?;
            // model 是 haiku 5.5，但计价基准 pricing_model 是 opus：不分档
            insert_log(
                &conn,
                "haiku-model-opus-pricing",
                "claude",
                "claude-haiku-5-5",
                Some("claude-opus-5-5"),
                2,
                [100_001, 0, 0, 0],
                ["0.400004", "0", "0", "0", "0.400004"],
            )?;
        }

        assert_eq!(db.backfill_haiku55_long_prompt_once()?, 1);

        let conn = lock_conn!(db.conn);
        assert_eq!(
            stored_costs(&conn, "opus-model-haiku-pricing"),
            decimals(["0.0500005", "0", "0", "0", "0.0500005"])
        );
        assert_eq!(
            stored_costs(&conn, "haiku-model-opus-pricing"),
            decimals(["0.400004", "0", "0", "0", "0.400004"])
        );
        Ok(())
    }

    #[test]
    fn placeholder_pricing_model_falls_back_to_model() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            seed_haiku_55_row(&conn);
            insert_log(
                &conn,
                "placeholder-pricing-model",
                "claude",
                "claude-haiku-5-5",
                Some(""),
                2,
                [100_001, 0, 0, 0],
                ["0.0100001", "0", "0", "0", "0.0100001"],
            )?;
        }

        assert_eq!(db.backfill_haiku55_long_prompt_once()?, 1);

        let conn = lock_conn!(db.conn);
        assert_eq!(
            stored_costs(&conn, "placeholder-pricing-model"),
            decimals(["0.0500005", "0", "0", "0", "0.0500005"])
        );
        Ok(())
    }

    #[test]
    fn unparsable_cost_skips_only_that_row() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            seed_haiku_55_row(&conn);
            insert_log(
                &conn,
                "unparsable",
                "claude",
                "claude-haiku-5-5",
                None,
                2,
                [100_001, 0, 0, 0],
                ["n/a", "0", "0", "0", "0.0100001"],
            )?;
            insert_log(
                &conn,
                "parsable",
                "claude",
                "claude-haiku-5-5",
                None,
                2,
                [100_001, 0, 0, 0],
                ["0.0100001", "0", "0", "0", "0.0100001"],
            )?;
        }

        assert_eq!(db.backfill_haiku55_long_prompt_once()?, 1);

        let conn = lock_conn!(db.conn);
        let unparsable_input: String = conn.query_row(
            "SELECT input_cost_usd FROM proxy_request_logs WHERE request_id = 'unparsable'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(unparsable_input, "n/a");
        assert_eq!(
            stored_costs(&conn, "parsable"),
            decimals(["0.0500005", "0", "0", "0", "0.0500005"])
        );
        assert!(marker_value(&conn).is_some());
        Ok(())
    }

    #[test]
    fn usage_daily_rollups_are_not_touched() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            seed_haiku_55_row(&conn);
            insert_log(
                &conn,
                "haiku-long",
                "claude",
                "claude-haiku-5-5",
                None,
                2,
                [100_001, 1_000, 0, 0],
                ["0.0100001", "0.0005", "0", "0", "0.0105001"],
            )?;
            conn.execute(
                "INSERT INTO usage_daily_rollups (date, app_type, provider_id, model, total_cost_usd)
                 VALUES ('2026-10-07', 'claude', 'p', 'claude-haiku-5-5', '0.0105001')",
                [],
            )?;
        }

        assert_eq!(db.backfill_haiku55_long_prompt_once()?, 1);

        let conn = lock_conn!(db.conn);
        let rollup_total: String = conn.query_row(
            "SELECT total_cost_usd FROM usage_daily_rollups WHERE date = '2026-10-07'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(rollup_total, "0.0105001");
        Ok(())
    }

    #[test]
    fn legacy_semantics_row_uses_row_semantics_for_the_tier() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            seed_haiku_55_row(&conn);
            // 旧语义（v12 及更早）：input 含缓存读、不含缓存写。
            // 按行语义 billable = 100_000 - 50_000 = 50_000，提示词长度 = 50_000 + 50_000 + 10_000 = 110_000，分档。
            // 若按计价器语义扣两桶，提示词长度只有 100_000，不分档。
            insert_log(
                &conn,
                "codex-legacy",
                "codex",
                "claude-haiku-5-5",
                None,
                0,
                [100_000, 0, 50_000, 10_000],
                ["0.005", "0", "0.0005", "0.00125", "0.00675"],
            )?;
        }

        assert_eq!(db.backfill_haiku55_long_prompt_once()?, 1);

        let conn = lock_conn!(db.conn);
        assert_eq!(
            stored_costs(&conn, "codex-legacy"),
            decimals(["0.025", "0", "0.0025", "0.00625", "0.03375"])
        );
        Ok(())
    }
}
