/**
 * Procedural 3D ear model.
 *
 * Built entirely from parametric geometry — no model file to download, so the
 * education screen works offline like everything else.
 *
 * The scientifically interesting part is the cochlea. Hair-cell markers are placed
 * along the spiral and mapped to frequency using the **Greenwood function**, the
 * established cochlear frequency-position relationship:
 *
 *     f(x) = A * (10^(a·x) - k),   A = 165.4, a = 2.1, k = 0.88
 *
 * where x is normalised distance from the apex. That means each marker sits at the
 * place in the cochlea that genuinely responds to its frequency — so colouring the
 * markers by the patient's own audiometric thresholds shows them where their
 * hearing loss physically is, and the tinnitus marker lands in the damaged region
 * rather than somewhere decorative. That correspondence is the entire teaching
 * point of the screen.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { greenwoodFrequency, greenwoodPosition, interpolateThreshold } from "../lib/cochlea";

export { greenwoodFrequency, greenwoodPosition } from "../lib/cochlea";

export interface EarSceneOptions {
  container: HTMLElement;
  /** Threshold in dB HL per frequency, used to colour the hair cells. */
  audiogram?: Record<string, number>;
  tinnitusHz?: number | null;
  onPick?(key: string | null): void;
}

interface Layer {
  key: string;
  group: THREE.Group;
}

/**
 * Palette tuned for the dark canvas: structures are lit, saturated and slightly
 * emissive so they read against near-black, rather than the pale anatomical
 * tones that only work on paper.
 *
 * Hair-cell colouring is the important part — mint for healthy, gold for mild
 * loss, coral for significant loss — and the patient's own tinnitus frequency is
 * marked in white so it cannot be confused with any threshold colour.
 */
const COLORS = {
  bone: 0xcfd8dc,
  boneDark: 0x9fb0b6,
  membrane: 0xe0836a,
  fluid: 0x2fb9a0,
  cochleaShell: 0x8fb3bb,
  nerve: 0xffc46b,
  brain: 0xc79bb0,
  healthy: 0x3ee0b0,
  mild: 0xffc46b,
  severe: 0xff6b7d,
  tinnitus: 0xffffff,
  signal: 0x3ee0b0,
};

export class EarScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private layers = new Map<string, Layer>();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private frame = 0;
  private disposed = false;
  private clock = new THREE.Clock();
  private travellingWave: THREE.Mesh[] = [];
  private tinnitusMarker: THREE.Mesh | null = null;
  private container: HTMLElement;
  private onPick?: (key: string | null) => void;
  private resizeObserver: ResizeObserver;

  constructor(options: EarSceneOptions) {
    this.container = options.container;
    this.onPick = options.onPick;

    const width = this.container.clientWidth || 720;
    const height = this.container.clientHeight || 460;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = false;
    this.container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 200);
    this.camera.position.set(2.2, 2.6, 9.4);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.6;
    this.controls.maxDistance = 22;
    this.controls.target.set(0.4, 0, 0);

    this.buildLighting();
    this.buildOuterEar();
    this.buildMiddleEar();
    this.buildCochlea(options.audiogram, options.tinnitusHz);
    this.buildNerve();

    this.renderer.domElement.addEventListener("pointerdown", this.handlePointer);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);

    this.animate();
  }

  /* -- lighting ----------------------------------------------------------- */
  private buildLighting(): void {
    // Studio lighting for a dark room: a cool key, a mint rim to pick out
    // silhouettes against the near-black canvas, and a warm fill underneath so
    // the underside of the cochlea does not go solid black.
    this.scene.add(new THREE.AmbientLight(0xbfe6de, 0.5));

    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(5, 7, 6);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x3ee0b0, 1.1);
    rim.position.set(-6, 2, -5);
    this.scene.add(rim);

    const fill = new THREE.PointLight(0xff9a86, 0.7, 26);
    fill.position.set(1.5, -3, 4);
    this.scene.add(fill);

    const top = new THREE.PointLight(0x6fc7ff, 0.5, 30);
    top.position.set(0, 6, -4);
    this.scene.add(top);
  }

  private material(color: number, options: Partial<THREE.MeshStandardMaterialParameters> = {}) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.05, ...options });
  }

  private layer(key: string): THREE.Group {
    const existing = this.layers.get(key);
    if (existing) return existing.group;
    const group = new THREE.Group();
    group.userData.layerKey = key;
    this.scene.add(group);
    this.layers.set(key, { key, group });
    return group;
  }

  /* -- outer ear ---------------------------------------------------------- */
  private buildOuterEar(): void {
    const group = this.layer("outer");

    // Pinna: a lathe profile swept into a shell, then flattened and tilted so it
    // reads as an ear rather than a bowl.
    const profile: THREE.Vector2[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const radius = 0.18 + 1.05 * Math.sin(Math.PI * t) ** 1.35;
      profile.push(new THREE.Vector2(radius, -1.35 + 2.7 * t));
    }
    const pinna = new THREE.Mesh(
      new THREE.LatheGeometry(profile, 48, 0, Math.PI * 1.35),
      this.material(COLORS.membrane, { roughness: 0.78, side: THREE.DoubleSide })
    );
    pinna.rotation.set(0, Math.PI * 0.5, 0);
    pinna.scale.set(0.62, 1, 1);
    pinna.position.set(-3.5, 0, 0);
    pinna.userData = { key: "outer", label: "Pinna" };
    group.add(pinna);

    // Helix rim: a torus arc thickening the outer edge.
    const helix = new THREE.Mesh(
      new THREE.TorusGeometry(1.16, 0.13, 12, 40, Math.PI * 1.3),
      this.material(COLORS.membrane, { roughness: 0.8 })
    );
    helix.rotation.set(0, Math.PI / 2, Math.PI * 0.12);
    helix.position.set(-3.52, 0.05, 0);
    helix.scale.set(1, 1, 0.62);
    helix.userData = { key: "outer", label: "Helix" };
    group.add(helix);

    // Ear canal: slightly curved, as it is in life.
    const canalCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-3.3, 0, 0),
      new THREE.Vector3(-2.6, -0.12, 0.1),
      new THREE.Vector3(-1.9, -0.05, 0.05),
      new THREE.Vector3(-1.45, 0, 0),
    ]);
    const canal = new THREE.Mesh(
      new THREE.TubeGeometry(canalCurve, 40, 0.29, 20, false),
      this.material(COLORS.membrane, { roughness: 0.85, transparent: true, opacity: 0.62 })
    );
    canal.userData = { key: "outer", label: "Ear canal" };
    group.add(canal);

    // Tympanic membrane: a shallow cone, pointing inward like the real drum.
    const drum = new THREE.Mesh(
      new THREE.ConeGeometry(0.31, 0.16, 32),
      this.material(0xe8d9c0, { roughness: 0.35, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
    );
    drum.rotation.z = Math.PI / 2;
    drum.position.set(-1.4, 0, 0);
    drum.userData = { key: "middle", label: "Tympanic membrane" };
    group.add(drum);
  }

  /* -- middle ear --------------------------------------------------------- */
  private buildMiddleEar(): void {
    const group = this.layer("middle");
    const bone = this.material(COLORS.bone, { roughness: 0.42, metalness: 0.1 });

    // Malleus (hammer): handle against the drum plus a head.
    const malleusHandle = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.42, 6, 12), bone);
    malleusHandle.rotation.z = Math.PI * 0.42;
    malleusHandle.position.set(-1.22, 0.06, 0);
    malleusHandle.userData = { key: "middle", label: "Malleus (hammer)" };
    group.add(malleusHandle);

    const malleusHead = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), bone);
    malleusHead.position.set(-1.03, 0.22, 0);
    malleusHead.userData = { key: "middle", label: "Malleus head" };
    group.add(malleusHead);

    // Incus (anvil).
    const incus = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), bone);
    incus.scale.set(1, 0.78, 0.82);
    incus.position.set(-0.82, 0.2, 0);
    incus.userData = { key: "middle", label: "Incus (anvil)" };
    group.add(incus);

    const incusProcess = new THREE.Mesh(new THREE.CapsuleGeometry(0.038, 0.26, 6, 10), bone);
    incusProcess.rotation.z = -Math.PI * 0.28;
    incusProcess.position.set(-0.7, 0.08, 0);
    incusProcess.userData = { key: "middle", label: "Incus long process" };
    group.add(incusProcess);

    // Stapes (stirrup): the smallest bone in the body, with its footplate on the
    // oval window.
    const stapesArch = new THREE.Mesh(
      new THREE.TorusGeometry(0.085, 0.022, 8, 20, Math.PI),
      this.material(COLORS.boneDark, { roughness: 0.4, metalness: 0.12 })
    );
    stapesArch.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    stapesArch.position.set(-0.56, -0.02, 0);
    stapesArch.userData = { key: "middle", label: "Stapes (stirrup)" };
    group.add(stapesArch);

    const footplate = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075, 0.075, 0.022, 18),
      this.material(COLORS.boneDark, { roughness: 0.35 })
    );
    footplate.rotation.z = Math.PI / 2;
    footplate.position.set(-0.47, -0.02, 0);
    footplate.userData = { key: "middle", label: "Stapes footplate / oval window" };
    group.add(footplate);

    // Eustachian tube.
    const tubeCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.9, -0.3, 0.1),
      new THREE.Vector3(-1.3, -0.9, 0.3),
      new THREE.Vector3(-1.9, -1.5, 0.5),
    ]);
    const eustachian = new THREE.Mesh(
      new THREE.TubeGeometry(tubeCurve, 24, 0.1, 12, false),
      this.material(COLORS.membrane, { roughness: 0.85, transparent: true, opacity: 0.5 })
    );
    eustachian.userData = { key: "middle", label: "Eustachian tube" };
    group.add(eustachian);
  }

  /* -- cochlea ------------------------------------------------------------ */
  private buildCochlea(audiogram?: Record<string, number>, tinnitusHz?: number | null): void {
    const group = this.layer("cochlea");
    const hairGroup = this.layer("hair_cells");

    const turns = 2.6;
    const points: THREE.Vector3[] = [];
    const segments = 300;
    // Base is wide and near the oval window; the spiral narrows toward the apex.
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const angle = t * Math.PI * 2 * turns;
      const radius = 1.06 * (1 - 0.68 * t);
      points.push(new THREE.Vector3(0.55 + radius * Math.cos(angle), radius * Math.sin(angle) * 0.86, t * 0.72));
    }
    const curve = new THREE.CatmullRomCurve3(points);

    // Outer bony shell, translucent so the basilar membrane is visible inside.
    const shell = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 260, 0.2, 18, false),
      this.material(COLORS.cochleaShell, {
        roughness: 0.5,
        transparent: true,
        opacity: 0.28,
        side: THREE.DoubleSide,
      })
    );
    shell.userData = { key: "cochlea", label: "Cochlea (bony labyrinth)" };
    group.add(shell);

    // Basilar membrane running the length of the duct.
    const membrane = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 260, 0.075, 12, false),
      this.material(COLORS.fluid, { roughness: 0.35, emissive: 0x0d2a30, emissiveIntensity: 0.35 })
    );
    membrane.userData = { key: "cochlea", label: "Basilar membrane" };
    group.add(membrane);

    /* -- hair cells, positioned by the Greenwood function ------------------ */
    const count = 72;
    for (let i = 0; i < count; i++) {
      // x = 0 at the base (high frequency, near the oval window) to 1 at the apex.
      const along = i / (count - 1);
      // Greenwood x is measured from the apex, so invert.
      const freq = greenwoodFrequency(1 - along);
      const point = curve.getPointAt(along);
      const tangent = curve.getTangentAt(along);

      const threshold = audiogram ? interpolateThreshold(audiogram, freq) : null;
      const color = thresholdColor(threshold);

      const cell = new THREE.Mesh(
        new THREE.BoxGeometry(0.035, 0.115, 0.035),
        new THREE.MeshStandardMaterial({
          color,
          roughness: 0.45,
          emissive: color,
          emissiveIntensity: threshold !== null && threshold >= 40 ? 0.05 : 0.28,
        })
      );
      // Stand the cell up off the membrane, oriented along the duct.
      const normal = new THREE.Vector3(0, 0, 1).cross(tangent).normalize();
      cell.position.copy(point).addScaledVector(normal, 0.085);
      cell.lookAt(point.clone().addScaledVector(normal, 1));
      cell.userData = {
        key: "hair_cells",
        label: `${freq >= 1000 ? `${(freq / 1000).toFixed(1)} kHz` : `${Math.round(freq)} Hz`}${
          threshold !== null ? ` · ${Math.round(threshold)} dB HL` : ""
        }`,
        freq,
      };
      hairGroup.add(cell);
      this.travellingWave.push(cell);
    }

    /* -- the patient's tinnitus frequency --------------------------------- */
    if (tinnitusHz) {
      const x = Math.max(0, Math.min(1, greenwoodPosition(tinnitusHz)));
      const along = Math.max(0, Math.min(1, 1 - x));
      const point = curve.getPointAt(along);

      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 20, 16),
        new THREE.MeshStandardMaterial({
          color: COLORS.tinnitus,
          emissive: COLORS.tinnitus,
          emissiveIntensity: 1.4,
          roughness: 0.2,
        })
      );
      marker.position.copy(point);
      marker.userData = {
        key: "hair_cells",
        label: `Your tinnitus: ${Math.round(tinnitusHz)} Hz`,
      };
      hairGroup.add(marker);
      this.tinnitusMarker = marker;

      // A ring highlighting the affected stretch of the cochlea.
      const halo = new THREE.Mesh(
        new THREE.TorusGeometry(0.28, 0.02, 8, 32),
        new THREE.MeshBasicMaterial({ color: COLORS.signal, transparent: true, opacity: 0.7 })
      );
      halo.position.copy(point);
      halo.lookAt(this.camera.position);
      hairGroup.add(halo);
    }

    // Vestibular system, for anatomical context.
    const vestibular = this.layer("cochlea");
    for (const rotation of [
      new THREE.Euler(0, 0, 0),
      new THREE.Euler(Math.PI / 2, 0, 0),
      new THREE.Euler(0, Math.PI / 2, Math.PI / 3),
    ]) {
      const canal = new THREE.Mesh(
        new THREE.TorusGeometry(0.44, 0.055, 10, 30),
        this.material(COLORS.cochleaShell, { roughness: 0.55, transparent: true, opacity: 0.42 })
      );
      canal.rotation.copy(rotation);
      canal.position.set(0.65, 1.05, 0.5);
      canal.userData = { key: "cochlea", label: "Semicircular canal (balance)" };
      vestibular.add(canal);
    }
  }

  /* -- auditory nerve ----------------------------------------------------- */
  private buildNerve(): void {
    const group = this.layer("nerve");

    const nerveCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.6, 0, 0.15),
      new THREE.Vector3(1.7, 0.25, 0.1),
      new THREE.Vector3(2.7, 0.6, 0),
      new THREE.Vector3(3.5, 1.15, -0.1),
    ]);
    const nerve = new THREE.Mesh(
      new THREE.TubeGeometry(nerveCurve, 60, 0.14, 14, false),
      this.material(COLORS.nerve, { roughness: 0.55, emissive: 0x3a2f10, emissiveIntensity: 0.2 })
    );
    nerve.userData = { key: "nerve", label: "Cochlear (auditory) nerve" };
    group.add(nerve);

    // Individual fibres fanning out of the spiral ganglion.
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      const fibre = new THREE.Mesh(
        new THREE.TubeGeometry(
          new THREE.CatmullRomCurve3([
            new THREE.Vector3(0.55 + Math.cos(t * Math.PI * 2) * 0.5, Math.sin(t * Math.PI * 2) * 0.45, 0.2),
            new THREE.Vector3(1.1, 0.15 + t * 0.1, 0.15),
            new THREE.Vector3(1.7, 0.25, 0.1),
          ]),
          20,
          0.022,
          8,
          false
        ),
        this.material(COLORS.nerve, { roughness: 0.6 })
      );
      fibre.userData = { key: "nerve", label: "Spiral ganglion fibre" };
      group.add(fibre);
    }

    // Brainstem nuclei up to cortex, as stacked relay stations.
    const stations: [string, THREE.Vector3, number][] = [
      ["Cochlear nucleus", new THREE.Vector3(3.6, 1.2, -0.1), 0.3],
      ["Inferior colliculus", new THREE.Vector3(4.3, 1.95, -0.15), 0.26],
      ["Auditory cortex", new THREE.Vector3(5.0, 2.7, -0.2), 0.42],
    ];
    for (const [label, position, radius] of stations) {
      const node = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 20, 16),
        this.material(COLORS.brain, { roughness: 0.75 })
      );
      node.position.copy(position);
      node.userData = { key: "nerve", label };
      group.add(node);
    }
    const tract = new THREE.Mesh(
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(stations.map(([, position]) => position)),
        30,
        0.075,
        10,
        false
      ),
      this.material(COLORS.nerve, { roughness: 0.6 })
    );
    tract.userData = { key: "nerve", label: "Ascending auditory pathway" };
    group.add(tract);

    // Somatosensory convergence: trigeminal input meeting the cochlear nucleus.
    const somato = this.layer("somatosensory");
    const trigeminal = new THREE.Mesh(
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([
          new THREE.Vector3(1.6, -2.3, 0.6),
          new THREE.Vector3(2.6, -1.2, 0.3),
          new THREE.Vector3(3.5, 1.05, -0.05),
        ]),
        30,
        0.075,
        10,
        false
      ),
      this.material(0xb98fa8, { roughness: 0.6, emissive: 0x2a1220, emissiveIntensity: 0.25 })
    );
    trigeminal.userData = { key: "somatosensory", label: "Trigeminal / cervical input" };
    somato.add(trigeminal);

    const ganglion = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), this.material(0xb98fa8, { roughness: 0.6 }));
    ganglion.position.set(1.6, -2.3, 0.6);
    ganglion.userData = { key: "somatosensory", label: "Trigeminal ganglion (jaw and neck)" };
    somato.add(ganglion);
  }

  /* -- interaction -------------------------------------------------------- */
  private handlePointer = (event: PointerEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.scene.children, true);
    const hit = hits.find((h) => (h.object as THREE.Mesh).userData?.label);
    this.onPick?.(hit ? String((hit.object as THREE.Mesh).userData.label) : null);
  };

  /** Show or hide an anatomical layer. */
  setLayerVisible(key: string, visible: boolean): void {
    const layer = this.layers.get(key);
    if (layer) layer.group.visible = visible;
  }

  /** Move the camera to a named layer's framing. */
  focus(target: [number, number, number], distance: number): void {
    const to = new THREE.Vector3(...target);
    this.controls.target.copy(to);
    const direction = new THREE.Vector3(0.42, 0.34, 1).normalize();
    this.camera.position.copy(to).addScaledVector(direction, distance);
    this.controls.update();
  }

  setAutoRotate(enabled: boolean): void {
    this.controls.autoRotate = enabled;
    this.controls.autoRotateSpeed = 0.7;
  }

  /**
   * Animate a travelling wave along the basilar membrane. This is what makes the
   * tonotopic map legible: the bulge moves from base to apex and peaks at the
   * place matching the driving frequency, which is exactly how the cochlea
   * performs its frequency analysis.
   */
  private animateTravellingWave(elapsed: number): void {
    const speed = 0.45;
    const phase = (elapsed * speed) % 1.6;
    for (let i = 0; i < this.travellingWave.length; i++) {
      const cell = this.travellingWave[i];
      const along = i / (this.travellingWave.length - 1);
      const distance = Math.abs(along - (phase - 0.3));
      const envelope = Math.exp(-(distance * distance) / 0.012);
      cell.scale.setY(1 + envelope * 1.5);
    }
    if (this.tinnitusMarker) {
      this.tinnitusMarker.scale.setScalar(1 + 0.14 * Math.sin(elapsed * 2.6));
    }
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.animate);
    const elapsed = this.clock.getElapsedTime();
    this.animateTravellingWave(elapsed);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private resize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener("pointerdown", this.handlePointer);
    this.controls.dispose();
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/* ------------------------------------------------------------------------- */
function thresholdColor(threshold: number | null): number {
  if (threshold === null) return COLORS.healthy;
  if (threshold < 20) return COLORS.healthy;
  if (threshold < 40) return COLORS.mild;
  return COLORS.severe;
}
