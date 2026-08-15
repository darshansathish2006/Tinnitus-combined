"""Serve the built single-page app.

WhiteNoise answers every request that maps to a file the Vite build produced —
`/`, `/assets/index-*.js`, the intro video. What it cannot answer is a
client-side route: `/patient/assessment` is a path React Router invents in the
browser, so there is no such file and WhiteNoise falls through to the URLconf.
This view is what the URLconf falls through *to*, and returning index.html for
those paths is what makes a deep link or a page refresh work instead of 404ing.
"""

from __future__ import annotations

from pathlib import Path

from django.conf import settings
from django.http import HttpRequest, HttpResponse

_MISSING_BUILD = (
    "<!doctype html><meta charset='utf-8'><title>EchoSense AI</title>"
    "<body style=\"font:16px/1.6 system-ui;max-width:38rem;margin:12vh auto;padding:0 1.5rem\">"
    "<h1>Frontend not built</h1>"
    "<p>The API is running, but <code>frontend/dist/index.html</code> does not exist, "
    "so there is no app to serve.</p>"
    "<p>Build it with <code>npm run build</code> and restart, or use the API directly "
    "at <a href='/api'>/api</a>.</p>"
)

_cached: bytes | None = None


def _read_index() -> bytes | None:
    path = Path(settings.FRONTEND_DIST) / "index.html"
    return path.read_bytes() if path.is_file() else None


def index(request: HttpRequest) -> HttpResponse:
    """Return the SPA shell for any non-API path."""
    global _cached

    # index.html is small and never changes while a release is running, so it is
    # read once. Not in DEBUG, where a rebuild during a dev session should be
    # picked up without restarting the server.
    if settings.DEBUG:
        body = _read_index()
    else:
        if _cached is None:
            _cached = _read_index()
        body = _cached

    if body is None:
        return HttpResponse(_MISSING_BUILD, content_type="text/html; charset=utf-8", status=503)

    response = HttpResponse(body, content_type="text/html; charset=utf-8")
    # The shell must never be cached: it names the fingerprinted bundles, so a
    # stale copy pins a returning visitor to the previous release's assets —
    # which the next deploy deletes, leaving them on a blank page.
    response["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response
