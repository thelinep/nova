"""Per-reviewer acceptance-rate monitoring for Tier B records."""
from __future__ import annotations

from collections import defaultdict
from typing import Any, Sequence

from guru.schemas.quality import HumanReviewRecord, QualityTier


def track_reviewer_agreement(records: Sequence[HumanReviewRecord | dict[str, Any]]) -> dict[str, dict[str, Any]]:
    normalized = [record if isinstance(record, HumanReviewRecord)
                  else HumanReviewRecord.model_validate(record) for record in records]
    all_reviews: dict[str, list[bool]] = defaultdict(list)
    tier_b_reviews: dict[str, list[bool]] = defaultdict(list)
    pool = [record.accepted for record in normalized if record.tier is QualityTier.B]
    pool_mean = sum(pool) / len(pool) if pool else 0.0
    for record in normalized:
        all_reviews[record.reviewer_id].append(record.accepted)
        if record.tier is QualityTier.B:
            tier_b_reviews[record.reviewer_id].append(record.accepted)
    summary: dict[str, dict[str, Any]] = {}
    for reviewer_id, reviews in sorted(all_reviews.items()):
        tier_b = tier_b_reviews[reviewer_id]
        rate = sum(reviews) / len(reviews)
        tier_b_rate = sum(tier_b) / len(tier_b) if tier_b else None
        flags: list[str] = []
        if len(tier_b) >= 50 and tier_b_rate is not None and abs(tier_b_rate - pool_mean) > 0.15:
            flags.append("tier_b_accept_rate_diverges_from_pool_by_more_than_15pp")
        summary[reviewer_id] = {
            "review_count": len(reviews), "accept_rate": rate,
            "tier_b_review_count": len(tier_b), "tier_b_accept_rate": tier_b_rate,
            "pool_tier_b_accept_rate": pool_mean if tier_b else None,
            "flagged": bool(flags), "flags": flags,
        }
    return summary
