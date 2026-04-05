import warnings
import numpy as np
import pandas as pd
from sklearn.tree import DecisionTreeClassifier
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.svm import SVC
from sklearn.model_selection import cross_val_score, StratifiedKFold, train_test_split
from sklearn.metrics import confusion_matrix, classification_report, accuracy_score
from sklearn.preprocessing import StandardScaler
from config import TEST_SIZE, CV_FOLDS, RANDOM_STATE, INTERVAL_LABELS

warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", message=".*lbfgs failed to converge.*")


ENCODING = {"UP": 1, "NEUTRAL": 0, "DOWN": -1}


class MLEngine:

    def __init__(self, indicator_columns: list[str]):
        self.indicator_columns = indicator_columns
        self.numeric_features = [
            "rate_of_change", "range", "diff", "stddev", "mad",
            "volume", "buy_qty", "sell_qty", "S1", "R1", "S2", "R2",
        ]

    def prepare_features(self, df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series, list[str]]:
        work = df.copy()

        # Drop neutral labels
        work = work[work["label"].isin(["good", "bad"])].copy()
        if len(work) < 20:
            return pd.DataFrame(), pd.Series(dtype=int), []

        # Encode indicator columns: UP=1, NEUTRAL=0, DOWN=-1, None=0
        for col in self.indicator_columns:
            work[col] = work[col].map(ENCODING).fillna(0).astype(int)

        # Encode label
        y = (work["label"] == "good").astype(int)

        # Gather features
        feature_cols = []
        for col in self.indicator_columns:
            if col in work.columns:
                feature_cols.append(col)
        for col in self.numeric_features:
            if col in work.columns:
                feature_cols.append(col)

        X = work[feature_cols].fillna(0)
        return X, y, feature_cols

    def train_and_evaluate(self, X: pd.DataFrame, y: pd.Series, feature_names: list[str]) -> dict:
        if len(X) < 20:
            print("  Not enough data for ML training")
            return {}

        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=TEST_SIZE, random_state=RANDOM_STATE, stratify=y
        )

        # Scale features for models that need it (LR, SVM)
        scaler = StandardScaler()
        X_train_scaled = pd.DataFrame(scaler.fit_transform(X_train), columns=X_train.columns, index=X_train.index)
        X_test_scaled = pd.DataFrame(scaler.transform(X_test), columns=X_test.columns, index=X_test.index)

        models = {
            "DecisionTree": (DecisionTreeClassifier(random_state=RANDOM_STATE, max_depth=10), False),
            "RandomForest": (RandomForestClassifier(n_estimators=100, random_state=RANDOM_STATE, n_jobs=-1), False),
            "LogisticRegression": (LogisticRegression(max_iter=5000, random_state=RANDOM_STATE), True),
            "GradientBoosting": (GradientBoostingClassifier(n_estimators=100, random_state=RANDOM_STATE), False),
            "SVM": (SVC(kernel="rbf", probability=True, random_state=RANDOM_STATE), True),
        }

        skf = StratifiedKFold(n_splits=min(CV_FOLDS, min(y.value_counts())), shuffle=True, random_state=RANDOM_STATE)
        results = {}

        for name, (model, needs_scaling) in models.items():
            Xtr = X_train_scaled if needs_scaling else X_train
            Xte = X_test_scaled if needs_scaling else X_test

            # Cross-validation
            cv_scores = cross_val_score(model, Xtr, y_train, cv=skf, scoring="accuracy")

            # Train and test
            model.fit(Xtr, y_train)
            y_pred = model.predict(Xte)
            test_acc = accuracy_score(y_test, y_pred)
            cm = confusion_matrix(y_test, y_pred)
            # Only generate classification report if there are at least 2 classes in test set
            n_classes_in_test = len(np.unique(y_test))
            if n_classes_in_test >= 2:
                report = classification_report(y_test, y_pred, target_names=["bad", "good"])
            else:
                report = f"Test set has only {n_classes_in_test} class. Accuracy: {test_acc:.4f}"

            # Feature importance
            importance = []
            if hasattr(model, "feature_importances_"):
                for feat, imp in zip(feature_names, model.feature_importances_):
                    importance.append((feat, round(imp, 6)))
            elif hasattr(model, "coef_"):
                coefs = np.abs(model.coef_[0])
                for feat, imp in zip(feature_names, coefs):
                    importance.append((feat, round(imp, 6)))
            importance.sort(key=lambda x: x[1], reverse=True)

            results[name] = {
                "cv_scores": cv_scores.tolist(),
                "cv_mean": round(cv_scores.mean(), 4),
                "cv_std": round(cv_scores.std(), 4),
                "test_accuracy": round(test_acc, 4),
                "confusion_matrix": cm,
                "classification_report": report,
                "feature_importance": importance,
            }

            print(f"  {name}: CV={results[name]['cv_mean']:.4f}(+/-{results[name]['cv_std']:.4f})  Test={test_acc:.4f}")

        return results

    def get_best_model(self, results: dict) -> str:
        if not results:
            return "N/A"
        return max(results, key=lambda k: results[k]["cv_mean"])

    def get_top_features(self, results: dict, top_n: int = 20) -> pd.DataFrame:
        agg = {}
        count = 0
        for name, res in results.items():
            if res["feature_importance"]:
                count += 1
                for feat, imp in res["feature_importance"]:
                    agg[feat] = agg.get(feat, 0) + imp

        if not agg or count == 0:
            return pd.DataFrame(columns=["feature", "avg_importance", "rank"])

        rows = [{"feature": f, "avg_importance": round(v / count, 6)} for f, v in agg.items()]
        df = pd.DataFrame(rows).sort_values("avg_importance", ascending=False).reset_index(drop=True)
        df["rank"] = range(1, len(df) + 1)
        return df.head(top_n)

    def per_interval_analysis(self, interval_dfs: dict[int, pd.DataFrame]) -> pd.DataFrame:
        rows = []
        for interval, df in interval_dfs.items():
            label = INTERVAL_LABELS.get(interval, str(interval))
            print(f"\n--- ML for interval {label} ({len(df)} rows) ---")

            X, y, feature_names = self.prepare_features(df)
            if len(X) < 20:
                rows.append({
                    "interval": label,
                    "best_model": "N/A",
                    "best_cv_accuracy": 0,
                    "top_3_features": "insufficient data",
                })
                continue

            results = self.train_and_evaluate(X, y, feature_names)
            best = self.get_best_model(results)
            top_feats = self.get_top_features(results, top_n=3)
            top_names = ", ".join(top_feats["feature"].tolist()) if len(top_feats) > 0 else "N/A"

            rows.append({
                "interval": label,
                "best_model": best,
                "best_cv_accuracy": results[best]["cv_mean"] if best in results else 0,
                "top_3_features": top_names,
            })

        return pd.DataFrame(rows)
