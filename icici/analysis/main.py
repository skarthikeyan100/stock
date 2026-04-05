#!/usr/bin/env python3
import os
import time
import pandas as pd
from config import parse_args, INTERVALS, INTERVAL_LABELS
from data_loader import DataLoader
from candle_builder import CandleBuilder
from feature_builder import FeatureBuilder
from labeler import Labeler
from ml_engine import MLEngine


def run_threshold_analysis(
    combined_df: pd.DataFrame,
    raw_quotes: pd.DataFrame,
    indicator_columns: list[str],
    threshold: float,
    lookahead: int,
    output_dir: str,
    skip_ml: bool = False,
    stop_loss: float = None,
) -> dict:
    """
    Run labeling, success rates, and ML for a single threshold.

    Returns:
        dict with summary metrics for this threshold
    """
    from labeler import Labeler
    from ml_engine import MLEngine

    # Create threshold-specific output directory
    threshold_dir = os.path.join(output_dir, f"threshold_{int(threshold)}")
    os.makedirs(threshold_dir, exist_ok=True)

    print(f"\n{'='*60}")
    print(f"Analyzing threshold = {threshold} points, stop loss = {stop_loss or threshold} points")
    print(f"{'='*60}")

    # Step 1: Label with this threshold
    labeler = Labeler(indicator_columns, threshold, lookahead, stop_loss)

    # Label each interval separately (preserve existing structure)
    interval_dfs = {}
    for interval in combined_df["interval"].unique():
        interval_df = combined_df[combined_df["interval"] == interval].copy()
        interval_dfs[interval] = labeler.label(interval_df, raw_quotes)

    # Combine labeled intervals
    labeled_combined = pd.concat(interval_dfs.values(), ignore_index=True)

    # Write candle features CSV (includes all indicators + combinations)
    features_path = os.path.join(threshold_dir, "candle_features.csv")
    labeled_combined.to_csv(features_path, index=False)
    print(f"Wrote {features_path} ({len(labeled_combined)} rows × {len(labeled_combined.columns)} cols)")

    # Step 2: Per-indicator success rates (computed per interval)
    print(f"\nComputing success rates for {len(indicator_columns)} indicators...")

    summaries = []
    all_success_rates = []

    for interval, interval_labeled_df in interval_dfs.items():
        interval_label = INTERVAL_LABELS[interval]
        print(f"  Interval: {interval_label}")

        interval_sr = labeler.per_indicator_success_rates(interval_labeled_df, raw_quotes)
        interval_sr["interval_label"] = interval_label
        all_success_rates.append(interval_sr)

        total_good = interval_sr["good"].sum()
        total_bad = interval_sr["bad"].sum()
        overall_success_rate = (total_good / (total_good + total_bad) * 100) if (total_good + total_bad) > 0 else 0

        for i in range(len(interval_sr)):
            row = interval_sr.iloc[i]
            summaries.append({
                "threshold": threshold,
                "interval_label": interval_label,
                "rank": i + 1,
                "indicator": row["indicator"],
                "good_count": row["good"],
                "bad_count": row["bad"],
                "success_rate": row["success_rate"],
                "total_good": total_good,
                "total_bad": total_bad,
                "overall_success_rate": round(overall_success_rate, 2),
            })

    success_rates = pd.concat(all_success_rates, ignore_index=True) if all_success_rates else pd.DataFrame()
    sr_path = os.path.join(threshold_dir, "indicator_success_rates.csv")
    success_rates.to_csv(sr_path, index=False)
    print(f"Wrote {sr_path}")

    if not summaries:
        summaries.append({
            "threshold": threshold,
            "interval_label": None,
            "rank": 1,
            "indicator": None,
            "good_count": 0,
            "bad_count": 0,
            "success_rate": 0,
            "total_good": 0,
            "total_bad": 0,
            "overall_success_rate": 0,
        })

    summary = summaries  # Will be flattened in main()

    # Step 3: ML analysis (if not skipped)
    if not skip_ml:
        print(f"\nML analysis...")
        engine = MLEngine(indicator_columns)
        X, y, feature_names = engine.prepare_features(labeled_combined)

        if len(X) >= 20:
            results = engine.train_and_evaluate(X, y, feature_names)
            best = engine.get_best_model(results)

            # Model comparison CSV
            comp_rows = []
            for name, res in results.items():
                comp_rows.append({
                    "model": name,
                    "cv_mean": res["cv_mean"],
                    "cv_std": res["cv_std"],
                    "test_accuracy": res["test_accuracy"],
                })
            comp_df = pd.DataFrame(comp_rows).sort_values("cv_mean", ascending=False)
            comp_path = os.path.join(threshold_dir, "model_comparison.csv")
            comp_df.to_csv(comp_path, index=False)

            # Feature importance CSV
            importance_df = engine.get_top_features(results, top_n=50)
            imp_path = os.path.join(threshold_dir, "feature_importance.csv")
            importance_df.to_csv(imp_path, index=False)

            # Interval analysis
            interval_summary = engine.per_interval_analysis(interval_dfs)
            interval_path = os.path.join(threshold_dir, "interval_analysis.csv")
            interval_summary.to_csv(interval_path, index=False)

            # Add ML metrics to all summary rows
            for s in summary:
                s["best_model"] = best
                s["best_cv_accuracy"] = results[best]["cv_mean"]
                s["best_test_accuracy"] = results[best]["test_accuracy"]
        else:
            print("Not enough labeled data for ML training")

    return summary


def main():
    args = parse_args()
    os.makedirs(args.output_dir, exist_ok=True)
    start = time.time()

    # ========================================
    # PHASE 1: One-time data preparation
    # ========================================

    # Step 1: Load data from MongoDB
    print("=" * 60)
    print("PHASE 1: Data Preparation")
    print("=" * 60)
    print("\nStep 1: Loading data from MongoDB")
    loader = DataLoader()
    raw_quotes = loader.load()
    loader.close()

    # Step 2: Build candles at all intervals
    print("\nStep 2: Building candles")
    builder = CandleBuilder()
    candles_by_interval = builder.build(raw_quotes)

    # Step 3: Compute base indicators for each interval
    print("\nStep 3: Computing technical indicators")
    feat_builder = FeatureBuilder(reverse_rsi=args.reverse_rsi)
    interval_dfs = {}

    for interval, candles in candles_by_interval.items():
        label = INTERVAL_LABELS[interval]
        print(f"\n  Interval: {label}")
        if len(candles) < 5:
            print(f"    Skipping — only {len(candles)} candles")
            continue
        df = feat_builder.build(candles)
        interval_dfs[interval] = df

    # Combine all intervals
    combined = pd.concat(interval_dfs.values(), ignore_index=True)
    print(f"\nBase features: {len(combined)} rows × {len(combined.columns)} cols")
    print(f"Indicators: {len(feat_builder.indicator_columns)}")

    # Step 4: Generate indicator combinations (if enabled)
    all_indicator_cols = feat_builder.indicator_columns

    if args.include_combinations:
        print("\nStep 4: Generating indicator combinations")
        from combination_builder import CombinationBuilder
        combo_builder = CombinationBuilder(feat_builder.indicator_columns)
        combined = combo_builder.add_combinations(combined)
        all_indicator_cols = feat_builder.indicator_columns + combo_builder.combination_columns
        print(f"Total features: {len(all_indicator_cols)} indicators (including combinations)")

    # Write full feature matrix (unlabeled, all thresholds will use this)
    full_features_path = os.path.join(args.output_dir, "candle_features_full.csv")
    combined.to_csv(full_features_path, index=False)
    print(f"\nWrote {full_features_path}")

    # ========================================
    # PHASE 2: Multi-threshold analysis
    # ========================================

    print("\n" + "=" * 60)
    print("PHASE 2: Multi-Threshold Analysis")
    print("=" * 60)
    print(f"Thresholds: {args.thresholds}")
    print(f"Parallel: {args.parallel}")

    if args.parallel:
        from multiprocessing import Pool, cpu_count
        num_workers = min(len(args.thresholds), cpu_count())
        print(f"Using {num_workers} parallel workers")

        with Pool(processes=num_workers) as pool:
            threshold_results = pool.starmap(
                run_threshold_analysis,
                [
                    (combined, raw_quotes, all_indicator_cols, t, args.lookahead,
                     args.output_dir, args.skip_ml, args.stop_loss)
                    for t in args.thresholds
                ]
            )
    else:
        threshold_results = []
        for threshold in args.thresholds:
            result = run_threshold_analysis(
                combined, raw_quotes, all_indicator_cols, threshold,
                args.lookahead, args.output_dir, args.skip_ml, args.stop_loss
            )
            threshold_results.append(result)

    # ========================================
    # PHASE 3: Threshold comparison
    # ========================================

    print("\n" + "=" * 60)
    print("PHASE 3: Threshold Comparison")
    print("=" * 60)

    # Flatten: each threshold returns a list of rows
    all_rows = [row for result in threshold_results for row in result]
    comparison_df = pd.DataFrame(all_rows).sort_values(["threshold", "rank"])
    comparison_path = os.path.join(args.output_dir, "threshold_comparison.csv")
    comparison_df.to_csv(comparison_path, index=False)
    print(f"\nWrote {comparison_path}")
    print("\nThreshold Comparison:")
    print(comparison_df.to_string(index=False))

    elapsed = round(time.time() - start, 1)
    print(f"\n{'=' * 60}")
    print(f"Done in {elapsed}s. Outputs in {args.output_dir}/")
    print("=" * 60)


if __name__ == "__main__":
    main()
