//! 订阅额度历史 DAO（fork 附加功能）
//!
//! 供应商只暴露「当前窗口已用百分比」，窗口一旦重置读数就永久消失。额度探针
//! 每小时把一份快照落到这里，「额度趋势」才能回看任意区间的额度变化。
//!
//! ## 为什么不走 schema.rs 的迁移链
//!
//! `SCHEMA_VERSION` 是一条线性版本链，上游随时会加自己的下一版。若本 fork 也
//! 占用同一个版本号，装过 fork 构建的库会被盖上该版本号，之后上游构建看到
//! `user_version` 已经等于它的目标版本，就会跳过它自己那批建表——静默损坏，
//! 比 rebase 冲突严重得多。
//!
//! 所以本表**不进迁移链**：表名带 `fork_` 前缀避免与上游撞名，并在每次访问前
//! `CREATE TABLE IF NOT EXISTS` 惰性建表（SQLite 下是一次廉价的 schema 查表）。
//! `user_version` 始终由上游独占，上游怎么升级都不会与这里冲突；代价是本表不
//! 参与迁移链的备份/回滚语义，丢了就是重新开始累积。
//!
//! 表名不在 `webdav_auto_sync::should_trigger_for_table` 白名单里，所以每小时的
//! 写入不会触发自动同步上传。
use crate::database::{lock_conn, Database};
use crate::error::AppError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// 历史保留天数：约 90 天 × 24 小时 × 每应用数个 tier，量级在万行以内。
const RETENTION_DAYS: i64 = 90;
const HOURS_PER_DAY: i64 = 24;

/// 前端送来的单个窗口读数
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaTierSample {
    /// 窗口名，如 `five_hour` / `seven_day`
    pub name: String,
    /// 已用百分比 0-100
    pub utilization: f64,
    /// 供应商直接给出的已用金额（多数供应商不给）
    pub used_usd: Option<f64>,
    /// 供应商直接给出的窗口额度上限
    pub max_usd: Option<f64>,
    /// 本机在该窗口内实测到的美元消耗；与 utilization 配对即可反推窗口总额度
    pub spend_usd: Option<f64>,
}

/// 查询返回的一行：某应用某小时某窗口的读数
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaHistoryRow {
    pub app_id: String,
    /// 纪元小时序号 = `measured_at / 3_600_000`
    pub hour: i64,
    pub tier: String,
    pub utilization: f64,
    pub used_usd: Option<f64>,
    pub max_usd: Option<f64>,
    pub spend_usd: Option<f64>,
}

/// 毫秒时间戳 → 纪元小时序号
fn hour_of(measured_at_ms: i64) -> i64 {
    measured_at_ms.div_euclid(3_600_000)
}

/// 惰性建表。放在每个入口而不是 `init()`，是为了完全不碰上游的初始化路径。
///
/// 本表不在迁移链上，所以自身的加列也得自己管：v3.19.6 发出去的版本没有
/// `spend_usd`，装过那一版的库要就地补列，不能靠 `CREATE TABLE IF NOT EXISTS`
/// （表已存在时它什么都不做）。
fn ensure_table(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS fork_quota_history (
             app_id      TEXT NOT NULL,
             hour        INTEGER NOT NULL,
             tier        TEXT NOT NULL,
             utilization REAL NOT NULL,
             used_usd    REAL,
             max_usd     REAL,
             spend_usd   REAL,
             measured_at INTEGER NOT NULL,
             PRIMARY KEY (app_id, hour, tier)
         );",
    )
    .map_err(|e| AppError::Database(format!("创建额度历史表失败: {e}")))?;

    let has_spend_usd = conn
        .prepare("SELECT 1 FROM pragma_table_info('fork_quota_history') WHERE name = 'spend_usd'")
        .and_then(|mut stmt| stmt.exists([]))
        .map_err(|e| AppError::Database(format!("检查额度历史表结构失败: {e}")))?;
    if !has_spend_usd {
        // check-then-ALTER 在同一文件的多个连接间不是原子的：两边都看到缺列、都执行
        // ALTER，输的一方拿到 "duplicate column name"。那说明列已经在了，是成功不是失败。
        match conn.execute(
            "ALTER TABLE fork_quota_history ADD COLUMN spend_usd REAL",
            [],
        ) {
            Ok(_) => {}
            Err(e) if e.to_string().contains("duplicate column name") => {}
            Err(e) => return Err(AppError::Database(format!("补列 spend_usd 失败: {e}"))),
        }
    }
    Ok(())
}

impl Database {
    /// 记录一份额度快照，返回是否真的改动了数据。
    ///
    /// 以 `(app_id, hour, tier)` 为主键做 upsert，保留**测量时间最新**的那次。
    /// 探针侧已按测量小时节流，正常情况下一小时只写一次；这里的「最新者胜」是给
    /// 乱序投递与重启后补写兜底的。重复观察到同一份缓存读数是幂等的——按测量时间
    /// 分桶，陈旧快照只会重写它自己那个小时，不会被抹到之后每个小时上。
    ///
    /// 返回 false 表示这次观察没带来新信息（旧读数或数值完全相同），调用方据此
    /// 跳过缓存失效。
    pub fn record_quota_history(
        &self,
        app_id: &str,
        measured_at_ms: i64,
        tiers: &[QuotaTierSample],
    ) -> Result<bool, AppError> {
        if tiers.is_empty() {
            return Ok(false);
        }
        let hour = hour_of(measured_at_ms);
        let conn = lock_conn!(self.conn);
        ensure_table(&conn)?;

        let mut changed = 0usize;
        for tier in tiers {
            if !tier.utilization.is_finite() {
                continue;
            }
            // WHERE 子句同时挡掉「更旧的读数」和「数值没变」两种无效写入，
            // execute 的返回值因此正好等于「是否有新信息」。
            let affected = conn
                .execute(
                    "INSERT INTO fork_quota_history
                         (app_id, hour, tier, utilization, used_usd, max_usd, spend_usd, measured_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT(app_id, hour, tier) DO UPDATE SET
                         utilization = excluded.utilization,
                         used_usd    = excluded.used_usd,
                         max_usd     = excluded.max_usd,
                         spend_usd   = excluded.spend_usd,
                         measured_at = excluded.measured_at
                     WHERE excluded.measured_at > fork_quota_history.measured_at
                       AND (fork_quota_history.utilization IS NOT excluded.utilization
                            OR fork_quota_history.used_usd IS NOT excluded.used_usd
                            OR fork_quota_history.max_usd  IS NOT excluded.max_usd
                            OR fork_quota_history.spend_usd IS NOT excluded.spend_usd)",
                    rusqlite::params![
                        app_id,
                        hour,
                        tier.name,
                        tier.utilization,
                        tier.used_usd,
                        tier.max_usd,
                        tier.spend_usd,
                        measured_at_ms,
                    ],
                )
                .map_err(|e| AppError::Database(format!("写入额度历史失败: {e}")))?;
            changed += affected;
        }

        if changed > 0 {
            let cutoff = hour - RETENTION_DAYS * HOURS_PER_DAY;
            conn.execute("DELETE FROM fork_quota_history WHERE hour < ?1", [cutoff])
                .map_err(|e| AppError::Database(format!("清理额度历史失败: {e}")))?;
        }

        Ok(changed > 0)
    }

    /// 查询 `[start_hour, end_hour]` 闭区间内的额度历史，按小时升序。
    ///
    /// `app_id` 为 None 时返回全部应用——「额度趋势」在应用筛选为「全部」时靠它
    /// 挑出第一个有数据的应用，一次查询即可，无需按应用轮询。
    pub fn get_quota_history(
        &self,
        app_id: Option<&str>,
        start_hour: i64,
        end_hour: i64,
    ) -> Result<Vec<QuotaHistoryRow>, AppError> {
        let conn = lock_conn!(self.conn);
        ensure_table(&conn)?;

        let sql = "SELECT app_id, hour, tier, utilization, used_usd, max_usd, spend_usd
                   FROM fork_quota_history
                   WHERE hour >= ?1 AND hour <= ?2
                     AND (?3 IS NULL OR app_id = ?3)
                   ORDER BY hour ASC, app_id ASC, tier ASC";
        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| AppError::Database(format!("查询额度历史失败: {e}")))?;
        let rows = stmt
            .query_map(rusqlite::params![start_hour, end_hour, app_id], |row| {
                Ok(QuotaHistoryRow {
                    app_id: row.get(0)?,
                    hour: row.get(1)?,
                    tier: row.get(2)?,
                    utilization: row.get(3)?,
                    used_usd: row.get(4)?,
                    max_usd: row.get(5)?,
                    spend_usd: row.get(6)?,
                })
            })
            .map_err(|e| AppError::Database(format!("查询额度历史失败: {e}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| AppError::Database(format!("读取额度历史失败: {e}")))?;

        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR_MS: i64 = 3_600_000;

    // Upstream's constructor, so new `Database` fields never break this test.
    fn db() -> Database {
        Database::memory().expect("open memory db")
    }

    fn tier(name: &str, utilization: f64) -> QuotaTierSample {
        QuotaTierSample {
            name: name.to_string(),
            utilization,
            used_usd: None,
            max_usd: None,
            spend_usd: None,
        }
    }

    #[test]
    fn creates_its_table_without_touching_user_version() {
        let db = db();
        let user_version = |db: &Database| -> i32 {
            let conn = db.conn.lock().expect("lock");
            conn.query_row("PRAGMA user_version", [], |r| r.get(0))
                .expect("user_version")
        };
        let before = user_version(&db);

        db.record_quota_history("claude", 10 * HOUR_MS, &[tier("five_hour", 20.0)])
            .expect("record");

        assert_eq!(user_version(&db), before, "本表不得改动迁移链的版本号");
    }

    #[test]
    fn buckets_by_measurement_hour() {
        let db = db();
        // 同一小时内的第 41 分钟
        db.record_quota_history(
            "claude",
            10 * HOUR_MS + 41 * 60_000,
            &[tier("five_hour", 20.0)],
        )
        .expect("record");

        let rows = db.get_quota_history(None, 0, 100).expect("query");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].hour, 10);
    }

    #[test]
    fn newer_reading_wins_within_the_same_hour() {
        let db = db();
        db.record_quota_history("claude", 10 * HOUR_MS, &[tier("five_hour", 20.0)])
            .expect("first");
        let changed = db
            .record_quota_history(
                "claude",
                10 * HOUR_MS + 30 * 60_000,
                &[tier("five_hour", 55.0)],
            )
            .expect("second");

        assert!(changed);
        let rows = db.get_quota_history(Some("claude"), 0, 100).expect("query");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].utilization, 55.0);
    }

    #[test]
    fn older_or_identical_readings_report_no_change() {
        let db = db();
        db.record_quota_history(
            "claude",
            10 * HOUR_MS + 30 * 60_000,
            &[tier("five_hour", 55.0)],
        )
        .expect("first");

        // 更旧的测量时间：不得覆盖
        let older = db
            .record_quota_history("claude", 10 * HOUR_MS, &[tier("five_hour", 20.0)])
            .expect("older");
        // 同一份读数重复观察：无新信息
        let same = db
            .record_quota_history(
                "claude",
                10 * HOUR_MS + 45 * 60_000,
                &[tier("five_hour", 55.0)],
            )
            .expect("same");

        assert!(!older);
        assert!(!same);
        let rows = db.get_quota_history(Some("claude"), 0, 100).expect("query");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].utilization, 55.0);
    }

    #[test]
    fn keeps_tiers_and_apps_apart() {
        let db = db();
        db.record_quota_history(
            "claude",
            10 * HOUR_MS,
            &[tier("five_hour", 20.0), tier("seven_day", 40.0)],
        )
        .expect("claude");
        db.record_quota_history("codex", 10 * HOUR_MS, &[tier("five_hour", 60.0)])
            .expect("codex");

        assert_eq!(db.get_quota_history(None, 0, 100).expect("all").len(), 3);
        let claude = db
            .get_quota_history(Some("claude"), 0, 100)
            .expect("claude");
        assert_eq!(claude.len(), 2);
        assert!(claude.iter().all(|r| r.app_id == "claude"));
    }

    #[test]
    fn filters_by_hour_range() {
        let db = db();
        for hour in [5_i64, 50, 90] {
            db.record_quota_history("claude", hour * HOUR_MS, &[tier("five_hour", 10.0)])
                .expect("record");
        }

        let rows = db.get_quota_history(None, 40, 60).expect("query");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].hour, 50);
    }

    #[test]
    fn prunes_beyond_the_retention_window() {
        let db = db();
        let now_hour = 10_000_i64;
        let stale_hour = now_hour - RETENTION_DAYS * HOURS_PER_DAY - 1;
        db.record_quota_history("claude", stale_hour * HOUR_MS, &[tier("five_hour", 10.0)])
            .expect("stale");
        db.record_quota_history("claude", now_hour * HOUR_MS, &[tier("five_hour", 20.0)])
            .expect("fresh");

        let rows = db.get_quota_history(None, 0, 100_000).expect("query");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].hour, now_hour);
    }

    #[test]
    fn carries_provider_dollar_figures() {
        let db = db();
        db.record_quota_history(
            "codex",
            10 * HOUR_MS,
            &[QuotaTierSample {
                name: "seven_day".to_string(),
                utilization: 12.5,
                used_usd: Some(25.0),
                max_usd: Some(200.0),
                spend_usd: Some(41.5),
            }],
        )
        .expect("record");

        let rows = db.get_quota_history(None, 0, 100).expect("query");
        assert_eq!(rows[0].used_usd, Some(25.0));
        assert_eq!(rows[0].max_usd, Some(200.0));
        assert_eq!(rows[0].spend_usd, Some(41.5));
    }

    #[test]
    fn a_changed_spend_counts_as_new_information_even_when_the_percentage_held() {
        // 厂商的百分比很粗，本机消耗却是连续变化的：同一小时内 U 不动而 C 动了，
        // 也必须落库。少了 upsert WHERE 里的 spend_usd 那一支，这次写入会被静默丢掉，
        // 行里留着偏小的 C，图上的额度被低估，而且 record 返回 false 导致图表不刷新。
        let db = db();
        let mut first = tier("five_hour", 20.0);
        first.spend_usd = Some(10.0);
        db.record_quota_history("claude", 10 * HOUR_MS, &[first])
            .expect("first");

        let mut second = tier("five_hour", 20.0); // 百分比没变
        second.spend_usd = Some(18.0); // 消耗变了
        let changed = db
            .record_quota_history("claude", 10 * HOUR_MS + 30 * 60_000, &[second])
            .expect("second");

        assert!(changed, "消耗变化必须算作新信息");
        let rows = db.get_quota_history(Some("claude"), 0, 100).expect("query");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].spend_usd, Some(18.0));
    }

    #[test]
    fn adds_spend_usd_to_a_table_created_by_an_older_build() {
        let db = db();
        {
            // v3.19.6 建的表：没有 spend_usd
            let conn = db.conn.lock().expect("lock");
            conn.execute_batch(
                "CREATE TABLE fork_quota_history (
                     app_id      TEXT NOT NULL,
                     hour        INTEGER NOT NULL,
                     tier        TEXT NOT NULL,
                     utilization REAL NOT NULL,
                     used_usd    REAL,
                     max_usd     REAL,
                     measured_at INTEGER NOT NULL,
                     PRIMARY KEY (app_id, hour, tier)
                 );",
            )
            .expect("legacy table");
        }

        let mut sample = tier("five_hour", 20.0);
        sample.spend_usd = Some(12.0);
        db.record_quota_history("claude", 10 * HOUR_MS, &[sample])
            .expect("record");

        let rows = db.get_quota_history(None, 0, 100).expect("query");
        assert_eq!(rows[0].spend_usd, Some(12.0));
    }

    #[test]
    fn skips_non_finite_utilization() {
        let db = db();
        let changed = db
            .record_quota_history("claude", 10 * HOUR_MS, &[tier("five_hour", f64::NAN)])
            .expect("record");

        assert!(!changed);
        assert!(db
            .get_quota_history(None, 0, 100)
            .expect("query")
            .is_empty());
    }

    #[test]
    fn reads_cleanly_before_anything_was_recorded() {
        let db = db();
        assert!(db
            .get_quota_history(None, 0, 100)
            .expect("query")
            .is_empty());
    }
}
