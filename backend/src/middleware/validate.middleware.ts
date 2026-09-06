import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';
import { ApiError } from '../utils/ApiError';

type Source = 'body' | 'query' | 'params';

export function validate(schema: ZodTypeAny, source: Source = 'body'): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(ApiError.unprocessable('Los datos enviados no son válidos', formatIssues(result.error)));
    }
    if (source === 'body') req.body = result.data;
    else Object.assign(req[source], result.data);
    next();
  };
}

function formatIssues(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'general';
    if (!fields[path]) fields[path] = issue.message;
  }
  return fields;
}
