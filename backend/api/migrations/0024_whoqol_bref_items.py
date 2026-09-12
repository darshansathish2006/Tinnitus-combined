from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0023_vas_pain'),
    ]

    operations = [
        migrations.AddField(
            model_name='assessment',
            name='whoqol_bref_items',
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
