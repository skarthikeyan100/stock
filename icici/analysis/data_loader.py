import pandas as pd
from pymongo import MongoClient
from config import MONGO_URI, MONGO_DB, MONGO_COLLECTION


class DataLoader:

    def __init__(self, uri=MONGO_URI, db_name=MONGO_DB, collection=MONGO_COLLECTION):
        self.client = MongoClient(uri)
        self.db = self.client[db_name]
        self.collection = self.db[collection]

    def load(self) -> pd.DataFrame:
        cursor = self.collection.find()
        docs = list(cursor)
        if not docs:
            raise ValueError(f"No documents found ")

        df = pd.DataFrame(docs)
        # Keep only the fields we need
        keep = ["ltp", "ltt", "open", "high", "low", "close", "prevClose",
                "volume", "buyQty", "sellQty"]
        available = [c for c in keep if c in df.columns]
        df = df[available].copy()

        # Ensure numeric types
        for col in available:
            df[col] = pd.to_numeric(df[col], errors="coerce")

        df = df.dropna(subset=["ltp", "ltt"])
        df = df.sort_values("ltt").reset_index(drop=True)
        print(f"Loaded {len(df)} quotes from MongoDB ")
        return df

    def close(self):
        self.client.close()
