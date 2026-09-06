import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCurrency } from '@/utils/format';

const PALETTE = ['#F97316', '#3B82F6', '#22C55E', '#A855F7', '#F59E0B', '#EF4444', '#06B6D4'];

const AXIS_STYLE = { fontSize: 12, fill: '#94A3B8' };

interface SeriesPoint {
  label: string;
  value: number;
}

export function SalesAreaChart({ data, height = 260, currency = true }: { data: SeriesPoint[]; height?: number; currency?: boolean }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="salesGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#F97316" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#F97316" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="label" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
        <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} width={56} />
        <Tooltip
          formatter={(value: number) => (currency ? formatCurrency(value) : value)}
          contentStyle={{ borderRadius: 12, border: '1px solid #E2E8F0', boxShadow: '0 4px 16px rgba(15,23,42,.08)' }}
        />
        <Area type="monotone" dataKey="value" stroke="#F97316" strokeWidth={2.5} fill="url(#salesGradient)" dot={{ r: 3, fill: '#F97316' }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function CategoryBarChart({ data, height = 260, currency = true }: { data: SeriesPoint[]; height?: number; currency?: boolean }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <XAxis dataKey="label" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
        <YAxis tick={AXIS_STYLE} axisLine={false} tickLine={false} width={56} />
        <Tooltip
          formatter={(value: number) => (currency ? formatCurrency(value) : value)}
          contentStyle={{ borderRadius: 12, border: '1px solid #E2E8F0' }}
        />
        <Bar dataKey="value" radius={[8, 8, 0, 0]}>
          {data.map((_, index) => (
            <Cell key={index} fill={PALETTE[index % PALETTE.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DonutChart({ data, height = 240, currency = true }: { data: SeriesPoint[]; height?: number; currency?: boolean }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="label" innerRadius="58%" outerRadius="85%" paddingAngle={2}>
          {data.map((_, index) => (
            <Cell key={index} fill={PALETTE[index % PALETTE.length]} />
          ))}
        </Pie>
        <Tooltip
          formatter={(value: number) => (currency ? formatCurrency(value) : value)}
          contentStyle={{ borderRadius: 12, border: '1px solid #E2E8F0' }}
        />
        <Legend verticalAlign="bottom" iconType="circle" wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}
