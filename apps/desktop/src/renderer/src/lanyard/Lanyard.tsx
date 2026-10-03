/**
 * An ID card on a lanyard that swings, and can be grabbed and thrown.
 *
 * Adapted from the Lanyard component of React Bits by David Haz
 * (https://reactbits.dev/components/lanyard, MIT + Commons Clause), along
 * with its `card.glb` model. Changed here: the card's faces and the strap are
 * drawn from canvases the caller owns, so the card can be redrawn as the
 * user types without reloading a texture (which would drop the card again).
 */
import { Environment, Lightformer, useGLTF } from '@react-three/drei'
import { Canvas, extend, useFrame, type ThreeElement, type ThreeEvent } from '@react-three/fiber'
import {
  BallCollider,
  CuboidCollider,
  Physics,
  RigidBody,
  useRopeJoint,
  useSphericalJoint,
  type RapierRigidBody,
  type RigidBodyProps
} from '@react-three/rapier'
import { MeshLineGeometry, MeshLineMaterial } from 'meshline'
import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import cardGLB from './card.glb?url'
import { BACK, FRONT } from './face'

extend({ MeshLineGeometry, MeshLineMaterial })

declare module '@react-three/fiber' {
  interface ThreeElements {
    meshLineGeometry: ThreeElement<typeof MeshLineGeometry>
    // Its constructor arguments are optional in practice: every option is set as a prop.
    meshLineMaterial: Partial<ThreeElement<typeof MeshLineMaterial>>
  }
}

interface Props {
  /** The front of the card. Redraw it and bump `version` to update the card. */
  front: HTMLCanvasElement | null
  back?: HTMLCanvasElement | null
  /** The strap's repeating pattern. */
  strap: HTMLCanvasElement
  /** Changes whenever `front` or `back` was redrawn. */
  version: number
}

export default function Lanyard(props: Props): React.JSX.Element {
  return (
    <div className="lanyard">
      <Canvas
        camera={{ position: [0, 0, 17], fov: 20 }}
        dpr={[1, 2]}
        gl={{ alpha: true }}
        onCreated={({ gl }) => gl.setClearColor(new THREE.Color(0x000000), 0)}
      >
        <ambientLight intensity={Math.PI} />
        <Physics gravity={[0, -40, 0]} timeStep={1 / 60}>
          <Band {...props} />
        </Physics>
        <Environment blur={0.75}>
          <Lightformer
            intensity={2}
            color="white"
            position={[0, -1, 5]}
            rotation={[0, 0, Math.PI / 3]}
            scale={[100, 0.1, 1]}
          />
          <Lightformer
            intensity={3}
            color="white"
            position={[-1, -1, 1]}
            rotation={[0, 0, Math.PI / 3]}
            scale={[100, 0.1, 1]}
          />
          <Lightformer
            intensity={3}
            color="white"
            position={[1, 1, 1]}
            rotation={[0, 0, Math.PI / 3]}
            scale={[100, 0.1, 1]}
          />
          <Lightformer
            intensity={10}
            color="white"
            position={[-10, 0, 14]}
            rotation={[0, Math.PI / 2, Math.PI / 3]}
            scale={[100, 10, 1]}
          />
        </Environment>
      </Canvas>
    </div>
  )
}

type Lerped = RapierRigidBody & { lerped?: THREE.Vector3 }

interface CardModel {
  nodes: Record<'card' | 'clip' | 'clamp', THREE.Mesh>
  materials: { base: THREE.MeshStandardMaterial; metal: THREE.MeshStandardMaterial }
}

const MAX_SPEED = 50
const MIN_SPEED = 0

function Band({ front, back = null, strap, version }: Props): React.JSX.Element {
  const band = useRef<
    THREE.Mesh<InstanceType<typeof MeshLineGeometry>, InstanceType<typeof MeshLineMaterial>>
  >(null!)
  const fixed = useRef<RapierRigidBody>(null!)
  const j1 = useRef<Lerped>(null!)
  const j2 = useRef<Lerped>(null!)
  const j3 = useRef<RapierRigidBody>(null!)
  const card = useRef<RapierRigidBody>(null!)

  const vec = new THREE.Vector3()
  const ang = new THREE.Vector3()
  const rot = new THREE.Vector3()
  const dir = new THREE.Vector3()

  const segment: RigidBodyProps = {
    type: 'dynamic',
    canSleep: true,
    colliders: false,
    angularDamping: 4,
    linearDamping: 4
  }

  const lerpedOf = (body: Lerped): THREE.Vector3 => {
    body.lerped ??= new THREE.Vector3().copy(body.translation())
    return body.lerped
  }

  const { nodes, materials } = useGLTF(cardGLB) as unknown as CardModel

  // One texture for the card, made once; the faces are painted onto a copy
  // of the model's own atlas, which keeps the baked edges.
  const atlas = useMemo(() => {
    const base = materials.base.map as THREE.Texture
    const image = base.image as HTMLImageElement
    const canvas = document.createElement('canvas')
    canvas.width = image.width
    canvas.height = image.height
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.flipY = base.flipY
    texture.anisotropy = 16
    return { canvas, image, texture }
  }, [materials.base.map])

  useEffect(() => {
    const { canvas, image, texture } = atlas
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { width: W, height: H } = canvas
    ctx.drawImage(image, 0, 0, W, H)
    const paint = (face: HTMLCanvasElement | null, rect: typeof FRONT): void => {
      if (face) ctx.drawImage(face, rect.x * W, rect.y * H, rect.w * W, rect.h * H)
    }
    paint(front, FRONT)
    paint(back, BACK)
    texture.needsUpdate = true
  }, [atlas, front, back, version])

  const strapTexture = useMemo(() => {
    const texture = new THREE.CanvasTexture(strap)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    return texture
  }, [strap])

  const [curve] = useState(() => {
    const made = new THREE.CatmullRomCurve3([
      new THREE.Vector3(),
      new THREE.Vector3(),
      new THREE.Vector3(),
      new THREE.Vector3()
    ])
    made.curveType = 'chordal'
    return made
  })
  const [dragged, drag] = useState<false | THREE.Vector3>(false)
  const [hovered, hover] = useState(false)

  useRopeJoint(fixed, j1, [[0, 0, 0], [0, 0, 0], 1])
  useRopeJoint(j1, j2, [[0, 0, 0], [0, 0, 0], 1])
  useRopeJoint(j2, j3, [[0, 0, 0], [0, 0, 0], 1])
  useSphericalJoint(j3, card, [
    [0, 0, 0],
    [0, 1.45, 0]
  ])

  useEffect(() => {
    if (!hovered) return
    document.body.style.cursor = dragged ? 'grabbing' : 'grab'
    return () => {
      document.body.style.cursor = 'auto'
    }
  }, [hovered, dragged])

  useFrame((state, frameDelta) => {
    // A window that was in the background comes back with one very long frame.
    const delta = Math.min(frameDelta, 0.05)
    if (dragged) {
      vec.set(state.pointer.x, state.pointer.y, 0.5).unproject(state.camera)
      dir.copy(vec).sub(state.camera.position).normalize()
      vec.add(dir.multiplyScalar(state.camera.position.length()))
      ;[card, j1, j2, j3, fixed].forEach((ref) => ref.current?.wakeUp())
      card.current?.setNextKinematicTranslation({
        x: vec.x - dragged.x,
        y: vec.y - dragged.y,
        z: vec.z - dragged.z
      })
    }
    if (fixed.current) {
      ;[j1, j2].forEach((ref) => {
        const lerped = lerpedOf(ref.current)
        const distance = Math.max(0.1, Math.min(1, lerped.distanceTo(ref.current.translation())))
        lerped.lerp(
          ref.current.translation(),
          delta * (MIN_SPEED + distance * (MAX_SPEED - MIN_SPEED))
        )
      })
      curve.points[0].copy(j3.current.translation())
      curve.points[1].copy(lerpedOf(j2.current))
      curve.points[2].copy(lerpedOf(j1.current))
      curve.points[3].copy(fixed.current.translation())
      band.current.geometry.setPoints(curve.getPoints(32))
      ang.copy(card.current.angvel())
      rot.copy(card.current.rotation())
      card.current.setAngvel({ x: ang.x, y: ang.y - rot.y * 0.25, z: ang.z }, true)
    }
  })

  return (
    <>
      <group position={[0, 4, 0]}>
        <RigidBody ref={fixed} {...segment} type="fixed" />
        <RigidBody position={[0.5, 0, 0]} ref={j1} {...segment}>
          <BallCollider args={[0.1]} />
        </RigidBody>
        <RigidBody position={[1, 0, 0]} ref={j2} {...segment}>
          <BallCollider args={[0.1]} />
        </RigidBody>
        <RigidBody position={[1.5, 0, 0]} ref={j3} {...segment}>
          <BallCollider args={[0.1]} />
        </RigidBody>
        <RigidBody
          position={[2, 0, 0]}
          ref={card}
          {...segment}
          type={dragged ? 'kinematicPosition' : 'dynamic'}
        >
          <CuboidCollider args={[0.8, 1.125, 0.01]} />
          <group
            scale={2.25}
            position={[0, -1.2, -0.05]}
            onPointerOver={() => hover(true)}
            onPointerOut={() => hover(false)}
            onPointerUp={(e: ThreeEvent<PointerEvent>) => {
              ;(e.target as Element).releasePointerCapture(e.pointerId)
              drag(false)
            }}
            onPointerDown={(e: ThreeEvent<PointerEvent>) => {
              ;(e.target as Element).setPointerCapture(e.pointerId)
              drag(new THREE.Vector3().copy(e.point).sub(vec.copy(card.current.translation())))
            }}
          >
            <mesh geometry={nodes.card.geometry}>
              {/* Unlit: a printed card shows its artwork's own colours, so
                  its white stays white whatever the scene's lights do. */}
              <meshBasicMaterial map={atlas.texture} map-anisotropy={16} toneMapped={false} />
            </mesh>
            <mesh geometry={nodes.clip.geometry} material={materials.metal} material-roughness={0.3} />
            <mesh geometry={nodes.clamp.geometry} material={materials.metal} />
          </group>
        </RigidBody>
      </group>
      <mesh ref={band}>
        <meshLineGeometry />
        <meshLineMaterial
          color="white"
          depthTest={false}
          resolution={[1000, 1000]}
          useMap={1}
          map={strapTexture}
          repeat={[-4, 1]}
          lineWidth={1}
        />
      </mesh>
    </>
  )
}

useGLTF.preload(cardGLB)
