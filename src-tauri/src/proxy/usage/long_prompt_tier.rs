//! 按提示词长度分档计价（fork 专用）。
//!
//! 依据 Anthropic 官方定价页 <https://platform.claude.com/docs/en/about-claude/pricing>
//! 的 Long context pricing 一节：一笔请求的提示词（输入 + 缓存读 + 缓存写）严格大于门槛时，
//! 输入、输出、缓存读、缓存写单价都是标准档的 5 倍。
//!
//! 定价表只存标准档，分档规则不进 schema。哪些定价行附上这条规则，由
//! `services::usage_stats::fork_long_prompt` 按查价结果判定；计价器在
//! `calculate_with_cache_semantics` 里调用 [`effective_pricing`] 换成分档后的单价。

use super::calculator::ModelPricing;
use super::parser::TokenUsage;
use rust_decimal::Decimal;
use std::borrow::Cow;

/// 规则适用的模型 ID（查价归一化后的规范形式）。
pub(crate) const HAIKU_5_5_MODEL_ID: &str = "claude-haiku-5-5";

/// 一条分档规则：提示词严格超过 `threshold_tokens` 时，四个单价都乘以 `multiplier`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LongPromptTier {
    pub threshold_tokens: u64,
    pub multiplier: u32,
}

/// Claude Haiku 5.5：门槛 100,000 token，倍数 5。
pub const HAIKU_5_5_TIER: LongPromptTier = LongPromptTier {
    threshold_tokens: 100_000,
    multiplier: 5,
};

/// 提示词长度 = 计费输入 + 缓存读 + 缓存写。
pub(crate) fn prompt_tokens(
    billable_input_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
) -> u64 {
    billable_input_tokens
        .saturating_add(cache_read_tokens)
        .saturating_add(cache_creation_tokens)
}

/// 这笔请求要用的单价。
///
/// 定价行附了分档规则且提示词严格超过门槛时，四个单价都乘以倍数，回传的定价不再带规则；
/// 否则借用原定价。`billable_input_tokens` 是计价器已算出的计费输入。
pub(crate) fn effective_pricing<'a>(
    pricing: &'a ModelPricing,
    usage: &TokenUsage,
    billable_input_tokens: u32,
) -> Cow<'a, ModelPricing> {
    let Some(tier) = pricing.long_prompt_tier else {
        return Cow::Borrowed(pricing);
    };
    let prompt = prompt_tokens(
        u64::from(billable_input_tokens),
        u64::from(usage.cache_read_tokens),
        u64::from(usage.cache_creation_tokens),
    );
    if prompt <= tier.threshold_tokens {
        return Cow::Borrowed(pricing);
    }
    let multiplier = Decimal::from(tier.multiplier);
    Cow::Owned(ModelPricing {
        input_cost_per_million: pricing.input_cost_per_million * multiplier,
        output_cost_per_million: pricing.output_cost_per_million * multiplier,
        cache_read_cost_per_million: pricing.cache_read_cost_per_million * multiplier,
        cache_creation_cost_per_million: pricing.cache_creation_cost_per_million * multiplier,
        long_prompt_tier: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::usage::calculator::{CostBreakdown, CostCalculator};
    use std::str::FromStr;

    fn usage(
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

    /// 与 Haiku 5.5 种子价相同的定价；`tiered` 为真时附上分档规则。
    fn haiku_pricing(tiered: bool) -> ModelPricing {
        let mut pricing = ModelPricing::from_strings("0.10", "0.50", "0.01", "0.125").unwrap();
        if tiered {
            pricing.long_prompt_tier = Some(HAIKU_5_5_TIER);
        }
        pricing
    }

    fn dec(value: &str) -> Decimal {
        Decimal::from_str(value).unwrap()
    }

    fn cost_of(
        app_type: &str,
        usage: &TokenUsage,
        pricing: &ModelPricing,
        multiplier: Decimal,
    ) -> CostBreakdown {
        CostCalculator::calculate_for_app(app_type, usage, pricing, multiplier)
    }

    #[test]
    fn prompt_tokens_sums_billable_input_and_both_cache_buckets() {
        assert_eq!(prompt_tokens(1_000, 200, 300), 1_500);
    }

    #[test]
    fn cache_read_alone_can_push_prompt_over_threshold() {
        // 输入 60,000 + 缓存读 40,001 = 100,001：只有加上缓存读才超过门槛
        let cost = cost_of(
            "claude",
            &usage(60_000, 1_000, 40_001, 0, 0),
            &haiku_pricing(true),
            Decimal::ONE,
        );
        assert_eq!(cost.input_cost, dec("0.03"));
        assert_eq!(cost.output_cost, dec("0.0025"));
        assert_eq!(cost.cache_read_cost, dec("0.00200005"));
        assert_eq!(cost.cache_creation_cost, dec("0"));
        assert_eq!(cost.total_cost, dec("0.03450005"));
    }

    #[test]
    fn cache_creation_alone_can_push_prompt_over_threshold() {
        // 输入 50,000 + 缓存写 50,001 = 100,001：缓存写单价 0.125 × 5 = 0.625 / M
        let cost = cost_of(
            "claude",
            &usage(50_000, 0, 0, 50_001, 0),
            &haiku_pricing(true),
            Decimal::ONE,
        );
        assert_eq!(cost.input_cost, dec("0.025"));
        assert_eq!(cost.cache_creation_cost, dec("0.031250625"));
    }

    #[test]
    fn prompt_exactly_at_threshold_stays_standard() {
        // 100,000 不超过门槛：输入 100,000 × 0.10 / M = 0.01
        let cost = cost_of(
            "claude",
            &usage(100_000, 0, 0, 0, 0),
            &haiku_pricing(true),
            Decimal::ONE,
        );
        assert_eq!(cost.input_cost, dec("0.01"));
    }

    #[test]
    fn prompt_one_token_over_threshold_scales_input_and_output_prices() {
        // 100,001：输入 0.10 × 5 = 0.50 / M，输出 0.50 × 5 = 2.50 / M
        let cost = cost_of(
            "claude",
            &usage(100_001, 1_000, 0, 0, 0),
            &haiku_pricing(true),
            Decimal::ONE,
        );
        assert_eq!(cost.input_cost, dec("0.0500005"));
        assert_eq!(cost.output_cost, dec("0.0025"));
    }

    #[test]
    fn cache_inclusive_app_measures_prompt_as_billable_plus_both_cache_buckets() {
        // codex：input 100,000 含缓存读 1,000 与缓存写 1,000，计费输入 98,000，
        // 提示词 = 98,000 + 1,000 + 1,000 = 100,000，不超过门槛
        let standard = cost_of(
            "codex",
            &usage(100_000, 0, 1_000, 1_000, 0),
            &haiku_pricing(true),
            Decimal::ONE,
        );
        assert_eq!(standard.input_cost, dec("0.0098"));

        // 同上但 input 为 100,001：提示词 100,001，超过门槛
        let tiered = cost_of(
            "codex",
            &usage(100_001, 0, 1_000, 1_000, 0),
            &haiku_pricing(true),
            Decimal::ONE,
        );
        assert_eq!(tiered.input_cost, dec("0.0490005"));
    }

    #[test]
    fn cost_multiplier_applies_after_tier_scaling() {
        let cost = cost_of(
            "claude",
            &usage(60_000, 1_000, 40_001, 0, 0),
            &haiku_pricing(true),
            dec("1.5"),
        );
        // 倍率只乘在总价上：分项仍是分档后的基础成本
        assert_eq!(cost.input_cost, dec("0.03"));
        assert_eq!(cost.total_cost, dec("0.051750075"));
    }

    #[test]
    fn one_hour_cache_writes_keep_the_1_6_ratio_under_the_tier() {
        // 输入 99,001 + 缓存写 1,000（其中 600 为 1 小时）= 100,001
        // 缓存写成本 = (400 + 600 × 1.6) × 0.125 × 5 / M = 1360 × 0.625 / M
        let cost = cost_of(
            "claude",
            &usage(99_001, 0, 0, 1_000, 600),
            &haiku_pricing(true),
            Decimal::ONE,
        );
        assert_eq!(cost.cache_creation_cost, dec("0.00085"));
    }

    #[test]
    fn pricing_without_the_rule_is_standard_at_any_length() {
        let cost = cost_of(
            "claude",
            &usage(1_000_000, 0, 1_000_000, 0, 0),
            &haiku_pricing(false),
            Decimal::ONE,
        );
        assert_eq!(cost.input_cost, dec("0.1"));
        assert_eq!(cost.cache_read_cost, dec("0.01"));
    }
}
