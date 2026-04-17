from .mongo_service import MongoService
from .redis_service import RedisService
from .youtube_service import YouTubeService

# Shared service instances
redis_service = RedisService()
mongo_service = MongoService()
youtube_service = YouTubeService()
