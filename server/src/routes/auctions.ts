import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';

const router = Router();

function generateAuctionNumber(): string {
  const year = new Date().getFullYear();
  const random = Math.floor(10000 + Math.random() * 90000).toString();
  return `AUC-${year}-${random}`;
}

function isBidBetter(auctionType: string, newAmount: number, currentAmount: number): boolean {
  if (auctionType === 'REVERSE') {
    return newAmount < currentAmount;
  }
  return newAmount > currentAmount;
}

function shouldAutoExtend(auction: { endAt: Date; autoExtend: boolean }): boolean {
  if (!auction.autoExtend) return false;
  const now = new Date();
  const endAt = new Date(auction.endAt);
  const diffMs = endAt.getTime() - now.getTime();
  return diffMs > 0 && diffMs <= 5 * 60 * 1000; // within 5 minutes
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { status, type, partNumber, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: Prisma.AuctionWhereInput = {};
    if (status) where.status = status.toString().toUpperCase();
    if (type) where.type = type.toString().toUpperCase();
    if (partNumber) where.partNumber = { contains: partNumber.toString() };

    const [auctions, total] = await Promise.all([
      prisma.auction.findMany({
        where,
        include: {
          bids: {
            orderBy: { bidTime: 'desc' },
            take: 1,
            select: {
              id: true,
              amount: true,
              bidderName: true,
              bidTime: true,
            },
          },
          _count: { select: { bids: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.auction.count({ where }),
    ]);

    res.json({
      success: true,
      data: auctions.map((a) => ({
        id: a.id,
        auctionNumber: a.auctionNumber,
        title: a.title,
        type: a.type.toLowerCase(),
        status: a.status.toLowerCase(),
        partNumber: a.partNumber,
        partDescription: a.partDescription,
        quantity: a.quantity,
        conditionCode: a.conditionCode,
        certificateType: a.certificateType,
        startingPrice: a.startingPrice,
        reservePrice: a.reservePrice,
        buyNowPrice: a.buyNowPrice,
        currency: a.currency,
        startAt: a.startAt.toISOString(),
        endAt: a.endAt.toISOString(),
        autoExtend: a.autoExtend,
        extendMinutes: a.extendMinutes,
        sellerId: a.sellerId,
        buyerId: a.buyerId,
        winnerBidId: a.winnerBidId,
        finalPrice: a.finalPrice,
        closedAt: a.closedAt?.toISOString(),
        closedReason: a.closedReason,
        inventoryId: a.inventoryId,
        rfqId: a.rfqId,
        createdBy: a.createdBy,
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
        bidCount: a._count.bids,
        latestBid: a.bids[0]
          ? {
              id: a.bids[0].id,
              amount: a.bids[0].amount,
              bidderName: a.bids[0].bidderName,
              bidTime: a.bids[0].bidTime.toISOString(),
            }
          : null,
      })),
      pagination: { page: pageNum, limit: pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const {
      title,
      description,
      type,
      partNumber,
      partDescription,
      quantity,
      conditionCode,
      certificateType,
      startingPrice,
      reservePrice,
      buyNowPrice,
      currency,
      startAt,
      endAt,
      autoExtend,
      extendMinutes,
      sellerId,
      buyerId,
      invitedSupplierIds,
      inventoryId,
      rfqId,
    } = req.body;

    if (!title || !partNumber || !startAt || !endAt) {
      throw new AppError('标题、件号、开始时间和结束时间不能为空', 400, 'BAD_REQUEST');
    }

    const startDate = new Date(startAt);
    const endDate = new Date(endAt);
    if (endDate <= startDate) {
      throw new AppError('结束时间必须晚于开始时间', 400, 'BAD_REQUEST');
    }

    const auctionNumber = generateAuctionNumber();

    const auction = await prisma.auction.create({
      data: {
        auctionNumber,
        title,
        description: description || null,
        type: type?.toUpperCase() || 'SALES',
        status: 'DRAFT',
        partNumber,
        partDescription: partDescription || null,
        quantity: quantity || 1,
        conditionCode: conditionCode || null,
        certificateType: certificateType || null,
        startingPrice: startingPrice ?? null,
        reservePrice: reservePrice ?? null,
        buyNowPrice: buyNowPrice ?? null,
        currency: currency || 'USD',
        startAt: startDate,
        endAt: endDate,
        autoExtend: autoExtend !== undefined ? autoExtend : true,
        extendMinutes: extendMinutes || 5,
        sellerId: sellerId || null,
        buyerId: buyerId || null,
        invitedSupplierIds: Array.isArray(invitedSupplierIds) ? JSON.stringify(invitedSupplierIds) : invitedSupplierIds || null,
        inventoryId: inventoryId || null,
        rfqId: rfqId || null,
        createdBy: (req as AuthRequest).user!.id,
      },
    });

    res.status(201).json({
      success: true,
      data: {
        id: auction.id,
        auctionNumber: auction.auctionNumber,
        title: auction.title,
        type: auction.type.toLowerCase(),
        status: auction.status.toLowerCase(),
        partNumber: auction.partNumber,
        startAt: auction.startAt.toISOString(),
        endAt: auction.endAt.toISOString(),
        createdAt: auction.createdAt.toISOString(),
      },
    });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const auction = await prisma.auction.findUnique({
      where: { id: req.params.id },
      include: {
        bids: {
          orderBy: { bidTime: 'desc' },
          include: {
            auction: { select: { type: true, status: true } },
          },
        },
      },
    });

    if (!auction) {
      throw new AppError('拍卖不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    const isClosed = auction.status === 'CLOSED' || auction.status === 'CANCELLED';
    const isSealed = auction.type === 'SEALED';

    const bids = auction.bids.map((bid) => ({
      id: bid.id,
      auctionId: bid.auctionId,
      bidderId: bid.bidderId,
      bidderType: bid.bidderType.toLowerCase(),
      bidderName: bid.bidderName,
      amount: isSealed && !isClosed ? null : bid.amount,
      currency: bid.currency,
      quantity: bid.quantity,
      isAutoBid: bid.isAutoBid,
      maxAutoBid: bid.maxAutoBid,
      bidTime: bid.bidTime.toISOString(),
      isWinning: bid.isWinning,
      isSealed: bid.isSealed,
      notes: bid.notes,
    }));

    res.json({
      success: true,
      data: {
        id: auction.id,
        auctionNumber: auction.auctionNumber,
        title: auction.title,
        description: auction.description,
        type: auction.type.toLowerCase(),
        status: auction.status.toLowerCase(),
        partNumber: auction.partNumber,
        partDescription: auction.partDescription,
        quantity: auction.quantity,
        conditionCode: auction.conditionCode,
        certificateType: auction.certificateType,
        startingPrice: auction.startingPrice,
        reservePrice: auction.reservePrice,
        buyNowPrice: auction.buyNowPrice,
        currency: auction.currency,
        startAt: auction.startAt.toISOString(),
        endAt: auction.endAt.toISOString(),
        autoExtend: auction.autoExtend,
        extendMinutes: auction.extendMinutes,
        sellerId: auction.sellerId,
        buyerId: auction.buyerId,
        invitedSupplierIds: auction.invitedSupplierIds ? JSON.parse(auction.invitedSupplierIds) : [],
        winnerBidId: auction.winnerBidId,
        finalPrice: auction.finalPrice,
        closedAt: auction.closedAt?.toISOString(),
        closedReason: auction.closedReason,
        inventoryId: auction.inventoryId,
        rfqId: auction.rfqId,
        createdBy: auction.createdBy,
        createdAt: auction.createdAt.toISOString(),
        updatedAt: auction.updatedAt.toISOString(),
        bids,
      },
    });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.auction.findUnique({
      where: { id: req.params.id },
    });

    if (!existing) {
      throw new AppError('拍卖不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    if (existing.status !== 'DRAFT') {
      throw new AppError('只有草稿状态的拍卖可以编辑', 400, 'BAD_REQUEST');
    }

    const {
      title,
      description,
      type,
      partNumber,
      partDescription,
      quantity,
      conditionCode,
      certificateType,
      startingPrice,
      reservePrice,
      buyNowPrice,
      currency,
      startAt,
      endAt,
      autoExtend,
      extendMinutes,
      sellerId,
      buyerId,
      invitedSupplierIds,
      inventoryId,
      rfqId,
    } = req.body;

    const data: Prisma.AuctionUpdateInput = {};
    if (title !== undefined) data.title = title;
    if (description !== undefined) data.description = description || null;
    if (type !== undefined) data.type = type.toUpperCase();
    if (partNumber !== undefined) data.partNumber = partNumber;
    if (partDescription !== undefined) data.partDescription = partDescription || null;
    if (quantity !== undefined) data.quantity = quantity;
    if (conditionCode !== undefined) data.conditionCode = conditionCode || null;
    if (certificateType !== undefined) data.certificateType = certificateType || null;
    if (startingPrice !== undefined) data.startingPrice = startingPrice ?? null;
    if (reservePrice !== undefined) data.reservePrice = reservePrice ?? null;
    if (buyNowPrice !== undefined) data.buyNowPrice = buyNowPrice ?? null;
    if (currency !== undefined) data.currency = currency;
    if (startAt !== undefined) data.startAt = new Date(startAt);
    if (endAt !== undefined) data.endAt = new Date(endAt);
    if (autoExtend !== undefined) data.autoExtend = autoExtend;
    if (extendMinutes !== undefined) data.extendMinutes = extendMinutes;
    if (sellerId !== undefined) data.sellerId = sellerId || null;
    if (buyerId !== undefined) data.buyerId = buyerId || null;
    if (invitedSupplierIds !== undefined) {
      data.invitedSupplierIds = Array.isArray(invitedSupplierIds) ? JSON.stringify(invitedSupplierIds) : invitedSupplierIds || null;
    }
    if (inventoryId !== undefined) data.inventoryId = inventoryId || null;
    if (rfqId !== undefined) data.rfqId = rfqId || null;

    if (data.startAt && data.endAt) {
      const s = new Date(data.startAt as Date);
      const e = new Date(data.endAt as Date);
      if (e <= s) {
        throw new AppError('结束时间必须晚于开始时间', 400, 'BAD_REQUEST');
      }
    }

    const auction = await prisma.auction.update({
      where: { id: req.params.id },
      data,
    });

    res.json({
      success: true,
      data: {
        id: auction.id,
        auctionNumber: auction.auctionNumber,
        title: auction.title,
        type: auction.type.toLowerCase(),
        status: auction.status.toLowerCase(),
        partNumber: auction.partNumber,
        startAt: auction.startAt.toISOString(),
        endAt: auction.endAt.toISOString(),
        updatedAt: auction.updatedAt.toISOString(),
      },
    });
  })
);

router.post(
  '/:id/activate',
  asyncHandler(async (req, res) => {
    const auction = await prisma.auction.findUnique({
      where: { id: req.params.id },
    });

    if (!auction) {
      throw new AppError('拍卖不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    if (auction.status !== 'DRAFT') {
      throw new AppError('只有草稿状态的拍卖可以激活', 400, 'BAD_REQUEST');
    }

    const now = new Date();
    const startAt = new Date(auction.startAt);
    const endAt = new Date(auction.endAt);

    if (endAt <= startAt) {
      throw new AppError('结束时间必须晚于开始时间', 400, 'BAD_REQUEST');
    }

    const updated = await prisma.auction.update({
      where: { id: req.params.id },
      data: {
        status: 'ACTIVE',
        startAt: startAt <= now && endAt > now ? startAt : (startAt > now ? startAt : now),
      },
    });

    res.json({
      success: true,
      data: {
        id: updated.id,
        auctionNumber: updated.auctionNumber,
        status: updated.status.toLowerCase(),
        startAt: updated.startAt.toISOString(),
        endAt: updated.endAt.toISOString(),
      },
    });
  })
);

router.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const auction = await prisma.auction.findUnique({
      where: { id: req.params.id },
    });

    if (!auction) {
      throw new AppError('拍卖不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    if (auction.status === 'CANCELLED') {
      throw new AppError('拍卖已取消', 400, 'BAD_REQUEST');
    }

    if (auction.status === 'CLOSED') {
      throw new AppError('已结束的拍卖不能取消', 400, 'BAD_REQUEST');
    }

    const updated = await prisma.auction.update({
      where: { id: req.params.id },
      data: {
        status: 'CANCELLED',
        closedAt: new Date(),
        closedReason: 'CANCELLED',
      },
    });

    res.json({
      success: true,
      data: {
        id: updated.id,
        auctionNumber: updated.auctionNumber,
        status: updated.status.toLowerCase(),
        closedAt: updated.closedAt?.toISOString(),
        closedReason: updated.closedReason,
      },
    });
  })
);

router.post(
  '/:id/close',
  asyncHandler(async (req, res) => {
    const auction = await prisma.auction.findUnique({
      where: { id: req.params.id },
      include: {
        bids: {
          orderBy: { amount: 'asc' },
        },
      },
    });

    if (!auction) {
      throw new AppError('拍卖不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    if (auction.status !== 'ACTIVE') {
      throw new AppError('只有进行中的拍卖可以手动结束', 400, 'BAD_REQUEST');
    }

    let winnerBidId: string | null = null;
    let finalPrice: number | null = null;
    let closedReason = 'NO_BIDS';

    if (auction.bids.length > 0) {
      const sortedBids =
        auction.type === 'REVERSE'
          ? [...auction.bids].sort((a, b) => a.amount - b.amount)
          : [...auction.bids].sort((a, b) => b.amount - a.amount);

      const bestBid = sortedBids[0];

      if (auction.reservePrice != null) {
        const meetsReserve =
          auction.type === 'REVERSE'
            ? bestBid.amount <= auction.reservePrice
            : bestBid.amount >= auction.reservePrice;

        if (meetsReserve) {
          winnerBidId = bestBid.id;
          finalPrice = bestBid.amount;
          closedReason = 'SOLD';
        } else {
          closedReason = 'RESERVE_NOT_MET';
        }
      } else {
        winnerBidId = bestBid.id;
        finalPrice = bestBid.amount;
        closedReason = 'SOLD';
      }

      if (winnerBidId) {
        await prisma.auctionBid.updateMany({
          where: { auctionId: auction.id },
          data: { isWinning: false },
        });
        await prisma.auctionBid.update({
          where: { id: winnerBidId },
          data: { isWinning: true },
        });
      }
    }

    const updated = await prisma.auction.update({
      where: { id: req.params.id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        closedReason,
        winnerBidId,
        finalPrice,
      },
    });

    res.json({
      success: true,
      data: {
        id: updated.id,
        auctionNumber: updated.auctionNumber,
        status: updated.status.toLowerCase(),
        closedAt: updated.closedAt?.toISOString(),
        closedReason: updated.closedReason,
        winnerBidId: updated.winnerBidId,
        finalPrice: updated.finalPrice,
      },
    });
  })
);

router.post(
  '/:id/bid',
  asyncHandler(async (req, res) => {
    const { amount, quantity, isAutoBid, maxAutoBid, notes } = req.body;
    const user = (req as AuthRequest).user!;

    if (amount == null || isNaN(Number(amount))) {
      throw new AppError('出价金额不能为空', 400, 'BAD_REQUEST');
    }

    const bidAmount = Number(amount);

    const auction = await prisma.auction.findUnique({
      where: { id: req.params.id },
      include: {
        bids: {
          orderBy: { bidTime: 'desc' },
        },
      },
    });

    if (!auction) {
      throw new AppError('拍卖不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    if (auction.status !== 'ACTIVE') {
      throw new AppError('拍卖未在进行中', 400, 'BAD_REQUEST');
    }

    const now = new Date();
    const endAt = new Date(auction.endAt);
    if (now > endAt) {
      throw new AppError('拍卖已结束', 400, 'BAD_REQUEST');
    }

    // Validate bid amount
    if (auction.startingPrice != null) {
      const isReverse = auction.type === 'REVERSE';
      if (isReverse) {
        if (bidAmount > auction.startingPrice) {
          throw new AppError('反向拍卖出价不能高于起始价', 400, 'BAD_REQUEST');
        }
      } else {
        if (bidAmount < auction.startingPrice) {
          throw new AppError('出价不能低于起始价', 400, 'BAD_REQUEST');
        }
      }
    }

    // Check against current best bid
    if (auction.bids.length > 0) {
      const sortedBids =
        auction.type === 'REVERSE'
          ? [...auction.bids].sort((a, b) => a.amount - b.amount)
          : [...auction.bids].sort((a, b) => b.amount - a.amount);

      const currentBest = sortedBids[0];
      if (!isBidBetter(auction.type, bidAmount, currentBest.amount)) {
        const msg = auction.type === 'REVERSE' ? '出价必须低于当前最优价' : '出价必须高于当前最优价';
        throw new AppError(msg, 400, 'BAD_REQUEST');
      }
    }

    // Handle auto-extend
    let newEndAt: Date | undefined;
    if (shouldAutoExtend(auction)) {
      newEndAt = new Date(endAt.getTime() + (auction.extendMinutes || 5) * 60 * 1000);
    }

    const [bid, updatedAuction] = await prisma.$transaction([
      prisma.auctionBid.create({
        data: {
          auctionId: auction.id,
          bidderId: user.id,
          bidderType: 'USER',
          bidderName: user.name,
          amount: bidAmount,
          currency: auction.currency,
          quantity: quantity || 1,
          isAutoBid: isAutoBid || false,
          maxAutoBid: maxAutoBid ?? null,
          isSealed: auction.type === 'SEALED',
          notes: notes || null,
        },
      }),
      prisma.auction.update({
        where: { id: auction.id },
        data: {
          endAt: newEndAt || endAt,
        },
      }),
    ]);

    res.status(201).json({
      success: true,
      data: {
        id: bid.id,
        auctionId: bid.auctionId,
        bidderId: bid.bidderId,
        bidderName: bid.bidderName,
        amount: bid.amount,
        currency: bid.currency,
        quantity: bid.quantity,
        isAutoBid: bid.isAutoBid,
        maxAutoBid: bid.maxAutoBid,
        bidTime: bid.bidTime.toISOString(),
        isSealed: bid.isSealed,
        notes: bid.notes,
        endAtExtended: !!newEndAt,
        endAt: updatedAuction.endAt.toISOString(),
      },
    });
  })
);

router.get(
  '/:id/bids',
  asyncHandler(async (req, res) => {
    const auction = await prisma.auction.findUnique({
      where: { id: req.params.id },
      select: { type: true, status: true },
    });

    if (!auction) {
      throw new AppError('拍卖不存在', 404, 'RESOURCE_NOT_FOUND');
    }

    const isClosed = auction.status === 'CLOSED' || auction.status === 'CANCELLED';
    const isSealed = auction.type === 'SEALED';

    const bids = await prisma.auctionBid.findMany({
      where: { auctionId: req.params.id },
      orderBy: { bidTime: 'desc' },
    });

    res.json({
      success: true,
      data: bids.map((b) => ({
        id: b.id,
        auctionId: b.auctionId,
        bidderId: b.bidderId,
        bidderType: b.bidderType.toLowerCase(),
        bidderName: b.bidderName,
        amount: isSealed && !isClosed ? null : b.amount,
        currency: b.currency,
        quantity: b.quantity,
        isAutoBid: b.isAutoBid,
        maxAutoBid: b.maxAutoBid,
        bidTime: b.bidTime.toISOString(),
        isWinning: b.isWinning,
        isSealed: b.isSealed,
        notes: b.notes,
      })),
    });
  })
);

router.get(
  '/active',
  asyncHandler(async (req, res) => {
    const { partNumber, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const where: Prisma.AuctionWhereInput = {
      status: 'ACTIVE',
      endAt: { gt: new Date() },
    };
    if (partNumber) where.partNumber = { contains: partNumber.toString() };

    const [auctions, total] = await Promise.all([
      prisma.auction.findMany({
        where,
        include: {
          bids: {
            orderBy: { bidTime: 'desc' },
            take: 1,
            select: {
              id: true,
              amount: true,
              bidderName: true,
              bidTime: true,
            },
          },
          _count: { select: { bids: true } },
        },
        orderBy: { endAt: 'asc' },
        skip,
        take: pageSize,
      }),
      prisma.auction.count({ where }),
    ]);

    res.json({
      success: true,
      data: auctions.map((a) => ({
        id: a.id,
        auctionNumber: a.auctionNumber,
        title: a.title,
        type: a.type.toLowerCase(),
        status: a.status.toLowerCase(),
        partNumber: a.partNumber,
        partDescription: a.partDescription,
        quantity: a.quantity,
        conditionCode: a.conditionCode,
        certificateType: a.certificateType,
        startingPrice: a.startingPrice,
        reservePrice: a.reservePrice,
        buyNowPrice: a.buyNowPrice,
        currency: a.currency,
        startAt: a.startAt.toISOString(),
        endAt: a.endAt.toISOString(),
        autoExtend: a.autoExtend,
        extendMinutes: a.extendMinutes,
        sellerId: a.sellerId,
        buyerId: a.buyerId,
        createdBy: a.createdBy,
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
        bidCount: a._count.bids,
        latestBid: a.bids[0]
          ? {
              id: a.bids[0].id,
              amount: a.bids[0].amount,
              bidderName: a.bids[0].bidderName,
              bidTime: a.bids[0].bidTime.toISOString(),
            }
          : null,
      })),
      pagination: { page: pageNum, limit: pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  })
);

router.get(
  '/my-bids',
  asyncHandler(async (req, res) => {
    const user = (req as AuthRequest).user!;
    const { status, page, limit } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const bidWhere: Prisma.AuctionBidWhereInput = {
      bidderId: user.id,
    };

    const userBidAuctionIds = await prisma.auctionBid.findMany({
      where: bidWhere,
      select: { auctionId: true },
      distinct: ['auctionId'],
    });

    const auctionIds = userBidAuctionIds.map((b) => b.auctionId);

    if (auctionIds.length === 0) {
      res.json({
        success: true,
        data: [],
        pagination: { page: pageNum, limit: pageSize, total: 0, totalPages: 0 },
      });
      return;
    }

    const where: Prisma.AuctionWhereInput = {
      id: { in: auctionIds },
    };
    if (status) where.status = status.toString().toUpperCase();

    const [auctions, total] = await Promise.all([
      prisma.auction.findMany({
        where,
        include: {
          bids: {
            where: { bidderId: user.id },
            orderBy: { bidTime: 'desc' },
          },
          _count: { select: { bids: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.auction.count({ where }),
    ]);

    res.json({
      success: true,
      data: auctions.map((a) => {
        const myLatestBid = a.bids[0];
        return {
          id: a.id,
          auctionNumber: a.auctionNumber,
          title: a.title,
          type: a.type.toLowerCase(),
          status: a.status.toLowerCase(),
          partNumber: a.partNumber,
          partDescription: a.partDescription,
          quantity: a.quantity,
          conditionCode: a.conditionCode,
          startingPrice: a.startingPrice,
          reservePrice: a.reservePrice,
          buyNowPrice: a.buyNowPrice,
          currency: a.currency,
          startAt: a.startAt.toISOString(),
          endAt: a.endAt.toISOString(),
          autoExtend: a.autoExtend,
          extendMinutes: a.extendMinutes,
          sellerId: a.sellerId,
          buyerId: a.buyerId,
          winnerBidId: a.winnerBidId,
          finalPrice: a.finalPrice,
          closedAt: a.closedAt?.toISOString(),
          closedReason: a.closedReason,
          createdBy: a.createdBy,
          createdAt: a.createdAt.toISOString(),
          updatedAt: a.updatedAt.toISOString(),
          myBidCount: a.bids.length,
          myLatestBid: myLatestBid
            ? {
                id: myLatestBid.id,
                amount: myLatestBid.amount,
                bidTime: myLatestBid.bidTime.toISOString(),
                isWinning: myLatestBid.isWinning,
              }
            : null,
        };
      }),
      pagination: { page: pageNum, limit: pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  })
);

export default router;
