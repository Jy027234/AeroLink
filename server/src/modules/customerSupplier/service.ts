import { AppError } from '../../middleware/errorHandler.js';
import prisma from '../../lib/prisma.js';
import type { Prisma } from '@prisma/client';

async function inTransaction<T>(operation: (tx: typeof prisma) => Promise<T>) {
  // Unit/route fixtures may provide a minimal Prisma delegate without $transaction;
  // production Prisma always takes the transactional branch.
  if (typeof (prisma as unknown as { $transaction?: unknown }).$transaction === 'function') {
    return prisma.$transaction((tx) => operation(tx as unknown as typeof prisma));
  }
  return operation(prisma);
}

export function normalizeSupplierEmail(value: unknown) {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

export function normalizeSupplierPhone(value: unknown) {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

export function normalizeSupplierLevel(value: unknown) {
  return (value || 'C').toString().toUpperCase();
}

export function normalizeCustomerStatus(value: string) {
  return value.toUpperCase().replace('-', '_');
}

export function assertSupplierEmailAvailable(existing: { id: string } | null, currentId?: string) {
  if (existing && existing.id !== currentId) {
    throw new AppError(currentId ? '该邮箱已关联其他供应商' : '该邮箱已关联供应商', 409);
  }
}

export async function updateCustomerAggregate(
  id: string,
  data: Prisma.CustomerUpdateInput,
  include: Prisma.CustomerInclude,
  options: { contactsProvided: boolean; competitorListingsProvided: boolean },
) {
  return inTransaction(async (tx) => {
    const existing = await tx.customer.findUnique({ where: { id }, include });
    if (!existing) throw new AppError('客户不存在', 404);

    if (options.contactsProvided) {
      await tx.customerContact.deleteMany({ where: { customerId: id } });
    }
    if (options.competitorListingsProvided) {
      await tx.competitorListing.deleteMany({ where: { customerId: id } });
    }

    return tx.customer.update({ where: { id }, data, include });
  });
}

export async function createSupplierAggregate(data: Prisma.SupplierCreateInput) {
  return inTransaction(async (tx) => {
    const email = typeof data.email === 'string' ? data.email : undefined;
    const existing = email ? await tx.supplier.findUnique({ where: { email } }) : null;
    assertSupplierEmailAvailable(existing);
    return tx.supplier.create({ data });
  });
}

export async function updateSupplierAggregate(id: string, data: Prisma.SupplierUpdateInput) {
  return inTransaction(async (tx) => {
    const existing = await tx.supplier.findUnique({ where: { id } });
    if (!existing) throw new AppError('供应商不存在', 404);

    const email = typeof data.email === 'string' ? data.email : undefined;
    if (email && email !== existing.email) {
      const duplicate = await tx.supplier.findUnique({ where: { email } });
      assertSupplierEmailAvailable(duplicate, id);
    }

    return tx.supplier.update({ where: { id }, data });
  });
}
