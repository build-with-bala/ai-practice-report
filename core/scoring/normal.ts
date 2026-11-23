/**
 * The standard normal distribution: `phi`, its CDF, by Hart's algorithm 5666 (as given by West, "Better approximations to
 * cumulative normal functions", 2005), which is accurate to double precision (well inside |error| < 1e-7) and gives
 * exactly 0.5 at 0; and `phiInv`, its inverse, by Acklam's rational approximation with one Halley refinement step.
 * Both refuse input that would yield NaN or an infinite value (RangeError), so none leaves them.
 */

/** Φ(z) for any z but NaN: ±Infinity give 1 and 0. */
export function phi(z: number): number {
  if (Number.isNaN(z)) throw new RangeError("phi: z is NaN");
  const x = Math.abs(z);
  let c: number;
  if (x > 37) c = 0;
  else {
    const e = Math.exp(-x * x / 2);
    if (x < 7.07106781186547) {
      let n = 3.52624965998911e-2 * x + 0.700383064443688;
      n = n * x + 6.37396220353165;
      n = n * x + 33.912866078383;
      n = n * x + 112.079291497871;
      n = n * x + 221.213596169931;
      n = n * x + 220.206867912376;
      let d = 8.83883476483184e-2 * x + 1.75566716318264;
      d = d * x + 16.064177579207;
      d = d * x + 86.7807322029461;
      d = d * x + 296.564248779674;
      d = d * x + 637.333633378831;
      d = d * x + 793.826512519948;
      d = d * x + 440.413735824752;
      c = e * n / d;
    } else {
      let b = x + 0.65;
      b = x + 4 / b;
      b = x + 3 / b;
      b = x + 2 / b;
      b = x + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return z > 0 ? 1 - c : c;
}

const A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
const B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
const P_LOW = 0.02425;

/** Φ⁻¹(p) for 0 < p < 1 (for tests and reports); any other p is a RangeError. */
export function phiInv(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError("phiInv: p must lie strictly between 0 and 1");
  let x: number;
  if (p < P_LOW || p > 1 - P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p < P_LOW ? p : 1 - p));
    x = (((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) / ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
    if (p > 1 - P_LOW) x = -x;
  } else {
    const q = p - 0.5;
    const r = q * q;
    x = (((((A[0]! * r + A[1]!) * r + A[2]!) * r + A[3]!) * r + A[4]!) * r + A[5]!) * q
      / (((((B[0]! * r + B[1]!) * r + B[2]!) * r + B[3]!) * r + B[4]!) * r + 1);
  }
  // One Halley step against phi brings the result to near full precision.
  const e = phi(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  const refined = x - u / (1 + x * u / 2);
  return Number.isFinite(refined) ? refined : x;
}
