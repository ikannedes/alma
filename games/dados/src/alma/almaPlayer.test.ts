import { describe, expect, it } from 'vitest'
import { isValidRaise } from '../lib/liarDice'
import { createInitialState, gameReducer, type GameState } from '../state/gameReducer'
import { history, legalMoves, stateText } from './almaPlayer'

/** Alma "simulada": elige al azar de su lista (como el enum de Haiku). El juego valida y aplica. */
function playRound(seed: number): { almaMoves: number; invalid: number; winner: string } {
  let rnd = seed
  const random = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648)
  let s: GameState = createInitialState({ settings: { mode: 'liar', diceCount: 5, onesWild: seed % 2 === 0, reduceMotion: true } })
  s = gameReducer(s, { type: 'start-round' })
  s = gameReducer(s, { type: 'roll-complete' })
  let almaMoves = 0, invalid = 0
  for (let guard = 0; guard < 200 && s.phase !== 'round-over'; guard++) {
    if (s.phase === 'revealing') { s = gameReducer(s, { type: 'reveal-complete' }); continue }
    const legal = legalMoves(s)
    if (s.phase === 'ai-thinking') {
      expect(stateText(s)).toContain('Tus dados')
      const pick = legal[Math.floor(random() * legal.length)]
      if (pick.decision.action === 'raise' && !isValidRaise(s.currentCall, pick.decision.call!)) invalid++
      const before = s.log.length
      s = gameReducer(s, { type: 'ai-move', decision: pick.decision })
      if (pick.decision.action === 'raise' && s.log.length !== before + 1) invalid++
      almaMoves++
    } else if (s.phase === 'awaiting-call') {
      // el dueño: abre si puede y la apuesta es alta; si no, sube lo mínimo
      const raises = legal.filter((m) => m.decision.action === 'raise')
      if (s.lastCaller === 'ai' && (random() < 0.35 || !raises.length)) s = gameReducer(s, { type: 'player-open' })
      else s = gameReducer(s, { type: 'player-call', call: raises[0].decision.call! })
    } else break
  }
  expect(history(s).length).toBe(s.log.length)
  return { almaMoves, invalid, winner: s.result?.winner ?? 'none' }
}

describe('Alma en dados mentirosos', () => {
  it('100 rondas simuladas sin una sola jugada inválida', () => {
    let moves = 0
    const winners = new Set<string>()
    for (let i = 1; i <= 100; i++) {
      const r = playRound(i * 7919)
      expect(r.invalid).toBe(0)
      expect(r.winner).not.toBe('none')
      moves += r.almaMoves
      winners.add(r.winner)
    }
    expect(moves).toBeGreaterThan(100)
    expect(winners.size).toBe(2)
  })

  it('solo puede abrir una apuesta del dueño, y las ids son estables', () => {
    let s = createInitialState({ settings: { mode: 'liar', diceCount: 5, reduceMotion: true } })
    s = { ...s, phase: 'ai-thinking', currentCall: { quantity: 3, face: 4 }, lastCaller: 'player', aiDice: [1, 4, 4, 2, 6], playerDice: [1, 2, 3, 4, 5] }
    const ids = legalMoves(s).map((m) => m.id)
    expect(ids[0]).toBe('abrir')
    expect(ids).toContain('q3c5')
    expect(ids).not.toContain('q3c4')
    expect(new Set(ids).size).toBe(ids.length)
    expect(legalMoves({ ...s, lastCaller: 'ai' }).map((m) => m.id)).not.toContain('abrir')
  })
})
