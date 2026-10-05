/** Original centred unit primitives. Winding follows Babylon's left-handed convention. */
export const SHAPES = Object.freeze(['box', 'cylinder', 'sphere', 'wedge']);
export const TRIANGLES = Object.freeze({box: 12, cylinder: 64, sphere: 528, wedge: 8});

function normal(a, b, c) {
  const u = a.map((value, i) => value - b[i]);
  const v = c.map((value, i) => value - b[i]);
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}

/** Same face-normal convention as VertexData.ComputeNormals, without a renderer dependency. */
export function computeNormals(positions, indices) {
  const normals = Array(positions.length).fill(0);
  for (let index = 0; index < indices.length; index += 3) {
    const ids = indices.slice(index, index + 3);
    const n = normal(...ids.map(id => positions.slice(id * 3, id * 3 + 3)));
    const length = Math.hypot(...n);
    if (length === 0) throw new Error('Primitive topology contains a degenerate triangle');
    for (const id of ids) for (let axis = 0; axis < 3; axis++) normals[id * 3 + axis] += n[axis] / length;
  }
  for (let index = 0; index < normals.length; index += 3) {
    const length = Math.hypot(...normals.slice(index, index + 3));
    for (let axis = 0; axis < 3; axis++) normals[index + axis] /= length || 1;
  }
  return normals;
}

function build(shape) {
  const positions = [], indices = [], uvs = [];
  const vertex = (point, uv) => {
    const index = positions.length / 3;
    positions.push(...point); uvs.push(...uv);
    return index;
  };
  const triangle = (a, b, c, outward) => {
    const n = normal(...[a, b, c].map(id => positions.slice(id * 3, id * 3 + 3)));
    indices.push(...(n.reduce((sum, value, i) => sum + value * outward[i], 0) >= 0 ? [a, b, c] : [a, c, b]));
  };
  const face = (points, outward) => {
    const ids = points.map((point, i) => vertex(point, [[0, 0], [1, 0], [1, 1], [0, 1]][i]));
    for (let i = 1; i < ids.length - 1; i++) triangle(ids[0], ids[i], ids[i + 1], outward);
  };
  if (shape === 'box') {
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const others = [0, 1, 2].filter(a => a !== axis);
      const points = [[-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5]].map(pair => {
        const point = [0, 0, 0]; point[axis] = sign * .5;
        pair.forEach((value, i) => { point[others[i]] = value; });
        return point;
      });
      const outward = [0, 0, 0]; outward[axis] = sign;
      face(points, outward);
    }
  } else if (shape === 'wedge') {
    const a = [-.5, -.5, -.5], b = [.5, -.5, -.5], c = [.5, -.5, .5];
    const d = [-.5, -.5, .5], e = [-.5, .5, .5], f = [.5, .5, .5];
    face([a, b, c, d], [0, -1, 0]);
    face([d, c, f, e], [0, 0, 1]);
    face([a, b, f, e], [0, 1, -1]);
    face([a, d, e], [-1, 0, 0]);
    face([b, c, f], [1, 0, 0]);
  } else if (shape === 'cylinder') {
    const count = 16, lower = [], upper = [];
    for (let i = 0; i <= count; i++) {
      const angle = 2 * Math.PI * i / count;
      lower.push(vertex([Math.cos(angle) / 2, -.5, Math.sin(angle) / 2], [i / count, 0]));
      upper.push(vertex([Math.cos(angle) / 2, .5, Math.sin(angle) / 2], [i / count, 1]));
    }
    for (let i = 0; i < count; i++) {
      const angle = 2 * Math.PI * (i + .5) / count, outward = [Math.cos(angle), 0, Math.sin(angle)];
      triangle(lower[i], upper[i], upper[i + 1], outward);
      triangle(lower[i], upper[i + 1], lower[i + 1], outward);
    }
    for (const sign of [-1, 1]) {
      const center = vertex([0, sign * .5, 0], [.5, .5]), ring = [];
      for (let i = 0; i < count; i++) {
        const angle = 2 * Math.PI * i / count, x = Math.cos(angle) / 2, z = Math.sin(angle) / 2;
        ring.push(vertex([x, sign * .5, z], [x + .5, z + .5]));
      }
      for (let i = 0; i < count; i++) triangle(center, ring[i], ring[(i + 1) % count], [0, sign, 0]);
    }
  } else {
    const slices = 24, stacks = 12, rings = [];
    const top = vertex([0, .5, 0], [.5, 1]), bottom = vertex([0, -.5, 0], [.5, 0]);
    for (let j = 1; j < stacks; j++) {
      const phi = Math.PI * j / stacks, ring = [];
      for (let i = 0; i <= slices; i++) {
        const angle = 2 * Math.PI * i / slices;
        ring.push(vertex([Math.sin(phi) * Math.cos(angle) / 2, Math.cos(phi) / 2, Math.sin(phi) * Math.sin(angle) / 2], [i / slices, 1 - j / stacks]));
      }
      rings.push(ring);
    }
    const sphereTriangle = (a, b, c) => triangle(a, b, c, [0, 1, 2].map(axis => (positions[3 * a + axis] + positions[3 * b + axis] + positions[3 * c + axis]) / 3));
    for (let i = 0; i < slices; i++) {
      sphereTriangle(top, rings[0][i], rings[0][i + 1]);
      for (let j = 0; j < rings.length - 1; j++) {
        sphereTriangle(rings[j][i], rings[j + 1][i], rings[j + 1][i + 1]);
        sphereTriangle(rings[j][i], rings[j + 1][i + 1], rings[j][i + 1]);
      }
      sphereTriangle(bottom, rings.at(-1)[i + 1], rings.at(-1)[i]);
    }
  }
  return {positions, indices, uvs, normals: computeNormals(positions, indices)};
}

const cache = new Map();
/** Each caller owns its arrays and can safely supply them to Babylon VertexData. */
export function geometry(shape) {
  if (!SHAPES.includes(shape)) throw new Error('Unknown primitive shape');
  if (!cache.has(shape)) cache.set(shape, build(shape));
  return Object.fromEntries(Object.entries(cache.get(shape)).map(([key, value]) => [key, [...value]]));
}
