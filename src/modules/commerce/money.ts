export interface Money {
  amount: number;
  currency: string;
}

export function assertMinorUnits(value: number, field = 'amount'): number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must be an integer number of minor currency units.`);
  }
  return value;
}

export function assertCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new TypeError('Currency must be a three-letter ISO 4217 code.');
  }
  return currency;
}

export function netFromGross(grossMinor: number, vatBasisPoints: number): number {
  assertMinorUnits(grossMinor, 'gross amount');
  if (!Number.isInteger(vatBasisPoints) || vatBasisPoints < 0 || vatBasisPoints > 10_000) {
    throw new TypeError('VAT rate must be expressed as basis points between 0 and 10000.');
  }
  return Math.round((grossMinor * 10_000) / (10_000 + vatBasisPoints));
}

export function percentageOf(amountMinor: number, basisPoints: number): number {
  assertMinorUnits(amountMinor);
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new TypeError('Percentage must be expressed as basis points between 0 and 10000.');
  }
  return Math.round((amountMinor * basisPoints) / 10_000);
}

