import type { ReactNode } from 'react';
import { STATUS_LABELS } from '@/constants/labels';
import { cn } from '@/utils/cn';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand' | 'purple';

const TONES: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700',
  success: 'bg-success-100 text-success-700',
  warning: 'bg-warning-100 text-warning-600',
  danger: 'bg-danger-100 text-danger-700',
  info: 'bg-info-100 text-info-600',
  brand: 'bg-brand-100 text-brand-700',
  purple: 'bg-purple-100 text-purple-700',
};

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold', TONES[tone], className)}>
      {children}
    </span>
  );
}

/** Maps every ENUM value in the schema to a consistent colour across the whole app. */
const STATUS_TONES: Record<string, Tone> = {
  ACTIVE: 'success',
  AVAILABLE: 'success',
  CONFIRMED: 'success',
  COMPLETED: 'success',
  PAID: 'success',
  PUBLISHED: 'success',
  RESOLVED: 'success',
  SENT: 'success',
  VERIFIED: 'success',

  PENDING: 'warning',
  PROCESSING: 'warning',
  DELAYED: 'warning',
  MAINTENANCE: 'warning',
  WAITING_USER: 'warning',
  DRAFT: 'warning',

  CANCELLED: 'danger',
  REJECTED: 'danger',
  FAILED: 'danger',
  SUSPENDED: 'danger',
  EXPIRED: 'danger',
  REVOKED: 'danger',

  INACTIVE: 'neutral',
  CLOSED: 'neutral',
  HIDDEN: 'neutral',
  READ: 'neutral',

  SCHEDULED: 'info',
  BOARDING: 'info',
  IN_PROGRESS: 'info',
  OPEN: 'info',
  REFUNDED: 'purple',
};

export function StatusBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  if (!status) return <Badge tone="neutral" className={className}>—</Badge>;
  return (
    <Badge tone={STATUS_TONES[status] ?? 'neutral'} className={className}>
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}
