/*
 * FlowLayer: a PathLayer whose lines carry small white dots drifting downstream in
 * lanes across the river's width, drawn in the fragment shader (no particle state).
 *
 * Each vertex has a flow time s (network.ts). In a lane, a dot sits wherever
 * `time − laneTime` is a multiple of a period, with
 *   laneTime = s × (1 + bankDrag × u²) + u × bend × c + laneOffset
 * where u is the lane's position across the river (−1 right bank … +1 left bank, looking
 * downstream). As `time` grows the dots move to larger flow times, i.e. downstream, at
 * each arc's velocity; lanes near the banks are slower (bankDrag), and c, the "bend
 * lead" (network.ts), moves the outer lanes ahead through a bend and lets the inner ones
 * fall behind. Each lane has its own random phase, and a random share of the dot slots
 * (1 − density) stays empty, so dots don't march in rows.
 *
 * Spacing: the period is chosen per pixel, so dot slots are about `spacing` pixels apart
 * on any river at any zoom (a fast river's dots are as dense as a slow one's; they just
 * move faster). The shader knows how many hours of flow a pixel spans (the screen
 * derivative of s), and takes the power of two of hours just below `spacing` pixels'
 * worth. Halving the period keeps every dot of the coarser one (the even ones) and adds
 * one in between each pair (the odd ones); those fade in as the spacing they'd make
 * nears `spacing`, so where the period changes (zooming, or along a river as it speeds
 * up) dots thin out or fill in gradually, never jump. A dot's identity (which decides
 * if its slot is empty) is its place in hours, the same at every period.
 *
 * Two sets of flow times and bend leads (A and B, packed in one vec4 attribute:
 * PathLayer already uses 13 of WebGL's 16 vertex attributes) let a change of velocities
 * cross-fade (`blend`) instead of making all the dots jump to their new places.
 */
import type { DefaultProps } from "@deck.gl/core";
import { PathLayer, type PathLayerProps } from "@deck.gl/layers";
import type { ShaderModule } from "@luma.gl/shadertools";

/** The animation clock wraps at this many hours (a multiple of every period's 2×). */
export const FLOW_WRAP = 4096;

export type FlowUniforms = {
  /** Animation clock, hours of flow, wrapped at FLOW_WRAP. */
  time: number;
  /** Space between dot slots in a lane, CSS pixels. */
  spacing: number;
  /** 0: flow times A, 1: flow times B. */
  blend: number;
  /** Brightness of the river under the dots (its colour × this, over black), 0–1. */
  baseBrightness: number;
  /** Dot radius, CSS pixels. */
  radius: number;
  /** Space between lanes, CSS pixels. */
  laneSpacing: number;
  /** Tail upstream of a dot, in dot radii. */
  tail: number;
  /** Share of dot slots that have a dot, 0–1. */
  density: number;
  /** How much slower the bank lanes are (0: not at all). */
  bankDrag: number;
  /** How much a bend moves the outer lanes ahead (0: not at all, 1: the most). */
  bend: number;
  pixelRatio: number;
};

const uniformBlock = `\
layout(std140) uniform flowUniforms {
  float time;
  float spacing;
  float blend;
  float baseBrightness;
  float radius;
  float laneSpacing;
  float tail;
  float density;
  float bankDrag;
  float bend;
  float pixelRatio;
} flow;
`;

const flowUniforms = {
  name: "flow",
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: {
    time: "f32",
    spacing: "f32",
    blend: "f32",
    baseBrightness: "f32",
    radius: "f32",
    laneSpacing: "f32",
    tail: "f32",
    density: "f32",
    bankDrag: "f32",
    bend: "f32",
    pixelRatio: "f32",
  },
} as const satisfies ShaderModule<FlowUniforms>;

const injections = {
  "vs:#decl": `\
in vec4 instanceFlows;
in vec4 instanceNextFlows;
out vec4 vFlows;
out float vHalfWidth;
`,
  "vs:#main-end": `\
float flowR = vPathLength > 0.0 ? vPathPosition.y / vPathLength : 0.0;
vFlows = mix(instanceFlows, instanceNextFlows, flowR);
vHalfWidth = widthPixels.x;
`,
  "fs:#decl": `\
in vec4 vFlows;
in float vHalfWidth;

const float FLOW_WRAP = ${FLOW_WRAP.toFixed(1)};

float flowHash(float n) {
  return fract(sin(n * 12.9898 + 78.233) * 43758.5453);
}

// Opacity of the dot nearest this fragment in its lane, for flow time s and bend lead c,
// at u across the river: -1 (right bank) to 1 (left bank). (PathLayer's vPathPosition is
// declared after the injected code; it reaches the filter as geometry.uv.)
float flowDots(float s, float c, float u) {
  float lanes = clamp(floor(2.0 * vHalfWidth / flow.laneSpacing), 1.0, 8.0);
  float lane = clamp(floor((u + 1.0) * 0.5 * lanes), 0.0, lanes - 1.0);
  float uc = (lane + 0.5) / lanes * 2.0 - 1.0;
  float laneTime = s * (1.0 + flow.bankDrag * uc * uc) + uc * flow.bend * c + flowHash(lane + 1.0) * FLOW_WRAP;

  // Hours of flow per device pixel along the river, and the period from it: a power of
  // two of hours (at most FLOW_WRAP / 4), with the odd dots fading out as the spacing
  // nears twice the target.
  float hoursPerPx = max(length(vec2(dFdx(s), dFdy(s))), 1e-7);
  float level = clamp(log2(flow.spacing * flow.pixelRatio * hoursPerPx), -16.0, log2(FLOW_WRAP) - 2.001);
  float period = exp2(floor(level));
  float oddFade = 1.0 - fract(level);

  float x = flow.time - laneTime;
  float k = floor(x / period);
  float behind = x - k * period; // hours since dot k passed this point

  // The nearer of dot k (downstream of here) and dot k + 1 (upstream of here).
  bool upcoming = period - behind < behind;
  float kd = upcoming ? k + 1.0 : k;
  float alongPx = upcoming ? -(period - behind) / hoursPerPx : behind / hoursPerPx; // > 0: in its tail
  float acrossPx = (u - uc) * vHalfWidth * flow.pixelRatio;
  float r = flow.radius * flow.pixelRatio;
  float along = alongPx > 0.0 ? alongPx / (1.0 + flow.tail) : alongPx;
  float a = 1.0 - smoothstep(r - 0.75, r + 0.75, length(vec2(along, acrossPx)));
  if (alongPx > 0.0) a *= 1.0 - 0.75 * clamp(alongPx / (r * (1.0 + flow.tail)), 0.0, 1.0);

  // The dot's identity: its place in hours (the same at every period), wrapped as the
  // clock wraps.
  float id = mod(kd * period, FLOW_WRAP) * 0.01 + lane * 7.31;
  if (flowHash(id) > flow.density) a = 0.0;
  if (mod(kd, 2.0) > 0.5) a *= oddFade;
  return a;
}
`,
  "fs:DECKGL_FILTER_COLOR": `\
float dots = mix(flowDots(vFlows.x, vFlows.z, geometry.uv.x), flowDots(vFlows.y, vFlows.w, geometry.uv.x), flow.blend);
// Opaque: color.a is only PathLayer's edge antialiasing, so where segments overlap (at
// corners) they paint the same colour twice instead of adding up. Rivers too thin to hold
// a dot, or faded (small streams zoomed out: their colour is faded towards black), fade
// their dots too.
dots *= smoothstep(0.5, 1.5, vHalfWidth) * smoothstep(0.15, 0.6, max(color.r, max(color.g, color.b)));
color.rgb = mix(color.rgb * flow.baseBrightness, vec3(1.0), dots);
`,
};

type FlowLayerProps<D> = PathLayerProps<D> &
  FlowUniforms & {
    /** Per vertex: flow time A, B (hours), bend lead A, B (hours); a path's values one vertex after another. */
    getFlows: (d: D, info: { index: number }) => ArrayLike<number>;
  };

const defaultProps: DefaultProps<FlowLayerProps<unknown>> = {
  time: 0,
  spacing: 16,
  blend: 0,
  baseBrightness: 0.5,
  radius: 1.3,
  laneSpacing: 4,
  tail: 1.5,
  density: 0.65,
  bankDrag: 0.25,
  bend: 1,
  pixelRatio: 1,
  getFlows: { type: "accessor", value: () => [] },
};

export class FlowLayer<D = unknown> extends PathLayer<D, FlowLayerProps<D>> {
  static layerName = "FlowLayer";
  static defaultProps = defaultProps;

  getShaders() {
    const shaders = super.getShaders();
    return { ...shaders, inject: injections, modules: [...shaders.modules, flowUniforms] };
  }

  initializeState() {
    super.initializeState();
    // Four values per vertex; each segment reads its start (offset 0) and end (offset 1).
    this.getAttributeManager()!.addInstanced({
      flows: {
        size: 4,
        accessor: "getFlows",
        shaderAttributes: { instanceFlows: { vertexOffset: 0 }, instanceNextFlows: { vertexOffset: 1 } },
      },
    });
  }

  draw(params: Parameters<PathLayer["draw"]>[0]) {
    const p = this.props;
    const flow: FlowUniforms = {
      time: p.time,
      spacing: p.spacing,
      blend: p.blend,
      baseBrightness: p.baseBrightness,
      radius: p.radius,
      laneSpacing: p.laneSpacing,
      tail: p.tail,
      density: p.density,
      bankDrag: p.bankDrag,
      bend: p.bend,
      pixelRatio: p.pixelRatio,
    };
    this.state.model!.shaderInputs.setProps({ flow });
    super.draw(params);
  }
}
