"""Patient education content for the interactive 3D ear model.

Separated from the views so a clinician can review and edit what patients are told
without touching request handling.
"""

from __future__ import annotations

from typing import Any

EAR_MODEL_LAYERS: list[dict[str, Any]] = [
    {
        "key": "outer",
        "title": "Outer ear",
        "structures": ["Pinna", "Ear canal", "Tympanic membrane"],
        "body": "The pinna funnels sound into the ear canal, which resonates around 2-4 kHz and "
        "amplifies exactly the frequencies that carry speech. The eardrum converts that pressure "
        "wave into mechanical movement. Almost nothing here causes tinnitus - but wax occluding the "
        "canal can make an existing tinnitus suddenly much louder, which is why an otoscopy comes first.",
        "tinnitus_relevance": "low",
        "camera": {"target": [-2.4, 0, 0], "distance": 5.0},
    },
    {
        "key": "middle",
        "title": "Middle ear",
        "structures": ["Malleus", "Incus", "Stapes", "Eustachian tube", "Stapedius muscle"],
        "body": "Three of the smallest bones in your body act as a lever, matching the low impedance "
        "of air to the high impedance of cochlear fluid - a gain of roughly 30 dB. Middle-ear problems "
        "produce conductive hearing loss and can cause a pulsatile or clicking tinnitus. Involuntary "
        "contraction of the middle-ear muscles produces middle ear myoclonus, which is one of the rare "
        "genuinely objective tinnituses.",
        "tinnitus_relevance": "moderate",
        "camera": {"target": [-0.9, 0.15, 0], "distance": 3.6},
    },
    {
        "key": "cochlea",
        "title": "Cochlea",
        "structures": ["Basilar membrane", "Organ of Corti", "Scala vestibuli", "Scala tympani"],
        "body": "A fluid-filled spiral of two and a half turns that performs a mechanical Fourier "
        "transform. The basilar membrane is stiff and narrow at the base, where it responds to high "
        "frequencies, and floppy and wide at the apex for low frequencies. This tonotopic map is "
        "preserved all the way to the auditory cortex - which is why a specific frequency of hearing "
        "loss produces a tinnitus at a specific pitch.",
        "tinnitus_relevance": "high",
        "camera": {"target": [1.6, -0.2, 0], "distance": 3.2},
    },
    {
        "key": "hair_cells",
        "title": "Hair cells",
        "structures": ["Outer hair cells", "Inner hair cells", "Stereocilia", "Tectorial membrane"],
        "body": "Around 12,000 outer hair cells act as active amplifiers, and 3,500 inner hair cells "
        "do the actual transduction. Their stereocilia open ion channels when they bend. They do not "
        "regenerate in humans. Noise and ageing destroy the high-frequency cells at the cochlear base "
        "first - and the region of dead cells is the region your tinnitus pitch will match.",
        "tinnitus_relevance": "critical",
        "camera": {"target": [1.6, -0.2, 0], "distance": 1.9},
    },
    {
        "key": "nerve",
        "title": "Auditory nerve and central pathway",
        "structures": ["Spiral ganglion", "Cochlear nerve", "Cochlear nucleus", "Inferior colliculus",
                       "Auditory cortex"],
        "body": "Roughly 30,000 fibres carry the signal to the cochlear nucleus, then up through the "
        "brainstem to the auditory cortex. Two things happen here that create tinnitus. First, when "
        "input from a damaged frequency region falls, central neurons increase their gain to "
        "compensate - and amplify their own spontaneous activity. Second, the deprived cortical region "
        "gets taken over by neighbouring frequencies and the neurons there start firing in abnormal "
        "synchrony. Your tinnitus is that synchronous activity being read as sound.",
        "tinnitus_relevance": "critical",
        "camera": {"target": [3.4, 0.6, 0], "distance": 4.2},
    },
    {
        "key": "somatosensory",
        "title": "Somatosensory convergence",
        "structures": ["Trigeminal ganglion", "Dorsal cochlear nucleus", "Cervical dorsal roots"],
        "body": "Sensory nerves from your jaw, face and upper neck converge with auditory pathways in "
        "the dorsal cochlear nucleus. This is why around two thirds of patients can change their "
        "tinnitus by clenching their jaw or turning their head, and why physiotherapy and dental "
        "treatment help that subgroup. It is also the anatomical basis for bimodal stimulation "
        "therapy, which pairs sound with touch to drive plasticity.",
        "tinnitus_relevance": "high",
        "camera": {"target": [2.6, -1.2, 0], "distance": 4.4},
    },
    {
        "key": "therapy",
        "title": "How sound therapy acts",
        "structures": ["Tonotopic map", "Lateral inhibition", "Central gain control"],
        "body": "Notched sound therapy removes energy at your tinnitus frequency while stimulating "
        "everything around it. The surrounding regions become more active and laterally inhibit the "
        "tinnitus region, while the absence of input at the notch stops reinforcing the reorganised "
        "map. Broadband enrichment works differently: by removing silence it reduces the contrast the "
        "percept stands out against, letting central gain fall back down. Neither approach needs to "
        "cover the sound, which is why we set the level at the mixing point rather than turning it up.",
        "tinnitus_relevance": "critical",
        "camera": {"target": [2.0, 0.2, 0], "distance": 6.0},
    },
    {
        "key": "protection",
        "title": "Protecting what you have",
        "structures": ["Stereocilia", "Metabolic exhaustion", "Synaptopathy"],
        "body": "Noise damage happens two ways: mechanical shearing of stereocilia, and metabolic "
        "exhaustion from sustained overstimulation. Cochlear synaptopathy - loss of the synapses "
        "between hair cells and nerve fibres - happens before any threshold shift shows on an "
        "audiogram, which is why 'my hearing test was normal' does not mean no damage occurred. "
        "85 dB is safe for about 8 hours; every 3 dB above that halves the safe duration.",
        "tinnitus_relevance": "high",
        "camera": {"target": [0, 0, 0], "distance": 7.0},
    },
]
