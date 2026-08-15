"""Fit the predictive ensemble.

    python manage.py train_models [--n 6000] [--seed 20260730]
"""

from __future__ import annotations

from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Train the predictive ensemble and write artifacts/model_card.json"

    def add_arguments(self, parser) -> None:
        parser.add_argument("--n", type=int, default=6000, help="Simulated cohort size")
        parser.add_argument("--seed", type=int, default=20260730)

    def handle(self, *args, **options) -> None:
        from ml.train import train_all

        self.stdout.write(self.style.MIGRATE_HEADING("EchoSense AI — training predictive ensemble\n"))
        card = train_all(n=options["n"], seed=options["seed"], verbose=True)
        self.stdout.write(
            self.style.SUCCESS(
                f"\nModel {card['model_version']} trained in {card['training_seconds']}s."
            )
        )
