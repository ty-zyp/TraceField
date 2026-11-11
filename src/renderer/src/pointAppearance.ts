import { Color, Vector2 } from 'three'

export type PointAppearance = 'original' | 'white' | 'solid' | 'height'
export type PointHeight = [min: number, max: number]

export function pointSliceUniforms() {
  return { pointSlice: { value: new Vector2(1, 0) } }
}

export const pointSliceGLSL = `
  uniform vec2 pointSlice;
  float outsidePointSlice(float z) {
    return pointSlice.x <= pointSlice.y && (z < pointSlice.x || z > pointSlice.y) ? 1.0 : 0.0;
  }
`

export function pointUniforms(height: PointHeight = [0, 0]) {
  return {
    pointAppearance: { value: 0 },
    pointColor: { value: new Color(0xffffff) },
    pointHeight: { value: new Vector2(...height) },
  }
}

export function updatePointUniforms(uniforms: ReturnType<typeof pointUniforms>, mode: PointAppearance, color: string) {
  uniforms.pointAppearance.value = mode === 'original' ? 0 : mode === 'height' ? 2 : 1
  uniforms.pointColor.value.set(mode === 'white' ? '#ffffff' : color).convertLinearToSRGB()
}

export const pointColorGLSL = `
  uniform int pointAppearance;
  uniform vec3 pointColor;
  uniform vec2 pointHeight;

  vec3 previewPointColor(float z) {
    if (pointAppearance == 1) return pointColor;
    float range = pointHeight.y - pointHeight.x;
    float t = range > 0.0 ? clamp((z - pointHeight.x) / range, 0.0, 1.0) : 0.5;
    vec3 low = vec3(59.0, 130.0, 246.0) / 255.0;
    vec3 mid = vec3(52.0, 211.0, 153.0) / 255.0;
    vec3 high = vec3(251.0, 191.0, 36.0) / 255.0;
    return t < 0.5 ? mix(low, mid, t * 2.0) : mix(mid, high, (t - 0.5) * 2.0);
  }
`
