import { Matrix4, Quaternion, Vector3 } from 'three'

const a = new Vector3(), b = new Vector3(), c = new Vector3()

/** Two-bone IK: where the elbow goes so the wrist reaches the target (or as near as the arm allows), bending toward `pole`. */
export function solveElbow(shoulder: Vector3, target: Vector3, upper: number, fore: number, pole: Vector3, outElbow: Vector3, outWrist: Vector3) {
  const dir = a.copy(target).sub(shoulder)
  const dist = Math.max(Math.abs(upper - fore) + 1e-3, Math.min((upper + fore) * 0.995, dir.length() || 1e-3))
  dir.normalize()
  const along = (upper * upper - fore * fore + dist * dist) / (2 * dist)
  const height = Math.sqrt(Math.max(0, upper * upper - along * along))
  const bend = b.copy(pole).addScaledVector(dir, -pole.dot(dir))
  if (bend.lengthSq() < 1e-6) bend.set(0, -1, 0).addScaledVector(dir, dir.y)
  bend.normalize()
  outElbow.copy(shoulder).addScaledVector(dir, along).addScaledVector(bend, height)
  outWrist.copy(shoulder).addScaledVector(dir, dist)
}

/** the rotation that takes a rest (fingers, palm) frame to a target (fingers, palm) frame */
export function frameRotation(restF: Vector3, restP: Vector3, f: Vector3, p: Vector3, out: Quaternion) {
  const basis = (x: Vector3, y: Vector3) => {
    const X = x.clone().normalize(), Z = new Vector3().crossVectors(X, y).normalize(), Y = new Vector3().crossVectors(Z, X)
    return new Matrix4().makeBasis(X, Y, Z)
  }
  const m = basis(f, p).multiply(basis(restF, restP).invert())
  return out.setFromRotationMatrix(m)
}

/** the part of q that spins around `axis` */
export function twistAround(q: Quaternion, axis: Vector3, out: Quaternion) {
  c.set(q.x, q.y, q.z)
  const d = c.dot(axis)
  out.set(axis.x * d, axis.y * d, axis.z * d, q.w)
  if (out.lengthSq() < 1e-9) return out.identity()
  return out.normalize()
}
