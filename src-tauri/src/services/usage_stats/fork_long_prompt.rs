//! fork 专用：Claude Haiku 5.5 按提示词长度分档的查价挂接与历史回填。
//!
//! 分档规则与计算在 `proxy::usage::long_prompt_tier`。这里只回答两件事：
//! 一个查价名要不要附上分档规则（查价挂接），以及已落库的明细要不要补乘倍数（回填）。

use super::{find_model_pricing_row, is_placeholder_pricing_model, model_pricing_candidates};
use crate::database::{lock_conn, Database};
use crate::error::AppError;
use crate::proxy::usage::calculator::ModelPricing;
use crate::proxy::usage::long_prompt_tier::{prompt_tokens, HAIKU_5_5_MODEL_ID, HAIKU_5_5_TIER};
use crate::services::sql_helpers::{
    is_cache_inclusive_app, INPUT_TOKEN_SEMANTICS_FRESH, INPUT_TOKEN_SEMANTICS_TOTAL,
};
use rusqlite::{params, Connection};
use rust_decimal::Decimal;
use std::collections::HashMap;
use std::str::FromStr;

/// 回填完成的标记，存放在 `settings` 表。
const BACKFILL_MARKER_KEY: &str = "fork_haiku55_long_prompt_backfill_v1";

/// 查价挂接：`model_id` 的查价同时满足下面两条时，把 Haiku 5.5 的分档规则附在 `pricing` 上，否则原样返回。
///
/// 1. `model_id` 的查价候选里有 `claude-haiku-5-5`；
/// 2. `model_id` 查到的价格与 `claude-haiku-5-5` 查到的价格完全相同，两边都要查得到。
///
/// 判定时查询出错，记一条警告并原样返回 `pricing`（按标准档计价），不让查价整体失败。
pub(crate) fn attach_long_prompt_tier(
    conn: &Connection,
    model_id: &str,
    mut pricing: ModelPricing,
) -> ModelPricing {
    match long_prompt_tier_applies(conn, model_id) {
        Ok(true) => pricing.long_prompt_tier = Some(HAIKU_5_5_TIER),
        Ok(false) => {}
        Err(e) => log::warn!("Haiku 5.5 分档判定失败，{model_id} 按标准档计价: {e}"),
    }
    pricing
}

/// 启动时调用：执行一次性回填，结果只写日志，不影响启动。
pub(crate) fn backfill_haiku55_long_prompt_tier_at_startup(db: &Database) {
    if let Err(e) = backfill_haiku55_long_prompt_tier(db) {
        log::warn!("Haiku 5.5 分档历史回填失败，历史明细保持原值: {e}");
    }
}

/// 一次性回填：已落库的 Haiku 5.5 长提示词明细，五个成本栏乘以倍数。
///
/// 只改同时满足两点的明细：查价名通过 [`attach_long_prompt_tier`] 的判定，且提示词长度严格超过门槛。
/// 其余栏位不动，`usage_daily_rollups` 不动。`settings` 里已有标记时整体跳过。
/// 回填与写标记在同一个事务里提交。任何一步出错时整体回滚，但仍另外写下标记、不再重试：
/// 回填失败期间新落库的明细已按分档计价，重试会把它们再乘一次。
/// 返回本次改写的明细条数。
pub(crate) fn backfill_haiku55_long_prompt_tier(db: &Database) -> Result<u64, AppError> {
    let conn = lock_conn!(db.conn);
    if backfill_marker_exists(&conn)? {
        return Ok(0);
    }
    match backfill_and_mark(&conn) {
        Ok(updated) => {
            if updated > 0 {
                log::info!("已按 Haiku 5.5 长提示词分档回填 {updated} 条明细");
            }
            Ok(updated)
        }
        Err(e) => {
            write_backfill_marker(&conn)?;
            Err(e)
        }
    }
}

/// 在一个事务里回填并写标记；出错时事务随 `tx` 释放而回滚。
fn backfill_and_mark(conn: &Connection) -> Result<u64, AppError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| AppError::Database(format!("启动 Haiku 5.5 分档回填事务失败: {e}")))?;
    let updated = backfill_rows(&tx)?;
    write_backfill_marker(&tx)?;
    tx.commit()
        .map_err(|e| AppError::Database(format!("提交 Haiku 5.5 分档回填事务失败: {e}")))?;
    Ok(updated)
}

fn write_backfill_marker(conn: &Connection) -> Result<(), AppError> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, '1')",
        params![BACKFILL_MARKER_KEY],
    )
    .map(|_| ())
    .map_err(|e| AppError::Database(format!("写入 Haiku 5.5 分档回填标记失败: {e}")))
}

/// 判定 `model_id` 的查价是否适用 Haiku 5.5 的分档规则，判定条件见 [`attach_long_prompt_tier`]。
fn long_prompt_tier_applies(conn: &Connection, model_id: &str) -> Result<bool, AppError> {
    let names_haiku = model_pricing_candidates(model_id)
        .iter()
        .any(|candidate| candidate.model_id == HAIKU_5_5_MODEL_ID);
    if !names_haiku {
        return Ok(false);
    }
    let Some(row) = find_model_pricing_row(conn, model_id)? else {
        return Ok(false);
    };
    let Some(haiku_row) = find_model_pricing_row(conn, HAIKU_5_5_MODEL_ID)? else {
        return Ok(false);
    };
    Ok(row == haiku_row)
}

fn backfill_marker_exists(conn: &Connection) -> Result<bool, AppError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM settings WHERE key = ?1)",
        [BACKFILL_MARKER_KEY],
        |row| row.get::<_, bool>(0),
    )
    .map_err(|e| AppError::Database(format!("读取 Haiku 5.5 分档回填标记失败: {e}")))
}

/// 扫描候选明细并改写，返回改写条数。`conn` 由调用方的事务提供。
fn backfill_rows(conn: &Connection) -> Result<u64, AppError> {
    let threshold = HAIKU_5_5_TIER.threshold_tokens;
    // 提示词长度不超过 input + 缓存读 + 缓存写，先用这个上界缩小扫描范围；精确判定在逐行循环里做。
    let rows = {
        let mut stmt = conn.prepare(
            "SELECT request_id, app_type, model, request_model, pricing_model,
                    input_tokens, cache_read_tokens, cache_creation_tokens, input_token_semantics,
                    input_cost_usd, output_cost_usd, cache_read_cost_usd,
                    cache_creation_cost_usd, total_cost_usd
             FROM proxy_request_logs
             WHERE input_tokens + cache_read_tokens + cache_creation_tokens > ?1",
        )?;
        let rows = stmt.query_map([i64::try_from(threshold).unwrap_or(i64::MAX)], |row| {
            Ok(BackfillRow {
                request_id: row.get(0)?,
                app_type: row.get(1)?,
                model: row.get(2)?,
                request_model: row.get(3)?,
                pricing_model: row.get(4)?,
                input_tokens: row.get(5)?,
                cache_read_tokens: row.get(6)?,
                cache_creation_tokens: row.get(7)?,
                input_token_semantics: row.get(8)?,
                input_cost: row.get(9)?,
                output_cost: row.get(10)?,
                cache_read_cost: row.get(11)?,
                cache_creation_cost: row.get(12)?,
                total_cost: row.get(13)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let multiplier = Decimal::from(HAIKU_5_5_TIER.multiplier);
    let mut applies_by_name: HashMap<String, bool> = HashMap::new();
    let mut updated = 0u64;
    for row in &rows {
        if prompt_length(row) <= threshold {
            continue;
        }
        let Some(name) = pricing_lookup_name(row) else {
            continue;
        };
        let applies = match applies_by_name.get(name).copied() {
            Some(cached) => cached,
            None => {
                let value = long_prompt_tier_applies(conn, name)?;
                applies_by_name.insert(name.to_string(), value);
                value
            }
        };
        if !applies || all_costs_zero(row) {
            continue;
        }
        let Some([input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost]) =
            scaled_costs(row, multiplier)
        else {
            log::warn!(
                "Haiku 5.5 分档回填跳过 request_id={}：成本字串无法解析，或放大后溢出",
                row.request_id
            );
            continue;
        };
        conn.execute(
            "UPDATE proxy_request_logs
             SET input_cost_usd = ?1,
                 output_cost_usd = ?2,
                 cache_read_cost_usd = ?3,
                 cache_creation_cost_usd = ?4,
                 total_cost_usd = ?5
             WHERE request_id = ?6",
            params![
                input_cost,
                output_cost,
                cache_read_cost,
                cache_creation_cost,
                total_cost,
                row.request_id
            ],
        )
        .map_err(|e| AppError::Database(format!("回填 Haiku 5.5 分档成本失败: {e}")))?;
        updated += 1;
    }
    Ok(updated)
}

/// 回填扫描读出的一行明细。
struct BackfillRow {
    request_id: String,
    app_type: String,
    model: String,
    request_model: Option<String>,
    pricing_model: Option<String>,
    input_tokens: i64,
    cache_read_tokens: i64,
    cache_creation_tokens: i64,
    input_token_semantics: i64,
    input_cost: String,
    output_cost: String,
    cache_read_cost: String,
    cache_creation_cost: String,
    total_cost: String,
}

/// 查价用的模型名：计价模型不是占位符就用它；否则用模型列；模型列也是占位符时才用请求模型。
fn pricing_lookup_name(row: &BackfillRow) -> Option<&str> {
    if let Some(pricing_model) = row
        .pricing_model
        .as_deref()
        .filter(|name| !is_placeholder_pricing_model(name))
    {
        return Some(pricing_model);
    }
    if !is_placeholder_pricing_model(&row.model) {
        return Some(row.model.as_str());
    }
    row.request_model.as_deref()
}

/// 提示词长度。计费输入的还原规则与上游 `maybe_backfill_log_costs` 中那段一致，
/// 按这行自己的应用类型与输入语义计算；上游那段不改，这里另写一份。
fn prompt_length(row: &BackfillRow) -> u64 {
    let input = tokens(row.input_tokens);
    let cache_read = tokens(row.cache_read_tokens);
    let cache_creation = tokens(row.cache_creation_tokens);
    let billable = if !is_cache_inclusive_app(&row.app_type)
        || row.input_token_semantics == INPUT_TOKEN_SEMANTICS_FRESH
    {
        input
    } else if row.input_token_semantics == INPUT_TOKEN_SEMANTICS_TOTAL {
        input
            .saturating_sub(cache_read)
            .saturating_sub(cache_creation)
    } else {
        input.saturating_sub(cache_read)
    };
    prompt_tokens(billable, cache_read, cache_creation)
}

/// 库里的 token 列按非负整数读取，负值与读取失败都按 0 处理。
fn tokens(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

/// 五个成本栏各乘倍数，顺序为输入、输出、缓存读、缓存写、合计。任一栏解析失败或溢出则整行放弃。
fn scaled_costs(row: &BackfillRow, multiplier: Decimal) -> Option<[String; 5]> {
    Some([
        scale_cost(&row.input_cost, multiplier)?,
        scale_cost(&row.output_cost, multiplier)?,
        scale_cost(&row.cache_read_cost, multiplier)?,
        scale_cost(&row.cache_creation_cost, multiplier)?,
        scale_cost(&row.total_cost, multiplier)?,
    ])
}

/// 五个成本栏都能解析且都是 0：乘以倍数仍是 0，不必改写。
fn all_costs_zero(row: &BackfillRow) -> bool {
    [
        &row.input_cost,
        &row.output_cost,
        &row.cache_read_cost,
        &row.cache_creation_cost,
        &row.total_cost,
    ]
    .iter()
    .all(|raw| Decimal::from_str(raw).is_ok_and(|value| value.is_zero()))
}

fn scale_cost(raw: &str, multiplier: Decimal) -> Option<String> {
    let value = Decimal::from_str(raw).ok()?.checked_mul(multiplier)?;
    Some(cost_string(value))
}

/// 至少 6 位小数、不截断，格式与上游 `maybe_backfill_log_costs` 的 `cost_string` 相同。
/// 只存 6 位会把极小额写成 0；界面显示时再舍入。
fn cost_string(value: Decimal) -> String {
    let value = value.normalize();
    if value.scale() < 6 {
        format!("{value:.6}")
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::{lock_conn, Database};
    use crate::error::AppError;
    use crate::proxy::usage::logger::UsageLogger;
    use crate::proxy::usage::parser::TokenUsage;
    use crate::services::session_usage::cost_columns;
    use crate::services::sql_helpers::INPUT_TOKEN_SEMANTICS_LEGACY;
    use crate::services::usage_stats::find_model_pricing;
    use rusqlite::{params, Connection};
    use rust_decimal::Decimal;
    use std::str::FromStr;

    /// 一行 `proxy_request_logs`，只列测试要改动或读取的栏位；其余栏位由 `insert_log` 填固定值。
    struct LogSeed<'a> {
        request_id: &'a str,
        app_type: &'a str,
        model: &'a str,
        request_model: Option<&'a str>,
        pricing_model: Option<&'a str>,
        input_tokens: i64,
        cache_read_tokens: i64,
        cache_creation_tokens: i64,
        input_token_semantics: i64,
        /// 依次为输入、输出、缓存读、缓存写、合计成本字串
        costs: [&'a str; 5],
    }

    impl<'a> LogSeed<'a> {
        fn claude(request_id: &'a str, model: &'a str, input_tokens: i64) -> Self {
            Self {
                request_id,
                app_type: "claude",
                model,
                request_model: None,
                pricing_model: Some(model),
                input_tokens,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                input_token_semantics: INPUT_TOKEN_SEMANTICS_FRESH,
                costs: ["0.01", "0.02", "0", "0", "0.03"],
            }
        }
    }

    fn insert_log(conn: &Connection, seed: &LogSeed<'_>) -> Result<(), AppError> {
        conn.execute(
            "INSERT INTO proxy_request_logs (
                request_id, provider_id, app_type, model, request_model, pricing_model,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                input_token_semantics, input_cost_usd, output_cost_usd, cache_read_cost_usd,
                cache_creation_cost_usd, total_cost_usd, latency_ms, status_code, created_at
            ) VALUES (?1, 'provider-1', ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 100, 200, 1000)",
            params![
                seed.request_id,
                seed.app_type,
                seed.model,
                seed.request_model,
                seed.pricing_model,
                seed.input_tokens,
                seed.cache_read_tokens,
                seed.cache_creation_tokens,
                seed.input_token_semantics,
                seed.costs[0],
                seed.costs[1],
                seed.costs[2],
                seed.costs[3],
                seed.costs[4],
            ],
        )?;
        Ok(())
    }

    fn read_costs(conn: &Connection, request_id: &str) -> Result<[String; 5], AppError> {
        let costs: [String; 5] = conn.query_row(
            "SELECT input_cost_usd, output_cost_usd, cache_read_cost_usd,
                    cache_creation_cost_usd, total_cost_usd
             FROM proxy_request_logs WHERE request_id = ?1",
            [request_id],
            |row| {
                Ok([
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ])
            },
        )?;
        Ok(costs)
    }

    fn marker_present(conn: &Connection) -> Result<bool, AppError> {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM settings WHERE key = ?1",
            [BACKFILL_MARKER_KEY],
            |row| row.get::<_, i64>(0),
        )? > 0)
    }

    fn insert_pricing_row(
        conn: &Connection,
        model_id: &str,
        prices: [&str; 4],
    ) -> Result<(), AppError> {
        conn.execute(
            "INSERT INTO model_pricing (model_id, display_name, input_cost_per_million,
                output_cost_per_million, cache_read_cost_per_million,
                cache_creation_cost_per_million)
             VALUES (?1, ?1, ?2, ?3, ?4, ?5)",
            params![model_id, prices[0], prices[1], prices[2], prices[3]],
        )?;
        Ok(())
    }

    fn dec(value: &str) -> Decimal {
        Decimal::from_str(value).unwrap()
    }

    /// 查价挂接后，分档规则是否附上。定价数字与判定无关，这里只用占位价。
    fn tier_attached(db: &Database, model: &str) -> Result<bool, AppError> {
        let conn = lock_conn!(db.conn);
        let pricing = ModelPricing::from_strings("1", "1", "1", "1").unwrap();
        let attached = attach_long_prompt_tier(&conn, model, pricing);
        Ok(attached.long_prompt_tier.is_some())
    }

    fn haiku_usage(input: u32) -> TokenUsage {
        TokenUsage {
            input_tokens: input,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            cache_creation_1h_tokens: 0,
            model: None,
            message_id: None,
        }
    }

    // ---- 查价判定（R4） ----

    #[test]
    fn haiku_names_attach_the_rule() -> Result<(), AppError> {
        let db = Database::memory()?;
        for model in [
            "claude-haiku-5-5",
            "claude-haiku-5-5-20261007",
            "anthropic/claude-haiku-5.5",
        ] {
            assert!(tier_attached(&db, model)?, "{model}");
        }
        Ok(())
    }

    #[test]
    fn other_models_do_not_attach_the_rule() -> Result<(), AppError> {
        let db = Database::memory()?;
        for model in ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"] {
            assert!(!tier_attached(&db, model)?, "{model}");
        }
        Ok(())
    }

    #[test]
    fn same_prices_without_a_haiku_candidate_stay_standard() -> Result<(), AppError> {
        // 价格与 Haiku 5.5 完全相同，但候选里没有 claude-haiku-5-5：只比价格不够
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            insert_pricing_row(&conn, "my-haiku-clone", ["0.10", "0.50", "0.01", "0.125"])?;
        }
        assert!(!tier_attached(&db, "my-haiku-clone")?);
        Ok(())
    }

    #[test]
    fn differently_priced_row_for_a_haiku_candidate_stays_standard() -> Result<(), AppError> {
        // 名字能归一化到 claude-haiku-5-5，但命中的是一行价格不同的自订定价
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            insert_pricing_row(&conn, "claude-haiku-5-5-20261007", ["1", "2", "3", "4"])?;
        }
        assert!(!tier_attached(&db, "claude-haiku-5-5-20261007")?);
        Ok(())
    }

    #[test]
    fn missing_haiku_row_detaches_the_rule() -> Result<(), AppError> {
        // 两边都要查得到：Haiku 5.5 自己的定价行没有，就不附规则
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            conn.execute(
                "DELETE FROM model_pricing WHERE model_id = 'claude-haiku-5-5'",
                [],
            )?;
        }
        assert!(!tier_attached(&db, "claude-haiku-5-5")?);
        Ok(())
    }

    // ---- 入口：即时记账与会话查价 ----

    #[test]
    fn proxy_logging_bills_haiku_prompt_over_threshold_at_five_times() -> Result<(), AppError> {
        let db = Database::memory()?;
        UsageLogger::new(&db).log_with_calculation(
            "req-haiku-long".to_string(),
            "provider-1".to_string(),
            Decimal::ONE,
            "claude".to_string(),
            "claude-haiku-5-5".to_string(),
            "claude-haiku-5-5".to_string(),
            "claude-haiku-5-5".to_string(),
            haiku_usage(100_001),
            100,
            None,
            200,
            None,
            Some("claude".to_string()),
            false,
        )?;

        let conn = lock_conn!(db.conn);
        let costs = read_costs(&conn, "req-haiku-long")?;
        assert_eq!(dec(&costs[0]), dec("0.0500005"));
        assert_eq!(dec(&costs[4]), dec("0.0500005"));
        Ok(())
    }

    #[test]
    fn proxy_logging_at_threshold_stays_standard() -> Result<(), AppError> {
        let db = Database::memory()?;
        UsageLogger::new(&db).log_with_calculation(
            "req-haiku-at".to_string(),
            "provider-1".to_string(),
            Decimal::ONE,
            "claude".to_string(),
            "claude-haiku-5-5".to_string(),
            "claude-haiku-5-5".to_string(),
            "claude-haiku-5-5".to_string(),
            haiku_usage(100_000),
            100,
            None,
            200,
            None,
            Some("claude".to_string()),
            false,
        )?;

        let conn = lock_conn!(db.conn);
        let costs = read_costs(&conn, "req-haiku-at")?;
        assert_eq!(dec(&costs[0]), dec("0.01"));
        Ok(())
    }

    #[test]
    fn session_pricing_lookup_carries_the_rule() -> Result<(), AppError> {
        // 会话导入查价走 find_model_pricing，分项成本由 cost_columns 算出。
        // 落库函数 upsert_session_log_entry_on_conn 是私有的，这里测不到，见报告。
        let db = Database::memory()?;
        let conn = lock_conn!(db.conn);
        let pricing = find_model_pricing(&conn, "claude-haiku-5-5-20261007")
            .expect("Haiku 5.5 seed row must be priced");
        let costs = cost_columns(
            "claude",
            &haiku_usage(100_001),
            Some(&pricing),
            Decimal::ONE,
        );
        assert_eq!(dec(&costs[4]), dec("0.0500005"));
        Ok(())
    }

    // ---- 历史回填（R6） ----

    #[test]
    fn backfill_scales_five_cost_columns_of_target_rows_only() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            insert_log(
                &conn,
                &LogSeed {
                    costs: ["0.010001", "0.02", "0", "0", "0.030001"],
                    ..LogSeed::claude("target", "claude-haiku-5-5", 100_001)
                },
            )?;
        }

        assert_eq!(backfill_haiku55_long_prompt_tier(&db)?, 1);

        let conn = lock_conn!(db.conn);
        assert_eq!(
            read_costs(&conn, "target")?,
            ["0.050005", "0.100000", "0.000000", "0.000000", "0.150005"]
        );
        let (input_tokens, model, cost_multiplier, created_at): (i64, String, String, i64) = conn
            .query_row(
            "SELECT input_tokens, model, cost_multiplier, created_at
                 FROM proxy_request_logs WHERE request_id = 'target'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(input_tokens, 100_001);
        assert_eq!(model, "claude-haiku-5-5");
        assert_eq!(cost_multiplier, "1.0");
        assert_eq!(created_at, 1000);
        Ok(())
    }

    #[test]
    fn backfill_leaves_rows_at_threshold_untouched() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            insert_log(
                &conn,
                &LogSeed::claude("at-threshold", "claude-haiku-5-5", 100_000),
            )?;
        }

        assert_eq!(backfill_haiku55_long_prompt_tier(&db)?, 0);

        let conn = lock_conn!(db.conn);
        assert_eq!(
            read_costs(&conn, "at-threshold")?,
            ["0.01", "0.02", "0", "0", "0.03"]
        );
        Ok(())
    }

    #[test]
    fn backfill_leaves_other_models_untouched() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            insert_log(
                &conn,
                &LogSeed::claude("opus-long", "claude-opus-5-5", 200_000),
            )?;
            insert_log(
                &conn,
                &LogSeed::claude("sonnet-long", "claude-sonnet-5-5", 200_000),
            )?;
        }

        assert_eq!(backfill_haiku55_long_prompt_tier(&db)?, 0);

        let conn = lock_conn!(db.conn);
        assert_eq!(
            read_costs(&conn, "opus-long")?,
            ["0.01", "0.02", "0", "0", "0.03"]
        );
        assert_eq!(
            read_costs(&conn, "sonnet-long")?,
            ["0.01", "0.02", "0", "0", "0.03"]
        );
        Ok(())
    }

    #[test]
    fn backfill_runs_once_and_second_run_does_not_multiply_again() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            insert_log(
                &conn,
                &LogSeed {
                    costs: ["0.01", "0", "0", "0", "0.01"],
                    ..LogSeed::claude("target", "claude-haiku-5-5", 100_001)
                },
            )?;
        }

        assert_eq!(backfill_haiku55_long_prompt_tier(&db)?, 1);
        let first = {
            let conn = lock_conn!(db.conn);
            read_costs(&conn, "target")?
        };

        assert_eq!(backfill_haiku55_long_prompt_tier(&db)?, 0);
        let conn = lock_conn!(db.conn);
        assert_eq!(read_costs(&conn, "target")?, first);
        Ok(())
    }

    #[test]
    fn existing_marker_skips_the_whole_backfill() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, '1')",
                [BACKFILL_MARKER_KEY],
            )?;
            insert_log(
                &conn,
                &LogSeed {
                    costs: ["0.01", "0", "0", "0", "0.01"],
                    ..LogSeed::claude("target", "claude-haiku-5-5", 100_001)
                },
            )?;
        }

        assert_eq!(backfill_haiku55_long_prompt_tier(&db)?, 0);

        let conn = lock_conn!(db.conn);
        assert_eq!(
            read_costs(&conn, "target")?,
            ["0.01", "0", "0", "0", "0.01"]
        );
        Ok(())
    }

    #[test]
    fn backfill_prefers_pricing_model_over_model() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            // 计价模型是 Haiku 5.5：模型列是别的名字，仍然命中
            insert_log(
                &conn,
                &LogSeed {
                    pricing_model: Some("claude-haiku-5-5"),
                    ..LogSeed::claude("pricing-haiku", "claude-sonnet-4-5", 100_001)
                },
            )?;
            // 模型列是 Haiku 5.5，计价模型是别的模型：不命中
            insert_log(
                &conn,
                &LogSeed {
                    pricing_model: Some("claude-sonnet-4-5"),
                    ..LogSeed::claude("model-haiku", "claude-haiku-5-5", 100_001)
                },
            )?;
        }

        assert_eq!(backfill_haiku55_long_prompt_tier(&db)?, 1);

        let conn = lock_conn!(db.conn);
        assert_eq!(
            read_costs(&conn, "pricing-haiku")?,
            ["0.050000", "0.100000", "0.000000", "0.000000", "0.150000"]
        );
        assert_eq!(
            read_costs(&conn, "model-haiku")?,
            ["0.01", "0.02", "0", "0", "0.03"]
        );
        Ok(())
    }

    #[test]
    fn placeholder_pricing_model_falls_back_to_model() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            insert_log(
                &conn,
                &LogSeed {
                    pricing_model: Some(""),
                    ..LogSeed::claude("pm-empty", "claude-haiku-5-5", 100_001)
                },
            )?;
            insert_log(
                &conn,
                &LogSeed {
                    pricing_model: None,
                    ..LogSeed::claude("pm-null", "claude-haiku-5-5-20261007", 100_001)
                },
            )?;
            insert_log(
                &conn,
                &LogSeed {
                    pricing_model: Some("unknown"),
                    ..LogSeed::claude("pm-unknown", "claude-haiku-5-5", 100_001)
                },
            )?;
        }

        assert_eq!(backfill_haiku55_long_prompt_tier(&db)?, 3);
        Ok(())
    }

    #[test]
    fn placeholder_model_falls_back_to_request_model() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            insert_log(
                &conn,
                &LogSeed {
                    request_model: Some("claude-haiku-5-5"),
                    pricing_model: None,
                    ..LogSeed::claude("model-placeholder", "unknown", 100_001)
                },
            )?;
            insert_log(
                &conn,
                &LogSeed {
                    request_model: None,
                    pricing_model: None,
                    ..LogSeed::claude("model-placeholder-no-request", "unknown", 100_001)
                },
            )?;
        }

        assert_eq!(backfill_haiku55_long_prompt_tier(&db)?, 1);

        let conn = lock_conn!(db.conn);
        assert_eq!(
            read_costs(&conn, "model-placeholder")?,
            ["0.050000", "0.100000", "0.000000", "0.000000", "0.150000"]
        );
        assert_eq!(
            read_costs(&conn, "model-placeholder-no-request")?,
            ["0.01", "0.02", "0", "0", "0.03"]
        );
        Ok(())
    }

    #[test]
    fn unparseable_cost_skips_only_that_row() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            insert_log(
                &conn,
                &LogSeed {
                    costs: ["0.01", "0.02", "0", "0", "abc"],
                    ..LogSeed::claude("bad-cost", "claude-haiku-5-5", 100_001)
                },
            )?;
            insert_log(
                &conn,
                &LogSeed::claude("good-cost", "claude-haiku-5-5", 100_001),
            )?;
        }

        assert_eq!(backfill_haiku55_long_prompt_tier(&db)?, 1);

        let conn = lock_conn!(db.conn);
        assert_eq!(
            read_costs(&conn, "bad-cost")?,
            ["0.01", "0.02", "0", "0", "abc"]
        );
        assert_eq!(
            read_costs(&conn, "good-cost")?,
            ["0.050000", "0.100000", "0.000000", "0.000000", "0.150000"]
        );
        Ok(())
    }

    #[test]
    fn backfill_leaves_daily_rollups_untouched() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            conn.execute(
                "INSERT INTO usage_daily_rollups
                    (date, app_type, provider_id, model, request_count, total_cost_usd)
                 VALUES ('2026-11-01', 'claude', 'provider-1', 'claude-haiku-5-5', 3, '0.05')",
                [],
            )?;
            insert_log(
                &conn,
                &LogSeed::claude("rollup-target", "claude-haiku-5-5", 100_001),
            )?;
        }

        assert_eq!(backfill_haiku55_long_prompt_tier(&db)?, 1);

        let conn = lock_conn!(db.conn);
        let (request_count, total_cost): (i64, String) = conn.query_row(
            "SELECT request_count, total_cost_usd FROM usage_daily_rollups WHERE date = '2026-11-01'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(request_count, 3);
        assert_eq!(total_cost, "0.05");
        Ok(())
    }

    #[test]
    fn empty_database_still_writes_the_marker() -> Result<(), AppError> {
        let db = Database::memory()?;

        assert_eq!(backfill_haiku55_long_prompt_tier(&db)?, 0);

        let conn = lock_conn!(db.conn);
        assert!(marker_present(&conn)?);
        Ok(())
    }

    #[test]
    fn failure_rolls_back_all_rows_but_still_writes_the_marker() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            // row-ok 先于 row-fail 被扫描到（rowid 更小），回滚后它也必须还原
            insert_log(
                &conn,
                &LogSeed::claude("row-ok", "claude-haiku-5-5", 100_001),
            )?;
            insert_log(
                &conn,
                &LogSeed::claude("row-fail", "claude-haiku-5-5", 100_001),
            )?;
            conn.execute(
                "CREATE TRIGGER fail_row_fail BEFORE UPDATE ON proxy_request_logs
                 WHEN NEW.request_id = 'row-fail'
                 BEGIN SELECT RAISE(ABORT, 'forced failure'); END",
                [],
            )?;
        }

        assert!(backfill_haiku55_long_prompt_tier(&db).is_err());

        {
            let conn = lock_conn!(db.conn);
            assert_eq!(
                read_costs(&conn, "row-ok")?,
                ["0.01", "0.02", "0", "0", "0.03"]
            );
            // 标记照写：失败期间新落库的明细已按分档计价，下次启动再回填会重复乘倍
            assert!(marker_present(&conn)?);
            conn.execute("DROP TRIGGER fail_row_fail", [])?;
        }

        assert_eq!(backfill_haiku55_long_prompt_tier(&db)?, 0);
        {
            let conn = lock_conn!(db.conn);
            assert_eq!(
                read_costs(&conn, "row-ok")?,
                ["0.01", "0.02", "0", "0", "0.03"]
            );
        }
        Ok(())
    }

    #[test]
    fn prompt_length_follows_each_row_app_type_and_semantics() -> Result<(), AppError> {
        let db = Database::memory()?;
        {
            let conn = lock_conn!(db.conn);
            // TOTAL：input 已含缓存，提示词 = input = 100,000，不超过门槛
            insert_log(
                &conn,
                &LogSeed {
                    app_type: "codex",
                    cache_read_tokens: 1_000,
                    cache_creation_tokens: 1_000,
                    input_token_semantics: INPUT_TOKEN_SEMANTICS_TOTAL,
                    ..LogSeed::claude("codex-total-at", "claude-haiku-5-5", 100_000)
                },
            )?;
            // TOTAL：提示词 = input = 100,001，超过门槛
            insert_log(
                &conn,
                &LogSeed {
                    app_type: "codex",
                    cache_read_tokens: 1_000,
                    cache_creation_tokens: 1_000,
                    input_token_semantics: INPUT_TOKEN_SEMANTICS_TOTAL,
                    ..LogSeed::claude("codex-total-over", "claude-haiku-5-5", 100_001)
                },
            )?;
            // LEGACY：计费输入 = input - 缓存读 = 99,000，提示词 = 99,000 + 缓存写 1,001 = 100,001
            insert_log(
                &conn,
                &LogSeed {
                    app_type: "codex",
                    cache_creation_tokens: 1_001,
                    input_token_semantics: INPUT_TOKEN_SEMANTICS_LEGACY,
                    ..LogSeed::claude("codex-legacy-over", "claude-haiku-5-5", 99_000)
                },
            )?;
        }

        assert_eq!(backfill_haiku55_long_prompt_tier(&db)?, 2);

        let conn = lock_conn!(db.conn);
        assert_eq!(
            read_costs(&conn, "codex-total-at")?,
            ["0.01", "0.02", "0", "0", "0.03"]
        );
        assert_eq!(
            read_costs(&conn, "codex-total-over")?,
            ["0.050000", "0.100000", "0.000000", "0.000000", "0.150000"]
        );
        assert_eq!(
            read_costs(&conn, "codex-legacy-over")?,
            ["0.050000", "0.100000", "0.000000", "0.000000", "0.150000"]
        );
        Ok(())
    }
}
