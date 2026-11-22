//! Cost Calculator - 计算 API 请求成本
//!
//! 使用高精度 Decimal 类型避免浮点数精度问题

use super::long_prompt_tier;
use super::parser::TokenUsage;
use rust_decimal::Decimal;
use std::str::FromStr;

/// 成本明细
#[derive(Debug, Clone)]
pub struct CostBreakdown {
    pub input_cost: Decimal,
    pub output_cost: Decimal,
    pub cache_read_cost: Decimal,
    pub cache_creation_cost: Decimal,
    pub total_cost: Decimal,
}

/// 模型定价信息
#[derive(Debug, Clone)]
pub struct ModelPricing {
    pub input_cost_per_million: Decimal,
    pub output_cost_per_million: Decimal,
    pub cache_read_cost_per_million: Decimal,
    pub cache_creation_cost_per_million: Decimal,
    /// 查价命中的定价行 model_id。分档只看它（见 `long_prompt_tier`）；
    /// `None` 表示价格不来自定价行，按标准档计价。
    pub pricing_row_model_id: Option<String>,
}

/// 成本计算器
pub struct CostCalculator;

impl CostCalculator {
    /// 按 app_type 选择输入 token 语义后计算成本。
    ///
    /// Codex/OpenAI Responses 与 Gemini 的输入 token 字段包含 cache read 部分；
    /// Claude/Anthropic 的 input_tokens 已经是 fresh input。
    pub fn calculate_for_app(
        app_type: &str,
        usage: &TokenUsage,
        pricing: &ModelPricing,
        cost_multiplier: Decimal,
    ) -> CostBreakdown {
        let input_includes_cache_read =
            crate::services::sql_helpers::is_cache_inclusive_app(app_type);
        Self::calculate_with_cache_semantics(
            usage,
            pricing,
            cost_multiplier,
            input_includes_cache_read,
        )
    }

    fn calculate_with_cache_semantics(
        usage: &TokenUsage,
        pricing: &ModelPricing,
        cost_multiplier: Decimal,
        input_includes_cache_read: bool,
    ) -> CostBreakdown {
        let million = Decimal::from(1_000_000);

        // OpenAI/Gemini 风格的 input_tokens 包含缓存读取和写入，需要扣除后再按输入价计费；
        // Claude/Anthropic 风格的 input_tokens 已经是 fresh input，不能再次扣减。
        let billable_input_tokens = if input_includes_cache_read {
            usage
                .input_tokens
                .saturating_sub(usage.cache_read_tokens)
                .saturating_sub(usage.cache_creation_tokens)
        } else {
            usage.input_tokens
        };

        // 提示词超过门槛时四个单价都乘以分档倍数；cost_multiplier 仍只乘在下方的总价上。
        let tier_multiplier = long_prompt_tier::price_multiplier(
            pricing.pricing_row_model_id.as_deref(),
            long_prompt_tier::prompt_tokens(
                u64::from(billable_input_tokens),
                u64::from(usage.cache_read_tokens),
                u64::from(usage.cache_creation_tokens),
            ),
        );
        let input_rate = pricing.input_cost_per_million * tier_multiplier;
        let output_rate = pricing.output_cost_per_million * tier_multiplier;
        let cache_read_rate = pricing.cache_read_cost_per_million * tier_multiplier;
        let cache_creation_rate = pricing.cache_creation_cost_per_million * tier_multiplier;

        // 各项基础成本（不含倍率）
        let input_cost = Decimal::from(billable_input_tokens) * input_rate / million;
        let output_cost = Decimal::from(usage.output_tokens) * output_rate / million;
        let cache_read_cost = Decimal::from(usage.cache_read_tokens) * cache_read_rate / million;
        // Anthropic 5 分钟缓存写入为输入价 1.25 倍、1 小时写入为 2 倍；定价表的
        // cache_creation 单价对应 5 分钟写入，1 小时写入按其 1.6 倍计。
        let cache_creation_1h_tokens = usage
            .cache_creation_1h_tokens
            .min(usage.cache_creation_tokens);
        let cache_creation_cost =
            (Decimal::from(usage.cache_creation_tokens - cache_creation_1h_tokens)
                + Decimal::from(cache_creation_1h_tokens) * Decimal::new(16, 1))
                * cache_creation_rate
                / million;

        // 总成本 = 各项基础成本之和 × 倍率
        let base_total = input_cost + output_cost + cache_read_cost + cache_creation_cost;
        let total_cost = base_total * cost_multiplier;

        CostBreakdown {
            input_cost,
            output_cost,
            cache_read_cost,
            cache_creation_cost,
            total_cost,
        }
    }

    pub fn try_calculate_for_app(
        app_type: &str,
        usage: &TokenUsage,
        pricing: Option<&ModelPricing>,
        cost_multiplier: Decimal,
    ) -> Option<CostBreakdown> {
        pricing.map(|p| Self::calculate_for_app(app_type, usage, p, cost_multiplier))
    }
}

impl ModelPricing {
    /// 从字符串创建定价信息，不关联定价行（按标准档计价）
    pub fn from_strings(
        input: &str,
        output: &str,
        cache_read: &str,
        cache_creation: &str,
    ) -> Result<Self, rust_decimal::Error> {
        Ok(Self {
            input_cost_per_million: Decimal::from_str(input)?,
            output_cost_per_million: Decimal::from_str(output)?,
            cache_read_cost_per_million: Decimal::from_str(cache_read)?,
            cache_creation_cost_per_million: Decimal::from_str(cache_creation)?,
            pricing_row_model_id: None,
        })
    }

    /// 从命中的定价行创建定价信息。行 model_id 与单价取自同一行，分档判定与价格出自同一次查价
    pub fn from_row(
        model_id: &str,
        input: &str,
        output: &str,
        cache_read: &str,
        cache_creation: &str,
    ) -> Result<Self, rust_decimal::Error> {
        let mut pricing = Self::from_strings(input, output, cache_read, cache_creation)?;
        pricing.pricing_row_model_id = Some(model_id.to_string());
        Ok(pricing)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cost_calculation() {
        let usage = TokenUsage {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_tokens: 200,
            cache_creation_tokens: 100,
            cache_creation_1h_tokens: 0,
            model: None,
            message_id: None,
        };

        let pricing = ModelPricing::from_strings("3.0", "15.0", "0.3", "3.75").unwrap();
        let multiplier = Decimal::from_str("1.0").unwrap();

        let cost = CostCalculator::calculate_for_app("claude", &usage, &pricing, multiplier);

        // Claude/Anthropic 语义：input_tokens 已经不含 cache_read_tokens
        // input: 1000 * 3.0 / 1M = 0.003
        assert_eq!(cost.input_cost, Decimal::from_str("0.003").unwrap());
        // output: 500 * 15.0 / 1M = 0.0075
        assert_eq!(cost.output_cost, Decimal::from_str("0.0075").unwrap());
        // cache_read: 200 * 0.3 / 1M = 0.00006
        assert_eq!(cost.cache_read_cost, Decimal::from_str("0.00006").unwrap());
        // cache_creation: 100 * 3.75 / 1M = 0.000375
        assert_eq!(
            cost.cache_creation_cost,
            Decimal::from_str("0.000375").unwrap()
        );
        // total: 0.003 + 0.0075 + 0.00006 + 0.000375 = 0.010935
        assert_eq!(cost.total_cost, Decimal::from_str("0.010935").unwrap());
    }

    #[test]
    fn test_claude_1h_cache_writes_billed_at_1h_rate() {
        // Claude Opus 4.8：5m 缓存写入 $6.25/M，1h 缓存写入 $10/M（输入价的 2 倍）
        let pricing = ModelPricing::from_strings("5", "25", "0.50", "6.25").unwrap();
        let usage = serde_json::json!({
            "input_tokens": 2,
            "output_tokens": 1,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 1000,
            "cache_creation": {
                "ephemeral_5m_input_tokens": 400,
                "ephemeral_1h_input_tokens": 600
            }
        });
        let response = serde_json::json!({ "model": "claude-opus-4-8", "usage": usage });
        let events = [
            serde_json::json!({
                "type": "message_start",
                "message": { "model": "claude-opus-4-8", "usage": usage }
            }),
            serde_json::json!({ "type": "message_delta", "usage": { "output_tokens": 5 } }),
        ];

        for parsed in [
            TokenUsage::from_claude_response(&response),
            TokenUsage::from_claude_stream_events(&events),
        ] {
            let cost = CostCalculator::calculate_for_app(
                "claude",
                &parsed.unwrap(),
                &pricing,
                Decimal::ONE,
            );
            // 400 × 6.25 / 1M + 600 × 10 / 1M = 0.0085
            assert_eq!(
                cost.cache_creation_cost,
                Decimal::from_str("0.0085").unwrap()
            );
        }
    }

    #[test]
    fn test_cost_calculation_for_cache_inclusive_app() {
        let usage = TokenUsage {
            input_tokens: 1000,
            output_tokens: 500,
            cache_read_tokens: 200,
            cache_creation_tokens: 100,
            cache_creation_1h_tokens: 0,
            model: None,
            message_id: None,
        };

        let pricing = ModelPricing::from_strings("3.0", "15.0", "0.3", "3.75").unwrap();
        let multiplier = Decimal::from_str("1.0").unwrap();

        let cost = CostCalculator::calculate_for_app("codex", &usage, &pricing, multiplier);

        // Codex/OpenAI 语义：input_tokens 包含 cache read/write，两桶都需扣除。
        assert_eq!(cost.input_cost, Decimal::from_str("0.0021").unwrap());
        assert_eq!(cost.output_cost, Decimal::from_str("0.0075").unwrap());
        assert_eq!(cost.cache_read_cost, Decimal::from_str("0.00006").unwrap());
        assert_eq!(
            cost.cache_creation_cost,
            Decimal::from_str("0.000375").unwrap()
        );
        assert_eq!(cost.total_cost, Decimal::from_str("0.010035").unwrap());
    }

    #[test]
    fn grokbuild_does_not_double_bill_cached_input() {
        let usage = TokenUsage {
            input_tokens: 1000,
            output_tokens: 0,
            cache_read_tokens: 600,
            cache_creation_tokens: 0,
            cache_creation_1h_tokens: 0,
            model: None,
            message_id: None,
        };
        let pricing = ModelPricing::from_strings("10", "0", "1", "0").unwrap();

        let cost = CostCalculator::calculate_for_app("grokbuild", &usage, &pricing, Decimal::ONE);

        assert_eq!(cost.input_cost, Decimal::from_str("0.004").unwrap());
        assert_eq!(cost.cache_read_cost, Decimal::from_str("0.0006").unwrap());
        assert_eq!(cost.total_cost, Decimal::from_str("0.0046").unwrap());
    }

    #[test]
    fn test_cost_multiplier() {
        let usage = TokenUsage {
            input_tokens: 1000,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            cache_creation_1h_tokens: 0,
            model: None,
            message_id: None,
        };

        let pricing = ModelPricing::from_strings("3.0", "15.0", "0", "0").unwrap();
        let multiplier = Decimal::from_str("1.5").unwrap();

        let cost = CostCalculator::calculate_for_app("claude", &usage, &pricing, multiplier);

        // input_cost: 基础价格（不含倍率）= 1000 * 3.0 / 1M = 0.003
        assert_eq!(cost.input_cost, Decimal::from_str("0.003").unwrap());
        // total_cost: 基础价格 × 倍率 = 0.003 * 1.5 = 0.0045
        assert_eq!(cost.total_cost, Decimal::from_str("0.0045").unwrap());
    }

    #[test]
    fn test_decimal_precision() {
        let usage = TokenUsage {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_tokens: 1,
            cache_creation_tokens: 1,
            cache_creation_1h_tokens: 0,
            model: None,
            message_id: None,
        };

        let pricing = ModelPricing::from_strings("0.075", "0.3", "0.01875", "0.075").unwrap();
        let multiplier = Decimal::from_str("1.0").unwrap();

        let cost = CostCalculator::calculate_for_app("claude", &usage, &pricing, multiplier);

        // 验证高精度计算
        assert!(cost.total_cost > Decimal::ZERO);
        assert!(cost.total_cost.to_string().len() > 2); // 确保保留了小数位
    }

    fn usage_of(
        input: u32,
        output: u32,
        cache_read: u32,
        cache_creation: u32,
        cache_creation_1h: u32,
    ) -> TokenUsage {
        TokenUsage {
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cache_read,
            cache_creation_tokens: cache_creation,
            cache_creation_1h_tokens: cache_creation_1h,
            model: None,
            message_id: None,
        }
    }

    /// 命中 `claude-haiku-5-5` 定价行，标准档单价与种子行一致。
    fn haiku_55_row() -> ModelPricing {
        ModelPricing::from_row("claude-haiku-5-5", "0.10", "0.50", "0.01", "0.125").unwrap()
    }

    #[test]
    fn haiku_55_prompt_above_threshold_scales_every_component_five_times() {
        let usage = usage_of(100_001, 1_000, 0, 0, 0);
        let cost =
            CostCalculator::calculate_for_app("claude", &usage, &haiku_55_row(), Decimal::ONE);

        // input: 100_001 × 0.10 × 5 / 1M
        assert_eq!(cost.input_cost, Decimal::from_str("0.0500005").unwrap());
        // output: 1_000 × 0.50 × 5 / 1M
        assert_eq!(cost.output_cost, Decimal::from_str("0.0025").unwrap());
        assert_eq!(cost.cache_read_cost, Decimal::ZERO);
        assert_eq!(cost.cache_creation_cost, Decimal::ZERO);
        assert_eq!(cost.total_cost, Decimal::from_str("0.0525005").unwrap());
    }

    #[test]
    fn haiku_55_prompt_exactly_at_threshold_keeps_standard_price() {
        let usage = usage_of(100_000, 0, 0, 0, 0);
        let cost =
            CostCalculator::calculate_for_app("claude", &usage, &haiku_55_row(), Decimal::ONE);

        assert_eq!(cost.input_cost, Decimal::from_str("0.01").unwrap());
        assert_eq!(cost.total_cost, Decimal::from_str("0.01").unwrap());
    }

    #[test]
    fn cache_read_and_creation_count_toward_the_threshold() {
        // 1_000 + 99_500 + 1_000 = 101_500 > 100_000，三桶都按高档价
        let usage = usage_of(1_000, 0, 99_500, 1_000, 0);
        let cost =
            CostCalculator::calculate_for_app("claude", &usage, &haiku_55_row(), Decimal::ONE);

        assert_eq!(cost.input_cost, Decimal::from_str("0.0005").unwrap());
        assert_eq!(cost.cache_read_cost, Decimal::from_str("0.004975").unwrap());
        assert_eq!(
            cost.cache_creation_cost,
            Decimal::from_str("0.000625").unwrap()
        );
    }

    #[test]
    fn cache_tokens_below_threshold_keep_standard_price() {
        // 1_000 + 98_999 = 99_999，未超门槛
        let usage = usage_of(1_000, 0, 98_999, 0, 0);
        let cost =
            CostCalculator::calculate_for_app("claude", &usage, &haiku_55_row(), Decimal::ONE);

        assert_eq!(
            cost.cache_read_cost,
            Decimal::from_str("0.00098999").unwrap()
        );
    }

    #[test]
    fn cache_inclusive_prompt_length_does_not_count_cache_twice() {
        // codex 的 input_tokens 已含缓存：billable = 100_000 - 50_000 = 50_000，
        // 提示词长度 = 50_000 + 50_000 = 100_000，仍是标准档
        let usage = usage_of(100_000, 0, 50_000, 0, 0);
        let cost =
            CostCalculator::calculate_for_app("codex", &usage, &haiku_55_row(), Decimal::ONE);

        assert_eq!(cost.input_cost, Decimal::from_str("0.005").unwrap());
        assert_eq!(cost.cache_read_cost, Decimal::from_str("0.0005").unwrap());
    }

    #[test]
    fn cache_inclusive_prompt_above_threshold_after_deduction_is_tiered() {
        // billable = 150_000 - 60_000 = 90_000，提示词长度 = 90_000 + 60_000 = 150_000
        let usage = usage_of(150_000, 0, 60_000, 0, 0);
        let cost =
            CostCalculator::calculate_for_app("codex", &usage, &haiku_55_row(), Decimal::ONE);

        assert_eq!(cost.input_cost, Decimal::from_str("0.045").unwrap());
        assert_eq!(cost.cache_read_cost, Decimal::from_str("0.003").unwrap());
    }

    #[test]
    fn cost_multiplier_applies_after_tier_scaling() {
        let usage = usage_of(100_001, 0, 0, 0, 0);
        let cost =
            CostCalculator::calculate_for_app("claude", &usage, &haiku_55_row(), Decimal::from(2));

        // 分项是不含倍率的基础成本，倍率只乘在总价上
        assert_eq!(cost.input_cost, Decimal::from_str("0.0500005").unwrap());
        assert_eq!(cost.total_cost, Decimal::from_str("0.100001").unwrap());
    }

    #[test]
    fn one_hour_cache_writes_keep_their_relation_after_tier() {
        // 提示词长度 100_001（全为缓存写入），其中 600 个是 1 小时写入
        let usage = usage_of(0, 0, 0, 100_001, 600);
        let tiered =
            CostCalculator::calculate_for_app("claude", &usage, &haiku_55_row(), Decimal::ONE);
        let standard = CostCalculator::calculate_for_app(
            "claude",
            &usage,
            &ModelPricing::from_strings("0.10", "0.50", "0.01", "0.125").unwrap(),
            Decimal::ONE,
        );

        // (99_401 × 0.125 + 600 × 0.125 × 1.6) × 5 / 1M
        assert_eq!(
            tiered.cache_creation_cost,
            Decimal::from_str("0.062725625").unwrap()
        );
        assert_eq!(
            tiered.cache_creation_cost,
            standard.cache_creation_cost * Decimal::from(5)
        );
    }

    #[test]
    fn other_model_rows_above_threshold_cost_the_same_as_standard() {
        let usage = usage_of(150_000, 2_000, 10_000, 5_000, 1_000);
        for model in ["claude-opus-5-5", "claude-sonnet-5-5"] {
            let row = ModelPricing::from_row(model, "4", "20", "0.20", "5").unwrap();
            let plain = ModelPricing::from_strings("4", "20", "0.20", "5").unwrap();
            let tiered = CostCalculator::calculate_for_app("claude", &usage, &row, Decimal::ONE);
            let standard =
                CostCalculator::calculate_for_app("claude", &usage, &plain, Decimal::ONE);

            assert_eq!(tiered.input_cost, standard.input_cost, "{model}");
            assert_eq!(
                tiered.cache_creation_cost, standard.cache_creation_cost,
                "{model}"
            );
            assert_eq!(tiered.total_cost, standard.total_cost, "{model}");
        }
    }

    #[test]
    fn pricing_built_without_a_row_id_never_tiers() {
        let usage = usage_of(100_001, 0, 0, 0, 0);
        let cost = CostCalculator::calculate_for_app(
            "claude",
            &usage,
            &ModelPricing::from_strings("0.10", "0.50", "0.01", "0.125").unwrap(),
            Decimal::ONE,
        );

        assert_eq!(cost.input_cost, Decimal::from_str("0.0100001").unwrap());
    }
}
