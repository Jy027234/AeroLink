import { Router, type Request } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { authenticate, AuthRequest } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';

const router = Router();

/**
 * Verify a file's content matches its declared MIME type by checking magic bytes.
 * Reads the first 8 bytes of the file and compares against known signatures.
 * Returns true for text-based types (like CSV) that have no binary signature.
 */
function verifyFileSignature(filePath: string, mimetype: string): boolean {
  const buffer = Buffer.alloc(8);
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 8, 0);
  } catch {
    return false;
  } finally {
    try { fs.closeSync(fd!); } catch { /* ignore close errors */ }
  }

  const signatures: Record<string, (buf: Buffer) => boolean> = {
    // PDF: starts with "%PDF"
    'application/pdf': (buf) => buf.toString('utf8', 0, 4) === '%PDF',

    // JPEG: starts with 0xFF D8 FF
    'image/jpeg': (buf) => buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF,

    // PNG: starts with 0x89 0x50 0x4E 0x47 (.PNG)
    'image/png': (buf) => buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47,

    // GIF: starts with "GIF87a" or "GIF89a"
    'image/gif': (buf) => {
      const header = buf.toString('utf8', 0, 6);
      return header === 'GIF87a' || header === 'GIF89a';
    },

    // DOC (OLE2): starts with 0xD0 0xCF 0x11 0xE0
    'application/msword': (buf) => buf[0] === 0xD0 && buf[1] === 0xCF && buf[2] === 0x11 && buf[3] === 0xE0,

    // DOCX/XLSX (Office Open XML / PK zip): starts with 0x50 0x4B 0x03 0x04
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (buf) =>
      buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04,

    // XLS (OLE2): starts with 0xD0 0xCF 0x11 0xE0
    'application/vnd.ms-excel': (buf) => buf[0] === 0xD0 && buf[1] === 0xCF && buf[2] === 0x11 && buf[3] === 0xE0,

    // XLSX (Office Open XML): starts with 0x50 0x4B
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': (buf) =>
      buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04,

    // CSV: plain text, no reliable binary signature — skip
    'text/csv': () => true,
  };

  const checker = signatures[mimetype];
  if (!checker) {
    // Unknown MIME type — reject for safety
    logger.warn({ mimetype, filePath }, 'No magic-byte checker for MIME type, rejecting file');
    return false;
  }

  const valid = checker(buffer);
  if (!valid) {
    logger.warn({ mimetype, filePath, hex: buffer.toString('hex') }, 'File signature mismatch');
  }
  return valid;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  },
});

const fileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedTypes = [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/gif',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('不支持的文件类型: ' + file.mimetype));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});

router.post(
  '/',
  authenticate,
  upload.single('file'),
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.file) {
      throw new AppError('没有上传文件', 400);
    }

    // Verify file content against declared MIME type using magic bytes
    if (!verifyFileSignature(req.file.path, req.file.mimetype)) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore cleanup errors */ }
      throw new AppError('文件类型与实际内容不符', 400);
    }

    logger.info({
      userId: req.user?.id,
      filename: req.file.filename,
      originalname: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
    }, 'File uploaded');

    res.json({
      success: true,
      data: {
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
        url: `/uploads/${req.file.filename}`,
      },
    });
  })
);

router.post(
  '/multiple',
  authenticate,
  upload.array('files', 10),
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
      throw new AppError('没有上传文件', 400);
    }

    // Verify each file's content against its declared MIME type using magic bytes
    for (const file of req.files) {
      if (!verifyFileSignature(file.path, file.mimetype)) {
        // Clean up all uploaded files on verification failure
        for (const f of req.files) {
          try { fs.unlinkSync(f.path); } catch { /* ignore cleanup errors */ }
        }
        throw new AppError(`文件 ${file.originalname} 的类型与实际内容不符`, 400);
      }
    }

    const files = req.files.map((file) => ({
      filename: file.filename,
      originalName: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      url: `/uploads/${file.filename}`,
    }));

    logger.info({
      userId: req.user?.id,
      count: files.length,
    }, 'Multiple files uploaded');

    res.json({
      success: true,
      data: files,
    });
  })
);

export default router;
