// Árbitro del juego (de KelvinQiu802/battleship, MIT). Lógica intacta; solo se tradujeron los comentarios.
import * as BLOCK_STATE from './blockStates';
import * as SHIPS from './ships';

const ROWS = 8;
const COLS = 8;

export const createEmptyBoard = () => {
  return [...new Array(64)].fill(BLOCK_STATE.EMTPY);
};

// Fila y columna → índice
export const coordinateToIndex = (row, col) => row * COLS + col;

// Índice → fila y columna
export const indexToCoordinate = (index) => {
  return {
    row: Math.floor(index / COLS),
    col: index % COLS,
  };
};

// Pone un barco en el tablero (o marca en rojo dónde no cabe)
export const placeShipOnBoard = (board, ship, placing = false) => {
  let boardCopy = [...board];
  if (ship?.position.row != null) {
    const {
      name,
      length,
      direction,
      position: { row, col },
    } = ship;

    switch (direction) {
      case 'HORIZONTAL':
        switch (canBePlaced(boardCopy, length, direction, row, col)) {
          case 'OK':
            for (let i = 0; i < length; i++) {
              boardCopy[coordinateToIndex(row, col + i)] = placing
                ? BLOCK_STATE.PLACING
                : name;
            }
            break;
          case 'OVERFLOW':
            for (let i = 0; i < COLS - col; i++) {
              boardCopy[coordinateToIndex(row, col + i)] =
                BLOCK_STATE.FORBIDDEN;
            }
            break;
          case 'OCCUPIED':
            for (let i = 0; i < length; i++) {
              boardCopy[coordinateToIndex(row, col + i)] =
                BLOCK_STATE.FORBIDDEN;
            }
        }
        break;
      case 'VERTICAL':
        switch (canBePlaced(boardCopy, length, direction, row, col)) {
          case 'OK':
            for (let i = 0; i < length; i++) {
              boardCopy[coordinateToIndex(row + i, col)] = placing
                ? BLOCK_STATE.PLACING
                : name;
            }
            break;
          case 'OVERFLOW':
            for (let i = 0; i < ROWS - row; i++) {
              boardCopy[coordinateToIndex(row + i, col)] =
                BLOCK_STATE.FORBIDDEN;
            }
            break;
          case 'OCCUPIED':
            for (let i = 0; i < length; i++) {
              boardCopy[coordinateToIndex(row + i, col)] =
                BLOCK_STATE.FORBIDDEN;
            }
        }
    }
  }
  return boardCopy;
};

// ¿Cabe el barco aquí? OK, OVERFLOW (se sale) u OCCUPIED (pisa otro)
export const canBePlaced = (board, length, direction, row, col) => {
  switch (direction) {
    case 'HORIZONTAL':
      // no se sale
      if (col + length <= COLS) {
        // no pisa otro barco
        for (let i = 0; i < length; i++) {
          if (board[coordinateToIndex(row, +col + i)] !== BLOCK_STATE.EMTPY)
            // pisa otro barco
            return 'OCCUPIED';
        }
        return 'OK';
      }
      // se sale
      return 'OVERFLOW';
    case 'VERTICAL':
      if (row + length <= ROWS) {
        for (let i = 0; i < length; i++) {
          if (board[coordinateToIndex(row + i, col)] !== BLOCK_STATE.EMTPY)
            return 'OCCUPIED';
        }
        return 'OK';
      }
      return 'OVERFLOW';
  }
};

// Pinta la casilla que se está apuntando
// (el elemento 0 del array de disparos es el cursor "selecting")
export const showSelectiongBlock = (board, position) => {
  if (position.row === null) return board;
  const boardCopy = [...board];
  const index = coordinateToIndex(position.row, position.col);
  if (boardCopy[index] === BLOCK_STATE.EMTPY) {
    boardCopy[index] = BLOCK_STATE.SELECTING;
  }
  return boardCopy;
};

// ¿Se puede disparar a attack[0]? Solo si no se disparó ya ahí
export const canAttack = (attack) => {
  const { row, col } = attack[0].position;
  const attackCopy = [...attack];
  attackCopy.shift();
  // ¿ya se disparó ahí?
  const isAttacked = attackCopy.find(
    (item) => item.position.row === row && item.position.col === col
  );
  // no se repite disparo
  return isAttacked ? false : true;
};

// ¿Hay barco en esa casilla?
export const checkAttack = (finalBoard, position) => {
  const index = coordinateToIndex(position.row, position.col);
  return finalBoard[index] !== BLOCK_STATE.EMTPY;
};

// Pinta los disparos hechos
export const showAttack = (board, attack) => {
  const boardCopy = [...board];
  attack.forEach((item) => {
    const index = coordinateToIndex(item.position.row, item.position.col);
    if (item.state != BLOCK_STATE.SELECTING) {
      boardCopy[index] = item.state;
    }
  });
  return boardCopy;
};

// ¿Se hundió el barco tocado? Marca sus casillas como "sank"
export const checkSunk = (
  attack,
  finalBoard,
  row,
  col,
  potentialTarget = null
) => {
  const ship = finalBoard[coordinateToIndex(row, col)];
  if (ship === 'empty') return attack; // agua
  const attackCopy = [...attack];
  const length = SHIPS[ship.toUpperCase()].length;
  const amount = attack.filter((item) => item.ship === ship).length;
  if (amount === length) {
    // hundido
    attackCopy.forEach((item) => {
      if (item.ship === ship) {
        item.state = BLOCK_STATE.SANK;
      }
    });

    // (en el original: borra los objetivos de la IA del ordenador; aquí no se usa)
    if (potentialTarget) {
      potentialTarget.current = [];
    }
    return attackCopy;
  }
  return attack;
};
