import { DEFAULT_WORLDINFO_BUDGET_PERCENT } from '../core/generation-defaults';

export const defaultWorldinfoSettings = {
    scan_depth: 6, context_percentage: DEFAULT_WORLDINFO_BUDGET_PERCENT, budget_cap: 0, min_activations: 0, max_depth: 0, max_recursion_steps: 4,
    insertion_strategy: 'evenly' as 'evenly' | 'character_first' | 'global_first', include_names: false, recursive: true,
    case_sensitive: false, match_whole_words: false, use_group_scoring: false, overflow_alert: true,
};
export type WorldinfoSettings = typeof defaultWorldinfoSettings;
