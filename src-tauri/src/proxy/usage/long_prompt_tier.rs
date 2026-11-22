//! 按提示词长度分档计价（fork 专用）。
//!
//! 依据 Anthropic 官方定价页 <https://platform.claude.com/docs/en/about-claude/pricing>
//! 的 Model pricing 表与 Long context pricing 一节：一笔请求的提示词超过 10 万 token 时，
//! 输入、输出、缓存读、缓存写单价都是标准档的 5 倍。
//!
//! 定价表只存标准档，分档规则写在这里，不进 schema。
//! 是否分档看查价命中的定价行 `model_id`，不看请求里的模型名字串。

use rust_decimal::Decimal;

/// 一条分档规则：命中的定价行 `model_id` 的提示词超过 `threshold_tokens` 时，四个单价都乘以 `multiplier`。
struct LongPromptTier {
    model_id: &'static str,
    threshold_tokens: u64,
    multiplier: u32,
}

/// 分档表。目前只有 Haiku 5.5：门槛 100_000 token，倍数 5。
const TIERS: &[LongPromptTier] = &[LongPromptTier {
    model_id: "claude-haiku-5-5",
    threshold_tokens: 100_000,
    multiplier: 5,
}];

/// 提示词长度：billable 输入加上缓存读与缓存写，三者都计入门槛。
pub(crate) fn prompt_tokens(
    billable_input_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
) -> u64 {
    billable_input_tokens + cache_read_tokens + cache_creation_tokens
}

/// 命中的定价行在分档表中且提示词长度严格超过门槛时返回倍数，否则返回 1。
pub(crate) fn price_multiplier(pricing_row_model_id: Option<&str>, prompt_len: u64) -> Decimal {
    let Some(row_model_id) = pricing_row_model_id else {
        return Decimal::ONE;
    };
    TIERS
        .iter()
        .find(|tier| tier.model_id.eq_ignore_ascii_case(row_model_id))
        .filter(|tier| prompt_len > tier.threshold_tokens)
        .map_or(Decimal::ONE, |tier| Decimal::from(tier.multiplier))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn haiku_55_row_above_threshold_uses_five_times_multiplier() {
        assert_eq!(
            price_multiplier(Some("claude-haiku-5-5"), 100_001),
            Decimal::from(5)
        );
    }

    #[test]
    fn prompt_exactly_at_threshold_stays_standard() {
        assert_eq!(
            price_multiplier(Some("claude-haiku-5-5"), 100_000),
            Decimal::ONE
        );
    }

    #[test]
    fn rows_without_a_tier_entry_stay_standard() {
        for model in ["claude-opus-5-5", "claude-sonnet-5-5"] {
            assert_eq!(
                price_multiplier(Some(model), 1_000_000),
                Decimal::ONE,
                "{model}"
            );
        }
        assert_eq!(price_multiplier(None, 1_000_000), Decimal::ONE);
    }

    #[test]
    fn row_id_match_ignores_ascii_case() {
        assert_eq!(
            price_multiplier(Some("Claude-Haiku-5-5"), 100_001),
            Decimal::from(5)
        );
    }

    #[test]
    fn prompt_tokens_sums_billable_input_and_both_cache_buckets() {
        assert_eq!(prompt_tokens(1_000, 200, 300), 1_500);
    }
}
