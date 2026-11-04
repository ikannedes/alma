import { cn } from 'cn'

/**
 * Pip positions as fractions of the face, shared with the 3D texture layouts so
 * the flat and rendered dice always read the same way. Every layout is
 * symmetric under 180° rotation, which is what makes pip orientation
 * irrelevant everywhere in this project.
 */
const LAYOUTS: Record<number, ReadonlyArray<readonly [number, number]>> = {
  1: [[0.5, 0.5]],
  2: [
    [0.28, 0.28],
    [0.72, 0.72],
  ],
  3: [
    [0.26, 0.26],
    [0.5, 0.5],
    [0.74, 0.74],
  ],
  4: [
    [0.28, 0.28],
    [0.72, 0.28],
    [0.28, 0.72],
    [0.72, 0.72],
  ],
  5: [
    [0.26, 0.26],
    [0.74, 0.26],
    [0.5, 0.5],
    [0.26, 0.74],
    [0.74, 0.74],
  ],
  6: [
    [0.3, 0.22],
    [0.7, 0.22],
    [0.3, 0.5],
    [0.7, 0.5],
    [0.3, 0.78],
    [0.7, 0.78],
  ],
}

export interface PipFaceProps {
  value: number
  /** `highlight` marks the face the current bid is about. */
  tone?: 'ivory' | 'highlight' | 'concealed' | 'muted'
  className?: string
  /** Accessible label override. */
  label?: string
}

const TONES: Record<NonNullable<PipFaceProps['tone']>, { face: string; pip: string; ring: string }> = {
  ivory: { face: '#f8f7f4', pip: '#16161a', ring: 'rgba(0,0,0,0.25)' },
  highlight: { face: '#ffd166', pip: '#231b06', ring: 'rgba(251,191,36,0.9)' },
  concealed: { face: '#241b47', pip: '#c4b5fd', ring: 'rgba(167,139,250,0.55)' },
  muted: { face: 'rgba(255,255,255,0.12)', pip: 'rgba(255,255,255,0.55)', ring: 'rgba(255,255,255,0.18)' },
}

/** One die rendered as a flat SVG face — used in logs, reports and history. */
export function PipFace({ value, tone = 'ivory', className, label }: PipFaceProps) {
  const palette = TONES[tone]
  const pips = LAYOUTS[value] ?? []
  const radius = value === 1 ? 0.115 : 0.085

  return (
    <svg
      viewBox="0 0 24 24"
      role="img"
      aria-label={label ?? `${value} 点`}
      className={cn('h-6 w-6 shrink-0', className)}
    >
      <rect
        x="1"
        y="1"
        width="22"
        height="22"
        rx="5"
        fill={palette.face}
        stroke={palette.ring}
        strokeWidth="1.2"
      />
      {pips.map(([px, py], index) => (
        <circle key={index} cx={px * 24} cy={py * 24} r={radius * 24} fill={palette.pip} />
      ))}
    </svg>
  )
}
