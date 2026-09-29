// Ch-ch-chain-ges — walking the streets in 3D. A city's real streets, buildings (their heights where OSM knows
// them), pavements with painted kerbs, parks, trees and the sea, drawn with WebGL 2 from the map files; you walk them
// at eye height, look around by dragging, walk with your left thumb or by tapping the street where you want to go.
// People wait on the pavements and wave when you come near; walk up to them and they join your chain, following
// behind you. Nothing here talks to the server: it is a walk on this phone.
import { AREA_STYLE } from './map.js';
import { pacer } from './pace.js';
import {
  TILE, FLOOR, ROADS, streetCity, streetNamer, personModel, treeModel, seeded, rgb, hash2, inRing, nearestOnRing,
} from './street3d.js';

const EYE = 1.62; // metres
const WALK = 3.4; // m/s: a brisk walk (a game, not a stroll)
const RUN = 8;
const FAR = 480; // the fog is complete here, and nothing is drawn beyond
const FOG_START = 110;
const MAX_PEOPLE = 420;
const SIGNS_MAX = 64;
const WAITING = 26; // people waiting around you at any time
const CHAIN = '#1f5fd6'; // the shirts of people in your chain
const NEAR = 256; // metres a side of the sharp ground painted around you
const NEAR_PX = 1024; // its pixels a side: 4 a metre
const GROUND_CELL = 40;
const GROUND_N = 28; // squares a side: 1120 m, past the haze
const STONE = new Set(['jerusalem', 'maale-adumim', 'beitar-illit', 'beit-shemesh', 'modiin-illit', 'safed', 'ariel']);

// The land as seen from the street: paler, dustier and greener than the map's paper colours.
const GROUND = {
  land: '#cbc3b1',
  residential: '#c6c1ab',
  commercial: '#cdc5b8',
  industrial: '#bcb8b1',
  parking: '#8e8d8a',
  school: '#d1c7ae',
  hospital: '#cfc8bb',
  cemetery: '#9dab85',
  sport: '#7da458',
  farmland: '#b3aa76',
  forest: '#5d8243',
  sand: '#ddcc9c',
  green: '#7ba350',
  beach: '#e6d6a6',
  water: '#3b6c79',
};

const SHIRTS = ['#e5484d', '#f59e0b', '#12a594', '#8e4ec6', '#e93d82', '#f2f2f0', '#27272a', '#46a758', '#f76b15', '#0891b2', '#a18072', '#d6c3a5', '#6e56cf', '#fbbf24'];
const PANTS = ['#2f4a6d', '#1f2937', '#a89274', '#4b5563', '#e5e7eb', '#5b6b3a'];
const SKIN = ['#f1c7a4', '#e0ac85', '#c68b62', '#a8704a', '#7d4f35', '#f5d4b8'];
const HAIR = ['#1c1917', '#3f2a1d', '#6b4a2f', '#c9a36b', '#9ca3af', '#7c3a1d'];
const packRGB = (hex) => {
  const [r, g, b] = rgb(hex);
  return r * 65536 + g * 256 + b;
};

// ------------------------------------------------------------------------------------------------ shaders
const COMMON = `
precision highp float;
uniform vec3 u_eye;
uniform vec3 u_fogc;
uniform vec2 u_fogr;
uniform vec3 u_sun;
uniform vec3 u_zen;
uniform float u_time;
// The haze lies low: high up (the tops of towers) it is thinner, so a skyline shows over the town from afar.
vec3 fogged(vec3 c, vec3 p) {
  float d = distance(p, u_eye) * mix(1.0, 0.12, smoothstep(10.0, 160.0, p.y));
  float f = clamp((d - u_fogr.x) / (u_fogr.y - u_fogr.x), 0.0, 1.0);
  return mix(c, u_fogc, f * f * (3.0 - 2.0 * f));
}
vec3 skyc(vec3 d) {
  return mix(u_fogc, u_zen, pow(clamp(d.y, 0.0, 1.0), 0.5));
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}
float band(float x, float c, float w) {
  float px = fwidth(x) + 1e-4;
  return 1.0 - smoothstep(w - px, w + px, abs(x - c));
}
`;

const SKY_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_ndc;
void main() { v_ndc = a_pos; gl_Position = vec4(a_pos, 0.9999, 1.0); }`;
const SKY_FS = `#version 300 es
${COMMON}
in vec2 v_ndc;
out vec4 o;
uniform vec3 u_fw;
uniform vec3 u_rt;
uniform vec3 u_up;
uniform vec2 u_tan;
void main() {
  vec3 d = normalize(u_fw + u_rt * v_ndc.x * u_tan.x + u_up * v_ndc.y * u_tan.y);
  vec3 c = skyc(d);
  if (d.y > 0.0) {
    // A few light clouds, drifting.
    vec2 q = d.xz / (d.y + 0.08) * 0.9 + vec2(u_time * 0.004, u_time * 0.002);
    float n = vnoise(q) * 0.55 + vnoise(q * 2.3) * 0.3 + vnoise(q * 5.1) * 0.15;
    float cl = smoothstep(0.58, 0.82, n) * smoothstep(0.02, 0.25, d.y);
    c = mix(c, vec3(0.97, 0.97, 0.96), cl * 0.75);
  }
  float s = max(dot(d, u_sun), 0.0);
  c += vec3(1.0, 0.92, 0.76) * (pow(s, 900.0) * 1.8 + pow(s, 14.0) * 0.16);
  o = vec4(c, 1.0);
}`;

// The ground: a grid of 40 m squares following the walker (small triangles: a huge one reaching behind the eye loses
// depth precision on some phones, and the streets drawn over it then vanish).
const GROUND_VS = `#version 300 es
in vec2 a_pos;
uniform mat4 u_vp;
uniform vec2 u_origin;
out vec3 v_p;
void main() { v_p = vec3(a_pos.x + u_origin.x, 0.0, a_pos.y + u_origin.y); gl_Position = u_vp * vec4(v_p, 1.0); }`;
const GROUND_FS = `#version 300 es
${COMMON}
in vec3 v_p;
out vec4 o;
uniform sampler2D u_ground;
uniform sampler2D u_water;
uniform sampler2D u_nearGround;
uniform sampler2D u_nearWater;
uniform vec3 u_near;
uniform float u_E;
void main() {
  vec2 uv = (v_p.xz + u_E) / (2.0 * u_E);
  // Around you, a sharp picture of the ground (4 pixels a metre); further off, the whole town's (softer), blended
  // over the last few metres.
  vec2 nuv = (v_p.xz - u_near.xy) / u_near.z;
  float edge = min(min(nuv.x, 1.0 - nuv.x), min(nuv.y, 1.0 - nuv.y));
  float nf = u_near.z > 0.0 ? smoothstep(0.0, 0.1, edge) : 0.0;
  vec3 land = mix(texture(u_ground, uv).rgb, texture(u_nearGround, nuv).rgb, nf);
  land *= 0.9 + vnoise(v_p.xz * 0.6) * 0.12 + vnoise(v_p.xz * 3.1) * 0.06;
  float w = mix(texture(u_water, uv).r, texture(u_nearWater, nuv).r, nf);
  vec3 c = land;
  if (w > 0.02) {
    vec3 V = normalize(v_p - u_eye);
    vec2 q = v_p.xz * 0.3 + vec2(u_time * 0.35, u_time * 0.21);
    vec3 N = normalize(vec3((vnoise(q) - 0.5) * 0.3 + (vnoise(q * 2.7) - 0.5) * 0.15, 1.0, (vnoise(q + 19.0) - 0.5) * 0.3));
    vec3 R = reflect(V, N);
    float fres = 0.05 + 0.95 * pow(1.0 - max(dot(-V, N), 0.0), 5.0);
    vec3 sea = mix(vec3(0.09, 0.31, 0.40), skyc(R), fres);
    sea += vec3(1.0, 0.95, 0.82) * pow(max(dot(R, u_sun), 0.0), 220.0) * 1.4;
    // Foam where the sea meets the beach.
    sea = mix(sea, vec3(0.93), smoothstep(0.62, 0.45, w) * (0.35 + 0.35 * vnoise(q * 3.0)));
    c = mix(land, sea, smoothstep(0.3, 0.6, w));
  }
  o = vec4(fogged(c, v_p), 1.0);
}`;

// Everything on the ground lies at height 0; each layer is drawn a little nearer than the one under it by sliding its
// corners towards the eye along the line of sight (so they stay on the same pixels): a fixed share of the distance,
// which the depth buffer can always tell apart, near or far, whatever order the tiles are drawn in.
const ROAD_VS = `#version 300 es
in vec2 a_pos;
in vec4 a_road;
in vec4 a_info;
uniform mat4 u_vp;
uniform vec3 u_eye;
uniform float u_eps;
out vec3 v_p;
out vec4 v_road;
flat out vec4 v_info;
void main() {
  v_p = vec3(a_pos.x, 0.0, a_pos.y);
  v_road = a_road;
  v_info = a_info;
  gl_Position = u_vp * vec4(v_p + (u_eye - v_p) * (a_info.y * u_eps), 1.0);
}`;
const ROAD_FS = `#version 300 es
${COMMON}
in vec3 v_p;
in vec4 v_road;
flat in vec4 v_info;
out vec4 o;
void main() {
  float along = v_road.x;
  float acr = v_road.y * v_road.w;
  float total = v_road.z;
  float hw = v_road.w;
  float cls = v_info.x;
  float a = abs(acr);
  float e = min(along, total - along); // how far from the nearest end (a junction, usually)
  vec3 c;
  if (cls < 2.5) {
    c = vec3(0.29, 0.30, 0.32) * (0.9 + vnoise(v_p.xz * 1.3) * 0.12 + hash12(floor(v_p.xz * 9.0)) * 0.05);
    float paint = 0.0;
    if (e > 3.0) {
      if (cls < 0.5) {
        paint = band(a, 0.18, 0.06); // a double line in the middle
        paint = max(paint, band(a, hw * 0.5, 0.07) * step(fract(along / 6.0), 0.45));
      } else if (cls < 1.5) {
        paint = band(acr, 0.0, 0.07) * step(fract(along / 9.0), 0.4);
      }
    }
    // Zebra crossings where the street meets the next one.
    if (total > 26.0 && e > 2.2 && e < 5.6 && a < hw - 0.35) paint = max(paint, step(0.5, fract(acr + 0.25)));
    c = mix(c, vec3(0.9, 0.9, 0.88), paint * 0.92);
  } else if (cls < 3.5) {
    c = vec3(0.36, 0.365, 0.37) * (0.9 + vnoise(v_p.xz * 1.1) * 0.14);
  } else if (cls < 4.5) {
    c = vec3(0.54, 0.50, 0.46) * (0.85 + hash12(floor(v_p.xz * 12.0)) * 0.2);
    if (a < 1.25) c = mix(c, vec3(0.36, 0.30, 0.25), step(fract(along / 0.62), 0.3));
    c = mix(c, vec3(0.74, 0.74, 0.76), band(a, 0.72, 0.04));
  } else if (cls < 5.5) {
    c = vec3(0.80, 0.76, 0.68);
    float row = floor(along / 0.3);
    float g = max(band(fract(along / 0.3), 0.0, 0.05), band(fract(acr / 0.2 + mod(row, 2.0) * 0.5), 0.0, 0.06));
    c *= 1.0 - g * 0.12;
  } else {
    // The pavement: square slabs, and its kerb along the street, sometimes painted.
    c = vec3(0.77, 0.75, 0.71) * (0.95 + vnoise(v_p.xz * 2.0) * 0.08);
    float g = max(band(fract(along / 0.5), 0.0, 0.03), band(fract(acr / 0.5), 0.0, 0.03));
    c *= 1.0 - g * 0.1;
    float inner = v_info.w * 0.1;
    if (a > inner - 0.02 && a < inner + 0.24) {
      float kerb = v_info.z;
      float s = step(fract(along / 1.0), 0.5);
      vec3 k = vec3(0.86, 0.85, 0.82);
      if (kerb > 0.5 && kerb < 1.5) k = mix(vec3(0.95), vec3(0.78, 0.16, 0.14), s);
      if (kerb > 1.5) k = mix(vec3(0.95), vec3(0.10, 0.30, 0.72), s);
      c = k;
    }
  }
  o = vec4(fogged(c, v_p), 1.0);
}`;

const BUILDING_VS = `#version 300 es
in vec3 a_pos;
in vec3 a_nrm;
in vec2 a_uv;
in vec4 a_col;
uniform mat4 u_vp;
out vec3 v_p;
out vec3 v_n;
out vec2 v_uv;
out vec3 v_c;
flat out float v_fl;
void main() {
  v_p = a_pos;
  v_n = a_nrm;
  v_uv = a_uv;
  v_c = a_col.rgb;
  v_fl = floor(a_col.a * 255.0 + 0.5);
  gl_Position = u_vp * vec4(a_pos, 1.0);
}`;
const BUILDING_FS = `#version 300 es
${COMMON}
in vec3 v_p;
in vec3 v_n;
in vec2 v_uv;
in vec3 v_c;
flat in float v_fl;
out vec4 o;
const float FLOOR = ${FLOOR.toFixed(2)};
float box(float x, float c, float w) { return band(x, c, w); }
void main() {
  float style = mod(v_fl, 4.0);
  bool roof = mod(floor(v_fl / 4.0), 2.0) > 0.5;
  bool shops = mod(floor(v_fl / 8.0), 2.0) > 0.5;
  float variant = floor(v_fl / 16.0);
  vec3 n = normalize(v_n);
  vec3 V = normalize(v_p - u_eye);
  vec3 c = v_c;
  if (roof) {
    c = mix(c, vec3(0.60, 0.58, 0.55), 0.55) * (0.88 + vnoise(v_uv * 0.4) * 0.16);
  } else {
    float u = v_uv.x;
    float h = v_uv.y;
    float fv = h / FLOOR;
    float fy = fract(fv);
    float fu = fract(u);
    float storey = floor(fv);
    vec3 glass = mix(vec3(0.15, 0.19, 0.24), skyc(reflect(V, n)), 0.3 + 0.45 * pow(1.0 - abs(dot(V, n)), 3.0));
    // Too far to draw the windows one by one: their average instead (no shimmer).
    float fine = clamp(max(fwidth(u), fwidth(fv)) * 3.0 - 0.4, 0.0, 1.0);
    float win = 0.0;
    float frame = 0.0;
    float shutter = 0.0;
    if (u >= 0.0 && h > 0.6) {
      if (style < 0.5) {
        float ww = 0.2 + 0.05 * mod(variant, 3.0);
        float opening = box(fu, 0.5, ww) * box(fy, 0.56, 0.23);
        // Roller shutters (trisim), some of them part of the way down.
        float sh = hash12(vec2(floor(u) + variant * 7.0, storey));
        float down = sh < 0.35 ? 1.0 - step(fy, 0.79 - sh * 0.9) : 0.0;
        win = opening * (1.0 - down);
        shutter = opening * down;
        frame = max(box(fu, 0.5, ww + 0.035) * box(fy, 0.56, 0.26) - opening, 0.0);
        // Slab lines between the floors (balconies, on some buildings).
        if (mod(variant, 2.0) > 0.5) c *= 1.0 - 0.1 * box(fy, 0.02, 0.035);
      } else if (style < 1.5) {
        win = box(fy, 0.58, 0.27) * (1.0 - band(fract(u * 2.0), 0.0, 0.05));
      } else if (style < 2.5) {
        win = 1.0 - max(band(fract(u * 2.0), 0.0, 0.04), box(fy, 0.0, 0.04));
      }
    }
    vec3 wall = c;
    c = mix(c, glass, clamp(win, 0.0, 1.0));
    c = mix(c, vec3(0.80, 0.78, 0.73), clamp(shutter, 0.0, 1.0));
    c = mix(c, wall * 0.82, clamp(frame, 0.0, 1.0) * 0.6);
    if (shops && h < FLOOR && u >= 0.0) {
      // Shop fronts: big windows lit from inside, a sign band over them.
      float sw = box(fu, 0.5, 0.42) * box(h, 1.45, 1.1);
      vec3 inside = mix(vec3(0.22, 0.2, 0.17), vec3(0.62, 0.52, 0.38), hash12(vec2(floor(u), variant)));
      c = mix(c, mix(inside, glass, 0.35), sw);
      vec3 signc = vec3(0.12 + 0.6 * hash12(vec2(variant, 3.0)), 0.2 + 0.5 * hash12(vec2(variant, 5.0)), 0.25 + 0.5 * hash12(vec2(variant, 9.0)));
      c = mix(c, signc, box(h, 2.82, 0.2) * (1.0 - band(fu, 0.0, 0.02)));
    }
    c = mix(c, mix(wall, glass, style > 1.5 ? 0.8 : style > 0.5 ? 0.45 : 0.25), fine);
    c *= mix(0.72, 1.0, smoothstep(0.0, 2.8, h)); // darker at the foot of the wall
  }
  float lit = 0.6 + 0.42 * max(dot(n, u_sun), 0.0) + 0.05 * n.y;
  o = vec4(fogged(c * lit, v_p), 1.0);
}`;

const TREE_VS = `#version 300 es
in vec3 a_pos;
in vec3 a_nrm;
in float a_part;
in vec4 i_tree;
uniform mat4 u_vp;
uniform float u_time;
out vec3 v_p;
out vec3 v_n;
flat out float v_part;
flat out float v_var;
void main() {
  float s = i_tree.z;
  float r = i_tree.w * 0.785 + i_tree.x * 0.13;
  float cr = cos(r);
  float sr = sin(r);
  vec3 p = a_pos * vec3(s, s * (0.85 + 0.3 * fract(i_tree.x * 0.37 + i_tree.y * 0.11)), s);
  p.xz = mat2(cr, sr, -sr, cr) * p.xz;
  vec3 n = a_nrm;
  n.xz = mat2(cr, sr, -sr, cr) * n.xz;
  if (a_part > 0.5) p.x += sin(u_time * 1.4 + i_tree.x * 0.3 + i_tree.y * 0.2) * 0.05 * p.y;
  v_p = vec3(i_tree.x, 0.0, i_tree.y) + p;
  v_n = n;
  v_part = a_part;
  v_var = i_tree.w;
  gl_Position = u_vp * vec4(v_p, 1.0);
}`;
const TREE_FS = `#version 300 es
${COMMON}
in vec3 v_p;
in vec3 v_n;
flat in float v_part;
flat in float v_var;
out vec4 o;
void main() {
  vec3 n = normalize(v_n);
  vec3 c = vec3(0.40, 0.33, 0.26);
  if (v_part > 0.5) {
    c = mix(vec3(0.27, 0.45, 0.20), vec3(0.42, 0.56, 0.26), fract(v_var * 0.37));
    c = mix(c, vec3(0.33, 0.47, 0.30), step(6.5, v_var) * 0.6);
    c *= 0.85 + 0.3 * vnoise(v_p.xz * 1.7 + v_p.y);
  }
  float lit = 0.55 + 0.5 * max(dot(n, u_sun), 0.0);
  o = vec4(fogged(c * lit, v_p), 1.0);
}`;

const PERSON_VS = `#version 300 es
in vec3 a_pos;
in vec3 a_nrm;
in float a_part;
in vec4 i_pos;
in vec4 i_act;
in vec4 i_look;
uniform mat4 u_vp;
uniform float u_time;
out vec3 v_p;
out vec3 v_n;
out vec3 v_c;
vec3 unpack(float v) { return vec3(floor(v / 65536.0), mod(floor(v / 256.0), 256.0), mod(v, 256.0)) / 255.0; }
vec2 rot(vec2 v, float a) { float c = cos(a); float s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
void main() {
  vec3 p = a_pos;
  vec3 n = a_nrm;
  float act = i_act.x;
  float moving = (act > 0.5 && act < 1.5) || act > 2.5 ? 1.0 : 0.0;
  float sw = sin(i_pos.w) * 0.55 * moving;
  if (a_part > 0.5 && a_part < 2.5) {
    // Legs swing about the hips.
    float s = a_part < 1.5 ? sw : -sw;
    p.xy = rot(p.xy - vec2(0.0, 0.88), s) + vec2(0.0, 0.88);
    n.xy = rot(n.xy, s);
  } else if (a_part > 2.5 && a_part < 4.5) {
    bool right = a_part > 3.5;
    if (act > 1.5 && act < 2.5 && right) {
      // Waving: the right arm up, going side to side.
      float s = 2.75 + 0.3 * sin(u_time * 9.0 + i_pos.w);
      p.zy = rot(p.zy - vec2(0.27, 1.42), s) + vec2(0.27, 1.42);
      n.zy = rot(n.zy, s);
    } else if (act > 2.5) {
      // In the chain: hands on the shoulders of the one in front.
      float s = 1.25 + 0.08 * sin(i_pos.w);
      p.xy = rot(p.xy - vec2(0.0, 1.42), s) + vec2(0.0, 1.42);
      n.xy = rot(n.xy, s);
    } else {
      float s = (right ? sw : -sw) * 0.75;
      p.xy = rot(p.xy - vec2(0.0, 1.42), s) + vec2(0.0, 1.42);
      n.xy = rot(n.xy, s);
    }
  }
  float bob = moving * abs(sin(i_pos.w)) * 0.035;
  p *= i_act.y;
  p.y += bob;
  p.xz = rot(p.xz, i_pos.z);
  n.xz = rot(n.xz, i_pos.z);
  vec3 shirt = unpack(i_look.x);
  vec3 skin = unpack(i_look.z);
  vec3 c = shirt;
  if (a_part > 0.5 && a_part < 2.5) c = unpack(i_look.y);
  else if (a_part > 2.5 && a_part < 4.5) c = a_pos.y < 1.13 ? skin : shirt;
  else if (a_part > 4.5 && a_part < 5.5) c = skin;
  else if (a_part > 5.5) c = unpack(i_look.w);
  v_c = c;
  v_p = vec3(i_pos.x, 0.0, i_pos.y) + p;
  v_n = n;
  gl_Position = u_vp * vec4(v_p, 1.0);
}`;
const PERSON_FS = `#version 300 es
${COMMON}
in vec3 v_p;
in vec3 v_n;
in vec3 v_c;
out vec4 o;
void main() {
  vec3 n = normalize(v_n);
  float lit = 0.62 + 0.45 * max(dot(n, u_sun), 0.0);
  o = vec4(fogged(v_c * lit, v_p), 1.0);
}`;

// Soft round shadows under trees and people (and the ring where a tap sends you), on the ground.
const BLOB_VS = `#version 300 es
in vec2 a_pos;
in vec4 i_blob;
uniform mat4 u_vp;
uniform vec3 u_eye;
uniform float u_eps;
uniform float u_k;
uniform float u_alpha;
out vec2 v_q;
out vec3 v_p;
flat out float v_a;
void main() {
  v_q = a_pos;
  v_a = u_alpha > 0.0 ? u_alpha : i_blob.w;
  v_p = vec3(i_blob.x + a_pos.x * i_blob.z * u_k, 0.0, i_blob.y + a_pos.y * i_blob.z * u_k);
  gl_Position = u_vp * vec4(v_p + (u_eye - v_p) * (11.0 * u_eps), 1.0);
}`;
const BLOB_FS = `#version 300 es
${COMMON}
in vec2 v_q;
in vec3 v_p;
flat in float v_a;
out vec4 o;
uniform float u_ring;
void main() {
  float d = length(v_q);
  if (u_ring > 0.5) {
    float r = (1.0 - smoothstep(0.06, 0.12, abs(d - 0.8))) * (0.75 + 0.25 * sin(u_time * 6.0));
    o = vec4(vec3(1.0), r * v_a);
    return;
  }
  float f = clamp((distance(v_p, u_eye) - u_fogr.x) / (u_fogr.y - u_fogr.x), 0.0, 1.0);
  o = vec4(0.0, 0.0, 0.0, v_a * (1.0 - smoothstep(0.25, 1.0, d)) * (1.0 - f));
}`;

// Shop signs: the names of shops, cafés and the like, over their doors (a picture of each, in one big texture).
const SIGN_VS = `#version 300 es
in vec2 a_pos;
in vec4 i_c;
in vec4 i_r;
in vec4 i_uv;
uniform mat4 u_vp;
out vec2 v_uv;
out vec3 v_p;
void main() {
  vec3 right = vec3(i_r.x, 0.0, i_r.y);
  v_p = i_c.xyz + right * (a_pos.x * i_r.z) + vec3(0.0, a_pos.y * i_r.w, 0.0);
  v_uv = vec2(mix(i_uv.x, i_uv.z, a_pos.x + 0.5), mix(i_uv.w, i_uv.y, a_pos.y + 0.5));
  gl_Position = u_vp * vec4(v_p, 1.0);
}`;
const SIGN_FS = `#version 300 es
${COMMON}
in vec2 v_uv;
in vec3 v_p;
out vec4 o;
uniform sampler2D u_atlas;
void main() {
  o = vec4(fogged(texture(u_atlas, v_uv).rgb, v_p), 1.0);
}`;
const SIGN_PX = [512, 64]; // one sign's picture
const ATLAS = [2048, 1024]; // 4 × 16 signs
const SIGN_COLORS = [
  ['#0f4c81', '#ffffff'], ['#b91c1c', '#ffffff'], ['#166534', '#ffffff'], ['#111827', '#fde68a'], ['#f59e0b', '#1f2937'],
  ['#6d28d9', '#ffffff'], ['#f8fafc', '#b91c1c'], ['#0e7490', '#ffffff'], ['#9a3412', '#ffffff'], ['#fef3c7', '#1f2937'],
];
const SIGN_ICON = { food: '🍴', shop: '🛍️', health: '✚', bank: '🏦', hotel: '🛏️', culture: '🎭', edu: '🎓', gov: '🏛️', transit: '🚌', fuel: '⛽', sport: '⚽', worship: '' };

// ------------------------------------------------------------------------------------------------ small maths
function perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}
/** View matrix from the eye looking along f (unit), up +y; also returns the right and up vectors. */
function lookAlong(out, e, f) {
  let rx = -f[2];
  let rz = f[0];
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl;
  rz /= rl;
  const ux = -rz * f[1];
  const uy = rz * f[0] - rx * f[2];
  const uz = rx * f[1];
  out[0] = rx;
  out[1] = ux;
  out[2] = -f[0];
  out[3] = 0;
  out[4] = 0;
  out[5] = uy;
  out[6] = -f[1];
  out[7] = 0;
  out[8] = rz;
  out[9] = uz;
  out[10] = -f[2];
  out[11] = 0;
  out[12] = -(rx * e[0] + rz * e[2]);
  out[13] = -(ux * e[0] + uy * e[1] + uz * e[2]);
  out[14] = f[0] * e[0] + f[1] * e[1] + f[2] * e[2];
  out[15] = 1;
  return { right: [rx, 0, rz], up: [ux, uy, uz] };
}
function mul(out, a, b) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ------------------------------------------------------------------------------------------------ WebGL helpers
function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
  return s;
}
function program(gl, vs, fs, uniforms) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
  const u = {};
  for (const name of ['u_vp', 'u_eye', 'u_fogc', 'u_fogr', 'u_sun', 'u_zen', 'u_time', ...uniforms]) u[name] = gl.getUniformLocation(p, name);
  return { p, u, a: (name) => gl.getAttribLocation(p, name) };
}
function buffer(gl, target, data, usage = gl.STATIC_DRAW) {
  const b = gl.createBuffer();
  gl.bindBuffer(target, b);
  gl.bufferData(target, data, usage);
  return b;
}
function attrib(gl, loc, size, type, normalized, stride, offset, divisor = 0) {
  if (loc < 0) return;
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, type, normalized, stride, offset);
  gl.vertexAttribDivisor(loc, divisor);
}

// ------------------------------------------------------------------------------------------------ the walk
/**
 * The street view, drawn into `canvas` (a WebGL 2 context is made on the first walk). ui: the HUD elements
 * { root, street, count, mini, run, stick, pad, loading, exit }; hooks: { toast, hint, sfx, onExit }.
 * Returns { enter(map, extra, opts), exit(), frame(dt, nowMs), get active }.
 */
export function createWalk(canvas, ui, hooks = {}) {
  let gl = null;
  let P = null; // programs
  let shared = null; // models and quads
  let city = null;
  let map = null;
  let active = false;
  let ready = false; // the city is built and you are in it
  let tex = null;
  let lost = false;
  const tiles = new Map(); // key → tile (with its GL buffers)
  const me = { x: 0, y: 0, yaw: 0, pitch: -0.08, speed: 0, run: false, step: 0, moved: 0 };
  const input = { fwd: 0, side: 0, turn: 0, keys: new Set() };
  let target = null; // { x, y, since, best }
  const people = [];
  const trail = [];
  let joined = 0;
  let time = 0;
  let spawnWait = 0;
  let streetWait = 0;
  let miniWait = 0;
  let scale = 1;
  const pace = pacer({ every: 60 });
  let W = 1;
  let H = 1;
  let fovy = 1;
  let fovx = 1;
  const proj = new Float32Array(16);
  const view = new Float32Array(16);
  const vp = new Float32Array(16);
  let basis = null;
  let eyeY = EYE;
  let streetName = () => '';
  let sky = null; // the towers' mesh
  let rand = seeded(1);

  // ---------------------------------------------------------------------------------------------- set-up
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    lost = true;
    if (active) {
      exit();
      hooks.toast?.('התלת־ממד נעצר (הטלפון פינה זיכרון). אפשר להיכנס שוב', 4000);
    }
  });
  canvas.addEventListener('webglcontextrestored', () => {
    // Everything made on the old context is gone: start again on the next walk.
    lost = false;
    gl = null;
    P = null;
    shared = null;
    tex = null;
    map = null;
    sky = null;
    near.at = near.ground = near.water = null;
    tiles.clear();
  });
  function init() {
    gl = canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true, stencil: false, powerPreference: 'high-performance' });
    if (!gl) return false;
    P = {
      sky: program(gl, SKY_VS, SKY_FS, ['u_fw', 'u_rt', 'u_up', 'u_tan']),
      ground: program(gl, GROUND_VS, GROUND_FS, ['u_ground', 'u_water', 'u_nearGround', 'u_nearWater', 'u_near', 'u_E', 'u_origin']),
      road: program(gl, ROAD_VS, ROAD_FS, ['u_eps']),
      building: program(gl, BUILDING_VS, BUILDING_FS, []),
      tree: program(gl, TREE_VS, TREE_FS, []),
      person: program(gl, PERSON_VS, PERSON_FS, []),
      blob: program(gl, BLOB_VS, BLOB_FS, ['u_eps', 'u_k', 'u_ring', 'u_alpha']),
      sign: program(gl, SIGN_VS, SIGN_FS, ['u_atlas']),
    };
    // Shared vertex data: the sky's triangle, the ground's square, the models, a quad for shadows.
    const skyV = buffer(gl, gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]));
    const skyVao = gl.createVertexArray();
    gl.bindVertexArray(skyVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, skyV);
    attrib(gl, P.sky.a('a_pos'), 2, gl.FLOAT, false, 8, 0);
    const quad = buffer(gl, gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]));
    const person = personModel();
    const tree = treeModel();
    const personV = buffer(gl, gl.ARRAY_BUFFER, person);
    const treeV = buffer(gl, gl.ARRAY_BUFFER, tree);
    const peopleI = buffer(gl, gl.ARRAY_BUFFER, new Float32Array(MAX_PEOPLE * 12), gl.DYNAMIC_DRAW);
    const peopleVao = gl.createVertexArray();
    gl.bindVertexArray(peopleVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, personV);
    attrib(gl, P.person.a('a_pos'), 3, gl.FLOAT, false, 28, 0);
    attrib(gl, P.person.a('a_nrm'), 3, gl.FLOAT, false, 28, 12);
    attrib(gl, P.person.a('a_part'), 1, gl.FLOAT, false, 28, 24);
    gl.bindBuffer(gl.ARRAY_BUFFER, peopleI);
    attrib(gl, P.person.a('i_pos'), 4, gl.FLOAT, false, 48, 0, 1);
    attrib(gl, P.person.a('i_act'), 4, gl.FLOAT, false, 48, 16, 1);
    attrib(gl, P.person.a('i_look'), 4, gl.FLOAT, false, 48, 32, 1);
    const blobsI = buffer(gl, gl.ARRAY_BUFFER, new Float32Array(MAX_PEOPLE * 4 + 4), gl.DYNAMIC_DRAW);
    const blobVao = gl.createVertexArray();
    gl.bindVertexArray(blobVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    attrib(gl, P.blob.a('a_pos'), 2, gl.FLOAT, false, 8, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, blobsI);
    attrib(gl, P.blob.a('i_blob'), 4, gl.FLOAT, false, 16, 0, 1);
    // The signs: a quad per sign, and their pictures in one texture.
    const signsI = buffer(gl, gl.ARRAY_BUFFER, new Float32Array(SIGNS_MAX * 12), gl.DYNAMIC_DRAW);
    const signVao = gl.createVertexArray();
    gl.bindVertexArray(signVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    attrib(gl, P.sign.a('a_pos'), 2, gl.FLOAT, false, 8, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, signsI);
    attrib(gl, P.sign.a('i_c'), 4, gl.FLOAT, false, 48, 0, 1);
    attrib(gl, P.sign.a('i_r'), 4, gl.FLOAT, false, 48, 16, 1);
    attrib(gl, P.sign.a('i_uv'), 4, gl.FLOAT, false, 48, 32, 1);
    const atlas = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, atlas);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ATLAS[0], ATLAS[1], 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindVertexArray(null);
    shared = { signsI, signVao, atlas, skyVao, quad, treeV, treeCount: tree.length / 7, personCount: person.length / 7, peopleI, peopleVao, blobsI, blobVao, groundVao: null, groundV: null };
    return true;
  }

  /**
   * The land (land use, parks, beaches, the sea) for the square [x0, x0 + size]² into a canvas of px², and the sea
   * and lakes, white on black, into `mask` (half as many pixels a side, or as many).
   */
  function paintLand(c, mask, x0, y0, size, feats) {
    const px = c.width;
    const g = c.getContext('2d');
    const k = px / size;
    g.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
    g.fillStyle = GROUND.land;
    g.fillRect(x0, y0, size, size);
    const path = (ctx, list) => {
      ctx.beginPath();
      for (const f of list) {
        for (const ring of f.geom) {
          ctx.moveTo(ring[0], ring[1]);
          for (let i = 2; i < ring.length; i += 2) ctx.lineTo(ring[i], ring[i + 1]);
          ctx.closePath();
        }
      }
    };
    const fill = (layer, color) => {
      const list = feats.filter((f) => f.layer === layer);
      if (!list.length) return;
      g.fillStyle = color;
      path(g, list);
      g.fill('evenodd');
    };
    for (const cls of Object.keys(AREA_STYLE)) fill(`area:${cls}`, GROUND[cls] || GROUND.land);
    fill('beach', GROUND.beach);
    fill('green', GROUND.green);
    fill('sea', GROUND.water);
    fill('water', GROUND.water);
    const wg = mask.getContext('2d');
    const mk = mask.width / size;
    wg.setTransform(mk, 0, 0, mk, -x0 * mk, -y0 * mk);
    wg.fillStyle = '#000';
    wg.fillRect(x0, y0, size, size);
    wg.fillStyle = '#fff';
    path(
      wg,
      feats.filter((f) => f.layer === 'sea' || f.layer === 'water'),
    );
    wg.fill('evenodd');
    wg.strokeStyle = '#fff';
    wg.lineCap = 'round';
    for (const f of feats) {
      if (f.layer !== 'river') continue;
      wg.lineWidth = f.extra === 1 ? 14 : 5;
      wg.beginPath();
      wg.moveTo(f.geom[0], f.geom[1]);
      for (let i = 2; i < f.geom.length; i += 2) wg.lineTo(f.geom[i], f.geom[i + 1]);
      wg.stroke();
    }
  }
  function texture(source, one = false, t = gl.createTexture()) {
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (one) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, source);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const an = gl.getExtension('EXT_texture_filter_anisotropic');
    if (an) gl.texParameterf(gl.TEXTURE_2D, an.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(an.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    return t;
  }

  /** The whole town's ground, painted once per city. */
  function paintGround(m) {
    const E = m.E;
    const size = Math.min(2048, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const w = document.createElement('canvas');
    w.width = w.height = size >> 1;
    paintLand(c, w, -E, -E, 2 * E, m.features);
    if (tex) {
      gl.deleteTexture(tex.ground);
      gl.deleteTexture(tex.water);
    }
    tex = { ground: texture(c), water: texture(w, true), E };
    near.at = null; // the sharp ground is painted again, for this town
    if (!shared.groundVao) {
      // The ground's grid, around (0, 0); it moves with the walker in steps of one square.
      const N = GROUND_N;
      const v = new Float32Array((N + 1) * (N + 1) * 2);
      for (let j = 0; j <= N; j++) {
        for (let i = 0; i <= N; i++) {
          v[(j * (N + 1) + i) * 2] = (i - N / 2) * GROUND_CELL;
          v[(j * (N + 1) + i) * 2 + 1] = (j - N / 2) * GROUND_CELL;
        }
      }
      const idx = new Uint16Array(N * N * 6);
      let k = 0;
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const a = j * (N + 1) + i;
          idx.set([a, a + 1, a + N + 2, a, a + N + 2, a + N + 1], k);
          k += 6;
        }
      }
      shared.groundVao = gl.createVertexArray();
      gl.bindVertexArray(shared.groundVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer(gl, gl.ARRAY_BUFFER, v));
      attrib(gl, P.ground.a('a_pos'), 2, gl.FLOAT, false, 8, 0);
      buffer(gl, gl.ELEMENT_ARRAY_BUFFER, idx);
      shared.groundCount = idx.length;
      gl.bindVertexArray(null);
    }
  }

  /** The sharp ground around (cx, cy): painted again whenever you have walked a quarter of the way to its edge. */
  const near = { at: null, c: null, w: null, ground: null, water: null };
  function paintNear(cx, cy) {
    if (!near.c) {
      near.c = document.createElement('canvas');
      near.c.width = near.c.height = NEAR_PX;
      near.w = document.createElement('canvas');
      near.w.width = near.w.height = NEAR_PX;
    }
    const x0 = cx - NEAR / 2;
    const y0 = cy - NEAR / 2;
    paintLand(near.c, near.w, x0, y0, NEAR, map.query(x0, y0, x0 + NEAR, y0 + NEAR));
    near.ground = texture(near.c, false, near.ground || undefined);
    near.water = texture(near.w, true, near.water || undefined);
    near.at = [x0, y0];
  }

  // ---------------------------------------------------------------------------------------------- tiles
  const keyOf = (tx, ty) => `${tx},${ty}`;
  function upload(t) {
    const out = { tx: t.tx, ty: t.ty, box: t.box, tallest: t.tallest, trees: t.trees.length / 4, bufs: [] };
    const keep = (b) => (out.bufs.push(b), b);
    if (t.buildings.count) {
      const b = t.buildings;
      out.bVao = gl.createVertexArray();
      gl.bindVertexArray(out.bVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, keep(buffer(gl, gl.ARRAY_BUFFER, b.data)));
      const pr = P.building;
      attrib(gl, pr.a('a_pos'), 3, gl.FLOAT, false, 36, 0);
      attrib(gl, pr.a('a_nrm'), 3, gl.FLOAT, false, 36, 12);
      attrib(gl, pr.a('a_uv'), 2, gl.FLOAT, false, 36, 24);
      attrib(gl, pr.a('a_col'), 4, gl.UNSIGNED_BYTE, true, 36, 32);
      keep(buffer(gl, gl.ELEMENT_ARRAY_BUFFER, b.index));
      out.bCount = b.count;
      out.bType = b.index instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    }
    if (t.roads.count) {
      const r = t.roads;
      out.rVao = gl.createVertexArray();
      gl.bindVertexArray(out.rVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, keep(buffer(gl, gl.ARRAY_BUFFER, r.data)));
      const pr = P.road;
      attrib(gl, pr.a('a_pos'), 2, gl.FLOAT, false, 28, 0);
      attrib(gl, pr.a('a_road'), 4, gl.FLOAT, false, 28, 8);
      attrib(gl, pr.a('a_info'), 4, gl.UNSIGNED_BYTE, false, 28, 24);
      keep(buffer(gl, gl.ELEMENT_ARRAY_BUFFER, r.index));
      out.rCount = r.count;
      out.rType = r.index instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    }
    if (out.trees) {
      const inst = keep(buffer(gl, gl.ARRAY_BUFFER, t.trees));
      out.tVao = gl.createVertexArray();
      gl.bindVertexArray(out.tVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, shared.treeV);
      const pr = P.tree;
      attrib(gl, pr.a('a_pos'), 3, gl.FLOAT, false, 28, 0);
      attrib(gl, pr.a('a_nrm'), 3, gl.FLOAT, false, 28, 12);
      attrib(gl, pr.a('a_part'), 1, gl.FLOAT, false, 28, 24);
      gl.bindBuffer(gl.ARRAY_BUFFER, inst);
      attrib(gl, pr.a('i_tree'), 4, gl.FLOAT, false, 16, 0, 1);
      // Their shadows: the same numbers read as (x, z, size, darkness).
      out.sVao = gl.createVertexArray();
      gl.bindVertexArray(out.sVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, shared.quad);
      attrib(gl, P.blob.a('a_pos'), 2, gl.FLOAT, false, 8, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, inst);
      attrib(gl, P.blob.a('i_blob'), 4, gl.FLOAT, false, 16, 0, 1);
    }
    gl.bindVertexArray(null);
    return out;
  }
  function uploadSkyline() {
    if (sky) {
      for (const b of sky.bufs) gl.deleteBuffer(b);
      if (sky.vao) gl.deleteVertexArray(sky.vao);
    }
    const { mesh, count } = city.skyline();
    sky = { bufs: [], count: mesh.count, towers: count };
    if (!mesh.count) return;
    sky.vao = gl.createVertexArray();
    gl.bindVertexArray(sky.vao);
    const vb = buffer(gl, gl.ARRAY_BUFFER, mesh.data);
    const pr = P.building;
    attrib(gl, pr.a('a_pos'), 3, gl.FLOAT, false, 36, 0);
    attrib(gl, pr.a('a_nrm'), 3, gl.FLOAT, false, 36, 12);
    attrib(gl, pr.a('a_uv'), 2, gl.FLOAT, false, 36, 24);
    attrib(gl, pr.a('a_col'), 4, gl.UNSIGNED_BYTE, true, 36, 32);
    const ib = buffer(gl, gl.ELEMENT_ARRAY_BUFFER, mesh.index);
    gl.bindVertexArray(null);
    sky.bufs.push(vb, ib);
    sky.type = mesh.index instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
  }
  function drop(key) {
    const t = tiles.get(key);
    if (!t) return;
    for (const b of t.bufs) gl.deleteBuffer(b);
    for (const v of [t.bVao, t.rVao, t.tVao, t.sVao]) if (v) gl.deleteVertexArray(v);
    tiles.delete(key);
  }
  /** Builds missing tiles near the walker, nearest first, for at most `ms` (always at least one). */
  function buildTiles(ms, all = false) {
    const r = FAR + TILE * 0.5;
    const want = [];
    for (let ty = Math.floor((me.y - r) / TILE); ty <= Math.floor((me.y + r) / TILE); ty++) {
      for (let tx = Math.floor((me.x - r) / TILE); tx <= Math.floor((me.x + r) / TILE); tx++) {
        if (tiles.has(keyOf(tx, ty))) continue;
        const d = Math.hypot((tx + 0.5) * TILE - me.x, (ty + 0.5) * TILE - me.y);
        if (d > r + TILE * 0.72) continue;
        // In front first: what you are looking at.
        const ang = Math.abs(wrap(Math.atan2((ty + 0.5) * TILE - me.y, (tx + 0.5) * TILE - me.x) - me.yaw));
        want.push({ tx, ty, d: d * (d < TILE * 1.5 ? 0.3 : ang < fovx * 0.7 ? 1 : 2.2) });
      }
    }
    want.sort((a, b) => a.d - b.d);
    const t0 = performance.now();
    for (const w of want) {
      tiles.set(keyOf(w.tx, w.ty), upload(city.tile(w.tx, w.ty)));
      if (!all && performance.now() - t0 > ms) break;
    }
    // Tiles left well behind go.
    for (const [key, t] of tiles) {
      if (Math.hypot((t.tx + 0.5) * TILE - me.x, (t.ty + 0.5) * TILE - me.y) > FAR + TILE * 3) drop(key);
    }
  }
  function visible(t) {
    const cx = (t.tx + 0.5) * TILE - me.x;
    const cy = (t.ty + 0.5) * TILE - me.y;
    const d = Math.hypot(cx, cy);
    if (d < TILE * 1.1) return true;
    if (d > FAR + TILE * 0.72) return false;
    const ang = Math.abs(wrap(Math.atan2(cy, cx) - me.yaw));
    return ang < fovx / 2 + Math.asin(Math.min(1, (TILE * 0.72) / d)) + 0.04;
  }

  // ---------------------------------------------------------------------------------------------- shop signs
  const signs = { placed: new Map(), slots: new Map(), walls: new Map(), free: [], count: 0, wait: 0, scratch: null };
  function resetSigns() {
    signs.placed.clear();
    signs.walls.clear();
    signs.slots.clear();
    signs.free = Array.from({ length: SIGNS_MAX }, (_, i) => SIGNS_MAX - 1 - i);
    signs.count = 0;
  }
  /**
   * Where a named place's sign goes: over the door on the nearest wall (within 12 m) that has room for it, facing
   * the street; never over another sign.
   */
  function placeSign(p, pxWidth) {
    const edges = [];
    for (const f of map.query(p.x - 14, p.y - 14, p.x + 14, p.y + 14)) {
      if (f.layer !== 'building') continue;
      const ring = f.geom[0];
      for (let j = 0; j < ring.length; j += 2) {
        const i = (j + 2) % ring.length;
        const ax = ring[j];
        const ay = ring[j + 1];
        const dx = ring[i] - ax;
        const dy = ring[i + 1] - ay;
        const L = Math.hypot(dx, dy);
        if (L < 2.2) continue;
        const t = Math.max(0, Math.min(L, ((p.x - ax) * dx + (p.y - ay) * dy) / L));
        const d = Math.hypot(p.x - ax - (dx / L) * t, p.y - ay - (dy / L) * t);
        if (d < 12) edges.push({ d, f, ring, j, ax, ay, L, ux: dx / L, uy: dy / L, t });
      }
    }
    edges.sort((a, b) => a.d - b.d);
    for (const e of edges.slice(0, 6)) {
      let w = pxWidth / 72; // 72 pixels a metre: a sign 0.9 m tall
      let h = SIGN_PX[1] / 72;
      const room = Math.min(6, e.L - 0.5);
      if (w > room) {
        h *= room / w;
        w = room;
      }
      const key = `${e.f.extra}:${e.j}`;
      const taken = signs.walls.get(key) || [];
      const lo = w / 2 + 0.2;
      const hi = e.L - w / 2 - 0.2;
      const free = (s) => s >= lo - 1e-6 && s <= hi + 1e-6 && taken.every(([a, b]) => s + w / 2 + 0.15 <= a || s - w / 2 - 0.15 >= b);
      const want = Math.max(lo, Math.min(hi, e.t));
      const tries = [want, ...taken.flatMap(([a, b]) => [b + 0.15 + w / 2, a - 0.15 - w / 2])].filter(free);
      if (!tries.length) continue;
      const s = tries.reduce((x, y) => (Math.abs(y - want) < Math.abs(x - want) ? y : x));
      taken.push([s - w / 2, s + w / 2]);
      signs.walls.set(key, taken);
      let nx = -e.uy;
      let ny = e.ux;
      if (inRing(e.ring, e.ax + e.ux * e.L * 0.5 + nx * 0.4, e.ay + e.uy * e.L * 0.5 + ny * 0.4)) {
        nx = -nx;
        ny = -ny;
      }
      // Facing out of the wall, the sign's left-to-right runs to the right of someone looking at it.
      return { x: e.ax + e.ux * s + nx * 0.08, y: e.ay + e.uy * s + ny * 0.08, rx: ny, rz: -nx, w, h };
    }
    return null;
  }
  /** Draws a place's sign into the scratch canvas; returns its width in pixels. */
  function drawSign(p) {
    const [W0, H0] = SIGN_PX;
    if (!signs.scratch) {
      signs.scratch = document.createElement('canvas');
      signs.scratch.width = W0;
      signs.scratch.height = H0;
    }
    const g = signs.scratch.getContext('2d');
    const [bg, fg] = SIGN_COLORS[Math.floor(hash2(p.x * 0.7, p.y * 1.3) * SIGN_COLORS.length) % SIGN_COLORS.length];
    const icon = SIGN_ICON[p.cat] || '';
    const font = '800 38px system-ui, -apple-system, "Segoe UI", Arial, sans-serif';
    g.font = font;
    const text = p.name.length > 26 ? `${p.name.slice(0, 25)}…` : p.name;
    const tw = Math.ceil(g.measureText(text).width);
    const iw = icon ? 46 : 0;
    const w = Math.min(W0, tw + iw + 36);
    g.clearRect(0, 0, W0, H0);
    g.fillStyle = bg;
    g.fillRect(0, 0, W0, H0);
    g.fillStyle = 'rgba(0, 0, 0, 0.18)';
    g.fillRect(0, H0 - 5, w, 5);
    g.fillStyle = fg;
    g.font = font;
    g.textBaseline = 'middle';
    g.direction = 'rtl';
    g.textAlign = 'right';
    g.fillText(text, w - 18, H0 / 2 + 1, w - iw - 30);
    if (icon) {
      g.direction = 'ltr';
      g.textAlign = 'left';
      g.font = '32px system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
      g.fillText(icon, 12, H0 / 2 + 2);
    }
    return w;
  }
  /** The signs of the named places within 80 m: placed, drawn once, and the far ones' room given to new ones. */
  function updateSigns() {
    const near = [];
    for (let r = map.cell(me.y - 80); r <= map.cell(me.y + 80); r++) {
      for (let c = map.cell(me.x - 80); c <= map.cell(me.x + 80); c++) {
        for (const p of map.poiCells.get(r * map.n + c) || []) {
          if (!p.name || p.cat === 'park' || Math.abs(p.x - me.x) > 80 || Math.abs(p.y - me.y) > 80) continue;
          near.push(p);
        }
      }
    }
    near.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
    const keep = new Set(near.slice(0, SIGNS_MAX));
    for (const [p, slot] of signs.slots) {
      if (!keep.has(p)) {
        signs.slots.delete(p);
        signs.free.push(slot);
      }
    }
    let added = 0;
    for (const p of keep) {
      if (signs.slots.has(p) || !signs.free.length || added >= 6) continue;
      if (signs.placed.get(p) === null) continue;
      const w = drawSign(p);
      const at = signs.placed.get(p) ?? placeSign(p, w);
      signs.placed.set(p, at);
      if (!at) continue;
      const slot = signs.free.pop();
      const cols = ATLAS[0] / SIGN_PX[0];
      at.u0 = ((slot % cols) * SIGN_PX[0]) / ATLAS[0];
      at.v0 = (Math.floor(slot / cols) * SIGN_PX[1]) / ATLAS[1];
      at.u1 = at.u0 + (w - 1) / ATLAS[0];
      at.v1 = at.v0 + (SIGN_PX[1] - 1) / ATLAS[1];
      gl.bindTexture(gl.TEXTURE_2D, shared.atlas);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, (slot % cols) * SIGN_PX[0], Math.floor(slot / cols) * SIGN_PX[1], gl.RGBA, gl.UNSIGNED_BYTE, signs.scratch);
      signs.slots.set(p, slot);
      added++;
    }
    if (added) {
      gl.bindTexture(gl.TEXTURE_2D, shared.atlas);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    const data = new Float32Array(SIGNS_MAX * 12);
    let n = 0;
    for (const [p] of signs.slots) {
      const at = signs.placed.get(p);
      if (!at) continue;
      data.set([at.x, 2.93, at.y, 0, at.rx, at.rz, at.w, at.h, at.u0, at.v0, at.u1, at.v1], n * 12);
      n++;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, shared.signsI);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, n * 12);
    signs.count = n;
  }

  // ---------------------------------------------------------------------------------------------- people
  /** Someone new on a pavement, 25–100 m away (strolling, or standing and waiting). */
  function spawnPerson() {
    const a = rand() * Math.PI * 2;
    const d = 25 + rand() * 75;
    const px = me.x + Math.cos(a) * d;
    const py = me.y + Math.sin(a) * d;
    let best = null;
    for (const f of map.query(px - 30, py - 30, px + 30, py + 30)) {
      const st = ROADS[f.layer];
      if (!st || st.cls > 2) continue;
      const line = f.geom;
      for (let i = 2; i + 1 < line.length; i += 2) {
        const ax = line[i - 2];
        const ay = line[i - 1];
        const dx = line[i] - ax;
        const dy = line[i + 1] - ay;
        const L2 = dx * dx + dy * dy;
        if (L2 < 64) continue;
        const t = Math.max(0.1, Math.min(0.9, ((px - ax) * dx + (py - ay) * dy) / L2));
        const qd = Math.hypot(px - ax - dx * t, py - ay - dy * t);
        if (!best || qd < best.qd) best = { qd, ax, ay, dx, dy, t, st };
      }
    }
    if (!best) return;
    const L = Math.hypot(best.dx, best.dy);
    const ux = best.dx / L;
    const uy = best.dy / L;
    const side = rand() < 0.5 ? -1 : 1;
    const off = best.st.half + 0.8 + rand() * Math.max(0.2, best.st.walk - 1.2);
    const x = best.ax + best.dx * best.t - uy * off * side;
    const y = best.ay + best.dy * best.t + ux * off * side;
    if (Math.hypot(x - me.x, y - me.y) < 12 || city.buildingAt(x, y, 0.5) || !city.walkable(x, y) || city.onRoad(x, y, 0.2)) return;
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const strolling = rand() < 0.45;
    const dir = rand() < 0.5 ? 1 : -1;
    people.push({
      x,
      y,
      a: strolling ? Math.atan2(uy * dir, ux * dir) : Math.atan2(uy, ux) + (side > 0 ? -Math.PI / 2 : Math.PI / 2) + (rand() - 0.5),
      phase: rand() * 6,
      act: strolling ? 1 : 0,
      ux: ux * dir,
      uy: uy * dir,
      speed: strolling ? 1.05 + rand() * 0.4 : 0,
      scale: 0.9 + rand() * 0.16,
      shirt: packRGB(pick(SHIRTS)),
      pants: packRGB(pick(PANTS)),
      skin: packRGB(pick(SKIN)),
      hair: packRGB(pick(HAIR)),
      joined: false,
      walked: 0,
    });
  }
  function updatePeople(dt) {
    let waiting = 0;
    for (let i = people.length - 1; i >= 0; i--) {
      const p = people[i];
      if (p.joined) continue;
      const d = Math.hypot(p.x - me.x, p.y - me.y);
      if (d > 140) {
        people.splice(i, 1);
        continue;
      }
      waiting++;
      if (d < 2.6) {
        // Joins the chain.
        p.joined = true;
        p.act = 3;
        p.shirt = packRGB(CHAIN);
        joined++;
        hooks.sfx?.('pick');
        navigator.vibrate?.(25);
        ui.count.querySelector('b').textContent = String(joined);
        ui.count.classList.remove('pop');
        void ui.count.offsetWidth;
        ui.count.classList.add('pop');
        if (joined === 1) hooks.toast?.('🙌 מישהו הצטרף אליך! כל מי שתגיעו אליו ברחוב מצטרף לשרשרת', 3600);
        else if ([10, 25, 50, 100, 200].includes(joined)) hooks.toast?.(`🎉 ${joined} אנשים הולכים איתך ברחוב`, 2600);
        continue;
      }
      if (d < 14) {
        // Near: turns to you and waves.
        const want = Math.atan2(me.y - p.y, me.x - p.x);
        p.a += wrap(want - p.a) * Math.min(1, dt * 5);
        p.act = 2;
        p.phase += dt * 2;
      } else if (p.speed > 0) {
        p.act = 1;
        const nx = p.x + p.ux * p.speed * dt;
        const ny = p.y + p.uy * p.speed * dt;
        if (city.buildingAt(nx, ny, 0.4) || city.onRoad(nx, ny, 0.1) || !city.walkable(nx, ny) || (p.walked += p.speed * dt) > 60) {
          p.ux = -p.ux;
          p.uy = -p.uy;
          p.walked = 0;
        } else {
          p.x = nx;
          p.y = ny;
        }
        p.a += wrap(Math.atan2(p.uy, p.ux) - p.a) * Math.min(1, dt * 6);
        p.phase += p.speed * dt * 3.1;
      } else {
        p.act = 0;
      }
    }
    spawnWait -= dt;
    if (waiting < WAITING && spawnWait <= 0 && people.length < MAX_PEOPLE) {
      for (let k = 0; k < 3 && people.filter((p) => !p.joined).length < WAITING; k++) spawnPerson();
      spawnWait = 0.25;
    }
    // The chain follows you along the way you walked: each one about a metre behind the one in front.
    const followers = people.filter((p) => p.joined);
    if (!followers.length) return;
    let want = 2.1; // the first one a couple of steps behind you, the rest a metre apart
    let k = 0;
    let acc = 0;
    let px = me.x;
    let py = me.y;
    for (let i = trail.length - 1; i >= 0 && k < followers.length; i--) {
      const [tx, ty] = trail[i];
      const seg = Math.hypot(tx - px, ty - py);
      while (k < followers.length && acc + seg >= want) {
        const t = seg > 0 ? (want - acc) / seg : 0;
        place(followers[k], px + (tx - px) * t, py + (ty - py) * t, dt);
        k++;
        want += 1.05;
      }
      acc += seg;
      px = tx;
      py = ty;
    }
    for (; k < followers.length; k++) place(followers[k], px, py, dt);
  }
  function place(p, x, y, dt) {
    let dx = x - p.x;
    let dy = y - p.y;
    let d = Math.hypot(dx, dy);
    const speed = Math.max(RUN * 1.4, d * 4);
    // On the way to their place behind you, round you rather than through you (someone who joins from in front would
    // fill the whole screen for a moment): when the way passes within a metre of you, the next step aims beside you.
    if (d > 0.01) {
      const t = ((me.x - p.x) * dx + (me.y - p.y) * dy) / (d * d);
      if (t > 0 && t < 1) {
        const cx = p.x + dx * t - me.x;
        const cy = p.y + dy * t - me.y;
        const cd = Math.hypot(cx, cy);
        if (cd < 1) {
          const sx = cd > 1e-3 ? cx / cd : -dy / d;
          const sy = cd > 1e-3 ? cy / cd : dx / d;
          dx = me.x + sx * 1.1 - p.x;
          dy = me.y + sy * 1.1 - p.y;
          d = Math.hypot(dx, dy);
        }
      }
    }
    const step = Math.min(d, speed * dt);
    if (d > 0.01) {
      p.x += (dx / d) * step;
      p.y += (dy / d) * step;
      p.a += wrap(Math.atan2(dy, dx) - p.a) * Math.min(1, dt * 8);
    }
    p.phase += step * 3.1;
    p.act = 3;
  }

  // ---------------------------------------------------------------------------------------------- moving
  function walkTo(sx, sy) {
    // The tapped point on the ground (or 25 m ahead, for a tap on the sky), stopping short of any wall on the way.
    const nx = (sx / W) * 2 - 1;
    const ny = 1 - (sy / H) * 2;
    const tx = Math.tan(fovx / 2);
    const ty = Math.tan(fovy / 2);
    const { f, right, up } = basis;
    const d = [f[0] + right[0] * nx * tx + up[0] * ny * ty, f[1] + right[1] * nx * tx + up[1] * ny * ty, f[2] + right[2] * nx * tx + up[2] * ny * ty];
    const hl = Math.hypot(d[0], d[2]) || 1;
    const hx = d[0] / hl;
    const hz = d[2] / hl;
    const len = Math.min(90, d[1] < -0.02 ? (EYE / -d[1]) * hl : 25);
    let gx = me.x;
    let gy = me.y;
    for (let s = 0.5; s <= len; s += 0.5) {
      const x = me.x + hx * s;
      const y = me.y + hz * s;
      if (city.buildingAt(x, y, 0.3) || !city.walkable(x, y)) break;
      gx = x;
      gy = y;
    }
    if (Math.hypot(gx - me.x, gy - me.y) < 0.8) return;
    target = { x: gx, y: gy, since: 0, best: Infinity };
  }
  function moveMe(dt) {
    let fwd = input.fwd;
    let side = input.side;
    if (input.keys.size) {
      const k = input.keys;
      fwd = (k.has('w') || k.has('ArrowUp') ? 1 : 0) - (k.has('s') || k.has('ArrowDown') ? 1 : 0);
      side = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0);
      me.yaw += ((k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0)) * 1.9 * dt;
    }
    if (fwd || side) target = null;
    let vx = 0;
    let vy = 0;
    let mag = 0;
    if (target) {
      const dx = target.x - me.x;
      const dy = target.y - me.y;
      const d = Math.hypot(dx, dy);
      target.since += dt;
      if (d < target.best - 0.05) {
        target.best = d;
        target.since = 0;
      }
      if (d < 0.5 || target.since > 0.6) target = null;
      else {
        vx = dx / d;
        vy = dy / d;
        mag = Math.min(1, d / 1.5 + 0.3);
        me.yaw += wrap(Math.atan2(dy, dx) - me.yaw) * Math.min(1, dt * 3.2); // face where you are going
      }
    } else if (fwd || side) {
      const l = Math.hypot(fwd, side);
      const cy = Math.cos(me.yaw);
      const sy = Math.sin(me.yaw);
      vx = (cy * fwd - sy * side) / l;
      vy = (sy * fwd + cy * side) / l;
      mag = Math.min(1, l);
      me.yaw += side * Math.abs(fwd) * 0.9 * dt; // a push to the side turns you a little too, the way people walk
    }
    const want = mag * (me.run ? RUN : WALK);
    me.speed += (want - me.speed) * Math.min(1, dt * 6);
    if (mag > 0 && me.speed > 0.05) {
      const [nx, ny] = city.move(me.x, me.y, vx * me.speed * dt, vy * me.speed * dt);
      const moved = Math.hypot(nx - me.x, ny - me.y);
      me.x = nx;
      me.y = ny;
      me.step += moved * 2.1;
      me.moved += moved;
      const last = trail[trail.length - 1];
      if (!last || Math.hypot(last[0] - me.x, last[1] - me.y) > 0.25) {
        trail.push([me.x, me.y]);
        const keep = Math.ceil(((joined + 4) * 1.1) / 0.25) + 20;
        if (trail.length > keep * 2) trail.splice(0, trail.length - keep);
      }
    } else if (!mag) me.speed = Math.max(0, me.speed - dt * 12);
  }

  // ---------------------------------------------------------------------------------------------- input
  const ptrs = new Map();
  let stick = null; // { id, x, y }
  function stickArea(x, y) {
    return x < W * 0.46 && y > H * 0.52;
  }
  function onDown(e) {
    if (!ready) return;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* a pointer the browser no longer tracks */
    }
    if (!stick && e.pointerType !== 'mouse' && stickArea(e.clientX, e.clientY)) {
      stick = { id: e.pointerId, x: e.clientX, y: e.clientY };
      ui.pad?.classList.add('gone');
      ui.stick.hidden = false;
      ui.stick.style.transform = `translate(${e.clientX - 60}px, ${e.clientY - 60}px)`;
      ui.stick.firstElementChild.style.transform = 'translate(0px, 0px)';
      return;
    }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() });
  }
  function onMove(e) {
    if (!ready) return;
    if (stick && e.pointerId === stick.id) {
      let dx = e.clientX - stick.x;
      let dy = e.clientY - stick.y;
      const l = Math.hypot(dx, dy);
      if (l > 50) {
        dx *= 50 / l;
        dy *= 50 / l;
      }
      input.fwd = Math.abs(dy) < 6 ? 0 : -dy / 50;
      input.side = Math.abs(dx) < 6 ? 0 : dx / 50;
      me.run = l > 62 || ui.run.getAttribute('aria-pressed') === 'true';
      ui.stick.firstElementChild.style.transform = `translate(${dx}px, ${dy}px)`;
      return;
    }
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    // The street moves with the finger (as in a street-view picture).
    me.yaw -= ((e.clientX - p.x) / W) * fovx;
    me.pitch = Math.max(-1.2, Math.min(1.1, me.pitch + ((e.clientY - p.y) / H) * fovy));
    p.x = e.clientX;
    p.y = e.clientY;
  }
  function onUp(e) {
    if (stick && e.pointerId === stick.id) {
      stick = null;
      input.fwd = 0;
      input.side = 0;
      me.run = ui.run.getAttribute('aria-pressed') === 'true';
      ui.stick.hidden = true;
      return;
    }
    const p = ptrs.get(e.pointerId);
    ptrs.delete(e.pointerId);
    if (!p || !ready || e.type === 'pointercancel') return;
    if (performance.now() - p.t < 350 && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < 10) walkTo(e.clientX, e.clientY);
  }
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  const KEYS = new Set(['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  window.addEventListener('keydown', (e) => {
    if (!ready || e.target?.tagName === 'INPUT') return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (KEYS.has(k)) {
      input.keys.add(k);
      e.preventDefault();
    }
    if (k === 'Shift') me.run = true;
    if (k === 'Escape') exit();
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    input.keys.delete(k);
    if (k === 'Shift') me.run = ui.run.getAttribute('aria-pressed') === 'true';
  });
  window.addEventListener('blur', () => input.keys.clear());
  ui.run.addEventListener('click', () => {
    const on = ui.run.getAttribute('aria-pressed') !== 'true';
    ui.run.setAttribute('aria-pressed', String(on));
    me.run = on;
  });
  ui.exit.addEventListener('click', () => exit());

  // ---------------------------------------------------------------------------------------------- HUD
  function drawMini() {
    const c = ui.mini;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const size = c.clientWidth || 120;
    if (c.width !== Math.round(size * dpr)) {
      c.width = c.height = Math.round(size * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const zoom = size / 380;
    map.draw(g, me.x, me.y, zoom, size, size, dpr, 3);
    // Your chain, and you: a dot and where you look.
    g.fillStyle = CHAIN;
    for (const p of people) {
      if (!p.joined) continue;
      g.beginPath();
      g.arc(size / 2 + (p.x - me.x) * zoom, size / 2 + (p.y - me.y) * zoom, 1.6, 0, Math.PI * 2);
      g.fill();
    }
    g.save();
    g.translate(size / 2, size / 2);
    g.rotate(me.yaw);
    const cone = g.createRadialGradient(0, 0, 0, 0, 0, 34);
    cone.addColorStop(0, 'rgba(31, 95, 214, 0.45)');
    cone.addColorStop(1, 'rgba(31, 95, 214, 0)');
    g.fillStyle = cone;
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, 34, -fovx / 2, fovx / 2);
    g.closePath();
    g.fill();
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(0, 0, 6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = CHAIN;
    g.beginPath();
    g.arc(0, 0, 4.2, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  // ---------------------------------------------------------------------------------------------- drawing
  function resize() {
    const dpr = Math.min(3, window.devicePixelRatio || 1) * scale;
    W = window.innerWidth;
    H = window.innerHeight;
    const w = Math.max(1, Math.round(W * dpr));
    const h = Math.max(1, Math.round(H * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    // A wide enough view on a tall phone, without a fish-eye on a wide screen.
    const aspect = W / H;
    fovy = Math.max((45 * Math.PI) / 180, Math.min((92 * Math.PI) / 180, 2 * Math.atan(Math.tan((72 * Math.PI) / 360) / aspect)));
    fovx = 2 * Math.atan(Math.tan(fovy / 2) * aspect);
  }
  function setCommon(pr) {
    const u = pr.u;
    gl.uniformMatrix4fv(u.u_vp, false, vp);
    gl.uniform3f(u.u_eye, me.x, eyeY, me.y);
    gl.uniform3f(u.u_fogc, 0.81, 0.87, 0.91);
    gl.uniform2f(u.u_fogr, FOG_START, FAR);
    gl.uniform3f(u.u_sun, -0.5, 0.74, 0.45);
    gl.uniform3f(u.u_zen, 0.3, 0.55, 0.84);
    gl.uniform1f(u.u_time, time);
  }
  function draw() {
    resize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    const bob = Math.sin(me.step) * 0.03 * Math.min(1, me.speed / WALK);
    eyeY = EYE + bob;
    const eye = [me.x, eyeY, me.y];
    const cp = Math.cos(me.pitch);
    const f = [Math.cos(me.yaw) * cp, Math.sin(me.pitch), Math.sin(me.yaw) * cp];
    perspective(proj, fovy, W / H, 0.25, 4000);
    const b = lookAlong(view, eye, f);
    basis = { f, right: b.right, up: b.up };
    mul(vp, proj, view);
    const eps = 4e-4; // a share of the distance per layer (see ROAD_VS)
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    // The sky.
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(P.sky.p);
    setCommon(P.sky);
    gl.uniform3fv(P.sky.u.u_fw, f);
    gl.uniform3fv(P.sky.u.u_rt, b.right);
    gl.uniform3fv(P.sky.u.u_up, b.up);
    gl.uniform2f(P.sky.u.u_tan, Math.tan(fovx / 2), Math.tan(fovy / 2));
    gl.bindVertexArray(shared.skyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // The ground, then the streets on it (each layer a hair above the last, so any order will do).
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.useProgram(P.ground.p);
    setCommon(P.ground);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.ground);
    gl.uniform1i(P.ground.u.u_ground, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tex.water);
    gl.uniform1i(P.ground.u.u_water, 1);
    gl.uniform1f(P.ground.u.u_E, tex.E);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, near.ground || tex.ground);
    gl.uniform1i(P.ground.u.u_nearGround, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, near.water || tex.water);
    gl.uniform1i(P.ground.u.u_nearWater, 3);
    gl.activeTexture(gl.TEXTURE0);
    if (near.at) gl.uniform3f(P.ground.u.u_near, near.at[0], near.at[1], NEAR);
    else gl.uniform3f(P.ground.u.u_near, 0, 0, 0);
    gl.uniform2f(P.ground.u.u_origin, Math.round(me.x / GROUND_CELL) * GROUND_CELL, Math.round(me.y / GROUND_CELL) * GROUND_CELL);
    gl.bindVertexArray(shared.groundVao);
    gl.drawElements(gl.TRIANGLES, shared.groundCount, gl.UNSIGNED_SHORT, 0);
    const shown = [...tiles.values()].filter(visible);
    gl.useProgram(P.road.p);
    setCommon(P.road);
    gl.uniform1f(P.road.u.u_eps, eps);
    for (const t of shown) {
      if (!t.rVao) continue;
      gl.bindVertexArray(t.rVao);
      gl.drawElements(gl.TRIANGLES, t.rCount, t.rType, 0);
    }
    // Shadows under the trees and the people.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.useProgram(P.blob.p);
    setCommon(P.blob);
    gl.uniform1f(P.blob.u.u_eps, eps);
    gl.uniform1f(P.blob.u.u_ring, 0);
    gl.uniform1f(P.blob.u.u_k, 2.3);
    gl.uniform1f(P.blob.u.u_alpha, 0.22);
    for (const t of shown) {
      if (!t.sVao || Math.hypot((t.tx + 0.5) * TILE - me.x, (t.ty + 0.5) * TILE - me.y) > 330) continue;
      gl.bindVertexArray(t.sVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, t.trees);
    }
    const n = writePeople();
    gl.uniform1f(P.blob.u.u_alpha, 0);
    if (n) {
      gl.uniform1f(P.blob.u.u_k, 1);
      gl.bindVertexArray(shared.blobVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
    }
    if (target) {
      gl.uniform1f(P.blob.u.u_ring, 1);
      gl.uniform1f(P.blob.u.u_k, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, shared.blobsI);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array([target.x, target.y, 0.9, 0.9]));
      gl.bindVertexArray(shared.blobVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, 1);
    }
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    // Buildings, trees, people.
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.useProgram(P.building.p);
    setCommon(P.building);
    for (const t of shown) {
      if (!t.bVao) continue;
      gl.bindVertexArray(t.bVao);
      gl.drawElements(gl.TRIANGLES, t.bCount, t.bType, 0);
    }
    if (sky?.vao) {
      gl.bindVertexArray(sky.vao);
      gl.drawElements(gl.TRIANGLES, sky.count, sky.type, 0);
    }
    gl.useProgram(P.tree.p);
    setCommon(P.tree);
    for (const t of shown) {
      if (!t.tVao) continue;
      gl.bindVertexArray(t.tVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, shared.treeCount, t.trees);
    }
    if (n) {
      gl.useProgram(P.person.p);
      setCommon(P.person);
      gl.bindVertexArray(shared.peopleVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, shared.personCount, n);
    }
    if (signs.count) {
      gl.disable(gl.CULL_FACE);
      gl.useProgram(P.sign.p);
      setCommon(P.sign);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, shared.atlas);
      gl.uniform1i(P.sign.u.u_atlas, 0);
      gl.bindVertexArray(shared.signVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, signs.count);
    }
    gl.bindVertexArray(null);
  }
  /** People into their instance buffer (and their shadows into the blobs'); returns how many. */
  const peopleData = new Float32Array(MAX_PEOPLE * 12);
  const blobData = new Float32Array(MAX_PEOPLE * 4);
  function writePeople() {
    let n = 0;
    for (const p of people) {
      if (n >= MAX_PEOPLE) break;
      if (Math.hypot(p.x - me.x, p.y - me.y) > FAR) continue;
      const o = n * 12;
      peopleData[o] = p.x;
      peopleData[o + 1] = p.y;
      peopleData[o + 2] = p.a;
      peopleData[o + 3] = p.phase;
      peopleData[o + 4] = p.act;
      peopleData[o + 5] = p.scale;
      peopleData[o + 8] = p.shirt;
      peopleData[o + 9] = p.pants;
      peopleData[o + 10] = p.skin;
      peopleData[o + 11] = p.hair;
      blobData[n * 4] = p.x;
      blobData[n * 4 + 1] = p.y;
      blobData[n * 4 + 2] = 0.42;
      blobData[n * 4 + 3] = 0.3;
      n++;
    }
    if (n) {
      gl.bindBuffer(gl.ARRAY_BUFFER, shared.peopleI);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, peopleData, 0, n * 12);
      gl.bindBuffer(gl.ARRAY_BUFFER, shared.blobsI);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, blobData, 0, n * 4);
    }
    return n;
  }

  // ---------------------------------------------------------------------------------------------- start and stop
  /**
   * Where to start: in the middle of a street by the town hall (else a square, else the middle of the map), looking
   * along it the longer way, as a street-view picture would.
   */
  function startPoint() {
    const pois = map.data.pois || [];
    const at = pois.find((p) => p[2] === 'hall') || pois.find((p) => p[2] === 'square') || [0, 0];
    const [ax, ay] = at;
    let best = null;
    for (const f of map.query(ax - 200, ay - 200, ax + 200, ay + 200)) {
      const st = ROADS[f.layer];
      if (!st || st.cls > 2) continue;
      const line = f.geom;
      for (let i = 2; i + 1 < line.length; i += 2) {
        const x0 = line[i - 2];
        const y0 = line[i - 1];
        const dx = line[i] - x0;
        const dy = line[i + 1] - y0;
        const L = Math.hypot(dx, dy);
        if (L < 25) continue;
        const t = Math.max(0.2, Math.min(0.8, ((ax - x0) * dx + (ay - y0) * dy) / (L * L)));
        const x = x0 + dx * t;
        const y = y0 + dy * t;
        const d = Math.hypot(x - ax, y - ay) - Math.min(L, 120) * 0.3; // a longer street is worth a few more steps
        if (best && d >= best.d) continue;
        if (city.buildingAt(x, y, 1) || !city.walkable(x, y)) continue;
        best = { d, x, y, yaw: t < 0.5 ? Math.atan2(dy, dx) : Math.atan2(-dy, -dx) };
      }
    }
    if (best) return best;
    for (let r = 0; r < 400; r += 4) {
      for (let k = 0; k < 16; k++) {
        const x = ax + Math.cos((k / 16) * Math.PI * 2) * r;
        const y = ay + Math.sin((k / 16) * Math.PI * 2) * r;
        if (!city.buildingAt(x, y, 0.5) && city.walkable(x, y)) return { x, y, yaw: 0 };
      }
    }
    return { x: ax, y: ay, yaw: 0 };
  }

  /**
   * Into the street view of a city map (with its detail loaded); extra: its 3D file (heights and trees), or null.
   * Resolves to false when this phone cannot draw it.
   */
  async function enter(m, extra = null) {
    if (lost) return false;
    if (!gl && !init()) return false;
    active = true;
    ready = false;
    ui.root.hidden = false;
    ui.loading.hidden = false;
    await new Promise((r) => setTimeout(r, 30)); // the "building the city" note shows first
    try {
      if (map !== m) {
        for (const key of [...tiles.keys()]) drop(key);
        map = m;
        city = streetCity(m, extra, { stone: STONE.has(m.id) });
        paintGround(m);
        streetName = streetNamer(m);
        uploadSkyline();
        resetSigns();
      }
      const s = startPoint();
      me.x = s.x;
      me.y = s.y;
      me.yaw = s.yaw;
      me.pitch = -0.06;
      me.speed = 0;
      people.length = 0;
      trail.length = 0;
      joined = 0;
      target = null;
      rand = seeded((Date.now() & 0xffff) + 7);
      // Start at twice the screen's width in pixels (sharp on most phones, easy on them); finer when it copes.
      scale = Math.min(2, window.devicePixelRatio || 1) / Math.min(3, window.devicePixelRatio || 1);
      ui.count.querySelector('b').textContent = '0';
      resize();
      buildTiles(350); // the nearest first; the rest come in over the next frames, behind the haze
      for (let i = 0; i < 12; i++) spawnPerson();
    } catch (err) {
      active = false;
      ui.root.hidden = true;
      ui.loading.hidden = true;
      throw err;
    }
    ready = true;
    ui.loading.hidden = true;
    ui.street.textContent = '';
    if (ui.pad) {
      ui.pad.hidden = !window.matchMedia?.('(pointer: coarse)').matches;
      ui.pad.classList.remove('gone');
    }
    streetWait = 0;
    miniWait = 0;
    signs.wait = 0;
    return true;
  }
  function exit() {
    if (!active) return;
    active = false;
    ready = false;
    ui.root.hidden = true;
    stick = null;
    ptrs.clear();
    input.fwd = input.side = 0;
    input.keys.clear();
    hooks.onExit?.();
  }

  /** One frame (the game's loop calls it instead of drawing the map while you walk). */
  function frame(dt) {
    if (!ready || !gl || lost) return;
    time += dt;
    moveMe(dt);
    if (!near.at || Math.hypot(me.x - (near.at[0] + NEAR / 2), me.y - (near.at[1] + NEAR / 2)) > NEAR / 4) {
      paintNear(Math.round(me.x / 16) * 16, Math.round(me.y / 16) * 16);
    }
    updatePeople(dt);
    buildTiles(6);
    draw();
    streetWait -= dt;
    if (streetWait <= 0) {
      const name = streetName(me.x, me.y);
      ui.street.textContent = name ? `📍 ${name}` : '';
      ui.street.hidden = !name;
      streetWait = 0.7;
    }
    signs.wait -= dt;
    if (signs.wait <= 0) {
      updateSigns();
      signs.wait = 0.4;
    }
    miniWait -= dt;
    if (miniWait <= 0) {
      drawMini();
      miniWait = 0.12;
    }
    // As sharp as the phone manages: fewer pixels while it cannot keep up, more when it copes (pace.js).
    const step = pace(dt);
    if (step < 0 && scale > 0.4) scale = Math.max(0.4, scale - 0.12);
    else if (step > 0 && scale < 1) scale = Math.min(1, scale + 0.12);
  }

  return {
    enter,
    exit,
    frame,
    get active() {
      return active;
    },
    /** For tests: where you are, and how many have joined you. */
    state: () => ({
      x: me.x,
      y: me.y,
      yaw: me.yaw,
      pitch: me.pitch,
      joined,
      people: people.length,
      tiles: tiles.size,
      scale,
      roads: [...tiles.values()].reduce((n, t) => n + (t.rCount || 0), 0),
      signs: signs.count,
      towers: sky?.towers ?? 0,
      glError: gl ? gl.getError() : -1,
    }),
    /** For tests: the people around (where they are, and whether they joined). */
    people: () => people.map((p) => ({ x: p.x, y: p.y, joined: p.joined, act: p.act })),
    /** For tests: can you walk straight from one point to the other (no building, no water on the way)? */
    clearPath(x0, y0, x1, y1) {
      if (!city) return false;
      const L = Math.hypot(x1 - x0, y1 - y0) || 1;
      for (let d = 0; d <= L; d += 0.5) {
        const x = x0 + ((x1 - x0) * d) / L;
        const y = y0 + ((y1 - y0) * d) / L;
        if (city.buildingAt(x, y, 0.5) || !city.walkable(x, y)) return false;
      }
      return true;
    },
    /** For tests: stand somewhere, looking somewhere. */
    teleport(x, y, yaw = me.yaw, pitch = me.pitch) {
      const far = Math.hypot(x - me.x, y - me.y) > 5;
      me.x = x;
      me.y = y;
      me.yaw = yaw;
      me.pitch = pitch;
      target = null;
      if (!far) return;
      // Somewhere else: whoever follows you comes along, in a line behind you.
      const bx = -Math.cos(yaw);
      const by = -Math.sin(yaw);
      trail.length = 0;
      for (let d = 4 + joined * 1.1; d > 0; d -= 0.25) trail.push([x + bx * d, y + by * d]);
      trail.push([x, y]);
      let k = 0;
      for (const p of people) {
        if (!p.joined) continue;
        const d = 2.1 + 1.05 * k++;
        p.x = x + bx * d;
        p.y = y + by * d;
        p.a = yaw;
      }
    },
    supported: () => !!(gl || (typeof WebGL2RenderingContext !== 'undefined')),
  };
}

