"""Django settings for EchoSense AI.

SQLite by default so the platform runs with zero infrastructure; point
``ECHOSENSE_DATABASE_URL`` at PostgreSQL for deployment without a code change.
"""

from __future__ import annotations

import os
from pathlib import Path
from datetime import timedelta

from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BASE_DIR.parent
FRONTEND_DIST = REPO_ROOT / "frontend" / "dist"

# Render exports RENDER=true into every build and every running service. Using it
# to pick the *default* means a deployment cannot accidentally ship a debug build
# because someone forgot an environment variable, while `npm run dev` keeps its
# zero-configuration default of DEBUG on. An explicit ECHOSENSE_DEBUG still wins
# in both directions.
IS_RENDER = bool(os.environ.get("RENDER"))
DEBUG = os.environ.get("ECHOSENSE_DEBUG", "0" if IS_RENDER else "1") == "1"

DEV_SECRET_KEY = "dev-only-change-me-in-production"
SECRET_KEY = os.environ.get("ECHOSENSE_SECRET_KEY", DEV_SECRET_KEY)
if not DEBUG and SECRET_KEY == DEV_SECRET_KEY:
    # Refusing to boot is the right failure here rather than a warning nobody
    # reads. SIMPLE_JWT signs access tokens with SECRET_KEY, so a deployment
    # running on the published development key lets anyone mint a token for any
    # account — including a clinician's, which reads every patient record.
    raise ImproperlyConfigured(
        "ECHOSENSE_SECRET_KEY must be set to a unique secret when DEBUG is off. "
        "On Render the blueprint generates one; set it manually if you created "
        "the service by hand."
    )

ALLOWED_HOSTS = [h.strip() for h in os.environ.get("ECHOSENSE_ALLOWED_HOSTS", "*").split(",") if h.strip()]
# Render publishes the service's public hostname. Appending it means the default
# deployment works without anyone having to know the URL in advance.
RENDER_HOSTNAME = os.environ.get("RENDER_EXTERNAL_HOSTNAME")
if RENDER_HOSTNAME and RENDER_HOSTNAME not in ALLOWED_HOSTS:
    ALLOWED_HOSTS.append(RENDER_HOSTNAME)

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.auth",
    "django.contrib.staticfiles",
    "rest_framework",
    "corsheaders",
    "api",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    # Directly after SecurityMiddleware, as WhiteNoise requires: it answers
    # requests for the built SPA and for Django's collected static files without
    # waking the rest of the stack.
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "api.middleware.TimingMiddleware",
]

# --------------------------------------------------------------------------- #
# Transport security
# --------------------------------------------------------------------------- #
# Render terminates TLS at its edge and forwards over plain HTTP, so Django sees
# an insecure request unless it is told to trust the forwarded header. Without
# this, is_secure() is False and the SSL redirect below would loop forever.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
# Overridable so the production settings can be exercised locally over plain
# HTTP (`ECHOSENSE_DEBUG=0 ECHOSENSE_SSL_REDIRECT=0`) without every request
# bouncing to an https URL that nothing is listening on.
SECURE_SSL_REDIRECT = os.environ.get("ECHOSENSE_SSL_REDIRECT", "0" if DEBUG else "1") == "1"
# The platform health check reaches the container directly rather than through
# the TLS edge, so it arrives without X-Forwarded-Proto and Django reads it as
# insecure. Left to the rule above it would be answered with a 301 to https,
# which the health check counts as a failure — and a service that never reports
# healthy is never routed traffic. Exempting the one endpoint is narrower than
# weakening the redirect.
SECURE_REDIRECT_EXEMPT = [r"^api/health$"]
SECURE_HSTS_SECONDS = 0 if DEBUG else 31536000
SECURE_HSTS_INCLUDE_SUBDOMAINS = not DEBUG
# No `preload`: that directive asks for inclusion in the browsers' hardcoded
# preload list, which is irreversible and not ours to ask for on a hostname
# under someone else's domain.
SECURE_HSTS_PRELOAD = False
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"

# `manage.py check --deploy` raises these two, and both are deliberate. Silenced
# rather than tolerated so the command stays a clean pass and a *new* warning is
# visible the moment it appears.
SILENCED_SYSTEM_CHECKS = [
    # W003: no CsrfViewMiddleware. Authentication is a bearer token read from the
    # Authorization header — there are no sessions and no auth cookies, so a
    # cross-site request carries no ambient credential to abuse. CSRF protection
    # defends cookie-based auth; there is none here to defend.
    "security.W003",
    # W021: SECURE_HSTS_PRELOAD is off on purpose. See the comment above it.
    "security.W021",
]

ROOT_URLCONF = "echosense.urls"
WSGI_APPLICATION = "echosense.wsgi.application"
ASGI_APPLICATION = "echosense.asgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {"context_processors": ["django.template.context_processors.request"]},
    }
]

# --------------------------------------------------------------------------- #
# Database
# --------------------------------------------------------------------------- #
# Managed Postgres providers — Render included — inject a plain `DATABASE_URL`.
# Reading it as a fallback means attaching a database is a one-click operation
# with no environment variable to copy across by hand.
DATABASE_URL = os.environ.get("ECHOSENSE_DATABASE_URL") or os.environ.get("DATABASE_URL", "")

if DATABASE_URL.startswith("postgres"):
    # postgresql://user:pass@host:port/name[?sslmode=require]
    from urllib.parse import parse_qs, unquote, urlparse

    parsed = urlparse(DATABASE_URL)
    options: dict[str, str] = {}
    # Render's *external* connection string carries `?sslmode=require`; the
    # internal one does not. Honouring whatever the URL says keeps one code path
    # for both, and for any other provider that mandates TLS.
    sslmode = parse_qs(parsed.query).get("sslmode", [None])[0]
    if sslmode:
        options["sslmode"] = sslmode

    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": (parsed.path or "/echosense").lstrip("/"),
            # Credentials are percent-encoded in a URL; a password containing
            # `@` or `/` arrives mangled unless it is decoded back.
            "USER": unquote(parsed.username or ""),
            "PASSWORD": unquote(parsed.password or ""),
            "HOST": parsed.hostname or "localhost",
            "PORT": str(parsed.port or 5432),
            "CONN_MAX_AGE": 60,
            "OPTIONS": options,
        }
    }
else:
    # `sqlite:///<path>` selects an alternative file. The verification harness
    # uses it to run smoke tests against a disposable database so exercising the
    # API never writes audit rows into the demo data.
    if DATABASE_URL.startswith("sqlite"):
        raw = DATABASE_URL.split("://", 1)[-1].lstrip("/") or "echosense.sqlite3"
        sqlite_path = Path(raw) if Path(raw).is_absolute() else BASE_DIR / raw
    else:
        sqlite_path = BASE_DIR / "echosense.sqlite3"

    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": sqlite_path,
            "OPTIONS": {
                # WAL keeps concurrent reads from blocking the writer, so the demo
                # database behaves like the production Postgres under load.
                "init_command": "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;",
                "transaction_mode": "IMMEDIATE",
            },
        }
    }

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
AUTH_USER_MODEL = "api.User"

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 8}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
]

LANGUAGE_CODE = "en-gb"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

# --------------------------------------------------------------------------- #
# Static files and the built SPA
# --------------------------------------------------------------------------- #
# The API and the single-page app are served from one origin by one process.
# That is not just fewer moving parts: it removes cross-origin requests from the
# deployment entirely, so the CORS allow-list, a second service URL to configure
# at build time, and the preflight round-trip on every API call all stop
# existing.
STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {
        # Hashed filenames let assets be cached forever, but the manifest they
        # rely on only exists after collectstatic. Requiring that in development
        # would break `npm run dev` for anyone who has not run it.
        "BACKEND": (
            "django.contrib.staticfiles.storage.StaticFilesStorage"
            if DEBUG
            else "whitenoise.storage.CompressedManifestStaticFilesStorage"
        )
    },
}

# Serve the Vite build at the site root, so `/assets/index-*.js` — the absolute
# paths Vite writes into index.html — resolve without rewriting the bundle.
# Guarded on existence because a checkout that has not run `npm run build` yet
# is a normal state, and WhiteNoise raises on a missing root.
if FRONTEND_DIST.is_dir():
    WHITENOISE_ROOT = str(FRONTEND_DIST)
# Makes `/` return the SPA's index.html rather than a 404.
WHITENOISE_INDEX_FILE = True
# Vite fingerprints every asset it emits, so a long max-age is safe: a changed
# file is a changed URL. index.html is served by the view in echosense.spa,
# which sets its own no-cache headers.
WHITENOISE_MAX_AGE = 0 if DEBUG else 31536000

# --------------------------------------------------------------------------- #
# REST framework
# --------------------------------------------------------------------------- #
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": (
        "rest_framework_simplejwt.authentication.JWTAuthentication",
    ),
    "DEFAULT_PERMISSION_CLASSES": ("rest_framework.permissions.IsAuthenticated",),
    "DEFAULT_RENDERER_CLASSES": (
        "rest_framework.renderers.JSONRenderer",
        "rest_framework.renderers.BrowsableAPIRenderer",
    ),
    "UNAUTHENTICATED_USER": None,
    "EXCEPTION_HANDLER": "api.exceptions.handler",
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(hours=12),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=7),
    "AUTH_HEADER_TYPES": ("Bearer",),
    "USER_ID_FIELD": "id",
    "USER_ID_CLAIM": "user_id",
}

# --------------------------------------------------------------------------- #
# CORS — the SPA is served separately in development
# --------------------------------------------------------------------------- #
# In production the SPA is same-origin (see the static files section above), so
# nothing here is exercised. It stays for the Vite dev server, and for a
# deployment that chooses to host the frontend elsewhere — set
# ECHOSENSE_CORS_ORIGINS to a comma-separated list of full origins for that.
CORS_ALLOWED_ORIGIN_REGEXES = [r"^http://(localhost|127\.0\.0\.1):\d+$"]
CORS_ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("ECHOSENSE_CORS_ORIGINS", "").split(",") if o.strip()
]
CORS_ALLOW_CREDENTIALS = True
# Content-Disposition must be exposed explicitly: it is not a CORS-safelisted
# response header, so without this the SPA's fetch-based downloader cannot read
# the server's filename and every export would fall back to a generic name.
CORS_EXPOSE_HEADERS = [
    "X-Process-Time",
    "X-Consented-Patients",
    "X-Rows",
    "Content-Disposition",
]

# --------------------------------------------------------------------------- #
# Domain settings (read via echosense.appconfig by the framework-free packages)
# --------------------------------------------------------------------------- #
ARTIFACTS_DIR = BASE_DIR / "artifacts"
MODEL_VERSION = "esai-predict-2.0.0"
ANTHROPIC_API_KEY = os.environ.get("ECHOSENSE_ANTHROPIC_API_KEY") or None
ANTHROPIC_MODEL = os.environ.get("ECHOSENSE_ANTHROPIC_MODEL", "claude-sonnet-5")

APP_NAME = "EchoSense AI"
API_VERSION = "2.0.0"

# --------------------------------------------------------------------------- #
# Teleconsultation
# --------------------------------------------------------------------------- #
# **One standing room for every consultation.**
#
# Requiring a clinician to create and paste a Meet link per appointment was the
# single most common reason a patient arrived at their consultation and found a
# disabled button: the appointment was confirmed, the clinician had not got to
# the link yet, and nothing in the booking flow forced them to. A standing room
# removes that failure mode entirely — the link exists before the appointment
# does.
#
# The trade-off is real and worth stating: one room means two consultations
# running at the same minute would share it. That is prevented upstream by the
# scheduler, which already refuses to double-book a clinician slot
# (`uniq_clinician_slot_active`), so the only way to collide is two *different*
# clinicians at the same minute. If this service grows past one clinical team,
# this becomes a per-clinician standing room rather than a global one — the
# resolution already goes through `_meeting_link_for`, so that is a one-function
# change.
#
# Overridable by environment so a deployment can point at its own room without
# a code change.
CONSULTATION_MEET_LINK = os.environ.get(
    "ECHOSENSE_MEET_LINK", "https://meet.google.com/kdz-zwyj-vqp"
)

# How long before the start the join button and the notice appear.
CONSULTATION_JOIN_OPENS_MINUTES = int(os.environ.get("ECHOSENSE_JOIN_OPENS_MINUTES", "10"))

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": "INFO"},
    "loggers": {"django.request": {"handlers": ["console"], "level": "ERROR", "propagate": False}},
}
