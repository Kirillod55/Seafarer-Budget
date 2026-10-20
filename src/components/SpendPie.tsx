import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts'

export interface PieSlice {
  name: string
  value: number
  color: string
}

/** Donut of spending by category. Decorative: the list next to it carries the same numbers as text. */
export function SpendPie({ data }: { data: PieSlice[] }) {
  return (
    <div className="pie" aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="55%"
            outerRadius="95%"
            paddingAngle={data.length > 1 ? 2 : 0}
            stroke="none"
            isAnimationActive={false}
          >
            {data.map((slice) => (
              <Cell key={slice.name} fill={slice.color} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    </div>
  )
}
