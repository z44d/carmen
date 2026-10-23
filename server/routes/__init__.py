from fastapi import APIRouter

from .browsing import router as browsing_router
from .convert import router as convert_router
from .playlists import router as playlists_router
from .podcasts import router as podcasts_router
from .search import router as search_router
from .stream import router as stream_router
from .watch import router as watch_router
from .app import router as app_router

router = APIRouter()
router.include_router(browsing_router)
router.include_router(search_router)
router.include_router(watch_router)
router.include_router(podcasts_router)
router.include_router(playlists_router)
router.include_router(stream_router)
router.include_router(convert_router)
# Registered last on purpose: it is a `/{spa_path:path}` catch-all that serves
# the web client's index.html (with link-preview tags), so every real API route
# above must match first. See server/routes/app.py.
router.include_router(app_router)
