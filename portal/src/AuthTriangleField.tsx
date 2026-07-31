import { useEffect, useRef } from 'react'

const vertexShader = /* glsl */ `
  void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform vec2 uResolution;
  uniform float uTime;
  uniform vec3 uCoral;
  uniform vec3 uEmber;

  out vec4 fragColor;

  float randomValue(vec2 point) {
    return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float valueNoise(vec2 point) {
    vec2 cell = floor(point);
    vec2 offset = fract(point);
    vec2 curve = offset * offset * (3.0 - 2.0 * offset);

    float lower = mix(randomValue(cell), randomValue(cell + vec2(1.0, 0.0)), curve.x);
    float upper = mix(randomValue(cell + vec2(0.0, 1.0)), randomValue(cell + vec2(1.0, 1.0)), curve.x);
    return mix(lower, upper, curve.y);
  }

  float layeredNoise(vec2 point) {
    float value = 0.0;
    float weight = 0.55;
    mat2 turn = mat2(0.80, -0.60, 0.60, 0.80);

    for (int octave = 0; octave < 4; octave += 1) {
      value += valueNoise(point) * weight;
      point = turn * point * 1.92 + 7.4;
      weight *= 0.5;
    }
    return value;
  }

  float bayerThreshold(ivec2 cell) {
    const float matrix[16] = float[16](
       0.0,  8.0,  2.0, 10.0,
      12.0,  4.0, 14.0,  6.0,
       3.0, 11.0,  1.0,  9.0,
      15.0,  7.0, 13.0,  5.0
    );
    int x = int(mod(float(cell.x), 4.0));
    int y = int(mod(float(cell.y), 4.0));
    return (matrix[y * 4 + x] + 0.5) / 16.0;
  }

  float triangleMask(vec2 localPosition, ivec2 cell) {
    if (mod(float(cell.x + cell.y), 2.0) > 0.5) {
      localPosition.x = 1.0 - localPosition.x;
    }

    float inset = 0.09;
    float diagonal = 1.0 - inset - localPosition.x - localPosition.y;
    float edge = max(fwidth(diagonal), 0.002);
    float triangle = smoothstep(-edge, edge, diagonal);
    triangle *= smoothstep(inset - edge, inset + edge, localPosition.x);
    triangle *= smoothstep(inset - edge, inset + edge, localPosition.y);
    return triangle;
  }

  void main() {
    float cellSize = clamp(min(uResolution.x, uResolution.y) / 78.0, 8.0, 14.0);
    vec2 gridPosition = gl_FragCoord.xy / cellSize;
    ivec2 cell = ivec2(floor(gridPosition));
    vec2 localPosition = fract(gridPosition);

    vec2 centered = (gl_FragCoord.xy - 0.5 * uResolution) / uResolution.y;
    vec2 drift = vec2(uTime * 0.035, -uTime * 0.022);
    float broadField = layeredNoise(centered * 1.65 + drift);
    float detailField = layeredNoise(centered * 3.4 - drift * 1.7);
    float diagonalFlow = sin((centered.x * 0.72 + centered.y) * 5.5 - uTime * 0.24) * 0.08;
    float density = broadField * 0.72 + detailField * 0.28 + diagonalFlow - 0.43;

    float centerDistance = length(centered * vec2(0.78, 1.0));
    density -= (1.0 - smoothstep(0.16, 0.52, centerDistance)) * 0.23;

    float coverage = smoothstep(0.08, 0.56, density);
    float visibleCell = step(bayerThreshold(cell), coverage);
    float triangle = triangleMask(localPosition, cell);
    float colorMix = clamp(0.2 + centered.y * 0.28 + detailField * 0.48, 0.0, 1.0);
    vec3 color = mix(uCoral, uEmber, colorMix);
    float alpha = visibleCell * triangle * mix(0.82, 1.0, coverage);

    fragColor = vec4(color, alpha);
  }
`

export function AuthTriangleField() {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let disposed = false
    let disposeScene = () => {}

    void (async () => {
      const THREE = await import('three')
      if (disposed) return

      const canvas = document.createElement('canvas')
      canvas.className = 'auth-triangle-canvas'
      host.appendChild(canvas)

      let renderer: InstanceType<typeof THREE.WebGLRenderer>
      try {
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: 'high-performance' })
      } catch {
        canvas.remove()
        return
      }

      renderer.setClearColor(0x000000, 0)
      renderer.outputColorSpace = THREE.SRGBColorSpace

      const scene = new THREE.Scene()
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
      const uniforms = {
        uResolution: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 },
        uCoral: { value: new THREE.Color('#ed7b66') },
        uEmber: { value: new THREE.Color('#ff9258') },
      }
      const material = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms,
        glslVersion: THREE.GLSL3,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      })
      const geometry = new THREE.PlaneGeometry(2, 2)
      scene.add(new THREE.Mesh(geometry, material))

      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const startedAt = performance.now()
      let animationFrame = 0
      let lastPaint = -Infinity

      const draw = (now: number) => {
        uniforms.uTime.value = reduceMotion ? 0 : (now - startedAt) / 1000
        renderer.render(scene, camera)
      }

      const resize = () => {
        const width = Math.max(1, host.clientWidth)
        const height = Math.max(1, host.clientHeight)
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
        renderer.setSize(width, height, false)
        uniforms.uResolution.value.set(canvas.width, canvas.height)
        draw(performance.now())
      }

      const animate = (now: number) => {
        if (document.visibilityState === 'visible' && now - lastPaint >= 32) {
          lastPaint = now
          draw(now)
        }
        animationFrame = window.requestAnimationFrame(animate)
      }

      const resizeObserver = new ResizeObserver(resize)
      resizeObserver.observe(host)
      resize()

      if (!reduceMotion) {
        animationFrame = window.requestAnimationFrame(animate)
      }

      disposeScene = () => {
        window.cancelAnimationFrame(animationFrame)
        resizeObserver.disconnect()
        geometry.dispose()
        material.dispose()
        renderer.dispose()
        canvas.remove()
      }
    })()

    return () => {
      disposed = true
      disposeScene()
    }
  }, [])

  return <div ref={hostRef} className="auth-triangle-field" aria-hidden="true" />
}
