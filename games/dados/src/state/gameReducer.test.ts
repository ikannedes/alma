import { describe, expect, it } from 'vitest'
import { createInitialState, gameReducer, type GameState } from './gameReducer'

const start = (state: GameState): GameState => gameReducer(state, { type: 'start-round' })

describe('round lifecycle', () => {
  it('deals the configured hands and rolls', () => {
    const state = start(createInitialState({ settings: { diceCount: 4 } }))
    expect(state.phase).toBe('rolling')
    expect(state.round).toBe(1)
    expect(state.rollId).toBe(1)
    expect(state.playerDice).toHaveLength(4)
    expect(state.aiDice).toHaveLength(4)
    expect(state.aiRevealed).toBe(false)
  })

  it('deals a single shared hand in open mode and ends the round after the roll', () => {
    let state = createInitialState({ settings: { mode: 'open', diceCount: 5 } })
    state = start(state)
    expect(state.aiDice).toHaveLength(0)
    expect(state.aiRevealed).toBe(true)

    state = gameReducer(state, { type: 'roll-complete' })
    expect(state.phase).toBe('round-over')
  })

  it('hands the turn to the player after the roll when the player bids first', () => {
    let state = start(createInitialState())
    state = { ...state, firstTurn: 'player' }
    state = gameReducer(state, { type: 'roll-complete' })
    expect(state.phase).toBe('awaiting-call')
  })
})

describe('bidding', () => {
  const bidding = (): GameState => {
    let state = start(createInitialState({ settings: { diceCount: 3 } }))
    state = { ...state, firstTurn: 'player' }
    return gameReducer(state, { type: 'roll-complete' })
  }

  it('accepts a legal bid and waits for the opponent', () => {
    const state = gameReducer(bidding(), { type: 'player-call', call: { quantity: 2, face: 3 } })
    expect(state.currentCall).toEqual({ quantity: 2, face: 3 })
    expect(state.lastCaller).toBe('player')
    expect(state.phase).toBe('ai-thinking')
    expect(state.log).toHaveLength(1)
  })

  it('rejects a bid that does not raise the standing one', () => {
    let state = gameReducer(bidding(), { type: 'player-call', call: { quantity: 2, face: 3 } })
    state = { ...state, phase: 'awaiting-call' }
    const rejected = gameReducer(state, { type: 'player-call', call: { quantity: 1, face: 6 } })
    expect(rejected.currentCall).toEqual({ quantity: 2, face: 3 })
    expect(rejected.log).toHaveLength(1)
  })

  it('caps bids at the dice on the table', () => {
    const state = gameReducer(bidding(), { type: 'player-call', call: { quantity: 99, face: 6 } })
    expect(state.currentCall).toBeNull()
  })

  it('cannot be opened before the opponent has bid', () => {
    const state = gameReducer(bidding(), { type: 'player-open' })
    expect(state.phase).toBe('awaiting-call')
    expect(state.result).toBeNull()
  })
})

describe('challenge', () => {
  const challenged = (): GameState => {
    let state = start(createInitialState({ settings: { diceCount: 2 } }))
    state = { ...state, firstTurn: 'player', playerDice: [4, 4], aiDice: [2, 2] }
    state = gameReducer(state, { type: 'roll-complete' })
    state = gameReducer(state, { type: 'player-call', call: { quantity: 2, face: 4 } })
    // The opponent raises; the player challenges it.
    state = gameReducer(state, {
      type: 'ai-move',
      decision: { action: 'raise', call: { quantity: 3, face: 4 } },
    })
    return gameReducer(state, { type: 'player-open' })
  }

  it('scores the round and reveals the table', () => {
    const state = challenged()
    expect(state.phase).toBe('revealing')
    expect(state.aiRevealed).toBe(true)
    expect(state.result?.winner).toBe('player')
    expect(state.result?.actualCount).toBe(2)
    expect(state.score).toEqual({ player: 1, ai: 0 })
  })

  it('closes out on reveal-complete and ignores stale roll events', () => {
    let state = challenged()
    state = gameReducer(state, { type: 'reveal-complete' })
    expect(state.phase).toBe('round-over')

    const stale = gameReducer(state, { type: 'roll-complete' })
    expect(stale).toBe(state)
  })
})

describe('settings', () => {
  it('restarts the round when the dice count changes', () => {
    let state = start(createInitialState({ settings: { diceCount: 3 } }))
    const before = state.rollId
    state = gameReducer(state, { type: 'set-dice-count', count: 6 })
    expect(state.settings.diceCount).toBe(6)
    expect(state.rollId).toBe(before + 1)
    expect(state.phase).toBe('rolling')
    expect(state.log).toHaveLength(0)
  })

  it('keeps the round when nothing actually changes', () => {
    let state = start(createInitialState({ settings: { diceCount: 3 } }))
    state = gameReducer(state, { type: 'roll-complete' })
    const same = gameReducer(state, { type: 'set-dice-count', count: 3 })
    expect(same).toBe(state)
  })

  it('resets the table but keeps the preferences', () => {
    let state = start(createInitialState({ settings: { diceCount: 7, mode: 'open' } }))
    state = gameReducer(state, { type: 'reset' })
    expect(state.phase).toBe('idle')
    expect(state.round).toBe(0)
    expect(state.score).toEqual({ player: 0, ai: 0 })
    expect(state.settings.diceCount).toBe(7)
    expect(state.settings.mode).toBe('open')
  })
})
