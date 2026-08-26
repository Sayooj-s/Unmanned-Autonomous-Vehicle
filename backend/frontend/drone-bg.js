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
  let mouseX = 0;
  let mouseY = 0;
  let targetX = 0;
  let targetY = 0;

  const windowHalfX = window.innerWidth / 2;
  const windowHalfY = window.innerHeight / 2;

  document.addEventListener('mousemove', (event) => {
    mouseX = (event.clientX - windowHalfX);
    mouseY = (event.clientY - windowHalfY);
  });
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
    color: 0x0a0c10,
    metalness: 0.85,
    roughness: 0.15,
  });
  const armMat = new THREE.MeshStandardMaterial({
    color: 0x050608,
    metalness: 0.9,
    roughness: 0.25,
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

  let baseDroneY = 0;

  function updateDronePosition() {
    if (window.innerWidth <= 768) {
      // On mobile, center the drone
      drone.position.set(0, 0, -2); 
      baseDroneY = 0;
    } else {
      drone.position.set(0, 0, 0); // Center on screen
      baseDroneY = 0;
    }
  }
  updateDronePosition();

  // Make the drone larger
  drone.scale.set(3, 3, 3);

  scene.add(drone);

  // ---------------------------------------------------------------------
  // Animation loop
  // ---------------------------------------------------------------------
  const clock = new THREE.Clock();

  function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();

    targetX = mouseX * 0.001;
    targetY = mouseY * 0.001;

    if (!prefersReducedMotion) {
      drone.rotation.y = (t * 0.15) + (targetX * 0.5);                 // slow turntable rotation + mouse
      drone.rotation.x = 0.18 + (targetY * 0.5);                       // base tilt + mouse
      drone.position.y = baseDroneY + Math.sin(t * 0.8) * 0.15 - (targetY * 0.5); // gentle hover bob + mouse
      drone.position.x = targetX * 1.5;                                // subtle parallax
      
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
    updateDronePosition();
  });
})();
