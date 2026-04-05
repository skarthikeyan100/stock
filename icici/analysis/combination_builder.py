"""
Generates indicator pair combinations using AND logic.
Both indicators must agree on direction to produce a signal.
"""
from itertools import combinations
import pandas as pd


class CombinationBuilder:

    def __init__(self, indicator_columns: list[str]):
        """
        Args:
            indicator_columns: List of base indicator column names (59 or 80)
        """
        self.indicator_columns = indicator_columns
        self.pairs = list(combinations(self.indicator_columns, 2))
        self.combination_columns = [f"{ind1}__AND__{ind2}" for ind1, ind2 in self.pairs]
        print(f"  Generated {len(self.pairs)} pair combinations")

    def add_combinations(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Add combined indicator columns to DataFrame.

        Args:
            df: Feature DataFrame with indicator columns

        Returns:
            DataFrame with added combination columns
        """
        print(f"  Computing {len(self.pairs)} combinations...")

        # Optimized: compute all combinations at once using vectorized operations
        combination_data = {}
        for ind1, ind2 in self.pairs:
            col_name = f"{ind1}__AND__{ind2}"
            # Vectorized AND logic: both must agree
            col1 = df[ind1]
            col2 = df[ind2]
            # Both are UP -> UP, both are DOWN -> DOWN, else NEUTRAL
            combination_data[col_name] = [
                val1 if val1 == val2 and val1 in ("UP", "DOWN") else "NEUTRAL"
                for val1, val2 in zip(col1, col2)
            ]

        # Create new DataFrame with combinations and concatenate
        combination_df = pd.DataFrame(combination_data, index=df.index)
        result = pd.concat([df, combination_df], axis=1)

        print(f"  Added {len(self.pairs)} combination columns")
        return result

    @staticmethod
    def _combine_and(row, ind1: str, ind2: str) -> str:
        """
        AND logic: both indicators must agree on direction.

        Args:
            row: DataFrame row
            ind1, ind2: Indicator column names

        Returns:
            "UP" if both are UP, "DOWN" if both are DOWN, else "NEUTRAL"
        """
        val1 = row.get(ind1)
        val2 = row.get(ind2)

        if val1 == val2 and val1 in ("UP", "DOWN"):
            return val1  # Both agree on direction
        return "NEUTRAL"  # Disagree or one/both are NEUTRAL
