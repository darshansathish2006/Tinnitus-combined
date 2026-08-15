#!/usr/bin/env bash
#
# Render build. Everything the running service needs but the repository does not
# carry is produced here: the SPA bundle, the collected static files, and the
# trained model artifacts, all of which are gitignored because they are outputs.
#
# Run it locally the same way to reproduce a deployment exactly:
#   bash ./build.sh

set -o errexit
set -o pipefail
set -o nounset

echo "==> Python dependencies"
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

echo "==> Frontend bundle"
# `ci` rather than `install`: it installs exactly what package-lock.json pins, so
# a build cannot silently pick up a different dependency version than the one
# that was tested.
npm --prefix frontend ci
npm --prefix frontend run build

cd backend

echo "==> Static files"
python manage.py collectstatic --no-input

echo "==> Database migrations"
python manage.py migrate --no-input

echo "==> Predictive ensemble"
# backend/artifacts/ is gitignored, so the ensemble is fitted at build time
# rather than shipped. ECHOSENSE_TRAIN_N trades accuracy for build minutes.
python manage.py train_models --n "${ECHOSENSE_TRAIN_N:-6000}"

echo "==> Demo cohort"
# Seeding is conditional so a redeploy never wipes a database that is already in
# use. The committed SQLite file already contains the demo cohort, so this only
# does work when the service is pointed at an empty Postgres.
#
# ECHOSENSE_SEED: auto (default) | always | never
SEED_MODE="${ECHOSENSE_SEED:-auto}"

if [ "$SEED_MODE" = "never" ]; then
  echo "    skipped (ECHOSENSE_SEED=never)"
else
  probe=$(python -c "
import os, django
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'echosense.settings')
django.setup()
from api.models import User
print('ECHOSENSE_HAS_USERS' if User.objects.exists() else 'ECHOSENSE_EMPTY')
" || true)

  case "$SEED_MODE:$probe" in
    always:*)
      python manage.py seed_demo --reset
      ;;
    *ECHOSENSE_HAS_USERS*)
      echo "    skipped (database already populated)"
      ;;
    *)
      # Reached when the database is empty, and also when the probe itself
      # failed. Seeding is the safe outcome for both: an unseeded deployment has
      # no accounts at all and cannot be logged into.
      python manage.py seed_demo --reset
      ;;
  esac
fi

echo "==> Build complete"
