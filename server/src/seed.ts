import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { normalizeMoney, normalizeOptionalMoney } from './lib/money.js';
import {
  toOrderStatusEnum,
  toQuotationStatusEnum,
  toRfqStatusEnum,
} from './lib/transactionStatusShadows.js';

const prisma = new PrismaClient();

const SALT_ROUNDS = 12;

async function main() {
  const demoSeedPassword = process.env.DEMO_SEED_PASSWORD;
  if (!demoSeedPassword || demoSeedPassword.length < 8) {
    throw new Error('DEMO_SEED_PASSWORD (at least 8 characters) is required; refusing to seed demo data with a default password.');
  }
  const demoPasswordHash = await bcrypt.hash(demoSeedPassword, SALT_ROUNDS);

  console.log('开始播种数据...');

  await prisma.transactionStatusHistory.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.approval.deleteMany();
  await prisma.trackingEvent.deleteMany();
  await prisma.shipmentTracking.deleteMany();
  await prisma.inventoryTransaction.deleteMany();
  await prisma.certificate.deleteMany();
  await prisma.generatedDocument.deleteMany();
  await prisma.outboundEmail.deleteMany();
  await prisma.order.deleteMany();
  await prisma.quotation.deleteMany();
  await prisma.inquiryItem.deleteMany();
  await prisma.inquiry.deleteMany();
  await prisma.rFQ.deleteMany();
  await prisma.email.deleteMany();
  await prisma.emailAccount.deleteMany();
  await prisma.vMIAgreement.deleteMany();
  await prisma.iPCData.deleteMany();
  await prisma.outboxEvent.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.certificateTemplate.deleteMany();
  await prisma.documentTemplate.deleteMany();

  // ========== IPC Data ==========
  const ipcData = await prisma.iPCData.createMany({
    data: [
      {
        id: 'ipc001',
        partNumber: '2341-123-050',
        description: 'Landing Gear Actuator',
        ataChapter: 'ATA32',
        aircraftTypes: JSON.stringify(['B737-800', 'B737-700', 'B737-900']),
        interchangeableWith: JSON.stringify(['2341-123-051']),
        alternateParts: JSON.stringify(['2341-123-052', '2341-123-053']),
      },
      {
        id: 'ipc002',
        partNumber: '2341-123-051',
        description: 'Landing Gear Actuator (Alternate)',
        ataChapter: 'ATA32',
        aircraftTypes: JSON.stringify(['B737-800', 'B737-700']),
        supersededBy: '2341-123-050',
        interchangeableWith: JSON.stringify(['2341-123-050']),
        alternateParts: JSON.stringify(['2341-123-052']),
      },
      {
        id: 'ipc003',
        partNumber: '3214-456-010',
        description: 'Hydraulic Pump Assembly',
        ataChapter: 'ATA29',
        aircraftTypes: JSON.stringify(['A320-200', 'A320neo', 'A321-200']),
        interchangeableWith: JSON.stringify(['3214-456-011']),
        alternateParts: JSON.stringify(['3214-456-012']),
      },
      {
        id: 'ipc004',
        partNumber: '3214-456-011',
        description: 'Hydraulic Pump Assembly (Series B)',
        ataChapter: 'ATA29',
        aircraftTypes: JSON.stringify(['A320-200', 'A320neo']),
        supersededBy: '3214-456-010',
        interchangeableWith: JSON.stringify(['3214-456-010']),
        alternateParts: JSON.stringify(['3214-456-012']),
      },
      {
        id: 'ipc005',
        partNumber: '4521-789-030',
        description: 'Fuel Control Unit',
        ataChapter: 'ATA73',
        aircraftTypes: JSON.stringify(['B777-300ER', 'B777-200LR']),
        interchangeableWith: JSON.stringify(['4521-789-031']),
        alternateParts: JSON.stringify(['4521-789-032']),
      },
      {
        id: 'ipc006',
        partNumber: '4521-789-031',
        description: 'Fuel Control Unit (Enhanced)',
        ataChapter: 'ATA73',
        aircraftTypes: JSON.stringify(['B777-300ER']),
        supersededBy: '4521-789-030',
        interchangeableWith: JSON.stringify(['4521-789-030']),
        alternateParts: JSON.stringify(['4521-789-032']),
      },
      {
        id: 'ipc007',
        partNumber: '5678-901-040',
        description: 'Cabin Pressure Controller',
        ataChapter: 'ATA21',
        aircraftTypes: JSON.stringify(['A350-900', 'A350-1000']),
        interchangeableWith: JSON.stringify(['5678-901-041']),
        alternateParts: JSON.stringify(['5678-901-042']),
      },
      {
        id: 'ipc008',
        partNumber: '5678-901-041',
        description: 'Cabin Pressure Controller (Mod)',
        ataChapter: 'ATA21',
        aircraftTypes: JSON.stringify(['A350-900']),
        supersededBy: '5678-901-040',
        interchangeableWith: JSON.stringify(['5678-901-040']),
        alternateParts: JSON.stringify(['5678-901-042']),
      },
      {
        id: 'ipc009',
        partNumber: '6789-012-050',
        description: 'Navigation Light Assembly',
        ataChapter: 'ATA33',
        aircraftTypes: JSON.stringify(['C919', 'ARJ21']),
        interchangeableWith: JSON.stringify(['6789-012-051']),
        alternateParts: JSON.stringify(['6789-012-052']),
      },
      {
        id: 'ipc010',
        partNumber: '7890-123-060',
        description: 'APU Starter Motor',
        ataChapter: 'ATA49',
        aircraftTypes: JSON.stringify(['B737-800', 'B737-700', 'B737-900', 'B737-MAX8']),
        interchangeableWith: JSON.stringify(['7890-123-061']),
        alternateParts: JSON.stringify(['7890-123-062']),
      },
      {
        id: 'ipc011',
        partNumber: '8901-234-070',
        description: 'Oxygen Mask Regulator',
        ataChapter: 'ATA35',
        aircraftTypes: JSON.stringify(['A320-200', 'A320neo', 'A321-200', 'A321neo']),
        interchangeableWith: JSON.stringify(['8901-234-071']),
        alternateParts: JSON.stringify(['8901-234-072']),
      },
      {
        id: 'ipc012',
        partNumber: '9012-345-080',
        description: 'Fire Detection Sensor',
        ataChapter: 'ATA26',
        aircraftTypes: JSON.stringify(['B777-300ER', 'B777-200LR', 'B787-9']),
        interchangeableWith: JSON.stringify(['9012-345-081']),
        alternateParts: JSON.stringify(['9012-345-082']),
      },
      {
        id: 'ipc013',
        partNumber: '0123-456-090',
        description: 'Flight Control Computer',
        ataChapter: 'ATA22',
        aircraftTypes: JSON.stringify(['A350-900', 'A350-1000']),
        interchangeableWith: JSON.stringify(['0123-456-091']),
        alternateParts: JSON.stringify(['0123-456-092']),
      },
      {
        id: 'ipc014',
        partNumber: '1234-567-100',
        description: 'Weather Radar Antenna',
        ataChapter: 'ATA34',
        aircraftTypes: JSON.stringify(['B737-800', 'B737-MAX8']),
        interchangeableWith: JSON.stringify(['1234-567-101']),
        alternateParts: JSON.stringify(['1234-567-102']),
      },
      {
        id: 'ipc015',
        partNumber: '2345-678-110',
        description: 'Brake Control Unit',
        ataChapter: 'ATA32',
        aircraftTypes: JSON.stringify(['A320-200', 'A320neo', 'A321-200']),
        interchangeableWith: JSON.stringify(['2345-678-111']),
        alternateParts: JSON.stringify(['2345-678-112']),
      },
      {
        id: 'ipc016',
        partNumber: '3456-789-120',
        description: 'Engine Vibration Sensor',
        ataChapter: 'ATA77',
        aircraftTypes: JSON.stringify(['B777-300ER', 'B787-9', 'B787-10']),
        interchangeableWith: JSON.stringify(['3456-789-121']),
        alternateParts: JSON.stringify(['3456-789-122']),
      },
      {
        id: 'ipc017',
        partNumber: '4567-890-130',
        description: 'Fuel Pump Assembly',
        ataChapter: 'ATA28',
        aircraftTypes: JSON.stringify(['B737-800', 'B737-700', 'B737-900']),
        interchangeableWith: JSON.stringify(['4567-890-131']),
        alternateParts: JSON.stringify(['4567-890-132']),
      },
      {
        id: 'ipc018',
        partNumber: '5678-901-140',
        description: 'Air Conditioning Valve',
        ataChapter: 'ATA21',
        aircraftTypes: JSON.stringify(['A320-200', 'A320neo', 'A321-200']),
        interchangeableWith: JSON.stringify(['5678-901-141']),
        alternateParts: JSON.stringify(['5678-901-142']),
      },
      {
        id: 'ipc019',
        partNumber: '6789-012-150',
        description: 'Landing Light Assembly',
        ataChapter: 'ATA33',
        aircraftTypes: JSON.stringify(['C919', 'ARJ21', 'MA700']),
        interchangeableWith: JSON.stringify(['6789-012-151']),
        alternateParts: JSON.stringify(['6789-012-152']),
      },
      {
        id: 'ipc020',
        partNumber: '7890-123-160',
        description: 'Hydraulic Accumulator',
        ataChapter: 'ATA29',
        aircraftTypes: JSON.stringify(['B777-300ER', 'B777-200LR']),
        interchangeableWith: JSON.stringify(['7890-123-161']),
        alternateParts: JSON.stringify(['7890-123-162']),
      },
    ],
  });
  console.log(`创建了 ${ipcData.count} 条IPC数据`);

  await prisma.aIModel.deleteMany();
  await prisma.aIAgent.deleteMany();
  await prisma.decisionMaker.deleteMany();
  await prisma.inventoryDetail.deleteMany();
  await prisma.inventoryItem.deleteMany();
  await prisma.inventory.deleteMany();
  await prisma.supplierQuote.deleteMany();
  await prisma.supplierPortalUser.deleteMany();
  await prisma.supplier.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.user.deleteMany();

  const users = await prisma.user.createMany({
    data: [
      {
        id: 'u001',
        email: 'zhang@aerolink.com',
        name: '张经理',
        password: demoPasswordHash,
        role: 'MANAGER',
        department: '销售部',
        avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=zhang',
      },
      {
        id: 'u002',
        email: 'li@aerolink.com',
        name: '李财务',
        password: demoPasswordHash,
        role: 'FINANCE',
        department: '财务部',
      },
      {
        id: 'u003',
        email: 'wang@aerolink.com',
        name: '王总监',
        password: demoPasswordHash,
        role: 'GM',
        department: '总经理室',
      },
    ],
  });
  console.log(`创建了 ${users.count} 个用户`);

  const customers = await prisma.customer.createMany({
    data: [
      {
        id: 'c001',
        name: '中国国航',
        contactName: '王采购',
        email: 'procurement@airchina.com',
        phone: '+86-10-1234-5678',
        registeredAddress: '北京市顺义区首都国际机场',
        buyerType: 'End User',
        creditLimit: 5000000,
        paymentTerms: 'Net 60',
        paymentMethod: 'Wire Transfer',
        annualRevenue: 2500000,
        creditRating: 'A',
        vatNumber: '91110000100012345X',
        iataCode: 'CA',
        icaoCode: 'CCA',
        qualityApprovalStatus: 'Approved',
        status: 'ACTIVE',
      },
      {
        id: 'c002',
        name: '海南航空',
        contactName: '刘经理',
        email: 'buyer@hainanair.com',
        phone: '+86-898-6575-1234',
        registeredAddress: '海南省海口市美兰区',
        buyerType: 'End User',
        creditLimit: 3000000,
        paymentTerms: 'Net 45',
        paymentMethod: 'Wire Transfer',
        annualRevenue: 1800000,
        creditRating: 'A',
        vatNumber: '91460000100023456Y',
        iataCode: 'HU',
        icaoCode: 'CHH',
        qualityApprovalStatus: 'Approved',
        status: 'ACTIVE',
      },
      {
        id: 'c003',
        name: '南方航空',
        contactName: '陈采购',
        email: 'purchasing@csair.com',
        phone: '+86-20-8612-3456',
        registeredAddress: '广东省广州市白云区',
        buyerType: 'End User',
        creditLimit: 8000000,
        paymentTerms: 'Net 60',
        paymentMethod: 'Wire Transfer',
        annualRevenue: 4200000,
        creditRating: 'A',
        vatNumber: '91440000100034567Z',
        iataCode: 'CZ',
        icaoCode: 'CSN',
        qualityApprovalStatus: 'Approved',
        status: 'ACTIVE',
      },
      {
        id: 'c004',
        name: '厦门航空',
        contactName: '林经理',
        email: 'procurement@xiamenair.com',
        phone: '+86-592-5731-1234',
        registeredAddress: '福建省厦门市湖里区',
        buyerType: 'End User',
        creditLimit: 2000000,
        paymentTerms: 'Net 30',
        paymentMethod: 'Wire Transfer',
        annualRevenue: 950000,
        creditRating: 'B',
        vatNumber: '91350000100045678A',
        iataCode: 'MF',
        icaoCode: 'CXA',
        qualityApprovalStatus: 'Approved',
        status: 'ACTIVE',
      },
      {
        id: 'c005',
        name: '东海航空',
        contactName: '赵技术',
        email: 'tech@donghai.com',
        phone: '+86-755-2345-6789',
        registeredAddress: '广东省深圳市宝安区',
        buyerType: 'MRO',
        creditLimit: 500000,
        paymentTerms: 'Net 30',
        paymentMethod: 'Wire Transfer',
        annualRevenue: 320000,
        creditRating: 'C',
        vatNumber: '91440300100056789B',
        qualityApprovalStatus: 'Pending',
        status: 'AT_RISK',
      },
    ],
  });
  console.log(`创建了 ${customers.count} 个客户`);

  await prisma.decisionMaker.createMany({
    data: [
      {
        customerId: 'c001',
        name: '王采购',
        title: '采购经理',
        role: 'PURCHASER',
        concerns: '价格,交期',
      },
      {
        customerId: 'c001',
        name: '李质量',
        title: '质量经理',
        role: 'QUALITY_MANAGER',
        concerns: '证书,可追溯性',
        vetoItems: '乌克兰修理厂',
      },
      {
        customerId: 'c002',
        name: '刘经理',
        title: '采购总监',
        role: 'PURCHASER',
        concerns: '价格,质量',
      },
      {
        customerId: 'c003',
        name: '陈采购',
        title: '采购专员',
        role: 'PURCHASER',
        concerns: '交期',
      },
    ],
  });

  const suppliers = await prisma.supplier.createMany({
    data: [
      {
        id: 's001',
        name: 'Aviation Parts Inc.',
        contactName: 'John Smith',
        email: 'john@aviationparts.com',
        phone: '+1-555-0123',
        address: '123 Aviation Blvd, Miami, FL',
        level: 'S',
        paymentTerms: 'Net 30',
        leadTime: 14,
        performanceScore: 95,
        supplierType: 'Distributor',
        cageCode: 'CAGE001',
        pmaHolder: true,
        oemAuthorized: true,
        qualityApprovalExpiry: new Date('2027-06-30'),
        lastAuditDate: new Date('2026-01-15'),
        nextAuditDue: new Date('2027-01-15'),
        approvedPartCategories: JSON.stringify(['ATA21', 'ATA28', 'ATA32']),
        specializesInAircraft: JSON.stringify(['B737', 'A320']),
        incotermsOffered: JSON.stringify(['EXW', 'FOB', 'CIF']),
        leadTimeAverage: 12,
        onTimeDeliveryRate: 96.5,
        certificateTypesProvided: JSON.stringify(['FAA-8130-3', 'EASA-Form-1']),
        moqPolicy: 'MOQ 1 EA for most items',
        warrantyPolicy: '90 days standard warranty',
        returnPolicy: '30 days return with RMA',
        bankAccountInfo: JSON.stringify({ bank: 'Chase', account: '****1234', swift: 'CHASUS33' }),
      },
      {
        id: 's002',
        name: 'Global Aero Supply',
        contactName: 'Sarah Johnson',
        email: 'sarah@globalaero.com',
        phone: '+44-20-7123-4567',
        address: '456 Aero Street, London, UK',
        level: 'A',
        paymentTerms: 'Net 45',
        leadTime: 21,
        performanceScore: 88,
        supplierType: 'Broker',
        cageCode: 'CAGE002',
        pmaHolder: false,
        oemAuthorized: false,
        qualityApprovalExpiry: new Date('2026-12-31'),
        lastAuditDate: new Date('2025-08-20'),
        nextAuditDue: new Date('2026-08-20'),
        approvedPartCategories: JSON.stringify(['ATA72', 'ATA73']),
        specializesInAircraft: JSON.stringify(['B777', 'A350']),
        incotermsOffered: JSON.stringify(['EXW', 'FCA']),
        leadTimeAverage: 18,
        onTimeDeliveryRate: 82.0,
        certificateTypesProvided: JSON.stringify(['FAA-8130-3']),
        moqPolicy: 'No MOQ for stock items',
        warrantyPolicy: 'As per OEM',
        returnPolicy: 'No return for broker items',
        bankAccountInfo: JSON.stringify({ bank: 'Barclays', account: '****5678', swift: 'BARCGB22' }),
      },
      {
        id: 's003',
        name: 'Pacific Components',
        contactName: 'Li Wei',
        email: 'liwei@pacificcomp.com',
        phone: '+86-21-5678-9012',
        address: '789 Industry Road, Shanghai, China',
        level: 'A',
        paymentTerms: 'Net 30',
        leadTime: 10,
        performanceScore: 82,
        supplierType: '145RepairStation',
        cageCode: 'CAGE003',
        caac145CertificateNo: 'D.200027',
        pmaHolder: false,
        ctsoaHolder: true,
        oemAuthorized: false,
        qualityApprovalExpiry: new Date('2027-03-15'),
        lastAuditDate: new Date('2026-02-10'),
        nextAuditDue: new Date('2027-02-10'),
        approvedPartCategories: JSON.stringify(['ATA21', 'ATA22', 'ATA23']),
        specializesInAircraft: JSON.stringify(['B737', 'A320', 'C919']),
        incotermsOffered: JSON.stringify(['EXW', 'FOB', 'CIP']),
        leadTimeAverage: 8,
        onTimeDeliveryRate: 91.2,
        certificateTypesProvided: JSON.stringify(['CAAC-038', 'FAA-8130-3']),
        moqPolicy: 'MOQ 5 EA for repair items',
        warrantyPolicy: '6 months for repaired units',
        returnPolicy: '15 days for defective items',
        bankAccountInfo: JSON.stringify({ bank: 'Bank of China', account: '****9012', swift: 'BKCHCNBJ' }),
      },
      {
        id: 's004',
        name: 'Euro Aero Parts',
        contactName: 'Hans Mueller',
        email: 'hans@euroaero.eu',
        phone: '+49-89-1234-5678',
        address: '321 Flugzeug Strasse, Munich, Germany',
        level: 'B',
        paymentTerms: 'Net 60',
        leadTime: 30,
        performanceScore: 75,
        supplierType: 'OEM',
        cageCode: 'CAGE004',
        pmaHolder: true,
        oemAuthorized: true,
        qualityApprovalExpiry: new Date('2026-09-01'),
        lastAuditDate: new Date('2025-05-12'),
        nextAuditDue: new Date('2026-05-12'),
        approvedPartCategories: JSON.stringify(['ATA32', 'ATA34', 'ATA52']),
        specializesInAircraft: JSON.stringify(['A320', 'A330', 'A350']),
        incotermsOffered: JSON.stringify(['DDP', 'DAP']),
        leadTimeAverage: 25,
        onTimeDeliveryRate: 78.5,
        certificateTypesProvided: JSON.stringify(['EASA-Form-1', 'FAA-8130-3']),
        moqPolicy: 'MOQ 10 EA for OEM parts',
        warrantyPolicy: '2 years OEM warranty',
        returnPolicy: '90 days OEM return policy',
        bankAccountInfo: JSON.stringify({ bank: 'Deutsche Bank', account: '****3456', swift: 'DEUTDEFF' }),
      },
    ],
  });
  console.log(`创建了 ${suppliers.count} 个供应商`);

  const inventory = await prisma.inventory.createMany({
    data: [
      {
        id: 'inv001',
        partNumber: '2341-123-050',
        description: 'Fuel Pump Assembly',
        quantity: 5,
        location: 'A-01-05',
        warehouse: '北京主仓',
        shelf: 'A-01',
        conditionCode: 'NE',
        certificateType: 'FAA-8130-3',
        certificateNumber: '8130-2026-001',
        type: 'OWN',
        unitCost: 1800,
        unitOfMeasure: 'EA',
        manufacturer: 'Parker Hannifin',
        manufacturerCageCode: 'CAGE12345',
        ataChapter: '28',
        serialNumber: 'SN-001-2026',
        countryOfOrigin: 'USA',
        hsCode: '8413.30.90',
      },
      {
        id: 'inv002',
        partNumber: '2341-123-050',
        description: 'Fuel Pump Assembly (Overhauled)',
        quantity: 2,
        location: 'B-03-12',
        warehouse: '北京主仓',
        shelf: 'B-03',
        conditionCode: 'OH',
        certificateType: 'FAA-8130-3',
        certificateNumber: '8130-2026-002',
        type: 'OWN',
        unitCost: 1200,
        unitOfMeasure: 'EA',
        manufacturer: 'Parker Hannifin',
        ataChapter: '28',
        serialNumber: 'SN-002-2026',
        countryOfOrigin: 'USA',
        hsCode: '8413.30.90',
        // 时寿件示例
        lifeLimited: true,
        totalHours: 12500,
        totalCycles: 8500,
        remainingHours: 3500,
        remainingCycles: 1500,
        manufactureDate: new Date('2019-03-15'),
        shelfLifeDate: new Date('2027-03-15'),
        overhaulDate: new Date('2025-01-10'),
        nextOverhaulDue: new Date('2027-01-10'),
        adStatus: 'COMPLIANT',
        sbStatus: 'COMPLIANT',
        repairScheme: 'RS-2024-008',
        // 二手件追溯示例
        previousOperator: 'Delta Air Lines',
        removalAircraftReg: 'N375DA',
        removalDate: new Date('2024-11-20'),
        removalReason: 'Scheduled overhaul',
        nonIncidentStatement: true,
        militarySource: false,
        traceabilityDocs: JSON.stringify(['FAA 8130-3', 'Work Order #WO-2024-1120', 'Back-to-Birth Log']),
        // 存储与包装
        storageCondition: 'Climate-Controlled',
        ata300Packaging: true,
      },
      {
        id: 'inv003',
        partNumber: '3214-567-100',
        description: 'Hydraulic Valve',
        quantity: 10,
        location: 'C-02-08',
        warehouse: '上海分仓',
        shelf: 'C-02',
        conditionCode: 'NE',
        certificateType: 'EASA-Form-1',
        certificateNumber: 'EASA-2026-003',
        type: 'OWN',
        unitCost: 2200,
        unitOfMeasure: 'EA',
        manufacturer: 'Moog',
        ataChapter: '29',
        batchNumber: 'BN-003-2026',
        countryOfOrigin: 'DEU',
        hsCode: '8481.20.00',
      },
      {
        id: 'inv004',
        partNumber: '4567-890-001',
        description: 'Landing Gear Component',
        quantity: 1,
        location: 'IN-TRANSIT',
        conditionCode: 'NE',
        certificateType: 'NONE',
        type: 'IN_TRANSIT',
        supplierId: 's001',
        unitCost: 15000,
        unitOfMeasure: 'EA',
        manufacturer: 'Safran',
        ataChapter: '32',
        eta: new Date('2026-04-05'),
        countryOfOrigin: 'FRA',
        hsCode: '8803.30.00',
      },
      {
        id: 'inv005',
        partNumber: '1234-567-890',
        description: 'Engine Filter',
        quantity: 20,
        location: 'D-01-03',
        warehouse: '北京主仓',
        shelf: 'D-01',
        conditionCode: 'NE',
        certificateType: 'FAA-8130-3',
        certificateNumber: '8130-2026-005',
        type: 'OWN',
        unitCost: 350,
        unitOfMeasure: 'EA',
        manufacturer: 'Donaldson',
        ataChapter: '72',
        batchNumber: 'BN-005-2026',
        countryOfOrigin: 'USA',
        hsCode: '8421.23.00',
      },
      {
        id: 'inv006',
        partNumber: '5678-901-234',
        description: 'Cabin Pressure Sensor',
        quantity: 3,
        location: 'E-02-15',
        warehouse: '广州分仓',
        shelf: 'E-02',
        conditionCode: 'OH',
        certificateType: 'FAA-8130-3',
        certificateNumber: '8130-2026-006',
        type: 'OWN',
        unitCost: 2800,
        unitOfMeasure: 'EA',
        manufacturer: 'Honeywell',
        ataChapter: '21',
        serialNumber: 'SN-006-2026',
        countryOfOrigin: 'USA',
        hsCode: '9026.20.80',
        // 时寿件示例
        lifeLimited: true,
        totalHours: 8000,
        remainingHours: 2000,
        manufactureDate: new Date('2020-06-01'),
        shelfLifeDate: new Date('2028-06-01'),
        overhaulDate: new Date('2025-02-15'),
        nextOverhaulDue: new Date('2027-02-15'),
        adStatus: 'COMPLIANT',
        sbStatus: 'PENDING',
        // 二手件追溯示例
        previousOperator: 'United Airlines',
        removalAircraftReg: 'N68807',
        removalDate: new Date('2025-01-05'),
        removalReason: 'Unserviceable - replaced during C-check',
        nonIncidentStatement: true,
        militarySource: false,
        traceabilityDocs: JSON.stringify(['FAA 8130-3', 'Removal Tag', 'Repair Shop Report']),
        // 存储与包装
        storageCondition: 'Ambient',
        ata300Packaging: false,
      },
      {
        id: 'inv007',
        partNumber: '3456-789-012',
        description: 'Avionics Module',
        quantity: 2,
        location: 'VIRTUAL',
        conditionCode: 'NE',
        certificateType: 'FAA-8130-3',
        certificateNumber: '8130-2026-007',
        type: 'VIRTUAL',
        supplierId: 's002',
        unitCost: 8500,
        unitOfMeasure: 'EA',
        manufacturer: 'Collins Aerospace',
        ataChapter: '23',
        serialNumber: 'SN-007-2026',
        countryOfOrigin: 'USA',
        hsCode: '8526.91.00',
      },
    ],
  });
  console.log(`创建了 ${inventory.count} 条库存记录`);

  // 保持旧库存表与明细库存层的演示数据一致。这样新部署后的 seed 也能
  // 直接覆盖预留、部分出库和证书关联等核心交易链路。
  const seededInventoryRecords = await prisma.inventory.findMany({
    orderBy: { id: 'asc' },
  });
  const uniqueInventoryItems = new Map<string, (typeof seededInventoryRecords)[number]>();
  for (const record of seededInventoryRecords) {
    if (!uniqueInventoryItems.has(record.partNumber)) {
      uniqueInventoryItems.set(record.partNumber, record);
    }
  }

  const inventoryItemResult = await prisma.inventoryItem.createMany({
    data: Array.from(uniqueInventoryItems.values()).map((record) => ({
      partNumber: record.partNumber,
      description: record.description,
      partCategory: record.partCategory,
      trackingType: record.trackingType,
      manufacturer: record.manufacturer,
      manufacturerCageCode: record.manufacturerCageCode,
      ataChapter: record.ataChapter,
      alternatePartNumbers: record.alternatePartNumbers,
      unitOfMeasure: record.unitOfMeasure,
      countryOfOrigin: record.countryOfOrigin,
      hsCode: record.hsCode,
    })),
  });
  const seededInventoryItems = await prisma.inventoryItem.findMany({
    where: {
      partNumber: {
        in: Array.from(uniqueInventoryItems.keys()),
      },
    },
  });
  const inventoryItemIds = new Map(seededInventoryItems.map((item) => [item.partNumber, item.id]));

  const inventoryDetailResult = await prisma.inventoryDetail.createMany({
    data: seededInventoryRecords.map((record) => {
      const inventoryItemId = inventoryItemIds.get(record.partNumber);
      if (!inventoryItemId) {
        throw new Error(`Missing inventory item for seeded part number ${record.partNumber}`);
      }

      return {
        // Reuse legacy IDs so the compatibility layer and certificate references remain stable.
        id: record.id,
        inventoryItemId,
        serialNumber: record.serialNumber,
        batchNumber: record.batchNumber,
        quantity: record.quantity,
        conditionCode: record.conditionCode,
        status: 'AVAILABLE',
        warehouse: record.warehouse,
        shelf: record.shelf,
        location: record.location,
        certificateType: record.certificateType,
        certificateNumber: record.certificateNumber,
        certificateFileUrl: record.certificateFileUrl,
        lifeLimited: record.lifeLimited,
        totalHours: record.totalHours,
        remainingHours: record.remainingHours,
        totalCycles: record.totalCycles,
        remainingCycles: record.remainingCycles,
        manufactureDate: record.manufactureDate,
        shelfLifeDate: record.shelfLifeDate,
        overhaulDate: record.overhaulDate,
        nextOverhaulDue: record.nextOverhaulDue,
        adStatus: record.adStatus,
        sbStatus: record.sbStatus,
        repairScheme: record.repairScheme,
        previousOperator: record.previousOperator,
        removalAircraftReg: record.removalAircraftReg,
        removalDate: record.removalDate,
        removalReason: record.removalReason,
        nonIncidentStatement: record.nonIncidentStatement,
        militarySource: record.militarySource,
        traceabilityDocs: record.traceabilityDocs,
        storageCondition: record.storageCondition,
        ata300Packaging: record.ata300Packaging,
        shelfLifeDays: record.shelfLifeDays,
        storageTempMin: record.storageTempMin,
        storageTempMax: record.storageTempMax,
        hazardClass: record.hazardClass,
        unitCost: record.unitCost,
        supplierId: record.supplierId,
        eta: record.eta,
        type: record.type,
      };
    }),
  });
  console.log(`创建了 ${inventoryItemResult.count} 个库存件号和 ${inventoryDetailResult.count} 条库存明细`);

  const emails = await prisma.email.createMany({
    data: [
      {
        id: 'e001',
        from: 'procurement@airchina.com',
        fromName: '中国国航采购部',
        subject: 'Urgent AOG Requirement - PN 2341-123-050',
        body: `Dear Supplier,

We have an AOG situation for our B737-800 fleet.

Required:
- Part Number: 2341-123-050
- Quantity: 2 EA
- Required Date: 2026-04-03
- Aircraft Type: B737-800

Please confirm availability and quote ASAP.

Best regards,
Air China Procurement`,
        type: 'AOG',
        isRead: false,
      },
      {
        id: 'e002',
        from: 'buyer@hainanair.com',
        fromName: '海南航空采购',
        subject: 'RFQ for Part Number 3214-567-100',
        body: `您好，

我们需要以下件号的报价：

件号: 3214-567-100
数量: 5 EA
需求日期: 2026-04-15
机型: A320

目标价格: 约$2,500/EA

请提供正式报价单。`,
        type: 'STANDARD',
        isRead: true,
      },
      {
        id: 'e003',
        from: 'purchasing@csair.com',
        fromName: '南方航空采购部',
        subject: 'Grounded Aircraft - Need PN 4567-890-001 URGENT',
        body: `紧急需求！

我们有一架飞机停场，急需以下件号：

件号: 4567-890-001
数量: 1 EA
需求日期: 立即

请立即确认是否有现货。`,
        type: 'AOG',
        isRead: false,
      },
      {
        id: 'e004',
        from: 'tech@donghai.com',
        fromName: '东海航空技术部',
        subject: 'Technical Inquiry - SB Compliance',
        body: `您好，

想咨询关于SB 737-28-1203改装后的件号适用性问题。

请问改装后的飞机还能使用PN 2341-123-050吗？

谢谢！`,
        type: 'INQUIRY',
        isRead: true,
      },
      {
        id: 'e005',
        from: 'spam@vendor.com',
        fromName: 'Unknown Vendor',
        subject: 'Best Price Aircraft Parts!',
        body: 'We offer best price for all aircraft parts! Contact us now!',
        type: 'SPAM',
        isRead: true,
      },
    ],
  });
  console.log(`创建了 ${emails.count} 封邮件`);

  const rfqs = await prisma.rFQ.createMany({
    data: [
      {
        id: 'rfq001',
        rfqNumber: 'RFQ-20260402-001',
        emailId: 'e001',
        customerId: 'c001',
        partNumber: '2341-123-050',
        quantity: 2,
        uom: 'EA',
        conditionCode: 'NE',
        requiredDate: new Date('2026-04-03'),
        aircraftType: 'B737-800',
        urgency: 'AOG',
        status: 'SOURCING',
        statusEnum: toRfqStatusEnum('SOURCING')!,
        notes: 'AOG紧急需求，需要立即响应',
        createdBy: 'u001',
      },
      {
        id: 'rfq002',
        rfqNumber: 'RFQ-20260402-002',
        emailId: 'e002',
        customerId: 'c002',
        partNumber: '3214-567-100',
        quantity: 5,
        uom: 'EA',
        conditionCode: 'NE',
        requiredDate: new Date('2026-04-15'),
        aircraftType: 'A320',
        targetPrice: 2500,
        targetPriceCurrency: 'USD',
        urgency: 'STANDARD',
        status: 'QUOTING',
        statusEnum: toRfqStatusEnum('QUOTING')!,
        createdBy: 'u001',
      },
      {
        id: 'rfq003',
        rfqNumber: 'RFQ-20260402-003',
        emailId: 'e003',
        customerId: 'c003',
        partNumber: '4567-890-001',
        quantity: 1,
        uom: 'EA',
        conditionCode: 'NE',
        requiredDate: new Date('2026-04-02'),
        urgency: 'AOG',
        status: 'PENDING',
        statusEnum: toRfqStatusEnum('PENDING')!,
        notes: '飞机停场，极其紧急',
        createdBy: 'u001',
      },
      {
        id: 'rfq004',
        rfqNumber: 'RFQ-20260401-004',
        customerId: 'c004',
        partNumber: '1234-567-890',
        quantity: 3,
        uom: 'EA',
        conditionCode: 'NE',
        requiredDate: new Date('2026-04-20'),
        urgency: 'STANDARD',
        status: 'APPROVING',
        statusEnum: toRfqStatusEnum('APPROVING')!,
        createdBy: 'u001',
      },
      {
        id: 'rfq005',
        rfqNumber: 'RFQ-20260401-005',
        customerId: 'c001',
        partNumber: '5678-901-234',
        quantity: 2,
        uom: 'EA',
        conditionCode: 'OH',
        requiredDate: new Date('2026-04-10'),
        aircraftType: 'B737-800',
        urgency: 'URGENT',
        status: 'ORDERED',
        statusEnum: toRfqStatusEnum('ORDERED')!,
        createdBy: 'u001',
      },
    ],
  });
  console.log(`创建了 ${rfqs.count} 个RFQ`);

  const quotations = await prisma.quotation.createMany({
    data: [
      {
        id: 'q001',
        quoteNumber: 'QT-20260401-001',
        rfqId: 'rfq004',
        customerId: 'c004',
        partNumber: '1234-567-890',
        quantity: 3,
        unitPrice: 420,
        unitPriceDecimal: normalizeMoney(420),
        totalPrice: 1260,
        totalPriceDecimal: normalizeMoney(1260),
        costPrice: 350,
        costPriceDecimal: normalizeMoney(350),
        margin: 20,
        certificateFiles: '8130-1234-567-890.pdf',
        template: 'STANDARD',
        status: 'SENT',
        statusEnum: toQuotationStatusEnum('SENT')!,
        validityDays: 7,
        saleType: 'Sale',
        incoterm: 'EXW',
        leadTimeDays: 14,
        taxIncluded: true,
        taxRate: 13,
        warrantyDays: 90,
        packagingRequirement: 'ATA300',
        shippingMethod: 'DHL',
        sentAt: new Date('2026-04-01T15:30:00Z'),
        expiryDate: new Date('2026-04-08'),
        createdBy: 'u001',
      },
      {
        id: 'q002',
        quoteNumber: 'QT-20260402-002',
        rfqId: 'rfq002',
        customerId: 'c002',
        partNumber: '3214-567-100',
        quantity: 5,
        unitPrice: 2600,
        unitPriceDecimal: normalizeMoney(2600),
        totalPrice: 13000,
        totalPriceDecimal: normalizeMoney(13000),
        costPrice: 2200,
        costPriceDecimal: normalizeMoney(2200),
        margin: 18.2,
        certificateFiles: 'easa-3214-567-100.pdf',
        template: 'STANDARD',
        status: 'PENDING_APPROVAL',
        statusEnum: toQuotationStatusEnum('PENDING_APPROVAL')!,
        validityDays: 7,
        saleType: 'Sale',
        incoterm: 'FOB',
        leadTimeDays: 21,
        taxIncluded: true,
        taxRate: 13,
        warrantyDays: 90,
        packagingRequirement: 'Standard',
        shippingMethod: 'FedEx',
        expiryDate: new Date('2026-04-09'),
        createdBy: 'u001',
      },
      {
        id: 'q003',
        quoteNumber: 'QT-20260402-003',
        rfqId: 'rfq001',
        customerId: 'c001',
        partNumber: '2341-123-050',
        quantity: 2,
        unitPrice: 2100,
        unitPriceDecimal: normalizeMoney(2100),
        totalPrice: 4200,
        totalPriceDecimal: normalizeMoney(4200),
        costPrice: 1800,
        costPriceDecimal: normalizeMoney(1800),
        margin: 16.7,
        certificateFiles: '8130-2341-123-050.pdf',
        template: 'AOG',
        status: 'APPROVED',
        statusEnum: toQuotationStatusEnum('APPROVED')!,
        validityDays: 3,
        saleType: 'Sale',
        incoterm: 'AOG Courier',
        leadTimeDays: 1,
        taxIncluded: true,
        warrantyDays: 30,
        packagingRequirement: 'AOG',
        shippingMethod: 'AOG Courier',
        approvedBy: 'u002',
        approvedAt: new Date('2026-04-02T10:15:00Z'),
        expiryDate: new Date('2026-04-05'),
        createdBy: 'u001',
      },
      {
        id: 'q004',
        quoteNumber: 'QT-20260328-004',
        rfqId: 'rfq005',
        customerId: 'c001',
        partNumber: '5678-901-234',
        quantity: 2,
        unitPrice: 3200,
        unitPriceDecimal: normalizeMoney(3200),
        totalPrice: 6400,
        totalPriceDecimal: normalizeMoney(6400),
        costPrice: 2800,
        costPriceDecimal: normalizeMoney(2800),
        margin: 14.3,
        certificateFiles: '8130-5678-901-234.pdf',
        template: 'STANDARD',
        status: 'ACCEPTED',
        statusEnum: toQuotationStatusEnum('ACCEPTED')!,
        validityDays: 7,
        saleType: 'Exchange',
        incoterm: 'CIF',
        incotermLocation: 'Beijing',
        leadTimeDays: 30,
        taxIncluded: false,
        taxRate: 13,
        warrantyDays: 180,
        packagingRequirement: 'ATA300',
        shippingMethod: 'Air Freight',
        sentAt: new Date('2026-03-28T14:30:00Z'),
        expiryDate: new Date('2026-04-04'),
        createdBy: 'u001',
      },
    ],
  });
  console.log(`创建了 ${quotations.count} 个报价单`);

  const orders = await prisma.order.createMany({
    data: [
      {
        id: 'o001',
        orderNumber: 'SO-20260328-001',
        soNumber: 'SO-20260328-001',
        poNumber: 'PO-20260329-001',
        quotationId: 'q004',
        customerId: 'c001',
        partNumber: '5678-901-234',
        quantity: 2,
        totalAmount: 6400,
        totalAmountDecimal: normalizeMoney(6400),
        status: 'IN_TRANSIT',
        statusEnum: toOrderStatusEnum('IN_TRANSIT')!,
        deliveryDate: new Date('2026-04-05'),
        trackingNumber: '1Z999AA1234567890',
        carrier: 'DHL',
        // P2 新增字段
        saleType: 'Exchange',
        incoterm: 'CIF',
        incotermLocation: 'Beijing',
        shipToId: 'c001-ship-to',
        shipForId: 'c001-ship-for',
        warrantyDays: 180,
        warrantyStartDate: new Date('2026-04-01'),
        certificateRequired: true,
        certificateType: 'FAA-8130-3',
        certificateDelivered: false,
        packagingStandard: 'ATA300',
        shippingMethod: 'Air Freight',
        carrierAccount: 'DHL-ACC-001',
        inspectionRequired: true,
        inspectionPassed: null,
        customsClearanceRequired: true,
        customsDeclarationNo: 'CD-20260328-001',
        importDuty: 320,
        importDutyDecimal: normalizeOptionalMoney(320),
        vatAmount: 832,
        vatAmountDecimal: normalizeOptionalMoney(832),
        totalLandCost: 7552,
        totalLandCostDecimal: normalizeOptionalMoney(7552),
        exchangeCoreCharge: 1500,
        exchangeCoreChargeDecimal: normalizeOptionalMoney(1500),
        exchangeCoreDueDate: new Date('2026-05-05'),
        eSignatureCustomer: 'signed-customer-001',
        eSignatureSupplier: null,
      },
      {
        id: 'o002',
        orderNumber: 'SO-20260401-002',
        soNumber: 'SO-20260401-002',
        quotationId: 'q001',
        customerId: 'c004',
        partNumber: '1234-567-890',
        quantity: 3,
        totalAmount: 1260,
        totalAmountDecimal: normalizeMoney(1260),
        status: 'SO_CREATED',
        statusEnum: toOrderStatusEnum('SO_CREATED')!,
        deliveryDate: new Date('2026-04-10'),
        // P2 新增字段
        saleType: 'Sale',
        incoterm: 'EXW',
        shipToId: 'c004-ship-to',
        warrantyDays: 90,
        certificateRequired: true,
        certificateType: 'AAC-038',
        certificateDelivered: false,
        packagingStandard: 'Standard',
        shippingMethod: 'DHL',
        inspectionRequired: false,
        customsClearanceRequired: false,
        importDuty: null,
        importDutyDecimal: null,
        vatAmount: null,
        vatAmountDecimal: null,
        totalLandCost: null,
        totalLandCostDecimal: null,
        exchangeCoreChargeDecimal: null,
      },
    ],
  });
  console.log(`创建了 ${orders.count} 个订单`);

  const [seededRfqs, seededQuotations, seededOrders] = await Promise.all([
    prisma.rFQ.findMany({
      select: { id: true, status: true, version: true, createdBy: true, createdAt: true },
    }),
    prisma.quotation.findMany({
      select: { id: true, status: true, version: true, createdBy: true, createdAt: true },
    }),
    prisma.order.findMany({
      select: { id: true, status: true, version: true, createdAt: true },
    }),
  ]);

  const statusHistory = await prisma.transactionStatusHistory.createMany({
    data: [
      ...seededRfqs.map((rfq) => ({
        entityType: 'RFQ',
        entityId: rfq.id,
        toStatus: rfq.status,
        reasonCode: 'SEEDED_INITIAL_STATE',
        reason: 'Created by the development seed.',
        actorId: rfq.createdBy,
        version: rfq.version,
        createdAt: rfq.createdAt,
      })),
      ...seededQuotations.map((quotation) => ({
        entityType: 'QUOTATION',
        entityId: quotation.id,
        toStatus: quotation.status,
        reasonCode: 'SEEDED_INITIAL_STATE',
        reason: 'Created by the development seed.',
        actorId: quotation.createdBy,
        version: quotation.version,
        createdAt: quotation.createdAt,
      })),
      ...seededOrders.map((order) => ({
        entityType: 'ORDER',
        entityId: order.id,
        toStatus: order.status,
        reasonCode: 'SEEDED_INITIAL_STATE',
        reason: 'Created by the development seed.',
        version: order.version,
        createdAt: order.createdAt,
      })),
    ],
  });
  console.log(`创建了 ${statusHistory.count} 条交易状态历史`);

  await prisma.shipmentTracking.create({
    data: {
      orderId: 'o001',
      trackingNumber: '1Z999AA1234567890',
      carrier: 'DHL',
      origin: 'Miami, FL',
      destination: 'Beijing, China',
      status: 'In Transit',
      estimatedDelivery: new Date('2026-04-05'),
      events: {
        create: [
          {
            timestamp: new Date('2026-04-01T08:00:00Z'),
            location: 'Miami, FL',
            status: 'Picked Up',
            description: 'Shipment picked up',
          },
          {
            timestamp: new Date('2026-04-01T14:00:00Z'),
            location: 'Miami Gateway',
            status: 'Departed',
            description: 'Departed from facility',
          },
          {
            timestamp: new Date('2026-04-02T02:00:00Z'),
            location: 'Cincinnati Hub',
            status: 'Arrived',
            description: 'Arrived at hub',
          },
        ],
      },
    },
  });

  const notifications = await prisma.notification.createMany({
    data: [
      {
        id: 'n001',
        title: 'AOG紧急需求',
        message: '中国国航有新的AOG需求：PN 2341-123-050',
        type: 'ERROR',
        isRead: false,
        link: '/ingestion',
      },
      {
        id: 'n002',
        title: '报价待审批',
        message: '海南航空报价 QT-20260402-002 待审批',
        type: 'WARNING',
        isRead: false,
        link: '/quotations',
      },
      {
        id: 'n003',
        title: '库存预警',
        message: 'PN 2341-123-050 库存低于安全库存',
        type: 'WARNING',
        isRead: true,
        link: '/inventory',
      },
      {
        id: 'n004',
        title: '报价已批准',
        message: 'AOG报价 QT-20260402-003 已获批准',
        type: 'SUCCESS',
        isRead: true,
        link: '/quotations',
      },
    ],
  });
  console.log(`创建了 ${notifications.count} 条通知`);

  const agents = await prisma.aIAgent.createMany({
    data: [
      {
        id: 'agent001',
        name: 'RFQ智能提取Agent',
        type: 'EXTRACTION',
        description: '从邮件中自动提取RFQ信息，包括客户名称、件号、数量、需求日期等',
        isActive: true,
        config: JSON.stringify({
          extractionFields: ['customerName', 'partNumber', 'quantity', 'requiredDate', 'aircraftType', 'urgency'],
          confidenceThreshold: 0.8,
        }),
        prompts: JSON.stringify([
          { role: 'system', content: '你是一个专业的航材RFQ信息提取助手。' },
          { role: 'user', content: '从以下邮件中提取RFQ信息...' },
        ]),
      },
      {
        id: 'agent002',
        name: '报价生成Agent',
        type: 'QUOTATION',
        description: '根据RFQ信息和库存情况，自动生成报价建议',
        isActive: true,
        config: JSON.stringify({
          autoMargin: true,
          minMargin: 15,
          maxMargin: 30,
        }),
        prompts: JSON.stringify([
          { role: 'system', content: '你是一个专业的航材报价助手。' },
        ]),
      },
      {
        id: 'agent003',
        name: '客户分析Agent',
        type: 'ANALYSIS',
        description: '分析客户历史交易数据，提供销售策略建议',
        isActive: true,
        config: JSON.stringify({
          analysisPeriod: '6months',
        }),
        prompts: JSON.stringify([
          { role: 'system', content: '你是一个专业的客户分析助手。' },
        ]),
      },
      {
        id: 'agent004',
        name: '库存预警Agent',
        type: 'MONITORING',
        description: '监控库存水平，自动触发补货建议',
        isActive: true,
        config: JSON.stringify({
          lowStockThreshold: 5,
          reorderPoint: 10,
        }),
        prompts: JSON.stringify([]),
      },
    ],
  });
  console.log(`创建了 ${agents.count} 个AI Agent`);

  const models = await prisma.aIModel.createMany({
    data: [
      {
        id: 'model001',
        name: 'GPT-4o',
        provider: 'openai',
        modelId: 'gpt-4o',
        apiKey: '',
        isActive: true,
        isDefault: true,
        config: JSON.stringify({ temperature: 0.7, maxTokens: 2000 }),
        capabilities: JSON.stringify(['chat', 'extraction', 'analysis']),
      },
      {
        id: 'model002',
        name: 'Claude 3.5 Sonnet',
        provider: 'anthropic',
        modelId: 'claude-3-5-sonnet-20240620',
        apiKey: '',
        isActive: true,
        isDefault: false,
        config: JSON.stringify({ temperature: 0.7, maxTokens: 2000 }),
        capabilities: JSON.stringify(['chat', 'extraction', 'analysis']),
      },
      {
        id: 'model003',
        name: 'GPT-4o-mini',
        provider: 'openai',
        modelId: 'gpt-4o-mini',
        apiKey: '',
        isActive: true,
        isDefault: false,
        config: JSON.stringify({ temperature: 0.5, maxTokens: 1000 }),
        capabilities: JSON.stringify(['chat', 'simple_extraction']),
      },
      {
        id: 'model004',
        name: 'Ollama 本地模型',
        provider: 'ollama',
        modelId: 'llama3',
        baseUrl: 'http://localhost:11434',
        isActive: false,
        isDefault: false,
        config: JSON.stringify({ temperature: 0.7 }),
        capabilities: JSON.stringify(['chat']),
      },
    ],
  });
  console.log(`创建了 ${models.count} 个AI Model`);

  console.log('数据播种完成！');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
