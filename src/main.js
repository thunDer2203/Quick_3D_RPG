import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.118.1/build/three.module.js';

import {third_person_camera} from './third-person-camera.js';
import {entity_manager} from './entity-manager.js';
import {player_entity} from './player-entity.js';
import {entity} from './entity.js';
import {gltf_component} from './gltf-component.js';
import {health_component} from './health-component.js';
import {player_input} from './player-input.js';
import {npc_entity} from './npc-entity.js';
import {math} from './math.js';
import {spatial_hash_grid} from './spatial-hash-grid.js';
import {ui_controller} from './ui-controller.js';
import {health_bar} from './health-bar.js';
import {level_up_component} from './level-up-component.js';
import {quest_component} from './quest-component.js';
import {spatial_grid_controller} from './spatial-grid-controller.js';
import {inventory_controller} from './inventory-controller.js';
import {equip_weapon_component} from './equip-weapon-component.js';
import {attack_controller} from './attacker-controller.js';


const _VS = `
varying vec3 vWorldPosition;

void main() {
  vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
  vWorldPosition = worldPosition.xyz;

  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;


const _FS = `
uniform vec3 topColor;
uniform vec3 bottomColor;
uniform float offset;
uniform float exponent;

varying vec3 vWorldPosition;

void main() {
  float h = normalize( vWorldPosition + offset ).y;
  gl_FragColor = vec4( mix( bottomColor, topColor, max( pow( max( h , 0.0), exponent ), 0.0 ) ), 1.0 );
}`;

// ----------------- thin grass shaders (item 1) -----------------
const grassVertex = `
uniform float time;
varying float vY;
varying vec2 vUv;

void main() {
  vUv = uv;
  vY = position.y;

  // world translation of this mesh (used to offset wind for each grass patch)
  vec3 worldPos = (modelMatrix * vec4(position, 1.0)).xyz;

  // compute a wind-based sway using time + mesh world position
  float wind = sin(time * 2.0 + worldPos.x * 0.02 + worldPos.z * 0.02);

  // amplitude scaled by vertex height (top of blade moves more)
  float amplitude = 0.15; // max horizontal offset
  float sway = wind * amplitude * (position.y / 3.0); // height normalizer (blade height = 3)

  // apply sway as a small X-offset (local space)
  vec3 pos = position;
  pos.x += sway;

  // optionally add a tiny twist using UV or Y
  float twist = sin(time * 1.8 + worldPos.z * 0.01) * 0.02 * (position.y / 3.0);
  pos.z += twist;

  // standard transform
  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
}
`;

const grassFragment = `
varying float vY;
varying vec2 vUv;

void main() {
  // simple vertical color gradient (darker at base, lighter at tip)
  vec3 base = vec3(0.12, 0.35, 0.08);   // dark green
  vec3 tip  = vec3(0.55, 0.85, 0.45);   // light green

  float t = smoothstep(0.0, 3.0, vY);  // blade height is ~3.0
  vec3 color = mix(base, tip, t);

  // slight vignette on edges using UV to help alpha feel natural (no texture here)
  float alpha = 1.0;
  float edge = smoothstep(0.0, 0.45, abs(vUv.x - 0.5));
  alpha *= 1.0 - edge * 0.9;

  gl_FragColor = vec4(color, alpha);
}
`;
// -------------------------------------------------------

class HackNSlashDemo {
  constructor() {
    this._Initialize();

    document.getElementById('btn-morning').addEventListener('click', () => {
      this.setEnvironmentMode('morning');
    });
    document.getElementById('btn-night').addEventListener('click', () => {
      this.setEnvironmentMode('night');
    });
  }

    


  _Initialize() {
    this._threejs = new THREE.WebGLRenderer({
      antialias: true,
    });
    this._threejs.outputEncoding = THREE.sRGBEncoding;
    this._threejs.gammaFactor = 2.2;
    this._threejs.shadowMap.enabled = true;
    this._threejs.shadowMap.type = THREE.PCFSoftShadowMap;
    this._threejs.setPixelRatio(window.devicePixelRatio);
    this._threejs.setSize(window.innerWidth, window.innerHeight);
    this._threejs.domElement.id = 'threejs';

    document.getElementById('container').appendChild(this._threejs.domElement);

    window.addEventListener('resize', () => {
      this._OnWindowResize();
    }, false);

    const fov = 60;
    const aspect = window.innerWidth / window.innerHeight;
    const near = 1.0;
    const far = 10000.0;
    this._camera = new THREE.PerspectiveCamera(fov, aspect, near, far);
    this._camera.position.set(25, 10, 25);
    const listener = new THREE.AudioListener();
this._camera.add(listener);
//sound
const sound = new THREE.Audio(listener);
const audioLoader = new THREE.AudioLoader();
audioLoader.load('./resources/sounds/retro_ringtone.mp3',
  (buffer) => {
    sound.setBuffer(buffer);
    sound.setLoop(true);
    sound.setVolume(0.5);
    // Try to play — may still be blocked until user gesture
    try { sound.play(); } catch (e) { /* will resume on gesture */ }
  },
  undefined,
  (err) => {
    console.error('[audio] load error:', err);
  }
);
    this._scene = new THREE.Scene();
    // warmer fog and blend with ground
    this._scene.background = new THREE.Color(0xCDE8FF);
    this._scene.fog = new THREE.FogExp2(0xC9EACD, 0.0011);

    // --- lighting: warm sun + hemisphere ambient ---
    let light = new THREE.DirectionalLight(0xfff1d6, 0.95);
    light.position.set(-40, 120, 60);
    light.target.position.set(0, 0, 0);
    light.castShadow = true;
    light.shadow.bias = -0.0004;
    light.shadow.mapSize.width = 2048;
    light.shadow.mapSize.height = 2048;
    light.shadow.camera.near = 0.1;
    light.shadow.camera.far = 1000.0;
    light.shadow.camera.left = 200;
    light.shadow.camera.right = -200;
    light.shadow.camera.top = 200;
    light.shadow.camera.bottom = -200;
    this._scene.add(light);
    this._sun = light;

    const hemi = new THREE.HemisphereLight(0xfff6e0, 0x445566, 0.45);
    this._scene.add(hemi);

    // --- Ground: try to use tiled texture, fallback to color ---
    const planeGeo = new THREE.PlaneGeometry(5000, 5000, 10, 10);
    // default material (in case texture not found)
    let planeMat = new THREE.MeshStandardMaterial({ color: 0x1e601c, roughness: 1.0, metalness: 0.0 });

    // try load ground texture
    try {
      const groundLoader = new THREE.TextureLoader();
      groundLoader.load(
       './resources/icons/weapons/S.jpeg',
        (tex) => {
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          tex.repeat.set(80, 80);
          tex.encoding = THREE.sRGBEncoding;
          planeMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1.0, metalness: 0.0 });
          // replace plane's material if plane exists
          if (this._groundMesh) {
            this._groundMesh.material = planeMat;
          }
        },
        undefined,
        (err) => {
          // failure - leave default material
          console.log('[ground] ground texture not found, using flat color.');
        }
      );
    } catch (e) {
      console.warn('[ground] texture loader error', e);
    }

    const plane = new THREE.Mesh(planeGeo, planeMat);
    plane.castShadow = false;
    plane.receiveShadow = true;
    plane.rotation.x = -Math.PI / 2;
    this._scene.add(plane);
    this._groundMesh = plane;

    this._entityManager = new entity_manager.EntityManager();
    this._grid = new spatial_hash_grid.SpatialHashGrid(
        [[-1000, -1000], [1000, 1000]], [100, 100]);

    this._LoadControllers();
    this._LoadPlayer();
    this._LoadFoliage();
    this._LoadClouds();
    this._LoadSky();

    // ----- GRASS support variables and settings -----
    // NOTE: the thin shader-driven grass below does NOT use an image file
    this._grassCount = 2500;   // (unused for the thin-mesh approach; kept for compatibility)
    this._grassArea = 600;     // spread (square) - not directly used by thin-mesh approach
    this._totalTime = 0;
    this._grassMeshes = null;
    this._grassOffsets = null;
    this._grassDummy = null;

    // create grass (after plane and sky/foliage so it sits on ground)
    // this._LoadGrass();

    this._previousRAF = null;
    this._RAF();
  }

  _LoadControllers() {
    const ui = new entity.Entity();
    ui.AddComponent(new ui_controller.UIController());
    this._entityManager.Add(ui, 'ui');
  }

  _LoadSky() {
    const hemiLight = new THREE.HemisphereLight(0xFFFFFF, 0xFFFFFFF, 0.6);
    hemiLight.color.setHSL(0.6, 1, 0.6);
    hemiLight.groundColor.setHSL(0.095, 1, 0.75);
    this._scene.add(hemiLight);

    const uniforms = {
      "topColor": { value: new THREE.Color(0x0077ff) },
      "bottomColor": { value: new THREE.Color(0xffffff) },
      "offset": { value: 33 },
      "exponent": { value: 0.6 }
    };
    uniforms["topColor"].value.copy(hemiLight.color);

    this._scene.fog.color.copy(uniforms["bottomColor"].value);

    const skyGeo = new THREE.SphereBufferGeometry(1000, 32, 15);
    const skyMat = new THREE.ShaderMaterial({
        uniforms: uniforms,
        vertexShader: _VS,
        fragmentShader: _FS,
        side: THREE.BackSide
    });

    const sky = new THREE.Mesh(skyGeo, skyMat);
    this._scene.add(sky);
  }

  _LoadClouds() {
    for (let i = 0; i < 20; ++i) {
      const index = math.rand_int(1, 3);
      const pos = new THREE.Vector3(
        (Math.random() * 2.0 - 1.0) * 500,
        100,
        (Math.random() * 2.0 - 1.0) * 500
      );

      const e = new entity.Entity();
      e.AddComponent(new gltf_component.StaticModelComponent({
        scene: this._scene,
        resourcePath: './resources/nature2/GLTF/',
        resourceName: 'Cloud' + index + '.glb',
        position: pos,
        scale: Math.random() * 5 + 10,
        emissive: new THREE.Color(0x808080),
      }));
      e.SetPosition(pos);
      this._entityManager.Add(e);
      e.SetActive(false);
    }
  }

  _LoadFoliage() {
    for (let i = 0; i < 100; ++i) {
      const names = [
          // 'CommonTree_Dead', 'CommonTree',
          'BirchTree', 'BirchTree_Dead',
          'Willow', 'Willow_Dead',
          // 'PineTree',
      ];
      const name = names[math.rand_int(0, names.length - 1)];
      const index = math.rand_int(1, 5);

      const pos = new THREE.Vector3(
          (Math.random() * 2.0 - 1.0) * 500,
          0,
          (Math.random() * 2.0 - 1.0) * 500);

      const e = new entity.Entity();
      e.AddComponent(new gltf_component.StaticModelComponent({
        scene: this._scene,
        resourcePath: './resources/nature/FBX/',
        resourceName: name + '_' + index + '.fbx',
        scale: 0.25,
        emissive: new THREE.Color(0x000000),
        specular: new THREE.Color(0x000000),
        receiveShadow: true,
        castShadow: true,
      }));
      e.AddComponent(
          new spatial_grid_controller.SpatialGridController({grid: this._grid}));
      e.SetPosition(pos);
      this._entityManager.Add(e);
      e.SetActive(false);
    }
  }

  _LoadPlayer() {
    const params = {
      camera: this._camera,
      scene: this._scene,
    };

    const levelUpSpawner = new entity.Entity();
    levelUpSpawner.AddComponent(new level_up_component.LevelUpComponentSpawner({
        camera: this._camera,
        scene: this._scene,
    }));
    this._entityManager.Add(levelUpSpawner, 'level-up-spawner');

    const axe = new entity.Entity();
    axe.AddComponent(new inventory_controller.InventoryItem({
        type: 'weapon',
        damage: 3,
        renderParams: {
          name: 'Axe',
          scale: 0.25,
          icon: 'war-axe-64.png',
        },
    }));
    this._entityManager.Add(axe);

    const sword = new entity.Entity();
    sword.AddComponent(new inventory_controller.InventoryItem({
        type: 'weapon',
        damage: 3,
        renderParams: {
          name: 'Sword',
          scale: 0.25,
          icon: 'pointy-sword-64.png',
        },
    }));
    this._entityManager.Add(sword);

    const girl = new entity.Entity();
    girl.AddComponent(new gltf_component.AnimatedModelComponent({
        scene: this._scene,
        resourcePath: './resources/girl/',
        resourceName: 'peasant_girl.fbx',
        resourceAnimation: 'Standing Idle.fbx',
        scale: 0.035,
        receiveShadow: true,
        castShadow: true,
    }));
    girl.AddComponent(new spatial_grid_controller.SpatialGridController({
        grid: this._grid,
    }));
    girl.AddComponent(new player_input.PickableComponent());
    girl.AddComponent(new quest_component.QuestComponent());
    girl.SetPosition(new THREE.Vector3(30, 0, 0));
    this._entityManager.Add(girl);

    const player = new entity.Entity();
    player.AddComponent(new player_input.BasicCharacterControllerInput(params));
    player.AddComponent(new player_entity.BasicCharacterController(params));
    player.AddComponent(
      new equip_weapon_component.EquipWeapon({anchor: 'RightHandIndex1'}));
    player.AddComponent(new inventory_controller.InventoryController(params));
    player.AddComponent(new health_component.HealthComponent({
        updateUI: true,
        health: 100,
        maxHealth: 100,
        strength: 50,
        wisdomness: 5,
        benchpress: 20,
        curl: 100,
        experience: 0,
        level: 1,
    }));
    player.AddComponent(
        new spatial_grid_controller.SpatialGridController({grid: this._grid}));
    player.AddComponent(new attack_controller.AttackController({timing: 0.7}));
    this._entityManager.Add(player, 'player');

    player.Broadcast({
        topic: 'inventory.add',
        value: axe.Name,
        added: false,
    });

    player.Broadcast({
        topic: 'inventory.add',
        value: sword.Name,
        added: false,
    });

    player.Broadcast({
        topic: 'inventory.equip',
        value: sword.Name,
        added: false,
    });

    const camera = new entity.Entity();
    camera.AddComponent(
        new third_person_camera.ThirdPersonCamera({
            camera: this._camera,
            target: this._entityManager.Get('player')}));
    this._entityManager.Add(camera, 'player-camera');

    for (let i = 0; i < 50; ++i) {
      const monsters = [
        {
          resourceName: 'Ghost.fbx',
          resourceTexture: 'Ghost_Texture.png',
        },
        {
          resourceName: 'Alien.fbx',
          resourceTexture: 'Alien_Texture.png',
        },
        {
          resourceName: 'Skull.fbx',
          resourceTexture: 'Skull_Texture.png',
        },
        {
          resourceName: 'GreenDemon.fbx',
          resourceTexture: 'GreenDemon_Texture.png',
        },
        {
          resourceName: 'Cyclops.fbx',
          resourceTexture: 'Cyclops_Texture.png',
        },
        {
          resourceName: 'Cactus.fbx',
          resourceTexture: 'Cactus_Texture.png',
        },
      ];
      const m = monsters[math.rand_int(0, monsters.length - 1)];

      const npc = new entity.Entity();
      npc.AddComponent(new npc_entity.NPCController({
          camera: this._camera,
          scene: this._scene,
          resourceName: m.resourceName,
          resourceTexture: m.resourceTexture,
      }));
      npc.AddComponent(
          new health_component.HealthComponent({
              health: 50,
              maxHealth: 50,
              strength: 2,
              wisdomness: 2,
              benchpress: 3,
              curl: 1,
              experience: 0,
              level: 1,
              camera: this._camera,
              scene: this._scene,
          }));
      npc.AddComponent(
          new spatial_grid_controller.SpatialGridController({grid: this._grid}));
      npc.AddComponent(new health_bar.HealthBar({
          parent: this._scene,
          camera: this._camera,
      }));
      npc.AddComponent(new attack_controller.AttackController({timing: 0.35}));
      npc.SetPosition(new THREE.Vector3(
          (Math.random() * 2 - 1) * 500,
          0,
          (Math.random() * 2 - 1) * 500));
      this._entityManager.Add(npc);
    }
  }


  _OnWindowResize() {
    this._camera.aspect = window.innerWidth / window.innerHeight;
    this._camera.updateProjectionMatrix();
    this._threejs.setSize(window.innerWidth, window.innerHeight);
  }

  _UpdateSun() {
    const player = this._entityManager.Get('player');
    const pos = player._position;

    this._sun.position.copy(pos);
    this._sun.position.add(new THREE.Vector3(-10, 500, -10));
    this._sun.target.position.copy(pos);
    this._sun.updateMatrixWorld();
    this._sun.target.updateMatrixWorld();
  }

  _RAF() {
    requestAnimationFrame((t) => {
      if (this._previousRAF === null) {
        this._previousRAF = t;
      }

      this._RAF();

      this._threejs.render(this._scene, this._camera);
      this._Step(t - this._previousRAF);
      this._previousRAF = t;
    });
  }

  _Step(timeElapsed) {
    const timeElapsedS = Math.min(1.0 / 30.0, timeElapsed * 0.001);

    this._UpdateSun();

    // accumulate time for grass animation (only here)
    this._totalTime += timeElapsedS;

    // update shader-driven grass if present (item 2)
    if (this._grassMaterial) {
      this._grassMaterial.uniforms.time.value += timeElapsedS;
    }

    // if you had CPU-based instance updates, they are not used now.
    // this._UpdateGrass(timeElapsedS);

    this._entityManager.Update(timeElapsedS);
  }


_addMoon() {
    if (this._moonMesh) return;
    const geometry = new THREE.SphereGeometry(20, 32, 32);
    const material = new THREE.MeshBasicMaterial({ color: 0xfafaff });
    const moon = new THREE.Mesh(geometry, material);
    moon.position.set(0, 400, -600);
    this._scene.add(moon);
    this._moonMesh = moon;
  }

  _removeMoon() {
    if (this._moonMesh) {
      this._scene.remove(this._moonMesh);
      this._moonMesh = null;
    }
  }

  setEnvironmentMode(mode) {
    if (mode === 'morning') {
      this._scene.background = new THREE.Color(0x87ceeb); // Sky blue
      this._scene.fog.color.set(0x87ceeb);
      this._sun.intensity = 1.2;
      this._sun.color.set(0xffffff);
      if (this._skyUniforms) {
        this._skyUniforms.topColor.value.set(0x87ceeb);
        this._skyUniforms.bottomColor.value.set(0xffffff);
      }
      this._removeMoon();
    } else if (mode === 'night') {
      this._scene.background = new THREE.Color(0x0a0a23); // Dark blue
      this._scene.fog.color.set(0x0a0a23);
      this._sun.intensity = 0.15;
      this._sun.color.set(0xaaaaff);
      if (this._skyUniforms) {
        this._skyUniforms.topColor.value.set(0x0a0a23);
        this._skyUniforms.bottomColor.value.set(0x222244);
      }
      this._addMoon();
    }
  }

}

let _APP = null;

window.addEventListener('DOMContentLoaded', () => {
  _APP = new HackNSlashDemo();
});