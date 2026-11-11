import {
  Box3, BufferAttribute, BufferGeometry, Color, DirectionalLight, GridHelper, Group,
  HemisphereLight, LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshBasicMaterial, OrthographicCamera,
  GLSL3, Points, Scene, ShaderMaterial, SphereGeometry, Texture, Vector3, WebGLRenderer, WebGLRenderTarget,
  type Material, type Object3D,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { engraving, layerChange, pulse, rapid, type PathData, type XYZ } from '../../shared/gcode'
import { pointColorGLSL, pointSliceGLSL, pointSliceUniforms, pointUniforms, updatePointUniforms, type PointAppearance, type PointHeight } from './pointAppearance'

export type ViewMode = 'top' | 'orbit'
export interface ViewOrientation {
  transform: string
  facing: XYZ
}

function createRenderer() {
  try {
    return new WebGLRenderer({ antialias: true })
  } catch (error) {
    console.warn('WebGL initialization failed. Retrying without antialiasing.', error)
    return new WebGLRenderer({ antialias: false, powerPreference: 'low-power' })
  }
}

function drawThrough(geometry: BufferGeometry, vertexLimit: number) {
  const indices = geometry.index?.array
  if (!indices || vertexLimit === Infinity) {
    geometry.setDrawRange(0, vertexLimit)
    return
  }
  let low = 0
  let high = indices.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (indices[middle] < vertexLimit) low = middle + 1
    else high = middle
  }
  geometry.setDrawRange(0, low)
}

export function disposeObject(root: Object3D) {
  const materials = new Set<Material>()
  const geometries = new Set<BufferGeometry>()
  const textures = new Set<Texture>()
  const bitmaps = new Set<ImageBitmap>()
  root.traverse((object) => {
    const drawable = object as Mesh
    if (drawable.geometry) geometries.add(drawable.geometry)
    const material = drawable.material
    if (material) for (const item of Array.isArray(material) ? material : [material]) materials.add(item)
  })
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value)
    material.dispose()
  }
  for (const texture of textures) {
    if (texture.image instanceof ImageBitmap) bitmaps.add(texture.image)
    texture.dispose()
  }
  for (const bitmap of bitmaps) bitmap.close()
  for (const geometry of geometries) geometry.dispose()
}

export class Viewport {
  private readonly pickScene = new Scene()
  private readonly pickPixels = new Uint8Array(9 * 9 * 4)
  private pickTarget?: WebGLRenderTarget
  private pickMaterial?: ShaderMaterial
  private pickLines?: LineSegments
  private modelPickRanges: { start: number; end: number; object: Points }[] = []
  private readonly inspection = new Group()
  private reference?: Group
  private referenceMaterials = new Map<Material, { opacity: number; transparent: boolean; depthWrite: boolean }>()
  private readonly scene = new Scene()
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.001, 100_000)
  private readonly renderer: WebGLRenderer
  private readonly controls: OrbitControls
  private readonly observer: ResizeObserver
  private content: Object3D | null = null
  private grid: GridHelper | null = null
  private bounds = new Box3()
  private span = 100
  private mode: ViewMode = 'top'
  private pathLines: LineSegments<BufferGeometry, ShaderMaterial> | null = null
  private pathPoints: Points<BufferGeometry, ShaderMaterial> | null = null
  private pathPointUniforms = pointUniforms()
  private slice = pointSliceUniforms()
  private hasCursor = false
  private marker: Mesh | null = null
  private frame = 0

  constructor(
    private readonly host: HTMLElement,
    private readonly onOrientation: (orientation: ViewOrientation) => void,
    private readonly onContextChange: (lost: boolean) => void,
  ) {
    this.scene.background = new Color('#101922')
    this.scene.add(this.inspection)
    this.renderer = createRenderer()
    this.renderer.domElement.addEventListener('webglcontextlost', this.contextLost)
    this.renderer.domElement.addEventListener('webglcontextrestored', this.contextRestored)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.host.append(this.renderer.domElement)
    this.camera.up.set(0, 0, 1)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.zoomToCursor = true
    this.controls.addEventListener('change', this.cameraChanged)
    this.scene.add(new HemisphereLight(0xffffff, 0x536273, 2))
    const light = new DirectionalLight(0xffffff, 2)
    light.position.set(4, -6, 9)
    this.scene.add(light)
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(host)
    this.fit()
  }

  private contextLost = () => this.onContextChange(true)

  private contextRestored = () => {
    this.onContextChange(false)
    this.render()
  }

  private readonly viewRotation = new Matrix4()
  private orientationTransform = ''

  private cameraChanged = () => {
    const rotation = this.viewRotation.makeRotationFromQuaternion(this.camera.quaternion).transpose().elements
    // Convert between Three.js Y-up screen coordinates and CSS Y-down coordinates.
    const values = rotation.map((value, index) => (index % 4 === 1) !== (Math.floor(index / 4) === 1) ? -value : value)
    const transform = `matrix3d(${values.join(',')})`
    if (transform !== this.orientationTransform) {
      this.orientationTransform = transform
      this.onOrientation({ transform, facing: [rotation[2], rotation[6], rotation[10]] })
    }
    this.render()
  }

  private render = () => {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      if (this.marker?.visible) {
        const worldPerPixel = (this.camera.top - this.camera.bottom) / (this.camera.zoom * Math.max(1, this.host.clientHeight))
        this.marker.scale.setScalar(4 * worldPerPixel)
      }
      this.renderer.render(this.scene, this.camera)
    })
  }

  private resize() {
    const width = Math.max(1, this.host.clientWidth)
    const height = Math.max(1, this.host.clientHeight)
    const aspect = width / height
    const x = this.span / 2 * Math.max(1, aspect)
    const y = this.span / 2 * Math.max(1, 1 / aspect)
    Object.assign(this.camera, { left: -x, right: x, top: y, bottom: -y })
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
    this.render()
  }

  fit(preserveDirection = false) {
    const bounds = this.content?.visible === false && this.reference?.visible ? new Box3() : this.bounds.clone()
    if (this.reference?.visible) bounds.expandByObject(this.reference)
    const center = bounds.isEmpty() ? new Vector3() : bounds.getCenter(new Vector3())
    const size = bounds.isEmpty() ? new Vector3(100, 100, 0) : bounds.getSize(new Vector3())
    this.span = Math.max(size.length() * 1.16, 0.01)
    this.camera.zoom = 1
    this.camera.near = this.span * 0.0001
    this.camera.far = this.span * 500
    const offset = preserveDirection
      ? this.camera.position.clone().sub(this.controls.target).normalize()
      : this.mode === 'top' ? new Vector3(0, -0.000001, 1) : new Vector3(0.8, -1, 0.85)
    this.camera.position.copy(center).addScaledVector(offset, this.span * 2)
    this.controls.target.copy(center)
    this.controls.enableRotate = this.mode === 'orbit'
    this.controls.update()
    this.cameraChanged()
    this.resize()
  }

  setMode(mode: ViewMode) {
    this.mode = mode
    this.fit()
  }

  lookFrom(direction: XYZ) {
    const [x, y, z] = direction
    this.mode = z > 0 ? 'top' : 'orbit'
    const target = this.controls.target
    const distance = this.camera.position.distanceTo(target)
    const offset = new Vector3(x, z ? -0.000001 : y, z).normalize()
    this.camera.position.copy(target).addScaledVector(offset, distance)
    this.controls.enableRotate = this.mode === 'orbit'
    this.controls.update()
    this.cameraChanged()
    return this.mode
  }

  clear(keepReference = false) {
    if (!keepReference) this.clearReference()
    this.hasCursor = false
    this.showInspection([])
    for (const child of this.pickScene.children) {
      if (child instanceof Points) (child.material as ShaderMaterial).dispose()
    }
    this.pickScene.clear()
    this.pickMaterial?.dispose()
    this.pickMaterial = undefined
    this.pickLines = undefined
    this.modelPickRanges = []
    if (this.content) {
      this.scene.remove(this.content)
      disposeObject(this.content)
      this.content = null
    }
    if (this.grid) {
      this.scene.remove(this.grid)
      disposeObject(this.grid)
      this.grid = null
    }
    this.pathLines = null
    this.pathPoints = null
    this.marker = null
    this.bounds.makeEmpty()
    this.render()
  }

  clearReference() {
    if (!this.reference) return
    this.scene.remove(this.reference)
    disposeObject(this.reference)
    this.reference = undefined
    this.referenceMaterials.clear()
    this.render()
  }

  showReference(root: Object3D, visible: boolean, opacity: number) {
    this.clearReference()
    this.reference = new Group()
    // The reference shares the G-code display convention while keeping its source coordinates.
    this.reference.scale.y = -1
    this.reference.add(root)
    root.traverse((object) => {
      const material = (object as Mesh).material
      if (!material) return
      for (const item of Array.isArray(material) ? material : [material]) {
        this.referenceMaterials.set(item, { opacity: item.opacity, transparent: item.transparent, depthWrite: item.depthWrite })
      }
    })
    this.scene.add(this.reference)
    this.setReferenceDisplay(visible, opacity)
  }

  setReferenceDisplay(visible: boolean, opacity: number) {
    if (!this.reference) return
    this.reference.visible = visible && opacity > 0
    for (const [material, original] of this.referenceMaterials) {
      const transparent = original.transparent || opacity < 1
      if (material.transparent !== transparent) material.needsUpdate = true
      material.transparent = transparent
      material.opacity = original.opacity * opacity
      material.depthWrite = opacity === 1 && original.depthWrite
    }
    this.render()
  }

  setPathVisible(visible: boolean) {
    if (this.content) this.content.visible = visible
    this.inspection.visible = visible
    this.render()
  }

  private show(object: Object3D, mode: ViewMode, bounds: Box3, gridZ: number, keepReference = false) {
    this.clear(keepReference)
    this.content = object
    this.bounds = bounds
    this.scene.add(object)
    const size = bounds.isEmpty() ? 100 : Math.max(1, bounds.getSize(new Vector3()).length())
    const spacing = 10 ** Math.floor(Math.log10(size / 8))
    this.grid = new GridHelper(spacing * 24, 24, 0x415262, 0x293745)
    this.grid.rotation.x = Math.PI / 2
    const center = bounds.isEmpty() ? new Vector3() : bounds.getCenter(new Vector3())
    this.grid.position.set(Math.round(center.x / spacing) * spacing, Math.round(center.y / spacing) * spacing, gridZ - spacing * 0.005)
    this.scene.add(this.grid)
    this.setMode(mode)
  }

  showModel(root: Object3D, slice: ReturnType<typeof pointSliceUniforms>) {
    const bounds = new Box3().setFromObject(root)
    this.show(root, 'orbit', bounds, bounds.min.z)
    this.slice = slice
    let start = 0
    root.traverseVisible((object) => {
      if (!(object instanceof Points)) return
      const count = object.geometry.getAttribute('position')?.count ?? 0
      if (!count) return
      const material = new ShaderMaterial({
        glslVersion: GLSL3,
        uniforms: { firstPoint: { value: start + 1 }, ...slice },
        vertexShader: `
          ${pointSliceGLSL}
          uniform int firstPoint;
          flat out int entry;
          flat out float sliceClipped;
          void main() {
            entry = gl_VertexID + firstPoint;
            sliceClipped = outsidePointSlice((modelMatrix * vec4(position, 1.0)).z);
            gl_PointSize = 3.0;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          flat in int entry;
          flat in float sliceClipped;
          out vec4 pickColor;
          void main() {
            if (sliceClipped > 0.5) discard;
            pickColor = vec4(float(entry & 255), float((entry >> 8) & 255), float((entry >> 16) & 255), 255.0) / 255.0;
          }`,
      })
      const proxy = new Points(object.geometry, material)
      proxy.matrixAutoUpdate = false
      proxy.matrix.copy(object.matrixWorld)
      this.pickScene.add(proxy)
      this.modelPickRanges.push({ start, end: start + count, object })
      start += count
    })
  }

  showPath(path: PathData, keepReference = false) {
    const group = new Group()
    // Match LDS: program X goes right and program Y goes down in the top view.
    group.scale.y = -1
    group.updateMatrix()
    const bounds = path.bounds ? new Box3(new Vector3(...path.bounds.min), new Vector3(...path.bounds.max)) : new Box3()
    const minZ = path.bounds?.min[2] ?? 0
    this.show(group, path.pointMode ? 'orbit' : 'top', bounds.clone().applyMatrix4(group.matrix), path.pointMode ? minZ : Math.min(0, minZ), keepReference)
    if (!path.kinds.length) return

    const total = path.distances.at(-1)!
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(path.positions, 3))
    geometry.boundingBox = bounds
    const route = new Float32Array(path.kinds.length * 2)
    const styles = new Uint8Array(route.length)
    const strengths = new Uint8Array(route.length)
    let pointCount = 0
    let lineCount = 0
    if (path.pointMode) {
      for (const kind of path.kinds) {
        if (kind === pulse) pointCount++
        else if (kind !== layerChange) lineCount++
      }
    }
    const pointIndices = new Uint32Array(pointCount)
    const lineIndices = path.pointMode ? new Uint32Array(lineCount * 2) : null
    let pointOffset = 0
    let lineOffset = 0
    let minPointZ = Infinity
    let maxPointZ = -Infinity
    let maxPower = 1
    for (const power of path.powers) maxPower = Math.max(maxPower, power)
    for (let index = 0; index < path.kinds.length; index++) {
      const kind = path.kinds[index]
      const vertex = index * 2
      const style = kind === pulse ? 3 : kind === engraving ? 2 : kind === rapid ? 0 : 1
      const strength = Math.round(path.powers[index] / maxPower * 255)
      styles[vertex] = styles[vertex + 1] = style
      strengths[vertex] = strengths[vertex + 1] = strength
      route[vertex] = (path.distances[index - 1] ?? 0) / total
      route[vertex + 1] = path.distances[index] / total
      if (kind === pulse) {
        pointIndices[pointOffset++] = vertex + 1
        const z = path.positions[(vertex + 1) * 3 + 2]
        minPointZ = Math.min(minPointZ, z)
        maxPointZ = Math.max(maxPointZ, z)
      } else if (kind !== layerChange && lineIndices) {
        lineIndices[lineOffset++] = vertex
        lineIndices[lineOffset++] = vertex + 1
      }
    }
    geometry.setAttribute('segmentStyle', new BufferAttribute(styles, 1))
    geometry.setAttribute('strength', new BufferAttribute(strengths, 1, true))
    geometry.setAttribute('route', new BufferAttribute(route, 1))
    const height: PointHeight | null = pointCount ? [minPointZ, maxPointZ] : null
    this.pathPointUniforms = pointUniforms(height ?? undefined)
    this.slice = pointSliceUniforms()
    const material = new ShaderMaterial({
      uniforms: { cursor: { value: -1 }, hideTravel: { value: false }, grayscale: { value: false }, ...this.pathPointUniforms, ...this.slice },
      vertexShader: `
        ${pointColorGLSL}
        ${pointSliceGLSL}
        uniform bool grayscale;
        attribute float segmentStyle;
        attribute float strength;
        attribute float route;
        varying vec3 lineTint;
        varying float lineRoute;
        varying float lineMoving;
        varying float sliceClipped;
        void main() {
          if (segmentStyle < 0.5) {
            lineTint = vec3(244.0, 141.0, 103.0) / 255.0;
          } else if (segmentStyle < 1.5) {
            lineTint = vec3(147.0, 164.0, 192.0) / 255.0;
          } else if (segmentStyle > 2.5 && pointAppearance != 0) {
            lineTint = previewPointColor(position.z);
          } else if (grayscale) {
            lineTint = vec3(mix(76.0, 255.0, strength) / 255.0);
          } else {
            lineTint = mix(vec3(78.0, 216.0, 187.0), vec3(171.0, 255.0, 228.0), strength) / 255.0;
          }
          lineRoute = route;
          lineMoving = segmentStyle < 1.5 ? 1.0 : 0.0;
          sliceClipped = segmentStyle > 2.5 ? outsidePointSlice(position.z) : 0.0;
          gl_PointSize = 2.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float cursor;
        uniform bool hideTravel;
        varying vec3 lineTint;
        varying float lineRoute;
        varying float lineMoving;
        varying float sliceClipped;
        void main() {
          if (sliceClipped > 0.5) discard;
          if (hideTravel && lineMoving > 0.5) discard;
          if (cursor >= 0.0 && lineRoute > cursor) discard;
          gl_FragColor = vec4(lineTint, 1.0);
        }`,
    })
    if (lineIndices) geometry.setIndex(new BufferAttribute(lineIndices, 1))
    if (!lineIndices || lineIndices.length) {
      this.pathLines = new LineSegments(geometry, material)
      group.add(this.pathLines)
    }
    if (pointIndices.length) {
      const points = new BufferGeometry()
      for (const [name, attribute] of Object.entries(geometry.attributes)) points.setAttribute(name, attribute)
      points.boundingBox = bounds
      points.setIndex(new BufferAttribute(pointIndices, 1))
      this.pathPoints = new Points(points, material)
      group.add(this.pathPoints)
    }
    this.pickMaterial = new ShaderMaterial({
      glslVersion: GLSL3,
      uniforms: { cursor: material.uniforms.cursor, hideTravel: material.uniforms.hideTravel, ...this.slice },
      vertexShader: `
        ${pointSliceGLSL}
        in float route;
        in float segmentStyle;
        flat out int entry;
        flat out float style;
        flat out float sliceClipped;
        out float distanceAlongPath;
        void main() {
          entry = gl_VertexID / 2 + 1;
          style = segmentStyle;
          sliceClipped = segmentStyle > 2.5 ? outsidePointSlice(position.z) : 0.0;
          distanceAlongPath = route;
          gl_PointSize = 2.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float cursor;
        uniform bool hideTravel;
        flat in int entry;
        flat in float style;
        flat in float sliceClipped;
        in float distanceAlongPath;
        out vec4 pickColor;
        void main() {
          if (sliceClipped > 0.5) discard;
          if ((hideTravel && style < 1.5) || (cursor >= 0.0 && distanceAlongPath > cursor)) discard;
          pickColor = vec4(float(entry & 255), float((entry >> 8) & 255), float((entry >> 16) & 255), 255.0) / 255.0;
        }`,
    })
    const pickGroup = new Group()
    pickGroup.scale.y = group.scale.y
    if (this.pathLines) {
      this.pickLines = new LineSegments(geometry, this.pickMaterial)
      pickGroup.add(this.pickLines)
    }
    if (this.pathPoints) pickGroup.add(new Points(this.pathPoints.geometry, this.pickMaterial))
    this.pickScene.add(pickGroup)
    this.marker = new Mesh(new SphereGeometry(1, 16, 12), new MeshBasicMaterial({ color: 0xffefae, depthTest: false, depthWrite: false }))
    this.marker.renderOrder = 1
    group.add(this.marker)
    return height
  }

  pickPath(clientX: number, clientY: number, pointsOnly = false) {
    if (!this.pickMaterial || !this.content?.visible) return null
    return this.pickIndex(clientX, clientY, pointsOnly)
  }

  pickModelPoint(clientX: number, clientY: number): XYZ | null {
    if (!this.modelPickRanges.length) return null
    const index = this.pickIndex(clientX, clientY)
    if (index === null) return null
    const range = this.modelPickRanges.find(item => index >= item.start && index < item.end)
    if (!range) return null
    const vertex = new Vector3().fromBufferAttribute(range.object.geometry.getAttribute('position'), index - range.start)
    return vertex.applyMatrix4(range.object.matrixWorld).toArray()
  }

  private pickIndex(clientX: number, clientY: number, pointsOnly = false) {
    if (this.renderer.getContext().isContextLost()) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    const x = Math.floor(clientX - rect.left)
    const y = Math.floor(clientY - rect.top)
    const width = Math.round(rect.width)
    const height = Math.round(rect.height)
    if (x < 0 || y < 0 || x >= width || y >= height) return null
    const size = 9
    const center = (size - 1) / 2
    const camera = this.camera.clone()
    camera.setViewOffset(width, height, x - center, y - center, size, size)
    this.pickTarget ??= new WebGLRenderTarget(size, size)
    const previous = this.renderer.getRenderTarget()
    if (pointsOnly && this.pickLines) this.pickLines.visible = false
    try {
      this.renderer.setRenderTarget(this.pickTarget)
      this.renderer.render(this.pickScene, camera)
      this.renderer.readRenderTargetPixels(this.pickTarget, 0, 0, size, size, this.pickPixels)
    } finally {
      if (pointsOnly && this.pickLines) this.pickLines.visible = true
      this.renderer.setRenderTarget(previous)
    }
    let closest = Infinity
    let result = null
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        const offset = (row * size + column) * 4
        const entry = this.pickPixels[offset] | (this.pickPixels[offset + 1] << 8) | (this.pickPixels[offset + 2] << 16)
        const distance = (row - center) ** 2 + (column - center) ** 2
        if (entry && distance < closest) {
          closest = distance
          result = entry - 1
        }
      }
    }
    return result
  }

  showInspection(points: XYZ[]) {
    disposeObject(this.inspection)
    this.inspection.clear()
    const radius = this.span * 0.008
    points.forEach((point, index) => {
      const marker = new Mesh(new SphereGeometry(radius, 12, 8), new MeshBasicMaterial({
        color: index === 0 ? 0x7be7c9 : 0xffb45e, depthTest: false,
      }))
      marker.position.set(...point)
      marker.renderOrder = 2
      this.inspection.add(marker)
    })
    if (points.length === 2) {
      const geometry = new BufferGeometry().setFromPoints(points.map(point => new Vector3(...point)))
      const segment = new LineSegments(geometry, new LineBasicMaterial({ color: 0xf4f7ff, depthTest: false }))
      segment.renderOrder = 2
      this.inspection.add(segment)
    }
    this.render()
  }

  setRotationCenter(position: XYZ) {
    const center = new Vector3(...position)
    this.camera.position.add(center.clone().sub(this.controls.target))
    this.controls.target.copy(center)
    this.mode = 'orbit'
    this.controls.enableRotate = true
    this.controls.update()
    this.cameraChanged()
  }

  setCursor(position: XYZ | null, progress: { ratio: number; segments: number; completed: number } | null, reveal = false) {
    this.hasCursor = !!position
    const material = (this.pathLines ?? this.pathPoints)?.material
    if (material) material.uniforms.cursor.value = progress?.ratio ?? -1
    // Clip the active line in the shader and show each pulse only once it completes.
    if (this.pathLines) drawThrough(this.pathLines.geometry, progress ? progress.segments * 2 : Infinity)
    if (this.pathPoints) drawThrough(this.pathPoints.geometry, progress ? progress.completed * 2 : Infinity)
    if (this.marker) {
      if (position) {
        this.marker.position.set(...position)
      }
      this.updateCursorVisibility()
      if (position && reveal && this.marker.visible) {
        const world = this.marker.getWorldPosition(new Vector3())
        this.camera.updateMatrixWorld()
        const screen = world.clone().project(this.camera)
        if (Math.abs(screen.x) > 0.95 || Math.abs(screen.y) > 0.95) {
          this.camera.position.add(world.clone().sub(this.controls.target))
          this.controls.target.copy(world)
          this.controls.update()
        }
      }
    }
    this.render()
  }

  setHideTravel(hidden: boolean) {
    const material = (this.pathLines ?? this.pathPoints)?.material
    if (material) material.uniforms.hideTravel.value = hidden
    this.render()
  }

  setGrayscale(enabled: boolean) {
    const material = (this.pathLines ?? this.pathPoints)?.material
    if (material) material.uniforms.grayscale.value = enabled
    this.render()
  }

  setPointAppearance(mode: PointAppearance, color: string) {
    updatePointUniforms(this.pathPointUniforms, mode, color)
    this.render()
  }

  setPointSlice(range: PointHeight | null) {
    this.slice.pointSlice.value.set(range?.[0] ?? 1, range?.[1] ?? 0)
    this.updateCursorVisibility()
    this.render()
  }

  private updateCursorVisibility() {
    if (!this.marker) return
    const { x: min, y: max } = this.slice.pointSlice.value
    const z = this.marker.position.z
    this.marker.visible = this.hasCursor && (min > max || (z >= min && z <= max))
  }

  refresh() {
    this.render()
  }

  dispose() {
    this.clear()
    cancelAnimationFrame(this.frame)
    this.observer.disconnect()
    this.controls.dispose()
    this.pickTarget?.dispose()
    this.renderer.domElement.removeEventListener('webglcontextlost', this.contextLost)
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.contextRestored)
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
