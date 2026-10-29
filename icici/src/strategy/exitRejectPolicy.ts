// What a strategy does when the broker rejects the resting EXIT sell it placed (shared by BulkPcrStrategy and HourlyStrategy, which each
// carried a copy). Live incidents behind it: 2026-10-15 an identical rejected order was re-placed without limit; a bare "insufficient" /
// "margin" match was broad enough to stop retrying on an unrelated transient message, and the first narrowed pattern used
// `[^a-z]{0,20}` between the two words, which excludes ANY letter, so ordinary phrasing ("Margin is insufficient", "Not enough margin to
// cover order") never matched at all. `.{0,30}` fixes that, and `enough`/`short` catch "not enough margin".

// Counts RE-PLACEMENTS after the original placement, not total placements: the count increments once per rejection and is checked with
// `>`, so rejections 1-5 each still get a retry (5 re-placements) and rejection 6 stops it. "6 total placements" is the same behaviour
// described another way, not an off-by-one (flagged twice on review).
export const MAX_EXIT_REJECT_RETRIES = 5;
export const EXIT_REJECT_RETRY_DELAY_MS = 5000;
// Rejections more than this far apart are not the same streak.
export const EXIT_REJECT_STREAK_RESET_MS = 120_000;
export const MARGIN_SHORTFALL_REASON_PATTERN = /margin.{0,30}(shortfall|insufficient|exceed|short)|(?:shortfall|insufficient|exceed|short|enough).{0,30}margin/i;

export interface ExitRejectState {
    exitRejectCount?: number;
    exitLastRejectAt?: number;
}

// Records one REJECTED exit sell on `pos` and says what to do:
//   'marginShortfall' - there is nothing left to sell against (usually the position was already closed outside the app); do NOT re-place
//   'tooMany'         - rejected more than MAX_EXIT_REJECT_RETRIES times in one streak; stop re-placing
//   'retry'           - re-place (after EXIT_REJECT_RETRY_DELAY_MS once the streak is past its first rejection)
export function recordExitReject(pos: ExitRejectState, rejectReason: string | undefined, now: number = Date.now()): 'marginShortfall' | 'tooMany' | 'retry' {
    const withinStreak = pos.exitLastRejectAt != null && now - pos.exitLastRejectAt <= EXIT_REJECT_STREAK_RESET_MS;
    pos.exitRejectCount = (withinStreak ? pos.exitRejectCount ?? 0 : 0) + 1;
    pos.exitLastRejectAt = now;
    if (rejectReason && MARGIN_SHORTFALL_REASON_PATTERN.test(rejectReason)) return 'marginShortfall';
    if (pos.exitRejectCount > MAX_EXIT_REJECT_RETRIES) return 'tooMany';
    return 'retry';
}
