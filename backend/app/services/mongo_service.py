import os

from motor.motor_asyncio import AsyncIOMotorClient


class MongoService:
    def __init__(self) -> None:
        self.uri = os.getenv("MONGO_URI", "mongodb://localhost:27017/musicsync")
        try:
            # Keep Mongo optional in local/dev runs: fail fast if unavailable.
            self.client = AsyncIOMotorClient(
                self.uri,
                serverSelectionTimeoutMS=1000,
                connectTimeoutMS=1000,
                socketTimeoutMS=1000,
            )
            self.db = self.client.get_default_database()
        except Exception as e:
            print(f"Error connecting to MongoDB: {e}")
            self.client = None
            self.db = None

    async def ping(self) -> bool:
        if self.client is None:
            return False
        try:
            # The admin command 'ping' is a common way to test connection
            await self.client.admin.command("ping")
            return True
        except Exception:
            return False

    async def upsert_user(self, user_id: str, username: str) -> None:
        if self.db is None:
            return
        try:
            await self.db.users.update_one(
                {"userId": user_id},
                {"$set": {"userId": user_id, "username": username}},
                upsert=True,
            )
        except Exception as e:
            print(f"Error upserting user to Mongo: {e}")
