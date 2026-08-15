"""DRF exception handling.

Normalises every error to ``{"detail": "..."}`` with a readable string, because the
frontend surfaces `detail` directly to the user and a nested validation dictionary
rendered as JSON is not something a patient should ever see.
"""

from __future__ import annotations

from typing import Any

from django.core.exceptions import ObjectDoesNotExist, ValidationError as DjangoValidationError
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_handler


def _flatten(detail: Any, prefix: str = "") -> list[str]:
    """Turn DRF's nested error structure into readable "field: message" lines."""
    if isinstance(detail, dict):
        lines: list[str] = []
        for key, value in detail.items():
            label = f"{prefix}{key}" if not prefix else f"{prefix}.{key}"
            lines.extend(_flatten(value, label))
        return lines
    if isinstance(detail, (list, tuple)):
        lines = []
        for item in detail:
            lines.extend(_flatten(item, prefix))
        return lines
    return [f"{prefix}: {detail}" if prefix else str(detail)]


def handler(exc: Exception, context: dict) -> Response | None:
    if isinstance(exc, ObjectDoesNotExist):
        return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)

    if isinstance(exc, DjangoValidationError):
        return Response(
            {"detail": "; ".join(exc.messages)}, status=status.HTTP_422_UNPROCESSABLE_ENTITY
        )

    response = drf_handler(exc, context)
    if response is None:
        return None

    data = response.data
    if isinstance(data, dict) and set(data) == {"detail"}:
        return response

    response.data = {"detail": "; ".join(_flatten(data)), "errors": data}
    return response
