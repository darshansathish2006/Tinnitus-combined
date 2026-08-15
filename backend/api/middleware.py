"""Request middleware."""

from __future__ import annotations

import time
from collections.abc import Callable

from django.http import HttpRequest, HttpResponse


class TimingMiddleware:
    """Attach the server-side processing time to every response.

    Useful during a demo: the Shapley explanation for a full assessment is a real
    computation, and being able to point at the header showing it took ~200 ms is
    more convincing than claiming it is fast.
    """

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        started = time.perf_counter()
        response = self.get_response(request)
        response["X-Process-Time"] = f"{(time.perf_counter() - started) * 1000:.1f}ms"
        return response
