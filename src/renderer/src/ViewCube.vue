<script setup lang="ts">
import type { XYZ } from '../../shared/gcode'
import type { ViewOrientation } from './viewport'

defineProps<{ orientation: ViewOrientation }>()
const emit = defineEmits<{ select: [direction: XYZ]; reset: [] }>()

const faces: { name: string; direction: XYZ; rotation: string; axis: number }[] = [
  { name: '顶', direction: [0, 0, 1], rotation: '', axis: 2 },
  { name: '底', direction: [0, 0, -1], rotation: 'rotateY(180deg)', axis: 2 },
  { name: '前', direction: [0, -1, 0], rotation: 'rotateX(-90deg)', axis: 1 },
  { name: '后', direction: [0, 1, 0], rotation: 'rotateX(90deg)', axis: 1 },
  { name: '右', direction: [1, 0, 0], rotation: 'rotateY(90deg)', axis: 0 },
  { name: '左', direction: [-1, 0, 0], rotation: 'rotateY(-90deg)', axis: 0 },
]
</script>

<template>
  <div class="view-nav" role="group" aria-label="视角导航">
    <button class="view-home" type="button" title="恢复默认视角" aria-label="恢复默认视角" @click="emit('reset')">⌂</button>
    <div class="view-cube" :style="{ transform: orientation.transform }">
      <button v-for="face in faces" :key="face.name" class="view-face" type="button"
        :style="{ transform: face.rotation + ' translateZ(26px)' }"
        :tabindex="orientation.facing[face.axis] * face.direction[face.axis] > 0.05 ? 0 : -1"
        :title="face.name + '视图'" :aria-label="face.name + '视图'" @click="emit('select', face.direction)">
        {{ face.name }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.view-nav {
  position: absolute;
  top: 14px;
  right: 16px;
  width: 110px;
  height: 96px;
  pointer-events: none;
}
.view-home {
  position: absolute;
  top: 0;
  left: 0;
  width: 28px;
  height: 28px;
  min-height: 0;
  padding: 0;
  font: 22px/24px "Segoe UI Symbol", sans-serif;
  pointer-events: auto;
}
.view-cube {
  position: absolute;
  top: 25px;
  right: 13px;
  width: 52px;
  height: 52px;
  transform-style: preserve-3d;
}
.view-face {
  position: absolute;
  inset: 0;
  padding: 0;
  border: 1px solid #527084;
  border-radius: 2px;
  background: #233747;
  color: #e4eff4;
  font-weight: 600;
  backface-visibility: hidden;
  pointer-events: auto;
}
.view-face:hover, .view-face:focus-visible {
  background: #304f57;
  color: var(--mint);
}
</style>
