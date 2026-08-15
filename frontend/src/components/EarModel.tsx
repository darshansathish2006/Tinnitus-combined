/**
 * Embeddable 3D cochlea.
 *
 * Extracted from the education screen so the clinician console can show a
 * patient's own hair-cell map inside their case without a page change. The
 * teaching page owns the layer controls, the anatomy copy and the guided tour;
 * this is the viewport and nothing else.
 *
 * **Only ever mount one of these at a time.** Each instance is a WebGL context,
 * and browsers cap those at around 8-16 before they start silently discarding
 * the oldest — which in a caseload of twelve looks like random blank cards. The
 * console enforces that by expanding one row at a time; this component does its
 * half by tearing the scene down on unmount rather than leaving it parked.
 *
 * Three.js is ~500 kB, so the import is lazy: a clinician who never opens a case
 * never pays for it.
 */

import { useEffect, useRef, useState } from "react";
import { Chip, fmt } from "./ui";
import { IconEar } from "./icons";

interface Props {
  /** Threshold in dB HL keyed by frequency, from one ear. */
  thresholds?: Record<string, number>;
  pitchHz?: number | null;
  /** Which ear the thresholds came from — labelled, never guessed at. */
  ear?: string;
  height?: number;
  /** Off by default: motion beside a table of numbers is a distraction. */
  autoRotate?: boolean;
}

export default function EarModel({
  thresholds,
  pitchHz,
  ear,
  height = 260,
  autoRotate = false,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const node = mountRef.current;
    if (!node) return;

    let disposed = false;
    let scene: { dispose(): void; setAutoRotate(on: boolean): void } | null = null;

    // Imported inside the effect so the Three.js chunk is fetched when a case is
    // opened, not when the console loads.
    import("../three/EarScene")
      .then(({ EarScene }) => {
        // The effect can be torn down while the chunk is still in flight — a
        // clinician clicking through rows faster than the network. Building the
        // scene then would leak a WebGL context with nothing to unmount it.
        if (disposed || !mountRef.current) return;
        scene = new EarScene({
          container: mountRef.current,
          audiogram: thresholds,
          tinnitusHz: pitchHz ?? null,
        });
        scene.setAutoRotate(autoRotate);
        setReady(true);
      })
      .catch((error: unknown) => {
        // WebGL is unavailable on some remote-desktop and locked-down clinic
        // machines. That is a supported environment, not a crash: say so and
        // leave the rest of the case usable.
        setFailed(error instanceof Error ? error.message : "3D rendering is unavailable here.");
      });

    return () => {
      disposed = true;
      scene?.dispose();
      scene = null;
      setReady(false);
    };
  }, [thresholds, pitchHz, autoRotate]);

  if (!thresholds || Object.keys(thresholds).length === 0) {
    return (
      <div className="earmodel earmodel--empty" style={{ height }}>
        <IconEar size={26} />
        <p className="meta">No audiogram on file, so there is nothing to map onto the cochlea yet.</p>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="earmodel earmodel--empty" style={{ height }}>
        <IconEar size={26} />
        <p className="meta">{failed}</p>
      </div>
    );
  }

  return (
    <figure className="earmodel" style={{ height }}>
      <div ref={mountRef} className="earmodel__canvas" />
      {!ready && <span className="earmodel__loading meta">Building the cochlea…</span>}
      <figcaption className="earmodel__caption">
        {ear && <Chip tone="ghost">{fmt.titleCase(ear)} ear</Chip>}
        {pitchHz ? (
          <Chip tone="signal" dot>
            Percept {fmt.hzFull(pitchHz)}
          </Chip>
        ) : (
          <Chip tone="ghost">Pitch not matched</Chip>
        )}
        <span className="meta">Hair cells coloured by this patient's own thresholds</span>
      </figcaption>
    </figure>
  );
}
