import { Prisma } from '@prisma/client';

export const MONEY_DECIMAL_PLACES = 4;

export type MoneyInput = Prisma.Decimal | number | string;

function toDecimal(value: MoneyInput) {
  const decimal = new Prisma.Decimal(value);
  if (!decimal.isFinite()) {
    throw new RangeError('金额必须是有限数字');
  }
  return decimal;
}

export function normalizeMoney(value: MoneyInput) {
  return toDecimal(value).toDecimalPlaces(MONEY_DECIMAL_PLACES, Prisma.Decimal.ROUND_HALF_UP);
}

export function normalizeOptionalMoney(value: MoneyInput | null | undefined) {
  return value === null || value === undefined ? null : normalizeMoney(value);
}

export function moneyToNumber(value: MoneyInput) {
  return normalizeMoney(value).toNumber();
}

export function preferredMoneyValue(
  decimalValue: MoneyInput | null | undefined,
  legacyValue: number | null | undefined,
) {
  if (decimalValue !== null && decimalValue !== undefined) {
    return moneyToNumber(decimalValue);
  }
  return legacyValue === null || legacyValue === undefined ? null : moneyToNumber(legacyValue);
}

export function calculateMoneyTotal(unitPrice: MoneyInput, quantity: number) {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new RangeError('数量必须是非负整数');
  }
  return normalizeMoney(unitPrice)
    .mul(quantity)
    .toDecimalPlaces(MONEY_DECIMAL_PLACES, Prisma.Decimal.ROUND_HALF_UP);
}

export function calculateMarginPercent(totalPrice: MoneyInput, costPrice: MoneyInput, quantity: number) {
  const total = normalizeMoney(totalPrice);
  if (total.isZero()) {
    return 0;
  }
  const totalCost = calculateMoneyTotal(costPrice, quantity);
  return total
    .minus(totalCost)
    .div(total)
    .mul(100)
    .toDecimalPlaces(MONEY_DECIMAL_PLACES, Prisma.Decimal.ROUND_HALF_UP)
    .toNumber();
}

export function moneyValuesMatch(
  decimalValue: MoneyInput | null | undefined,
  legacyValue: number | null | undefined,
) {
  if (decimalValue === null || decimalValue === undefined) {
    return legacyValue === null || legacyValue === undefined;
  }
  if (legacyValue === null || legacyValue === undefined) {
    return false;
  }
  return normalizeMoney(decimalValue).equals(normalizeMoney(legacyValue));
}
