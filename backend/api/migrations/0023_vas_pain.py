from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0022_phq9_fields'),
    ]

    operations = [
        migrations.AddField(
            model_name='assessment',
            name='vas_pain',
            field=models.FloatField(blank=True, null=True),
        ),
    ]
