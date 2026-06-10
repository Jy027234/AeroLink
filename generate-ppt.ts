import PptxGenJS_ from 'pptxgenjs';
const PptxGenJS = (PptxGenJS_ as any).default || PptxGenJS_;
import path from 'path';
import fs from 'fs';

const SCREENSHOT_DIR = path.resolve('ppt-screenshots');
const OUTPUT_FILE = path.resolve('AeroLink产品介绍.pptx');

// Helper to get screenshot path
function img(name: string): string {
  return path.join(SCREENSHOT_DIR, name);
}

// Colors
const C = {
  primary: '1E3A5F',      // Deep blue
  secondary: '2563EB',    // Bright blue
  accent: '0EA5E9',       // Sky blue
  dark: '0F172A',         // Near black
  white: 'FFFFFF',
  lightGray: 'F1F5F9',
  gray: '64748B',
  gold: 'F59E0B',
  green: '10B981',
  red: 'EF4444',
};

async function main() {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5
  pptx.author = 'AeroLink';
  pptx.company = 'AeroLink';
  pptx.subject = 'AeroLink航材智能交易平台产品介绍';
  pptx.title = 'AeroLink 产品介绍';

  // ============================================================
  // SLIDE 1: Cover Page
  // ============================================================
  let slide = pptx.addSlide();
  slide.background = { color: C.dark };
  // Decorative gradient bar at top
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.08, fill: { color: C.secondary } });
  // Logo area
  slide.addText('✈', { x: 1.0, y: 1.5, w: 1, h: 1, fontSize: 60, color: C.secondary, align: 'center' });
  slide.addText('AeroLink', { x: 2.0, y: 1.5, w: 5, h: 0.7, fontSize: 48, bold: true, color: C.white, fontFace: 'Arial' });
  slide.addText('航材智能交易平台', { x: 2.0, y: 2.2, w: 6, h: 0.6, fontSize: 28, color: C.accent, fontFace: 'Microsoft YaHei' });
  // Tagline
  slide.addText('面向全球航材贸易商与MRO企业的一站式数字化解决方案', {
    x: 2.0, y: 3.2, w: 8, h: 0.5, fontSize: 16, color: C.gray, fontFace: 'Microsoft YaHei'
  });
  // Bottom info
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 6.3, w: '100%', h: 1.2, fill: { color: '0D1B2A' } });
  slide.addText('产品介绍 | 2026', { x: 1.0, y: 6.5, w: 4, h: 0.4, fontSize: 14, color: C.gray, fontFace: 'Microsoft YaHei' });
  slide.addText('www.aerolink.com', { x: 9, y: 6.5, w: 3.5, h: 0.4, fontSize: 14, color: C.gray, align: 'right', fontFace: 'Arial' });

  // ============================================================
  // SLIDE 2: Table of Contents
  // ============================================================
  slide = pptx.addSlide();
  slide.background = { color: C.white };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.08, fill: { color: C.secondary } });
  slide.addText('目录', { x: 0.8, y: 0.3, w: 5, h: 0.8, fontSize: 32, bold: true, color: C.dark, fontFace: 'Microsoft YaHei' });

  const tocItems = [
    ['01', '产品概述', 'AeroLink是什么，解决什么问题'],
    ['02', '核心价值主张', '为什么选择AeroLink'],
    ['03', '主要功能模块', '十大核心功能详解'],
    ['04', '竞争优势', '与行业竞品的差异化分析'],
    ['05', '实际应用场景', '典型业务场景演示'],
    ['06', '总结与展望', '产品路线图与联系方式'],
  ];
  tocItems.forEach((item, i) => {
    const y = 1.5 + i * 0.9;
    slide.addText(item[0], { x: 1.0, y, w: 0.8, h: 0.6, fontSize: 24, bold: true, color: C.secondary, fontFace: 'Arial' });
    slide.addText(item[1], { x: 1.8, y, w: 4, h: 0.35, fontSize: 20, bold: true, color: C.dark, fontFace: 'Microsoft YaHei' });
    slide.addText(item[2], { x: 1.8, y: y + 0.35, w: 6, h: 0.3, fontSize: 13, color: C.gray, fontFace: 'Microsoft YaHei' });
  });
  // Right side: screenshot
  if (fs.existsSync(img('01-login.png'))) {
    slide.addImage({ path: img('01-login.png'), x: 7.5, y: 1.2, w: 5.2, h: 3.3, rounding: true, shadow: { type: 'outer', blur: 10, offset: 3, color: '00000030' } });
  }

  // ============================================================
  // SLIDE 3: Product Overview
  // ============================================================
  slide = pptx.addSlide();
  slide.background = { color: C.white };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.08, fill: { color: C.secondary } });
  slide.addText('01', { x: 0.8, y: 0.2, w: 1, h: 0.5, fontSize: 18, bold: true, color: C.secondary, fontFace: 'Arial' });
  slide.addText('产品概述', { x: 1.6, y: 0.2, w: 5, h: 0.5, fontSize: 28, bold: true, color: C.dark, fontFace: 'Microsoft YaHei' });

  // What is AeroLink
  slide.addShape(pptx.ShapeType.roundRect, { x: 0.8, y: 1.0, w: 5.5, h: 2.8, fill: { color: C.lightGray }, rectRadius: 0.15 });
  slide.addText('AeroLink 是什么？', { x: 1.1, y: 1.1, w: 5, h: 0.45, fontSize: 18, bold: true, color: C.primary, fontFace: 'Microsoft YaHei' });
  slide.addText([
    { text: 'AeroLink 是一款专为航材贸易商和维修企业（MRO）打造的', options: { fontSize: 14, color: C.dark } },
    { text: '智能化交易管理平台', options: { fontSize: 14, color: C.secondary, bold: true } },
    { text: '。\n\n它帮助企业实现从客户需求获取、智能寻源、询报价、合同签订到物流追踪的全流程数字化管理，大幅提升业务效率，降低运营成本。', options: { fontSize: 14, color: C.dark } },
  ], { x: 1.1, y: 1.6, w: 5, h: 2.0, fontFace: 'Microsoft YaHei', lineSpacingMultiple: 1.3 });

  // Target users
  slide.addShape(pptx.ShapeType.roundRect, { x: 0.8, y: 4.1, w: 5.5, h: 2.8, fill: { color: C.lightGray }, rectRadius: 0.15 });
  slide.addText('目标用户', { x: 1.1, y: 4.2, w: 5, h: 0.45, fontSize: 18, bold: true, color: C.primary, fontFace: 'Microsoft YaHei' });
  const targetUsers = [
    '✈  航空公司航材采购部门',
    '🔧  MRO航空维修企业',
    '📦  航材贸易商和分销商',
    '🏭  航材寄售与供应链管理企业',
  ];
  targetUsers.forEach((u, i) => {
    slide.addText(u, { x: 1.3, y: 4.8 + i * 0.5, w: 4.5, h: 0.45, fontSize: 14, color: C.dark, fontFace: 'Microsoft YaHei' });
  });

  // Right side: dashboard screenshot
  if (fs.existsSync(img('02-dashboard.png'))) {
    slide.addImage({ path: img('02-dashboard.png'), x: 6.8, y: 1.0, w: 5.8, h: 3.7, shadow: { type: 'outer', blur: 8, offset: 2, color: '00000020' } });
    slide.addText('▲ 工作台总览 — 一目了然的业务看板', { x: 6.8, y: 4.8, w: 5.8, h: 0.35, fontSize: 11, color: C.gray, align: 'center', fontFace: 'Microsoft YaHei', italic: true });
  }

  // Market context
  slide.addShape(pptx.ShapeType.roundRect, { x: 6.8, y: 5.3, w: 5.8, h: 1.6, fill: { color: 'EFF6FF' }, rectRadius: 0.1 });
  slide.addText('📊 市场背景', { x: 7.0, y: 5.4, w: 3, h: 0.35, fontSize: 14, bold: true, color: C.primary, fontFace: 'Microsoft YaHei' });
  slide.addText('全球航空MRO软件市场规模预计从2024年的74亿美元增长至2034年的116亿美元。数字化MRO细分领域年复合增长率高达13.9%，行业正处于数字化转型加速期。', {
    x: 7.0, y: 5.8, w: 5.3, h: 1.0, fontSize: 12, color: C.dark, fontFace: 'Microsoft YaHei', lineSpacingMultiple: 1.3
  });

  // ============================================================
  // SLIDE 4: Core Value Propositions
  // ============================================================
  slide = pptx.addSlide();
  slide.background = { color: C.white };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.08, fill: { color: C.secondary } });
  slide.addText('02', { x: 0.8, y: 0.2, w: 1, h: 0.5, fontSize: 18, bold: true, color: C.secondary, fontFace: 'Arial' });
  slide.addText('核心价值主张', { x: 1.6, y: 0.2, w: 5, h: 0.5, fontSize: 28, bold: true, color: C.dark, fontFace: 'Microsoft YaHei' });
  slide.addText('降本 · 增效 · 合规', { x: 1.6, y: 0.7, w: 5, h: 0.35, fontSize: 16, color: C.gray, fontFace: 'Microsoft YaHei' });

  const values = [
    { icon: '⚡', title: '效率提升', desc: 'AI智能报价将响应时间从数小时缩短至分钟级别，自动化工作流减少人工审批环节', color: 'EFF6FF' },
    { icon: '💰', title: '成本优化', desc: '库存健康度分析帮助减少积压库存，智能寻源自动匹配最优供应商和价格', color: 'F0FDF4' },
    { icon: '🛡️', title: '合规保障', desc: '区块链证书存证确保航材资质不可篡改，完整审计日志满足CAAC/FAA/EASA合规要求', color: 'FFF7ED' },
    { icon: '🌍', title: '全球协同', desc: '中英双语界面、多币种交易、时区适配，支持全球化航材贸易场景', color: 'FDF2F8' },
  ];

  values.forEach((v, i) => {
    const x = 0.8 + (i % 2) * 6.2;
    const y = 1.3 + Math.floor(i / 2) * 2.8;
    slide.addShape(pptx.ShapeType.roundRect, { x, y, w: 5.8, h: 2.4, fill: { color: v.color }, rectRadius: 0.15 });
    slide.addText(v.icon, { x: x + 0.3, y: y + 0.3, w: 0.8, h: 0.8, fontSize: 36 });
    slide.addText(v.title, { x: x + 1.2, y: y + 0.3, w: 4, h: 0.5, fontSize: 20, bold: true, color: C.dark, fontFace: 'Microsoft YaHei' });
    slide.addText(v.desc, { x: x + 1.2, y: y + 0.9, w: 4.2, h: 1.2, fontSize: 13, color: C.gray, fontFace: 'Microsoft YaHei', lineSpacingMultiple: 1.4 });
  });

  // ============================================================
  // SLIDE 5: Feature - Dashboard & Bilingual
  // ============================================================
  slide = pptx.addSlide();
  slide.background = { color: C.white };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.08, fill: { color: C.secondary } });
  slide.addText('03', { x: 0.8, y: 0.2, w: 1, h: 0.5, fontSize: 18, bold: true, color: C.secondary, fontFace: 'Arial' });
  slide.addText('智能工作台 — 业务全局尽在掌握', { x: 1.6, y: 0.2, w: 8, h: 0.5, fontSize: 24, bold: true, color: C.dark, fontFace: 'Microsoft YaHei' });

  if (fs.existsSync(img('02-dashboard.png'))) {
    slide.addImage({ path: img('02-dashboard.png'), x: 0.5, y: 1.0, w: 7.5, h: 4.7, shadow: { type: 'outer', blur: 8, offset: 2, color: '00000020' } });
  }

  // Feature bullets
  const dashFeatures = [
    { title: '实时业务看板', desc: '待处理需求、已询价、待审批报价、成交额等核心KPI一目了然' },
    { title: '销售漏斗可视化', desc: '从需求到成交的全流程可视化追踪，精准把握每个商机' },
    { title: '客户跟进提醒', desc: '自动提醒超期未跟进的客户，防止商机流失' },
    { title: '库存健康度监控', desc: '实时展示库存充足/偏低/紧急/过剩状态，库存总值一览无余' },
    { title: '时寿件预警', desc: '自动监控有时限要求的航材，到期前主动预警，保障飞行安全' },
  ];
  dashFeatures.forEach((f, i) => {
    const y = 1.0 + i * 1.2;
    slide.addShape(pptx.ShapeType.ellipse, { x: 8.3, y: y + 0.05, w: 0.3, h: 0.3, fill: { color: C.secondary } });
    slide.addText(String(i + 1), { x: 8.3, y: y + 0.02, w: 0.3, h: 0.3, fontSize: 11, color: C.white, align: 'center', bold: true });
    slide.addText(f.title, { x: 8.8, y: y, w: 4, h: 0.35, fontSize: 14, bold: true, color: C.dark, fontFace: 'Microsoft YaHei' });
    slide.addText(f.desc, { x: 8.8, y: y + 0.4, w: 4, h: 0.7, fontSize: 11, color: C.gray, fontFace: 'Microsoft YaHei', lineSpacingMultiple: 1.3 });
  });

  // ============================================================
  // SLIDE 6: Bilingual & Multi-currency
  // ============================================================
  slide = pptx.addSlide();
  slide.background = { color: C.white };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.08, fill: { color: C.secondary } });
  slide.addText('03', { x: 0.8, y: 0.2, w: 1, h: 0.5, fontSize: 18, bold: true, color: C.secondary, fontFace: 'Arial' });
  slide.addText('全球化支持 — 中英双语 · 多币种 · 时区适配', { x: 1.6, y: 0.2, w: 10, h: 0.5, fontSize: 24, bold: true, color: C.dark, fontFace: 'Microsoft YaHei' });

  // Login page showing language switcher
  if (fs.existsSync(img('01-login.png'))) {
    slide.addImage({ path: img('01-login.png'), x: 0.5, y: 1.0, w: 5.5, h: 3.5, shadow: { type: 'outer', blur: 8, offset: 2, color: '00000020' } });
    slide.addText('▲ 登录页面支持中英文一键切换', { x: 0.5, y: 4.6, w: 5.5, h: 0.3, fontSize: 11, color: C.gray, align: 'center', fontFace: 'Microsoft YaHei', italic: true });
  }

  // Feature cards
  const globalFeatures = [
    { icon: '🌐', title: '中英双语界面 [P1]', desc: '所有页面、菜单、通知、证书模板均支持中英文无缝切换，满足国际化业务需求', color: 'EFF6FF' },
    { icon: '💱', title: '多币种交易 [P1]', desc: '支持美元(USD)、欧元(EUR)、人民币(CNY)等多种货币，内置实时汇率转换引擎', color: 'F0FDF4' },
    { icon: '🕐', title: '时区智能适配 [P2]', desc: '报价截止时间、交货日期等按用户所在时区自动显示，跨国协作零障碍', color: 'FFF7ED' },
    { icon: '📏', title: '多计量单位 [P2]', desc: '支持件(EA)、千克(KG)、磅(LB)等单位自动换算，满足不同航材计量需求', color: 'FDF2F8' },
  ];

  globalFeatures.forEach((f, i) => {
    const y = 1.0 + i * 1.5;
    slide.addShape(pptx.ShapeType.roundRect, { x: 6.5, y, w: 6.3, h: 1.3, fill: { color: f.color }, rectRadius: 0.1 });
    slide.addText(f.icon, { x: 6.7, y: y + 0.15, w: 0.6, h: 0.6, fontSize: 28 });
    slide.addText(f.title, { x: 7.4, y: y + 0.1, w: 5, h: 0.4, fontSize: 15, bold: true, color: C.dark, fontFace: 'Microsoft YaHei' });
    slide.addText(f.desc, { x: 7.4, y: y + 0.55, w: 5, h: 0.6, fontSize: 11, color: C.gray, fontFace: 'Microsoft YaHei', lineSpacingMultiple: 1.3 });
  });

  // Bottom highlight
  slide.addShape(pptx.ShapeType.roundRect, { x: 0.5, y: 5.2, w: 12.3, h: 1.8, fill: { color: 'F8FAFC' }, line: { color: 'E2E8F0', width: 1 }, rectRadius: 0.1 });
  slide.addText('💡 行业洞察', { x: 0.8, y: 5.3, w: 3, h: 0.35, fontSize: 14, bold: true, color: C.primary, fontFace: 'Microsoft YaHei' });
  slide.addText('航材交易天然具有国际化属性——买家和卖家分布在全球各地。IATA MRO SmartHub、ILS、PartsBase等国际平台均以全球化为核心竞争力。AeroLink的多语言、多币种、多时区支持，让您的业务无国界。', {
    x: 0.8, y: 5.7, w: 11.5, h: 1.0, fontSize: 12, color: C.dark, fontFace: 'Microsoft YaHei', lineSpacingMultiple: 1.4
  });

  // ============================================================
  // SLIDE 7: Inventory Management
  // ============================================================
  slide = pptx.addSlide();
  slide.background = { color: C.white };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.08, fill: { color: C.secondary } });
  slide.addText('03', { x: 0.8, y: 0.2, w: 1, h: 0.5, fontSize: 18, bold: true, color: C.secondary, fontFace: 'Arial' });
  slide.addText('航材库存管理 — 精细化管理每一件航材', { x: 1.6, y: 0.2, w: 10, h: 0.5, fontSize: 24, bold: true, color: C.dark, fontFace: 'Microsoft YaHei' });

  if (fs.existsSync(img('03-inventory.png'))) {
    slide.addImage({ path: img('03-inventory.png'), x: 0.5, y: 0.9, w: 8.0, h: 5.0, shadow: { type: 'outer', blur: 8, offset: 2, color: '00000020' } });
  }

  const invFeatures = [
    { title: '多维度分类管理', desc: '按周转件、可修件、化工品、标准件、消耗件等航材类别精细分类' },
    { title: '完整件号追溯', desc: '记录件号、制造商、序号、批次号，支持全生命周期追溯' },
    { title: '证书关联管理', desc: '每件航材关联FAA 8130-3、EASA Form 1等适航证书' },
    { title: '多仓库多库位', desc: '支持多仓库、多库位管理，虚拟库存与在途库存统一视图' },
    { title: '智能搜索过滤', desc: '按状态、证书类型、仓库位置等多维度快速筛选' },
    { title: '批量导入导出', desc: '支持Excel批量导入库存数据，一键导出库存报表' },
  ];
  invFeatures.forEach((f, i) => {
    const y = 1.0 + i * 1.05;
    slide.addShape(pptx.ShapeType.roundRect, { x: 8.8, y, w: 4.2, h: 0.9, fill: { color: i % 2 === 0 ? 'EFF6FF' : 'F8FAFC' }, rectRadius: 0.08 });
    slide.addText('✔ ' + f.title, { x: 9.0, y: y + 0.05, w: 3.8, h: 0.35, fontSize: 13, bold: true, color: C.dark, fontFace: 'Microsoft YaHei' });
    slide.addText(f.desc, { x: 9.0, y: y + 0.4, w: 3.8, h: 0.45, fontSize: 10, color: C.gray, fontFace: 'Microsoft YaHei', lineSpacingMultiple: 1.2 });
  });

  // ============================================================
  // SLIDE 8: RFQ & Quotation Flow
  // ============================================================
  slide = pptx.addSlide();
  slide.background = { color: C.white };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.08, fill: { color: C.secondary } });
  slide.addText('03', { x: 0.8, y: 0.2, w: 1, h: 0.5, fontSize: 18, bold: true, color: C.secondary, fontFace: 'Arial' });
  slide.addText('询报价流程 — 从需求到报价，高效闭环', { x: 1.6, y: 0.2, w: 10, h: 0.5, fontSize: 24, bold: true, color: C.dark, fontFace: 'Microsoft YaHei' });

  if (fs.existsSync(img('04-rfq.png'))) {
    slide.addImage({ path: img('04-rfq.png'), x: 0.5, y: 0.9, w: 8.0, h: 5.0, shadow: { type: 'outer', blur: 8, offset: 2, color: '00000020' } });
  }

  // Process flow
  slide.addText('完整业务链路', { x: 8.8, y: 0.9, w: 4, h: 0.4, fontSize: 16, bold: true, color: C.primary, fontFace: 'Microsoft YaHei' });

  const flowSteps = [
    { step: '①', title: '需求归集', desc: 'AI自动从邮件中提取客户需求' },
    { step: '②', title: '需求单管理', desc: '统一管理所有RFQ，支持AOG紧急标记' },
    { step: '③', title: '智能寻源', desc: '自动匹配库存和供应商，推荐最优方案' },
    { step: '④', title: '报价生成', desc: 'AI推荐历史价格，一键生成专业报价' },
    { step: '⑤', title: '订单确认', desc: '报价转订单，自动生成合同和证书' },
    { step: '⑥', title: '物流追踪', desc: '全链路物流追踪，实时掌握发货状态' },
  ];
  flowSteps.forEach((s, i) => {
    const y = 1.5 + i * 0.95;
    slide.addShape(pptx.ShapeType.roundRect, { x: 8.8, y, w: 4.2, h: 0.8, fill: { color: i === 0 ? 'EFF6FF' : 'F8FAFC' }, line: { color: 'E2E8F0', width: 0.5 }, rectRadius: 0.08 });
    slide.addText(s.step, { x: 8.9, y: y + 0.1, w: 0.5, h: 0.5, fontSize: 20, color: C.secondary, bold: true });
    slide.addText(s.title, { x: 9.4, y: y + 0.05, w: 3.2, h: 0.35, fontSize: 13, bold: true, color: C.dark, fontFace: 'Microsoft YaHei' });
    slide.addText(s.desc, { x: 9.4, y: y + 0.4, w: 3.2, h: 0.35, fontSize: 10, color: C.gray, fontFace: 'Microsoft YaHei' });
  });

  // ============================================================
  // SLIDE 9: Customer & Supplier Management
  // ============================================================
  slide = pptx.addSlide();
  slide.background = { color: C.white };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.08, fill: { color: C.secondary } });
  slide.addText('03', { x: 0.8, y: 0.2, w: 1, h: 0.5, fontSize: 18, bold: true, color: C.secondary, fontFace: 'Arial' });
  slide.addText('客户与供应商管理 — 构建航材贸易生态', { x: 1.6, y: 0.2, w: 10, h: 0.5, fontSize: 24, bold: true, color: C.dark, fontFace: 'Microsoft YaHei' });

  if (fs.existsSync(img('07-customers.png'))) {
    slide.addImage({ path: img('07-customers.png'), x: 0.5, y: 0.9, w: 7.5, h: 4.7, shadow: { type: 'outer', blur: 8, offset: 2, color: '00000020' } });
  }

  // Customer features
  slide.addText('客户管理亮点', { x: 8.3, y: 0.9, w: 4.5, h: 0.4, fontSize: 16, bold: true, color: C.primary, fontFace: 'Microsoft YaHei' });
  const custFeatures = [
    '📊 客户分级：按年采购额、信用等级智能分层',
    '⚠️ 流失预警：自动识别长期未下单的流失风险客户',
    '📋 360°客户档案：采购历史、报价记录、跟进记录全记录',
    '💳 信用管理：信用额度设置与实时监控',
  ];
  custFeatures.forEach((f, i) => {
    slide.addText(f, { x: 8.5, y: 1.5 + i * 0.55, w: 4.3, h: 0.45, fontSize: 11, color: C.dark, fontFace: 'Microsoft YaHei', lineSpacingMultiple: 1.2 });
  });

  // Supplier features
  slide.addShape(pptx.ShapeType.roundRect, { x: 8.3, y: 3.8, w: 4.5, h: 3.0, fill: { color: 'F0FDF4' }, rectRadius: 0.1 });
  slide.addText('供应商管理亮点', { x: 8.5, y: 3.9, w: 4, h: 0.4, fontSize: 16, bold: true, color: '166534', fontFace: 'Microsoft YaHei' });
  const suppFeatures = [
    '🏅 供应商评级：按交货准时率、价格竞争力、质量评分',
    '🔍 智能寻源：AI自动从供应商库中匹配最优供货方案',
    '📧 供应商门户：供应商自助上传报价和库存信息',
    '📈 绩效看板：供应商KPI实时可视化',
  ];
  suppFeatures.forEach((f, i) => {
    slide.addText(f, { x: 8.5, y: 4.4 + i * 0.55, w: 4.1, h: 0.45, fontSize: 11, color: C.dark, fontFace: 'Microsoft YaHei', lineSpacingMultiple: 1.2 });
  });

  // ============================================================
  // SLIDE 10: AI & Pricing Engine
  // ============================================================
  slide = pptx.addSlide();
  slide.background = { color: C.white };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.08, fill: { color: C.secondary } });
  slide.addText('03', { x: 0.8, y: 0.2, w: 1, h: 0.5, fontSize: 18, bold: true, color: C.secondary, fontFace: 'Arial' });
  slide.addText('AI智能推荐与定价引擎', { x: 1.6, y: 0.2, w: 8, h: 0.5, fontSize: 24, bold: true, color: C.dark, fontFace: 'Microsoft YaHei' });

  // AI features in cards
  const aiFeatures = [
    { icon: '🤖', title: 'AI需求归集', desc: '智能解析客户邮件，自动提取件号、数量、紧急度等关键信息，生成标准化需求单', color: 'EFF6FF' },
    { icon: '💡', title: 'AI定价建议', desc: '基于历史成交数据、市场行情、客户等级，智能推荐最优报价区间和折扣策略', color: 'F0FDF4' },
    { icon: '📊', title: 'FMV公正市场价值', desc: '参考IATA SmartHub标准，提供件号级公正市场价值评估，辅助采购决策', color: 'FFF7ED' },
    { icon: '🔮', title: '需求预测', desc: '基于消耗趋势和季节性分析，预测未来航材需求，提前备货降低缺货风险', color: 'FDF2F8' },
  ];

  aiFeatures.forEach((f, i) => {
    const x = 0.5 + (i % 2) * 6.3;
    const y = 1.0 + Math.floor(i / 2) * 2.8;
    slide.addShape(pptx.ShapeType.roundRect, { x, y, w: 6.0, h: 2.4, fill: { color: f.color }, rectRadius: 0.15 });
    slide.addText(f.icon, { x: x + 0.3, y: y + 0.3, w: 0.8, h: 0.8, fontSize: 40 });
    slide.addText(f.title, { x: x + 1.3, y: y + 0.3, w: 4, h: 0.5, fontSize: 20, bold: true, color: C.dark, fontFace: 'Microsoft YaHei' });
    slide.addText(f.desc, { x: x + 1.3, y: y + 0.9, w: 4.3, h: 1.2, fontSize: 13, color: C.gray, fontFace: 'Microsoft YaHei', lineSpacingMultiple: 1.4 });
  });

  // Bottom stat
  slide.addShape(pptx.ShapeType.roundRect, { x: 0.5, y: 6.5, w: 12.3, h: 0.7, fill: { color: 'EFF6FF' }, rectRadius: 0.08 });
  slide.addText('📈 行业数据显示，50-80%的RFQ可以通过AI辅助实现自动报价响应，报价响应时间从数小时缩短至分钟级别', {
    x: 0.8, y: 6.55, w: 11.8, h: 0.6, fontSize: 13, color: C.primary, fontFace: 'Microsoft YaHei', bold: true
  });

  // ============================================================
  // SLIDE 11: Blockchain & Compliance
  // ============================================================
  slide = pptx.addSlide();
  slide.background = { color: C.white };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.08, fill: { color: C.secondary } });
  slide.addText('03', { x: 0.8, y: 0.2, w: 1, h: 0.5, fontSize: 18, bold: true, color: C.secondary, fontFace: 'Arial' });
  slide.addText('区块链验证与合规追踪', { x: 1.6, y: 0.2, w: 8, h: 0.5, fontSize: 24, bold: true, color: C.dark, fontFace: 'Microsoft YaHei' });

  // Left: blockchain features
  slide.addShape(pptx.ShapeType.roundRect, { x: 0.5, y: 1.0, w: 6.0, h: 5.5, fill: { color: 'F8FAFC' }, line: { color: 'E2E8F0', width: 1 }, rectRadius: 0.15 });
  slide.addText('🔗 区块链证书存证', { x: 0.8, y: 1.1, w: 5, h: 0.5, fontSize: 20, bold: true, color: C.primary, fontFace: 'Microsoft YaHei' });
  slide.addText('每一份航材证书的数字指纹（SHA-256哈希值）永久记录在区块链上，确保证书的真实性和不可篡改性。', {
    x: 0.8, y: 1.7, w: 5.2, h: 0.8, fontSize: 13, color: C.dark, fontFace: 'Microsoft YaHei', lineSpacingMultiple: 1.4
  });

  const bcFeatures = [
    { icon: '📜', title: '电子证书管理', desc: '支持AAC-038、FAA 8130-3、EASA Form 1、COC等标准证书模板，一键生成PDF证书' },
    { icon: '✅', title: '证书真伪验证', desc: '通过二维码或链接即可验证证书真伪，杜绝假冒伪劣航材' },
    { icon: '🔍', title: '完整审计日志', desc: '记录每一次操作（谁、何时、做了什么），满足CAAC/FAA/EASA审计要求' },
    { icon: '⏰', title: '时寿件追踪', desc: '自动追踪有时限要求的航材，到期前主动预警，保障飞行安全合规' },
  ];
  bcFeatures.forEach((f, i) => {
    const y = 2.7 + i * 1.1;
    slide.addText(f.icon, { x: 0.8, y, w: 0.5, h: 0.5, fontSize: 24 });
    slide.addText(f.title, { x: 1.4, y, w: 4.5, h: 0.35, fontSize: 14, bold: true, color: C.dark, fontFace: 'Microsoft YaHei' });
    slide.addText(f.desc, { x: 1.4, y: y + 0.35, w: 4.8, h: 0.65, fontSize: 11, color: C.gray, fontFace: 'Microsoft YaHei', lineSpacingMultiple: 1.3 });
  });

  // Right: contract & workflow
  slide.addShape(pptx.ShapeType.roundRect, { x: 6.8, y: 1.0, w: 6.0, h: 2.8, fill: { color: 'EFF6FF' }, rectRadius: 0.15 });
  slide.addText('📝 合同模板与电子签约', { x: 7.1, y: 1.1, w: 5, h: 0.5, fontSize: 18, bold: true, color: C.primary, fontFace: 'Microsoft YaHei' });
  slide.addText('• 内置标准合同模板（销售合同、采购协议等）\n• 自定义合同条款和变量\n• 合同关联订单自动生成\n• 支持电子签名和盖章', {
    x: 7.1, y: 1.7, w: 5.3, h: 2.0, fontSize: 12, color: C.dark, fontFace: 'Microsoft YaHei', lineSpacingMultiple: 1.5
  });

  slide.addShape(pptx.ShapeType.roundRect, { x: 6.8, y: 4.1, w: 6.0, h: 2.4, fill: { color: 'FFF7ED' }, rectRadius: 0.15 });
  slide.addText('⚙️ 智能工作流引擎', { x: 7.1, y: 4.2, w: 5, h: 0.5, fontSize: 18, bold: true, color: 'C2410C', fontFace: 'Microsoft YaHei' });
  slide.addText('• RFQ审批流：销售经理→总监逐级审批\n• AOG紧急通道：1小时未响应自动升级\n• 报价审批流：折扣超阈值自动升级\n• 供应商准入流：资质自动校验', {
    x: 7.1, y: 4.8, w: 5.3, h: 1.6, fontSize: 12, color: C.dark, fontFace: 'Microsoft YaHei', lineSpacingMultiple: 1.5
  });

  // ============================================================
  // SLIDE 12: Competitive Advantages
  // ============================================================
  slide = pptx.addSlide();
  slide.background = { color: C.white };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.08, fill: { color: C.secondary } });
  slide.addText('04', { x: 0.8, y: 0.2, w: 1, h: 0.5, fontSize: 18, bold: true, color: C.secondary, fontFace: 'Arial' });
  slide.addText('竞争优势 — 与行业方案的差异化', { x: 1.6, y: 0.2, w: 8, h: 0.5, fontSize: 24, bold: true, color: C.dark, fontFace: 'Microsoft YaHei' });

  // Comparison table
  const tableRows = [
    ['功能维度', '传统ERP', 'ILS/PartsBase', 'AeroLink'],
    ['AI智能报价', '❌', '❌', '✅ AI推荐 + 自动报价'],
    ['区块链证书存证', '❌', '❌', '✅ 哈希上链，不可篡改'],
    ['中英双语支持', '部分', '仅英文', '✅ 中英文一键切换'],
    ['多币种实时汇率', '❌', '❌', '✅ USD/EUR/CNY实时换算'],
    ['时寿件自动预警', '❌', '❌', '✅ 到期自动提醒'],
    ['AOG紧急通道', '❌', '手动', '✅ 自动升级机制'],
    ['完整审计日志', '部分', '❌', '✅ 全操作链路追踪'],
    ['到岸成本计算', '❌', '❌', '✅ 自动计算到岸总成本'],
    ['FMV公正价值', '❌', '❌', '✅ 件号级市场估值'],
  ];

  const colW = [2.8, 2.5, 2.5, 4.5];
  const tableOpts = {
    x: 0.8, y: 1.0, w: 12,
    border: { type: 'solid', pt: 0.5, color: 'E2E8F0' },
    colW,
    rowH: 0.5,
    fontSize: 12,
    fontFace: 'Microsoft YaHei',
    autoPage: false,
  };

  const formattedRows = tableRows.map((row, ri) => {
    return row.map((cell, ci) => {
      const isHeader = ri === 0;
      const isAeroCol = ci === 3;
      return {
        text: cell,
        options: {
          bold: isHeader || isAeroCol,
          color: isHeader ? C.white : (isAeroCol ? C.secondary : C.dark),
          fill: { color: isHeader ? C.primary : (isAeroCol ? 'EFF6FF' : (ri % 2 === 0 ? C.white : 'F8FAFC')) },
          align: ci === 0 ? 'left' : 'center',
          fontSize: isHeader ? 12 : 11,
        }
      };
    });
  });

  slide.addTable(formattedRows, tableOpts);

  // Summary box
  slide.addShape(pptx.ShapeType.roundRect, { x: 0.8, y: 6.2, w: 11.7, h: 1.0, fill: { color: 'EFF6FF' }, rectRadius: 0.1 });
  slide.addText('🏆 AeroLink 核心差异化：AI驱动 + 区块链合规 + 全球化支持 + 全链路数字化，专为中小型航材贸易商和MRO企业量身打造', {
    x: 1.0, y: 6.3, w: 11.2, h: 0.8, fontSize: 14, bold: true, color: C.primary, fontFace: 'Microsoft YaHei'
  });

  // ============================================================
  // SLIDE 13: Use Case - RFQ Processing
  // ============================================================
  slide = pptx.addSlide();
  slide.background = { color: C.white };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.08, fill: { color: C.secondary } });
  slide.addText('05', { x: 0.8, y: 0.2, w: 1, h: 0.5, fontSize: 18, bold: true, color: C.secondary, fontFace: 'Arial' });
  slide.addText('实际应用场景 — AOG紧急需求处理', { x: 1.6, y: 0.2, w: 10, h: 0.5, fontSize: 24, bold: true, color: C.dark, fontFace: 'Microsoft YaHei' });

  // Scenario description
  slide.addShape(pptx.ShapeType.roundRect, { x: 0.5, y: 0.9, w: 12.3, h: 1.2, fill: { color: 'FEF2F2' }, line: { color: 'FECACA', width: 1 }, rectRadius: 0.1 });
  slide.addText('🚨 场景：AOG（飞机停场）紧急需求', { x: 0.8, y: 0.95, w: 10, h: 0.4, fontSize: 16, bold: true, color: C.red, fontFace: 'Microsoft YaHei' });
  slide.addText('某航空公司飞机因燃油泵故障停场（AOG），急需件号2341-123-050的燃油泵总成2件。客户通过邮件发送紧急需求，要求在24小时内获取报价并安排发货。', {
    x: 0.8, y: 1.4, w: 11.5, h: 0.6, fontSize: 12, color: C.dark, fontFace: 'Microsoft YaHei', lineSpacingMultiple: 1.3
  });

  // Step-by-step flow
  const steps = [
    { step: '1', title: 'AI自动归集', desc: '系统AI自动识别邮件中的件号、数量和紧急级别，生成需求单', time: '0分钟' },
    { step: '2', title: '智能寻源', desc: '自动匹配库存中的2件翻修件（FAA 8130-3证书），推荐供应商方案', time: '2分钟' },
    { step: '3', title: 'AI报价建议', desc: '基于历史成交数据，推荐报价区间$1,000-$1,500/件', time: '3分钟' },
    { step: '4', title: 'AOG快速审批', desc: 'AOG通道自动跳过常规审批，直接推送至销售经理确认', time: '15分钟' },
    { step: '5', title: '合同与发货', desc: '一键生成销售合同，关联库存证书，安排物流发货', time: '1小时' },
  ];

  steps.forEach((s, i) => {
    const x = 0.5 + i * 2.55;
    const isLast = i === steps.length - 1;
    slide.addShape(pptx.ShapeType.roundRect, { x, y: 2.4, w: 2.35, h: 3.5, fill: { color: isLast ? 'F0FDF4' : 'F8FAFC' }, line: { color: isLast ? '86EFAC' : 'E2E8F0', width: 1 }, rectRadius: 0.12 });
    slide.addShape(pptx.ShapeType.ellipse, { x: x + 0.85, y: 2.6, w: 0.6, h: 0.6, fill: { color: isLast ? C.green : C.secondary } });
    slide.addText(s.step, { x: x + 0.85, y: 2.57, w: 0.6, h: 0.6, fontSize: 20, color: C.white, align: 'center', bold: true });
    slide.addText(s.title, { x: x + 0.15, y: 3.35, w: 2.1, h: 0.4, fontSize: 13, bold: true, color: C.dark, align: 'center', fontFace: 'Microsoft YaHei' });
    slide.addText(s.desc, { x: x + 0.15, y: 3.8, w: 2.1, h: 1.2, fontSize: 10, color: C.gray, align: 'center', fontFace: 'Microsoft YaHei', lineSpacingMultiple: 1.3 });
    slide.addShape(pptx.ShapeType.roundRect, { x: x + 0.4, y: 5.2, w: 1.5, h: 0.35, fill: { color: isLast ? 'DCFCE7' : 'EFF6FF' }, rectRadius: 0.06 });
    slide.addText(s.time, { x: x + 0.4, y: 5.2, w: 1.5, h: 0.35, fontSize: 11, color: isLast ? '166534' : C.secondary, align: 'center', bold: true, fontFace: 'Arial' });
  });

  // Result
  slide.addShape(pptx.ShapeType.roundRect, { x: 0.5, y: 6.2, w: 12.3, h: 1.0, fill: { color: 'F0FDF4' }, rectRadius: 0.1 });
  slide.addText('✅ 结果：从收到邮件到报价发出仅需 20 分钟，传统方式需要 4-8 小时。客户满意度提升，赢得订单概率大幅增加。', {
    x: 0.8, y: 6.3, w: 11.8, h: 0.8, fontSize: 13, bold: true, color: '166534', fontFace: 'Microsoft YaHei'
  });

  // ============================================================
  // SLIDE 14: Product Screenshots Gallery
  // ============================================================
  slide = pptx.addSlide();
  slide.background = { color: C.white };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.08, fill: { color: C.secondary } });
  slide.addText('05', { x: 0.8, y: 0.2, w: 1, h: 0.5, fontSize: 18, bold: true, color: C.secondary, fontFace: 'Arial' });
  slide.addText('产品界面展示', { x: 1.6, y: 0.2, w: 5, h: 0.5, fontSize: 24, bold: true, color: C.dark, fontFace: 'Microsoft YaHei' });

  // 2x2 grid of screenshots
  const galleryImgs = [
    { file: '20-dashboard-en.png', label: '英文界面工作台' },
    { file: '03-inventory.png', label: '库存管理中心' },
    { file: '04-rfq.png', label: '需求单管理' },
    { file: '07-customers.png', label: '客户管理' },
  ];
  galleryImgs.forEach((gi, i) => {
    const x = 0.3 + (i % 2) * 6.5;
    const y = 0.9 + Math.floor(i / 2) * 3.2;
    if (fs.existsSync(img(gi.file))) {
      slide.addImage({ path: img(gi.file), x, y, w: 6.2, h: 2.8, shadow: { type: 'outer', blur: 5, offset: 2, color: '00000015' } });
      slide.addText(gi.label, { x, y: y + 2.85, w: 6.2, h: 0.3, fontSize: 11, color: C.gray, align: 'center', fontFace: 'Microsoft YaHei', italic: true });
    }
  });

  // ============================================================
  // SLIDE 15: Summary & Contact
  // ============================================================
  slide = pptx.addSlide();
  slide.background = { color: C.dark };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.08, fill: { color: C.secondary } });
  slide.addText('06', { x: 0.8, y: 0.2, w: 1, h: 0.5, fontSize: 18, bold: true, color: C.accent, fontFace: 'Arial' });
  slide.addText('总结与展望', { x: 1.6, y: 0.2, w: 5, h: 0.5, fontSize: 28, bold: true, color: C.white, fontFace: 'Microsoft YaHei' });

  // Summary cards
  const summaryItems = [
    { icon: '✈', title: '10+ 核心功能模块', desc: '覆盖航材交易全流程' },
    { icon: '🤖', title: 'AI 驱动', desc: '智能报价、需求预测、自动归集' },
    { icon: '🔗', title: '区块链合规', desc: '证书存证、审计追踪、满足行业法规' },
    { icon: '🌍', title: '全球化就绪', desc: '双语、多币种、多时区' },
  ];
  summaryItems.forEach((s, i) => {
    const x = 0.5 + i * 3.15;
    slide.addShape(pptx.ShapeType.roundRect, { x, y: 1.0, w: 2.9, h: 1.8, fill: { color: '1E293B' }, line: { color: '334155', width: 1 }, rectRadius: 0.12 });
    slide.addText(s.icon, { x, y: 1.1, w: 2.9, h: 0.6, fontSize: 30, align: 'center' });
    slide.addText(s.title, { x, y: 1.7, w: 2.9, h: 0.4, fontSize: 14, bold: true, color: C.white, align: 'center', fontFace: 'Microsoft YaHei' });
    slide.addText(s.desc, { x, y: 2.1, w: 2.9, h: 0.4, fontSize: 11, color: C.gray, align: 'center', fontFace: 'Microsoft YaHei' });
  });

  // Roadmap
  slide.addText('产品路线图', { x: 0.8, y: 3.2, w: 5, h: 0.5, fontSize: 20, bold: true, color: C.white, fontFace: 'Microsoft YaHei' });
  const roadmap = [
    { phase: 'Phase 1', title: '功能补全', items: '电子证书管理 · 工作流引擎 · 数据库升级 · 操作审计', color: C.green },
    { phase: 'Phase 2', title: '智能化升级', items: 'AI历史价格推荐 · 拍卖模块 · 寄售管理 · 消耗趋势分析', color: C.gold },
    { phase: 'Phase 3', title: '平台化生态', items: 'API开放平台 · FMV价格引擎 · 区块链证书 · 多语言国际化', color: C.accent },
  ];
  roadmap.forEach((r, i) => {
    const x = 0.8 + i * 4.2;
    slide.addShape(pptx.ShapeType.roundRect, { x, y: 3.9, w: 3.8, h: 2.2, fill: { color: '1E293B' }, line: { color: r.color, width: 2 }, rectRadius: 0.12 });
    slide.addText(r.phase, { x, y: 4.0, w: 3.8, h: 0.35, fontSize: 12, color: r.color, align: 'center', bold: true, fontFace: 'Arial' });
    slide.addText(r.title, { x, y: 4.35, w: 3.8, h: 0.4, fontSize: 16, color: C.white, align: 'center', bold: true, fontFace: 'Microsoft YaHei' });
    slide.addText(r.items, { x: x + 0.2, y: 4.85, w: 3.4, h: 1.0, fontSize: 10, color: C.gray, align: 'center', fontFace: 'Microsoft YaHei', lineSpacingMultiple: 1.4 });
  });

  // Contact
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 6.4, w: '100%', h: 1.1, fill: { color: '0D1B2A' } });
  slide.addText('感谢关注 AeroLink  |  航材智能交易平台', { x: 0.8, y: 6.5, w: 7, h: 0.4, fontSize: 16, bold: true, color: C.white, fontFace: 'Microsoft YaHei' });
  slide.addText('联系我们获取演示账号和产品报价', { x: 0.8, y: 6.9, w: 7, h: 0.3, fontSize: 12, color: C.gray, fontFace: 'Microsoft YaHei' });
  slide.addText('© 2026 AeroLink. All Rights Reserved.', { x: 8, y: 6.6, w: 4.8, h: 0.3, fontSize: 11, color: C.gray, align: 'right', fontFace: 'Arial' });

  // Save
  await pptx.writeFile({ fileName: OUTPUT_FILE });
  console.log(`\n✅ PPT generated: ${OUTPUT_FILE}`);
}

main().catch(console.error);
