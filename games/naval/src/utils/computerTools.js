// Colocación aleatoria de barcos (de KelvinQiu802/battleship, MIT).
// La IA de ataque del original (randomAttack, addPotentialTarget, attackPotentialTarget) se quitó a propósito:
// todos los disparos de Alma los elige Haiku por el puente. Sin red, Alma no juega; no hay bot de repuesto.
import {
  canBePlaced,
  createEmptyBoard,
  placeShipOnBoard,
} from './boardTools';

export const getRandInt = (min, max) => {
  return Math.floor((max - min + 1) * Math.random() + min);
};

// Coordenada al azar
export const getRandCoordinate = () => {
  return {
    row: getRandInt(0, 7),
    col: getRandInt(0, 7),
  };
};

// Dirección al azar
export const getRandDirection = () => {
  return getRandInt(0, 1) ? 'HORIZONTAL' : 'VERTICAL';
};

// Coloca la flota al azar (la de Alma, o la del dueño si pulsa "Al azar"). Colocar no es una jugada.
export const computerPlacingShip = (avaliableShips) => {
  let board = createEmptyBoard();
  const shipsCopy = [...avaliableShips];
  shipsCopy.forEach((ship) => {
    while (true) {
      const position = getRandCoordinate();
      const direction = getRandDirection();
      const length = ship.length;
      if (
        canBePlaced(board, length, direction, position.row, position.col) ===
        'OK'
      ) {
        // pone el barco
        board = placeShipOnBoard(board, {
          ...ship,
          direction: direction,
          position: position,
        });
        break;
      }
    }
  });
  return board;
};

// Flota al azar para el dueño, devolviendo la lista de barcos colocados (para poder pintarlos y deshacer).
export const randomPlacedShips = (avaliableShips) => {
  let board = createEmptyBoard();
  const placed = [];
  avaliableShips.forEach((ship) => {
    while (true) {
      const position = getRandCoordinate();
      const direction = getRandDirection();
      if (canBePlaced(board, ship.length, direction, position.row, position.col) === 'OK') {
        const placedShip = { ...ship, direction, position };
        board = placeShipOnBoard(board, placedShip);
        placed.push(placedShip);
        break;
      }
    }
  });
  return placed;
};
