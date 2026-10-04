/**
 * Sanitised API errors.
 * Clients only ever receive { error: { code, message, requestId, details? } }
 * with a curated, human-readable message. Stack traces, SQL errors, SDK errors,
 * and file paths are logged server-side only.
 */
import crypto from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import multer from 'multer';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** Safe to show to end users */
    readonly publicMessage: string,
    readonly details?: unknown,
  ) {
    super(publicMessage);
    this.name = 'AppError';
  }
}

export const requestId: RequestHandler = (req, res, next) => {
  const id = crypto.randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
};

export const notFound: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', 'The requested resource was not found.'));
};

export function errorHandler(maxUploadBytes: number): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    const reqId: string = res.locals.requestId ?? 'unknown';

    let appErr: AppError;
    if (err instanceof AppError) {
      appErr = err;
    } else if (err instanceof multer.MulterError) {
      appErr =
        err.code === 'LIMIT_FILE_SIZE'
          ? new AppError(
              413,
              'FILE_TOO_LARGE',
              `The file is larger than the ${Math.round(maxUploadBytes / 1024 / 1024)} MB limit.`,
            )
          : new AppError(400, 'UPLOAD_INVALID', 'The upload could not be processed. Attach a single PDF file in the "file" field.');
    } else if (err?.type === 'entity.too.large') {
      appErr = new AppError(413, 'PAYLOAD_TOO_LARGE', 'The request is too large.');
    } else if (err?.type === 'entity.parse.failed') {
      appErr = new AppError(400, 'MALFORMED_JSON', 'The request body is not valid JSON.');
    } else {
      appErr = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong on our side. Please try again.');
    }

    if (appErr.status >= 500) {
      console.error(`[${reqId}]`, err);
    }

    res.status(appErr.status).json({
      error: {
        code: appErr.code,
        message: appErr.publicMessage,
        requestId: reqId,
        ...(appErr.details !== undefined ? { details: appErr.details } : {}),
      },
    });
  };
}
