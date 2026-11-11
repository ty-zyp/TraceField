import { Box3, BufferGeometry, DoubleSide, Group, LoadingManager, Mesh, MeshStandardMaterial, Points, PointsMaterial, type Object3D } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { PCDLoader } from 'three/addons/loaders/PCDLoader.js'
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js'
import { disposeObject } from './viewport'
import { pointColorGLSL, pointSliceGLSL, pointSliceUniforms, pointUniforms, updatePointUniforms, type PointAppearance, type PointHeight } from './pointAppearance'

export async function loadModel(file: File, extension: string, asPoints = false) {
  let root = new Group()
  try {
    if (extension === 'glb') {
      const loader = new GLTFLoader(new LoadingManager())
      loader.manager.setURLModifier((url) => {
        if (/^(blob:|data:)/i.test(url)) return url
        throw new Error('GLB 的资源需要内嵌在文件中。')
      })
      const gltf = await loader.parseAsync(await file.arrayBuffer(), '')
      root.add(gltf.scene)
      root.rotation.x = Math.PI / 2
    } else if (extension === 'obj') {
      root.add(new OBJLoader().parse(await file.text()))
      root.rotation.x = Math.PI / 2
    } else if (extension === 'ply') {
      const bytes = await file.arrayBuffer()
      const header = new TextDecoder().decode(bytes.slice(0, 65_536)).split(/\bend_header\b/, 1)[0]
      const faceHeader = header.match(/^element[ \t]+face[ \t]+[1-9]\d*[^\r\n]*[\r\n]+((?:property[^\r\n]*[\r\n]+)*)/im)?.[1]
      const geometry = new PLYLoader().parse(bytes)
      const color = geometry.hasAttribute('color')
      const faceAttributes = faceHeader && (
        (/\btexcoord\s*$/im.test(faceHeader) && geometry.hasAttribute('uv')) ||
        (/\b(?:red|r)\s*$/im.test(faceHeader) && color)
      )
      if (geometry.index?.count || faceAttributes) {
        if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals()
        root.add(new Mesh(geometry, new MeshStandardMaterial({ color: color ? 0xffffff : 0x95b9ca, vertexColors: color, side: DoubleSide })))
      } else {
        root.add(new Points(geometry, new PointsMaterial({ color: color ? 0xffffff : 0x95d8ea, vertexColors: color })))
      }
    } else if (extension === 'pcd') {
      root.add(new PCDLoader().parse(await file.arrayBuffer()))
    }
    if (asPoints) {
      const vertices = new Group()
      root.updateMatrixWorld(true)
      root.traverseVisible((object) => {
        if (!(object instanceof Mesh)) return
        const position = object.geometry.getAttribute('position')
        if (!position?.count) return
        const geometry = new BufferGeometry()
        geometry.setAttribute('position', position)
        const color = object.geometry.getAttribute('color')
        if (color) geometry.setAttribute('color', color)
        const cloud = new Points(geometry, new PointsMaterial({ color: color ? 0xffffff : 0x95d8ea, vertexColors: !!color }))
        cloud.matrixAutoUpdate = false
        cloud.matrix.copy(object.matrixWorld)
        vertices.add(cloud)
      })
      disposeObject(root)
      root = vertices
    }
    let points = 0
    let meshes = 0
    let minZ = Infinity
    let maxZ = -Infinity
    const pointMaterials = new Set<PointsMaterial>()
    root.updateMatrixWorld(true)
    root.traverse((object) => {
      if (object instanceof Points) {
        const position = object.geometry.getAttribute('position')
        const indices = object.geometry.index
        const count = position ? indices?.count ?? position.count : 0
        points += count
        const matrix = object.matrixWorld.elements
        for (let i = 0; i < count; i++) {
          const index = indices ? indices.getX(i) : i
          const z = matrix[2] * position.getX(index) + matrix[6] * position.getY(index)
            + matrix[10] * position.getZ(index) + matrix[14]
          minZ = Math.min(minZ, z)
          maxZ = Math.max(maxZ, z)
        }
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          if (material instanceof PointsMaterial) pointMaterials.add(material)
        }
      }
      if (object instanceof Mesh) meshes += object.geometry.getAttribute('position')?.count ? 1 : 0
    })
    const bounds = new Box3().setFromObject(root)
    if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)) {
      throw new Error('文件没有可显示的有限坐标。')
    }
    const height: PointHeight | null = points ? [minZ, maxZ] : null
    const uniforms = pointUniforms(height ?? undefined)
    const slice = pointSliceUniforms()
    for (const material of pointMaterials) {
      material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms, slice)
        shader.vertexShader = `${pointColorGLSL}\n${pointSliceGLSL}\nvarying vec3 pointTint;\nvarying float sliceClipped;\n${shader.vertexShader}`
          .replace('#include <project_vertex>', `
            float pointZ = (modelMatrix * vec4(transformed, 1.0)).z;
            sliceClipped = outsidePointSlice(pointZ);
            if (pointAppearance != 0) pointTint = previewPointColor(pointZ);
            #include <project_vertex>`)
        shader.fragmentShader = `uniform int pointAppearance;\nvarying vec3 pointTint;\nvarying float sliceClipped;\n${shader.fragmentShader}`
          .replace('#include <color_fragment>', `
            if (sliceClipped > 0.5) discard;
            #include <color_fragment>
            if (pointAppearance != 0) diffuseColor.rgb = sRGBTransferEOTF(vec4(pointTint, 1.0)).rgb;`)
      }
    }
    return {
      root, points, meshes, bounds, height, slice,
      setAppearance: (mode: PointAppearance, color: string) => updatePointUniforms(uniforms, mode, color),
    }
  } catch (error) {
    disposeObject(root)
    throw error
  }
}

export function setPointSize(root: Object3D, size: number) {
  root.traverse((object) => {
    if (!(object instanceof Points)) return
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!(material instanceof PointsMaterial)) continue
      material.size = size
      if (material.sizeAttenuation) {
        material.sizeAttenuation = false
        material.needsUpdate = true
      }
    }
  })
}
