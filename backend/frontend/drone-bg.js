/**
 * Slowly-rotating low-poly 3D drone rendered as a fixed full-screen
 * background behind the landing page. Purely decorative -- pointer-events
 * are disabled on the canvas (see landing.css) so it never blocks clicks
 * on the cards above it, and every card already has a solid background,
 * so this only shows through the hero area and the gaps between cards.
 */

(function () {
  if (typeof THREE === "undefined") return; // CDN failed to load -- fail silently, page still works fine without it

  const canvas = document.getElementById("drone-bg");
  if (!canvas) return;

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------------------------------------------------------------------
  // Scene / camera / renderer
  // ---------------------------------------------------------------------
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  camera.position.set(0, 1.4, 9);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,          // transparent -- the page's own dark background shows through
    antialias: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  // ---------------------------------------------------------------------
  // Lighting -- dim ambient + accent-colored point lights, matching the
  // app's green/cyan neon-on-dark palette
  // ---------------------------------------------------------------------
  scene.add(new THREE.AmbientLight(0x1a2530, 1.2));

  const greenLight = new THREE.PointLight(0x39ff88, 14, 20);
  greenLight.position.set(-4, 3, 4);
  scene.add(greenLight);

  const cyanLight = new THREE.PointLight(0x5ec8d8, 10, 20);
  cyanLight.position.set(4, -2, 3);
  scene.add(cyanLight);

  const rimLight = new THREE.DirectionalLight(0x8fa4b3, 0.6);
  rimLight.position.set(0, 5, -5);
  scene.add(rimLight);

  // ---------------------------------------------------------------------
  // Build a low-poly quadcopter procedurally out of primitives
  // ---------------------------------------------------------------------
  const drone = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x1a2128,
    metalness: 0.6,
    roughness: 0.35,
  });
  const armMat = new THREE.MeshStandardMaterial({
    color: 0x141a20,
    metalness: 0.5,
    roughness: 0.4,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: 0x39ff88,
    emissive: 0x39ff88,
    emissiveIntensity: 1.4,
    metalness: 0.2,
    roughness: 0.3,
  });
  const propMat = new THREE.MeshStandardMaterial({
    color: 0x2a333c,
    metalness: 0.3,
    roughness: 0.6,
    transparent: true,
    opacity: 0.55,
  });

  // Central body
  const body = new THREE.Mesh(new THREE.OctahedronGeometry(0.55, 0), bodyMat);
  body.scale.set(1, 0.5, 1);
  drone.add(body);

  // Small glowing accent core
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 16), accentMat);
  core.position.y = 0.02;
  drone.add(core);

  // Four arms + rotor hubs + spinning propellers
  const armLength = 1.5;
  const armPositions = [
    { x: 1, z: 1 },
    { x: -1, z: 1 },
    { x: 1, z: -1 },
    { x: -1, z: -1 },
  ];

  const propellers = []; // keep refs so the animation loop can spin them

  armPositions.forEach(({ x, z }) => {
    const angle = Math.atan2(z, x);

    // Arm (a thin box reaching out from the center)
    const arm = new THREE.Mesh(
      new THREE.BoxGeometry(armLength, 0.08, 0.08),
      armMat
    );
    arm.position.set((x * armLength) / 2, 0, (z * armLength) / 2);
    arm.rotation.y = -angle;
    drone.add(arm);

    // Rotor hub at the end of the arm
    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.16, 0.18, 12),
      armMat
    );
    hub.position.set(x * armLength, 0.05, z * armLength);
    drone.add(hub);

    // Small accent ring on each hub
    const hubGlow = new THREE.Mesh(
      new THREE.TorusGeometry(0.17, 0.02, 8, 16),
      accentMat
    );
    hubGlow.position.copy(hub.position);
    hubGlow.rotation.x = Math.PI / 2;
    drone.add(hubGlow);

    // Propeller (two thin blades crossed) -- spins independently
    const propGroup = new THREE.Group();
    propGroup.position.set(x * armLength, 0.16, z * armLength);

    const blade1 = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.02, 0.09), propMat);
    const blade2 = blade1.clone();
    blade2.rotation.y = Math.PI / 2;
    propGroup.add(blade1, blade2);

    drone.add(propGroup);
    propellers.push(propGroup);
  });

  // Slight tilt so it doesn't read as perfectly flat/top-down
  drone.rotation.x = 0.18;
  drone.position.set(3.8, 0.5, -1.5); // offset further to the right, and placed slightly higher
  scene.add(drone);

  // ---------------------------------------------------------------------
  // Animation loop
  // ---------------------------------------------------------------------
  const clock = new THREE.Clock();

  function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();

    if (!prefersReducedMotion) {
      drone.rotation.y = t * 0.25;                 // slow turntable rotation
      drone.position.y = 0.5 + Math.sin(t * 0.8) * 0.15; // gentle hover bob
      propellers.forEach((p, i) => {
        p.rotation.y += 0.55 + i * 0.03;            // fast propeller spin
      });
    }

    renderer.render(scene, camera);
  }
  animate();

  // ---------------------------------------------------------------------
  // Handle resize
  // ---------------------------------------------------------------------
  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
})();
