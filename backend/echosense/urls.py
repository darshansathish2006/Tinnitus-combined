"""Root URL configuration."""

from django.urls import include, path, re_path

from . import spa

urlpatterns = [
    path("", include("api.urls")),
    # Everything the API did not claim is a client-side route. `api/` and
    # `static/` are excluded so an unknown endpoint still returns a JSON-shaped
    # 404 rather than the SPA shell with a 200 — a mistyped API path that
    # answers "200 OK, here is some HTML" is a genuinely hard bug to read.
    re_path(r"^(?!api/|static/).*$", spa.index, name="spa"),
]
