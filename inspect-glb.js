// Script to inspect GLB file contents
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { FileLoader } from 'three'
import fs from 'fs'
import path from 'path'

// Read the GLB file
const glbPath = './public/assets/models/roads.glb'
const buffer = fs.readFileSync(glbPath)
const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)

// Parse using three.js GLTFLoader
const loader = new GLTFLoader()
loader.parse(arrayBuffer, '', (gltf) => {
  console.log('=== GLB Contents ===\n')

  const meshes = []
  const materials = new Set()

  gltf.scene.traverse((child) => {
    if (child.isMesh) {
      const geo = child.geometry
      const bounds = geo.boundingBox || geo.computeBoundingBox() || geo.boundingBox
      geo.computeBoundingBox()
      const box = geo.boundingBox
      const size = {
        x: (box.max.x - box.min.x).toFixed(3),
        y: (box.max.y - box.min.y).toFixed(3),
        z: (box.max.z - box.min.z).toFixed(3)
      }

      meshes.push({
        name: child.name,
        vertices: geo.attributes.position.count,
        size: size,
        material: child.material?.name || 'unnamed'
      })

      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(m => materials.add(m.name || 'unnamed'))
        } else {
          materials.add(child.material.name || 'unnamed')
        }
      }
    }
  })

  console.log('MESHES:')
  console.log('-------')
  meshes.forEach(m => {
    console.log(`  ${m.name}`)
    console.log(`    size: ${m.size.x} x ${m.size.y} x ${m.size.z}`)
    console.log(`    vertices: ${m.vertices}`)
    console.log(`    material: ${m.material}`)
    console.log('')
  })

  console.log('\nMATERIALS:')
  console.log('----------')
  materials.forEach(m => console.log(`  ${m}`))

  console.log(`\nTotal meshes: ${meshes.length}`)
}, (error) => {
  console.error('Error parsing GLB:', error)
})
