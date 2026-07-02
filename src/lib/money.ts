/**
 * Centralized rounding for fuel transactions.
 * Uses half-up rounding (standard commercial rounding).
 * All inputs and outputs are BigInt to avoid float imprecision.
 */
export function roundHalfUp(
  pricePerLitreHalalas: bigint,
  millilitres: bigint
): bigint {
  const numerator = pricePerLitreHalalas * millilitres;
  const quotient = numerator / 1000n;
  const remainder = numerator % 1000n;
  return remainder >= 500n ? quotient + 1n : quotient;
}

export function toSar(halalas: bigint): string {
  const sarInt = halalas / 100n;
  const halalasFraction = halalas % 100n;
  return `${sarInt}.${halalasFraction.toString().padStart(2, '0')} SAR`;
}

export function toLitres(millilitres: number): string {
  return `${(millilitres / 1000).toFixed(3)} L`;
}
