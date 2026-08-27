"""WSGI entry point at the repository root.

The real application is ``backend/echosense/wsgi.py``, and ``render.yaml`` starts
it directly with ``--chdir backend``. This module exists for the case where that
start command is *not* used: a Render service created by hand rather than from
the Blueprint keeps Render's stock default, ``gunicorn app:app``, which looks for
a module named ``app`` at the repository root, does not find one, and dies with::

    ModuleNotFoundError: No module named 'app'

That error names the missing module rather than the misconfiguration, so it is a
slow thing to diagnose from a deploy log. Ten lines here turn it into a working
boot on either command.

``backend`` goes on ``sys.path`` because gunicorn runs from the repository root
while ``DJANGO_SETTINGS_MODULE`` is ``echosense.settings`` — a path that only
resolves from inside ``backend/``. That is exactly what ``--chdir backend`` does
for the documented command; doing it here keeps the two equivalent.

Note this only fixes *starting*. A service that is not running ``build.sh`` still
has no ``frontend/dist`` and no migrations applied, so it will boot and then
serve the "Frontend not built" page. The build command has to be set as well —
there is no substitute for actually building the frontend.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "echosense.settings")

from echosense.wsgi import application  # noqa: E402  (path set up above)

# `application` is the WSGI standard name and `app` is what gunicorn's default
# `app:app` asks for. Both are exported so either spelling works.
app = application

__all__ = ["app", "application"]
