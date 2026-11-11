/** Shows a glTF board model in a WebGL canvas with orbit controls. Three.js loads on first use. */
import type { PerspectiveCamera, Scene, WebGLRenderer } from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { observeResize } from "~/lib/observeResize";

export type ModelView = "angle" | "top" | "bottom";

interface Stage {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Largest dimension of the board, which sets the viewing distance. */
  readonly size: number;
}

function decodeBase64(text: string): ArrayBuffer {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

export class ModelController {
  private stage: Stage | undefined;
  private destroyed = false;
  private frame = 0;
  private readonly stopObserving: () => void;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    glb: string,
    private readonly onState: (state: "ready" | "failed") => void,
  ) {
    this.stopObserving = observeResize(canvas, () => this.resize());
    void this.load(glb);
  }

  destroy(): void {
    this.destroyed = true;
    this.stopObserving();
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.stage?.controls.dispose();
    this.stage?.renderer.dispose();
    this.stage = undefined;
  }

  look(view: ModelView): void {
    const stage = this.stage;
    if (!stage) return;
    const distance = stage.size * 1.5;
    // The board lies flat with Y up, so "top" looks straight down on the front copper.
    const position =
      view === "top"
        ? ([0, distance, 0.001] as const)
        : view === "bottom"
          ? ([0, -distance, 0.001] as const)
          : ([distance * 0.45, distance * 0.7, distance * 0.75] as const);
    stage.camera.position.set(...position);
    stage.controls.target.set(0, 0, 0);
    stage.controls.update();
    this.schedule();
  }

  private async load(glb: string): Promise<void> {
    try {
      const [three, { GLTFLoader }, { OrbitControls }] = await Promise.all([
        import("three"),
        import("three/examples/jsm/loaders/GLTFLoader.js"),
        import("three/examples/jsm/controls/OrbitControls.js"),
      ]);
      const gltf = await new GLTFLoader().parseAsync(decodeBase64(glb), "");
      if (this.destroyed) return;
      const renderer = new three.WebGLRenderer({
        canvas: this.canvas,
        antialias: true,
        alpha: true,
      });
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      const scene = new three.Scene();
      const model = gltf.scene;
      // Lay the board flat: its thinnest axis becomes Y, whatever the exporter chose.
      const box = new three.Box3().setFromObject(model);
      const extent = box.getSize(new three.Vector3());
      if (extent.z < extent.y && extent.z < extent.x) model.rotation.x = -Math.PI / 2;
      else if (extent.x < extent.y && extent.x < extent.z) model.rotation.z = Math.PI / 2;
      const pivot = new three.Group();
      pivot.add(model);
      const placed = new three.Box3().setFromObject(pivot);
      pivot.position.sub(placed.getCenter(new three.Vector3()));
      scene.add(pivot);
      const size = Math.max(...placed.getSize(new three.Vector3()).toArray(), 1e-6);

      scene.add(new three.HemisphereLight(0xffffff, 0x556070, 1.6));
      const key = new three.DirectionalLight(0xffffff, 2.2);
      key.position.set(size, size * 2, size);
      const fill = new three.DirectionalLight(0xffffff, 0.9);
      fill.position.set(-size, -size * 1.5, -size);
      scene.add(key, fill);

      const camera = new three.PerspectiveCamera(35, 1, size / 500, size * 50);
      const controls = new OrbitControls(camera, this.canvas);
      controls.enableDamping = false;
      controls.minDistance = size * 0.15;
      controls.maxDistance = size * 8;
      controls.addEventListener("change", () => this.schedule());
      this.stage = { renderer, scene, camera, controls, size };
      this.resize();
      this.look("angle");
      this.onState("ready");
    } catch {
      if (!this.destroyed) this.onState("failed");
    }
  }

  private resize(): void {
    const stage = this.stage;
    if (!stage) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    stage.renderer.setSize(rect.width, rect.height, false);
    stage.camera.aspect = rect.width / rect.height;
    stage.camera.updateProjectionMatrix();
    this.schedule();
  }

  private schedule(): void {
    if (this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const stage = this.stage;
      if (stage) stage.renderer.render(stage.scene, stage.camera);
    });
  }
}
